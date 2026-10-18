#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const VERSION = 1;
const SELF = fileURLToPath(import.meta.url);
const MAX_BYTES = 2 * 1024 * 1024;
export const PROTECTED = [
  "scripts/dev-workflow.mjs",
  "scripts/dev-workflow.test.mjs",
  "scripts/dev-workflow-demo.mjs",
  "scripts/dev-workflow-hook-probe.mjs",
  "scripts/dev-workflow-policy.mjs",
  ".github/hooks/",
  ".github/copilot/",
  ".github/agents/development-",
  ".github/workflows/development-gates.yml",
  ".github/workflows/development-policy.yml",
  ".github/development-workflow",
];

export class WorkflowError extends Error {
  constructor(code, detail = code) {
    super(detail);
    this.name = "WorkflowError";
    this.code = code;
  }
}

function requireThat(condition, code, detail) {
  if (!condition) {
    throw new WorkflowError(code, detail);
  }
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (object(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted((left, right) => left.localeCompare(right, "en"))
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return hash(JSON.stringify(canonical(value)));
}

function identifier(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(value);
}

function relativePath(value) {
  requireThat(
    typeof value === "string" &&
      value.length > 0 &&
      value.length < 512 &&
      !isAbsolute(value) &&
      !/^[a-z]:/iu.test(value) &&
      !value.includes("\\") &&
      !value.split("/").some((part) => part === ".." || part === "." || part === ".git") &&
      !/[\0*?[\]]/u.test(value),
    "invalid_scope_path",
  );
  return value;
}

function matches(path, scope) {
  return scope.some(
    (prefix) => path === prefix || (prefix.endsWith("/") && path.startsWith(prefix)),
  );
}

function protectedPath(path) {
  return PROTECTED.some((prefix) => path === prefix || path.startsWith(prefix));
}

export function validateContract(input) {
  requireThat(object(input), "invalid_contract");
  const keys = new Set([
    "version",
    "id",
    "objective",
    "nonGoals",
    "scope",
    "protectedPaths",
    "criteria",
    "checks",
    "budget",
    "runtime",
    "regression",
  ]);
  requireThat(
    Object.keys(input).every((key) => keys.has(key)),
    "unknown_contract_field",
  );
  requireThat(input.version === VERSION && identifier(input.id), "invalid_contract_identity");
  requireThat(
    typeof input.objective === "string" &&
      input.objective.trim().length >= 10 &&
      input.objective.length <= 2000,
    "missing_objective",
  );
  requireThat(
    Array.isArray(input.nonGoals) &&
      input.nonGoals.every(
        (item) => typeof item === "string" && item.length > 0 && item.length <= 500,
      ),
    "invalid_non_goals",
  );
  for (const key of ["scope", "protectedPaths"]) {
    requireThat(Array.isArray(input[key]) && input[key].length <= 100, "invalid_scope");
    input[key].forEach(relativePath);
  }
  requireThat(input.scope.length > 0, "empty_scope");
  requireThat(object(input.criteria) && Object.keys(input.criteria).length > 0, "missing_criteria");
  requireThat(
    Object.entries(input.criteria).every(
      ([key, value]) => identifier(key) && typeof value === "string" && value.trim().length >= 5,
    ),
    "invalid_criteria",
  );
  requireThat(
    Array.isArray(input.checks) && input.checks.length > 0 && input.checks.length <= 20,
    "invalid_checks",
  );
  const checkIds = new Set();
  const covered = new Set();
  for (const check of input.checks) {
    requireThat(object(check) && identifier(check.id) && !checkIds.has(check.id), "invalid_check");
    checkIds.add(check.id);
    requireThat(
      Object.keys(check).every((key) => ["id", "argv", "timeoutSeconds", "criteria"].includes(key)),
      "unknown_check_field",
    );
    requireThat(
      Array.isArray(check.argv) &&
        check.argv.length > 0 &&
        check.argv.length <= 100 &&
        check.argv.every(
          (item) =>
            typeof item === "string" &&
            item.length > 0 &&
            item.length <= 4000 &&
            !/[\0\r\n]/u.test(item),
        ),
      "invalid_check_command",
    );
    requireThat(
      Number.isInteger(check.timeoutSeconds) &&
        check.timeoutSeconds >= 1 &&
        check.timeoutSeconds <= 900,
      "invalid_check_timeout",
    );
    requireThat(
      Array.isArray(check.criteria) &&
        check.criteria.every((id) => Object.hasOwn(input.criteria, id)),
      "invalid_check_criteria",
    );
    check.criteria.forEach((id) => covered.add(id));
  }
  requireThat(
    Object.keys(input.criteria).every((id) => covered.has(id)),
    "uncovered_criteria",
  );
  requireThat(
    object(input.budget) &&
      Object.keys(input.budget).every((key) => ["minutes", "attempts", "toolCalls"].includes(key)),
    "invalid_budget",
    "Use observable wall-time, check-attempt and tool-call budgets; model calls are not tool calls.",
  );
  for (const [key, maximum] of [
    ["minutes", 15],
    ["attempts", 10],
    ["toolCalls", 500],
  ]) {
    requireThat(
      Number.isInteger(input.budget[key]) && input.budget[key] >= 1 && input.budget[key] <= maximum,
      "invalid_budget",
    );
  }
  requireThat(typeof input.regression === "boolean", "regression_mode_required");
  if (input.runtime !== null) {
    requireThat(
      object(input.runtime) &&
        Object.keys(input.runtime).every((key) => ["url", "expected"].includes(key)),
      "invalid_runtime",
    );
    let url;
    try {
      url = new URL(input.runtime.url);
    } catch {
      throw new WorkflowError("invalid_runtime_url");
    }
    requireThat(
      url.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      "runtime_must_be_loopback",
    );
    requireThat(
      object(input.runtime.expected) &&
        ["instanceId", "dataDirId", "profileId", "revision", "sourceDigest"].every(
          (key) =>
            typeof input.runtime.expected[key] === "string" &&
            input.runtime.expected[key].length > 0,
        ) &&
        Object.keys(input.runtime.expected).every((key) =>
          ["instanceId", "dataDirId", "profileId", "revision", "sourceDigest"].includes(key),
        ),
      "runtime_identity_required",
    );
  }
  return structuredClone(input);
}

function fileDigest(root, name) {
  const path = resolve(root, name);
  if (!existsSync(path)) {
    return null;
  }
  const stat = lstatSync(path);
  requireThat(stat.isFile() && !stat.isSymbolicLink(), "unsupported_source_type", name);
  requireThat(stat.size <= 16 * MAX_BYTES, "source_file_too_large", name);
  requireThat(
    !relative(root, realpathSync(path)).startsWith(`..${sep}`),
    "source_outside_repository",
  );
  return hash(readFileSync(path));
}

export class DevelopmentWorkflow {
  constructor(
    root,
    {
      clock = Date.now,
      executor = executeCommand,
      probe = probeRuntime,
      processAlive = isProcessAlive,
    } = {},
  ) {
    this.root = realpathSync(root);
    this.clock = clock;
    this.executor = executor;
    this.probe = probe;
    this.processAlive = processAlive;
    const actual = this.git(["rev-parse", "--show-toplevel"]).trim();
    requireThat(realpathSync(actual) === this.root, "wrong_repository_root");
    this.directory = join(this.root, ".local", "dev-workflow");
    mkdirSync(this.directory, { recursive: true });
    // Bootstrap tooling must work before package installation; this private ledger has one SQL owner.
    this.db = new DatabaseSync(join(this.directory, "state.sqlite"));
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, contract TEXT NOT NULL, seal TEXT NOT NULL,
        base_head TEXT NOT NULL, baseline TEXT NOT NULL, protected TEXT NOT NULL,
        approved_at INTEGER NOT NULL, deadline INTEGER NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
        reproduced INTEGER NOT NULL DEFAULT 0, running TEXT,
        last_failure TEXT, failure_count INTEGER NOT NULL DEFAULT 0, verified_source TEXT
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, started INTEGER NOT NULL,
        finished INTEGER, phase TEXT NOT NULL, source TEXT NOT NULL, report TEXT, owner_pid INTEGER
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hook_events (
        id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, event TEXT NOT NULL,
        timestamp INTEGER NOT NULL, tool TEXT, decision TEXT NOT NULL
      );
    `);
    if (
      !this.db
        .prepare("PRAGMA table_info(runs)")
        .all()
        .some((column) => column.name === "owner_pid")
    ) {
      this.db.exec("ALTER TABLE runs ADD COLUMN owner_pid INTEGER");
    }
  }

  close() {
    this.db.close();
  }

  git(args) {
    return execFileSync("git", ["-C", this.root, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * MAX_BYTES,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
    });
  }

  head() {
    return this.git(["rev-parse", "HEAD"]).trim();
  }

  changed(base) {
    const paths = new Set(
      [
        ...this.git(["diff", "--name-only", "-z", base]).split("\0"),
        ...this.git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
      ].filter(Boolean),
    );
    return Object.fromEntries(
      [...paths]
        .toSorted((left, right) => left.localeCompare(right, "en"))
        .map((path) => [path, fileDigest(this.root, path)]),
    );
  }

  source() {
    const head = this.head();
    return digest({
      root: this.root,
      head,
      diff: this.git(["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"]),
      untracked: this.git(["ls-files", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean)
        .toSorted((left, right) => left.localeCompare(right, "en"))
        .map((path) => [path, fileDigest(this.root, path)]),
    });
  }

  activeId() {
    return this.db.prepare("SELECT value FROM settings WHERE key='active'").get()?.value ?? null;
  }

  task(id = this.activeId()) {
    const task = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id ?? "");
    requireThat(task, "task_not_approved");
    return task;
  }

  approve(input) {
    const contract = validateContract(input);
    const active = this.activeId();
    if (active) {
      requireThat(
        ["verified", "closed", "blocked"].includes(this.task(active).status),
        "task_already_active",
        "Checkpoint or finish the active task before approving another.",
      );
    }
    const protectedFiles = new Set(contract.protectedPaths);
    for (const file of this.git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean)) {
      if (protectedPath(file)) {
        protectedFiles.add(file);
      }
    }
    const protection = Object.fromEntries(
      [...protectedFiles].map((path) => [path, fileDigest(this.root, path)]),
    );
    requireThat(
      contract.protectedPaths.every((path) => protection[path] !== null),
      "acceptance_file_missing",
    );
    const head = this.head();
    const now = this.clock();
    this.db
      .prepare(`INSERT INTO tasks
      (id,contract,seal,base_head,baseline,protected,approved_at,deadline,status)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(
        contract.id,
        JSON.stringify(contract),
        digest(contract),
        head,
        JSON.stringify(this.changed(head)),
        JSON.stringify(protection),
        now,
        now + contract.budget.minutes * 60000,
        "active",
      );
    this.db
      .prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('active',?)")
      .run(contract.id);
    return this.status(contract.id);
  }

  guard(task) {
    const contract = validateContract(JSON.parse(task.contract));
    requireThat(digest(contract) === task.seal, "contract_seal_changed");
    requireThat(!["closed", "blocked"].includes(task.status), "task_blocked_or_closed");
    requireThat(this.clock() < task.deadline, "task_deadline_exceeded");
    for (const [path, expected] of Object.entries(JSON.parse(task.protected))) {
      requireThat(fileDigest(this.root, path) === expected, "protected_file_changed", path);
    }
    const baseline = JSON.parse(task.baseline);
    const changed = this.changed(task.base_head);
    for (const path of new Set([...Object.keys(baseline), ...Object.keys(changed)])) {
      const value = Object.hasOwn(changed, path) ? changed[path] : fileDigest(this.root, path);
      if (baseline[path] !== value) {
        requireThat(matches(path, contract.scope) && !protectedPath(path), "scope_drift", path);
      }
    }
    return contract;
  }

  executionContract(task) {
    const contract = this.guard(task);
    requireThat(
      ["active", "verified"].includes(task.status) && this.activeId() === task.id,
      "task_not_active_for_execution",
    );
    return contract;
  }

  status(id = this.activeId()) {
    if (!id) {
      return { status: "no_active_task" };
    }
    const task = this.task(id);
    let violation = null;
    try {
      this.guard(task);
    } catch (error) {
      if (!(error instanceof WorkflowError)) {
        throw error;
      }
      violation = error.code;
    }
    return {
      id,
      status: task.status,
      objective: JSON.parse(task.contract).objective,
      deadline: new Date(task.deadline).toISOString(),
      attempts: task.attempts,
      toolCalls: task.tool_calls,
      reproduced: Boolean(task.reproduced),
      running: task.running,
      violation,
      currentProof: task.verified_source !== null && task.verified_source === this.source(),
    };
  }

  checkpoint(id, reason) {
    requireThat(
      typeof reason === "string" && reason.trim().length >= 5,
      "checkpoint_reason_required",
    );
    const task = this.task(id);
    requireThat(!task.running, "command_still_running");
    this.db.prepare("UPDATE tasks SET status='blocked',verified_source=NULL WHERE id=?").run(id);
    return {
      ...this.status(id),
      reason,
      next: "Approve a genuinely new scoped strategy; do not reset this task.",
    };
  }

  recover(id, reason) {
    const task = this.task(id);
    if (!task.running) {
      return this.checkpoint(id, reason);
    }
    requireThat(
      typeof reason === "string" && reason.trim().length >= 5,
      "checkpoint_reason_required",
    );
    const run = this.db
      .prepare("SELECT * FROM runs WHERE id=? AND task_id=?")
      .get(task.running, id);
    requireThat(
      run && Number.isInteger(run.owner_pid) && run.owner_pid > 0,
      "run_owner_unverified",
    );
    requireThat(!this.processAlive(run.owner_pid), "command_still_running");
    const report = {
      version: VERSION,
      task: id,
      runId: run.id,
      source: run.source,
      phase: run.phase,
      status: "interrupted",
      error: "run_owner_exited",
      reason,
      finishedAt: new Date(this.clock()).toISOString(),
      reassessmentRequired: true,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(`UPDATE tasks SET running=NULL,status='blocked',
        verified_source=NULL WHERE id=? AND running=?`)
        .run(id, run.id);
      requireThat(result.changes === 1, "run_owner_changed");
      this.db
        .prepare("UPDATE runs SET finished=?,report=? WHERE id=?")
        .run(this.clock(), JSON.stringify(report), run.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return report;
  }

  async run(id, phase = "verify") {
    requireThat(["reproduce", "verify"].includes(phase), "invalid_phase");
    let task = this.task(id);
    const contract = this.executionContract(task);
    requireThat(!task.running, "run_in_progress");
    requireThat(task.attempts < contract.budget.attempts, "attempt_budget_exhausted");
    requireThat(
      phase === "reproduce" || !contract.regression || task.reproduced,
      "original_failure_not_reproduced",
    );
    const source = this.source();
    const runId = randomUUID();
    const now = this.clock();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const claimed = this.db
        .prepare(`UPDATE tasks SET running=?,attempts=attempts+1,
        status='active',verified_source=NULL WHERE id=? AND running IS NULL
        AND status IN ('active','verified')
        AND id=(SELECT value FROM settings WHERE key='active')`)
        .run(runId, id);
      requireThat(claimed.changes === 1, "run_in_progress");
      this.db
        .prepare(`INSERT INTO runs(id,task_id,started,phase,source,owner_pid) VALUES(?,?,?,?,?,?)`)
        .run(runId, id, now, phase, source, process.pid);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const directory = join(this.directory, "runs", runId);
    mkdirSync(directory, { recursive: true });
    const report = {
      version: VERSION,
      task: id,
      runId,
      phase,
      contractDigest: task.seal,
      commit: this.head(),
      source,
      repository: hash(this.root),
      startedAt: new Date(now).toISOString(),
      status: "failed",
      checks: [],
      runtime: null,
      error: null,
    };
    try {
      if (contract.runtime) {
        report.runtime = await this.probe(contract.runtime, this.head(), source);
      }
      for (const check of contract.checks) {
        if (phase === "reproduce" && check.criteria.length === 0) {
          continue;
        }
        task = this.task(id);
        this.guard(task);
        const evidencePath = join(directory, `${check.id}.json`);
        const result = await this.executor({
          argv: check.argv,
          cwd: this.root,
          timeoutMs: Math.min(check.timeoutSeconds * 1000, task.deadline - this.clock()),
          environment: {
            OPENCLAW_DEV_EVIDENCE: evidencePath,
            OPENCLAW_DEV_RUN_ID: runId,
            OPENCLAW_DEV_SOURCE: source,
            OPENCLAW_DEV_HEAD: report.commit,
            OPENCLAW_DEV_TASK: id,
            ...(contract.runtime ? { OPENCLAW_DEV_RUNTIME_URL: contract.runtime.url } : {}),
          },
        });
        let evidence = null;
        if (check.criteria.length > 0 && existsSync(evidencePath)) {
          requireThat(
            lstatSync(evidencePath).isFile() &&
              !lstatSync(evidencePath).isSymbolicLink() &&
              lstatSync(evidencePath).size <= MAX_BYTES,
            "invalid_evidence_file",
          );
          evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
          requireThat(
            object(evidence) &&
              evidence.version === VERSION &&
              evidence.runId === runId &&
              evidence.source === source &&
              object(evidence.criteria) &&
              Object.keys(evidence.criteria).length === check.criteria.length &&
              check.criteria.every(
                (criterion) => typeof evidence.criteria[criterion] === "boolean",
              ),
            "invalid_acceptance_evidence",
          );
        }
        report.checks.push({
          id: check.id,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          outputDigest: result.outputDigest,
          durationMs: result.durationMs,
          criteria: evidence?.criteria ?? null,
          passed:
            result.exitCode === 0 &&
            !result.timedOut &&
            (check.criteria.length === 0 ||
              (evidence !== null && Object.values(evidence.criteria).every(Boolean))),
        });
        if (result.timedOut) {
          break;
        }
      }
      this.guard(this.task(id));
      requireThat(this.source() === source, "source_changed_during_validation");
      if (contract.runtime) {
        const after = await this.probe(contract.runtime, this.head(), source);
        requireThat(digest(after) === digest(report.runtime), "runtime_changed_during_validation");
      }
      if (phase === "reproduce") {
        requireThat(
          report.checks.some(
            (check) =>
              check.exitCode !== 0 &&
              check.criteria &&
              Object.values(check.criteria).some((value) => value === false),
          ),
          "original_failure_not_reproduced",
        );
        report.status = "reproduced";
      } else {
        requireThat(
          report.checks.length === contract.checks.length &&
            report.checks.every((check) => check.passed),
          "required_checks_failed",
        );
        report.status = "passed";
      }
    } catch (error) {
      report.error =
        error instanceof WorkflowError ? error.code : "validation_infrastructure_error";
      report.errorType = error instanceof Error ? error.name : "UnknownError";
    } finally {
      report.finishedAt = new Date(this.clock()).toISOString();
      const success = ["passed", "reproduced"].includes(report.status);
      const failure = success
        ? null
        : digest({
            error: report.error,
            checks: report.checks
              .filter((check) => !check.passed)
              .map((check) => [check.id, check.exitCode, check.timedOut, check.criteria]),
          });
      const previous = this.task(id);
      const repeated = failure
        ? previous.last_failure === failure
          ? previous.failure_count + 1
          : 1
        : 0;
      const blocked = repeated >= 2 || this.clock() >= previous.deadline;
      this.db
        .prepare(`UPDATE tasks SET running=NULL,status=?,last_failure=?,failure_count=?,
        reproduced=?,verified_source=? WHERE id=?`)
        .run(
          blocked ? "blocked" : report.status === "passed" ? "verified" : "active",
          failure,
          repeated,
          report.status === "reproduced" ? 1 : previous.reproduced,
          report.status === "passed" ? source : null,
          id,
        );
      report.reassessmentRequired = blocked;
      this.db
        .prepare("UPDATE runs SET finished=?,report=? WHERE id=?")
        .run(this.clock(), JSON.stringify(report), runId);
      writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
    }
    return report;
  }

  finish(
    id = this.activeId() ??
      this.db.prepare("SELECT value FROM settings WHERE key='last_finished'").get()?.value,
  ) {
    const task = this.task(id);
    this.guard(task);
    requireThat(
      ["verified", "completed"].includes(task.status) &&
        !task.running &&
        task.verified_source === this.source(),
      "current_acceptance_proof_required",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(id);
      this.db.prepare("DELETE FROM settings WHERE key='active' AND value=?").run(id);
      this.db
        .prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('last_finished',?)")
        .run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      status: "verified",
      task: id,
      commit: this.head(),
      source: task.verified_source,
      validationScope: JSON.parse(task.contract).runtime ? "runtime_bound" : "source_checks_only",
    };
  }

  recordHook(sessionId, event, tool, decision) {
    this.db
      .prepare(`INSERT INTO hook_events(session_id,event,timestamp,tool,decision)
      VALUES(?,?,?,?,?)`)
      .run(sessionId, event, this.clock(), tool, decision);
  }

  hook(event, payload) {
    requireThat(object(payload), "invalid_hook_payload");
    const sessionId = String(payload.sessionId ?? payload.session_id ?? "unspecified");
    const tool = String(payload.toolName ?? payload.tool_name ?? "");
    let input = payload.toolArgs ?? payload.tool_input ?? {};
    if (typeof input === "string") {
      if (tool.endsWith("apply_patch") && input.trimStart().startsWith("*** Begin Patch")) {
        input = { input };
      } else {
        try {
          input = JSON.parse(input);
        } catch {
          this.recordHook(sessionId, event, tool, "deny");
          return {
            permissionDecision: "deny",
            permissionDecisionReason: "invalid_hook_tool_arguments",
          };
        }
      }
    }
    requireThat(object(input), "invalid_hook_tool_arguments");
    if (event === "sessionStart") {
      this.recordHook(sessionId, event, null, "loaded");
      return {
        additionalContext:
          "Development workflow gates loaded. Approve a scoped task before edits; use its frozen checks. Status is not proof.",
      };
    }
    if (event === "postToolUse") {
      this.recordHook(sessionId, event, tool, "observed");
      return {};
    }
    const id = this.activeId();
    const command = typeof input.command === "string" ? input.command.trim() : "";
    const runner =
      /^(?:node(?:\.exe)?\s+)(?:\.\/|\.\\)?scripts[\\/]dev-workflow\.mjs\s+(status|run|finish|checkpoint|doctor)\b/u.test(
        command,
      ) && !/[;&|><\r\n`$()%{}]/u.test(command);
    const readOnly =
      /(?:^|[_.-])(view|read|search|glob|grep)(?:$|[_.-])/iu.test(tool) ||
      (/^(?:git\s+(?:--no-pager\s+)?)(?:status|diff|log|show)\b[^;&|><\r\n`$()%{}]*$/u.test(
        command,
      ) &&
        !/--(?:output|ext-diff|textconv|exec-path|no-index|open-files-in-pager)\b/u.test(command));
    try {
      if (payload.cwd) {
        const location = realpathSync(payload.cwd);
        const within = relative(this.root, location);
        requireThat(
          location === this.root ||
            (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`)),
          "wrong_hook_workspace",
        );
      }
      if (event === "agentStop") {
        if (!id) {
          this.recordHook(sessionId, event, null, "read_only_session");
          return {};
        }
        const task = this.task(id);
        if (task.status === "blocked") {
          this.recordHook(sessionId, event, null, "checkpoint");
          return {
            additionalContext:
              "Task is blocked, not complete. Report the failure and next decision; do not claim success.",
          };
        }
        this.finish(id);
        this.recordHook(sessionId, event, null, "verified");
        return {};
      }
      requireThat(event === "preToolUse", "unsupported_hook_event");
      const diagnostic = runner && /\s(?:status|doctor|checkpoint)\b/u.test(command);
      if (id && !diagnostic) {
        const task = this.task(id);
        requireThat(this.clock() < task.deadline, "task_deadline_exceeded");
        requireThat(!["blocked", "closed"].includes(task.status), "task_blocked_or_closed");
        requireThat(
          task.tool_calls < JSON.parse(task.contract).budget.toolCalls,
          "tool_budget_exhausted",
        );
        this.db.prepare("UPDATE tasks SET tool_calls=tool_calls+1 WHERE id=?").run(id);
      }
      const verifier =
        /(?:^|[_.-])(?:task|agent)$/u.test(tool) &&
        (input.agent_type ?? input.agentName) === "development-verifier";
      if (readOnly || runner || verifier) {
        if (verifier) {
          this.guard(this.task(id));
        }
        this.recordHook(sessionId, event, tool, "allow");
        return {
          permissionDecision: "allow",
          permissionDecisionReason: "Read-only inspection or the bounded workflow owner.",
        };
      }
      const task = this.task(id);
      const contract = this.guard(task);
      requireThat(task.tool_calls < contract.budget.toolCalls, "tool_budget_exhausted");
      requireThat(!task.running, "validation_in_progress");
      const edit = /(?:edit|write|create|apply_patch)/iu.test(tool);
      requireThat(
        edit && !command,
        "unapproved_execution",
        "Run frozen commands through the workflow runner; arbitrary shell/delegation is not authorized.",
      );
      let paths = [input.path, input.file_path, input.filePath].filter(
        (path) => typeof path === "string",
      );
      const patch = input.patch ?? input.input;
      if (typeof patch === "string") {
        paths = [
          ...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gmu),
        ].map((match) => match[1]);
      }
      requireThat(paths.length > 0, "unrecognized_edit_payload");
      for (const path of paths) {
        const normalized = relative(this.root, resolve(this.root, path)).split(sep).join("/");
        relativePath(normalized);
        requireThat(
          matches(normalized, contract.scope) &&
            !protectedPath(normalized) &&
            !Object.hasOwn(JSON.parse(task.protected), normalized),
          "edit_outside_approved_scope",
        );
      }
      this.db.prepare("UPDATE tasks SET verified_source=NULL,status='active' WHERE id=?").run(id);
      this.recordHook(sessionId, event, tool, "allow");
      return {
        permissionDecision: "allow",
        permissionDecisionReason: "Within the frozen task scope.",
      };
    } catch (error) {
      const reason = error instanceof WorkflowError ? error.code : "hook_validation_failed";
      this.recordHook(sessionId, event, tool, "deny");
      return event === "agentStop"
        ? {
            decision: "block",
            reason: `Not complete: ${reason}. Run the required checks or checkpoint as blocked.`,
          }
        : { permissionDecision: "deny", permissionDecisionReason: reason };
    }
  }
}

export async function probeRuntime(runtime, head, source) {
  const response = await fetch(runtime.url, {
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  });
  requireThat(response.ok, "runtime_identity_unavailable");
  let text = "";
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += new TextDecoder().decode(value);
      requireThat(text.length <= 8192, "runtime_identity_too_large");
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const body = JSON.parse(text);
  const expected = { ...runtime.expected };
  if (expected.revision === "$HEAD") {
    expected.revision = head;
  }
  if (expected.sourceDigest === "$SOURCE") {
    expected.sourceDigest = source;
  }
  requireThat(
    expected.revision === head && expected.sourceDigest === source,
    "wrong_runtime_instance",
  );
  requireThat(
    object(body) && Object.entries(expected).every(([key, value]) => body[key] === value),
    "wrong_runtime_instance",
  );
  return { url: runtime.url, ...expected };
}

export async function executeCommand({ argv, cwd, timeoutMs, environment, observeOutput, signal }) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|CI)$/iu.test(
        key,
      ),
    ),
  );
  const command = argv[0] === "node" ? process.execPath : argv[0];
  const started = Date.now();
  const output = createHash("sha256");
  let timedOut = false;
  let cancelled = false;
  let stopping = false;
  let total = 0;
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, argv.slice(1), {
      cwd,
      env: { ...env, ...environment },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stop = () => {
      if (!stopping) {
        stopping = true;
        void terminateOwnedProcessTree(child).catch(reject);
      }
    };
    const abort = () => {
      cancelled = true;
      stop();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      Math.max(1, timeoutMs),
    );
    const collect = (chunk) => {
      total += chunk.length;
      output.update(chunk);
      observeOutput?.(chunk);
      if (total > 4 * MAX_BYTES) {
        timedOut = true;
        stop();
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error instanceof Error ? error : new WorkflowError("command_start_failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolveResult({
        exitCode: code,
        timedOut,
        cancelled,
        outputDigest: output.digest("hex"),
        durationMs: Date.now() - started,
      });
    });
  });
}

export async function superviseAgent(workflow, id, argv, { signal, observeOutput } = {}) {
  const task = workflow.task(id);
  workflow.executionContract(task);
  const result = await executeCommand({
    argv,
    cwd: workflow.root,
    timeoutMs: task.deadline - workflow.clock(),
    environment: {},
    signal,
    observeOutput,
  });
  if (result.timedOut || result.cancelled || result.exitCode !== 0) {
    const recovery = workflow.recover(
      id,
      "The supervised coding agent stopped or exceeded its time budget.",
    );
    return { status: "failed", task: id, execution: result, recovery };
  }
  return { ...workflow.finish(id), execution: result };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    throw new WorkflowError("run_owner_unverified");
  }
}

export async function terminateOwnedProcessTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    const script = `
      $ErrorActionPreference = 'Stop'
      function Stop-OwnedTree([int] $owner) {
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$owner")
        foreach ($item in $children) { Stop-OwnedTree ([int]$item.ProcessId) }
        if (Get-Process -Id $owner -ErrorAction SilentlyContinue) {
          Stop-Process -Id $owner -Force -ErrorAction Stop
        }
      }
      Stop-OwnedTree ${child.pid}
    `;
    await new Promise((resolveStop, reject) => {
      const stop = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: "ignore",
        windowsHide: true,
      });
      stop.once("error", reject);
      stop.once("exit", (code) =>
        code === 0 ? resolveStop() : reject(new WorkflowError("owned_process_cleanup_failed")),
      );
    });
    return;
  }
  const rows = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).map(Number));
  const owned = [];
  const visit = (pid) => {
    for (const [id, parent] of rows) {
      if (parent === pid) {
        visit(id);
      }
    }
    owned.push(pid);
  };
  visit(child.pid);
  for (const pid of owned) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
}

export function writeAcceptance(criteria) {
  requireThat(
    object(criteria) && Object.values(criteria).every((value) => typeof value === "boolean"),
    "invalid_criterion_results",
  );
  requireThat(
    process.env.OPENCLAW_DEV_EVIDENCE &&
      process.env.OPENCLAW_DEV_RUN_ID &&
      process.env.OPENCLAW_DEV_SOURCE,
    "runner_environment_required",
  );
  writeFileSync(
    process.env.OPENCLAW_DEV_EVIDENCE,
    JSON.stringify({
      version: VERSION,
      runId: process.env.OPENCLAW_DEV_RUN_ID,
      source: process.env.OPENCLAW_DEV_SOURCE,
      criteria,
    }) + "\n",
    { flag: "wx" },
  );
}

async function stdin() {
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    requireThat(value.length <= MAX_BYTES, "hook_input_too_large");
  }
  return JSON.parse(value || "{}");
}

export async function cli(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const root = process.env.OPENCLAW_DEV_ROOT || process.cwd();
  const workflow = new DevelopmentWorkflow(root);
  try {
    if (command === "approve") {
      requireThat(rest.length === 1, "usage", "approve <contract.json> (operator only)");
      return workflow.approve(JSON.parse(readFileSync(resolve(root, rest[0]), "utf8")));
    }
    if (command === "run") {
      return await workflow.run(rest[0] ?? workflow.activeId(), rest[1] ?? "verify");
    }
    if (command === "agent") {
      const id = rest[0];
      requireThat(
        rest[1] === "--" && rest.length >= 3,
        "usage",
        "agent <task-id> -- <coding-agent executable> [arguments]",
      );
      const controller = new AbortController();
      const abort = () => controller.abort();
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      try {
        return await superviseAgent(workflow, id, rest.slice(2), { signal: controller.signal });
      } finally {
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
      }
    }
    if (command === "status") {
      return workflow.status(rest[0]);
    }
    if (command === "finish") {
      return workflow.finish(rest[0]);
    }
    if (command === "checkpoint") {
      return workflow.checkpoint(rest[0] ?? workflow.activeId(), rest.slice(1).join(" "));
    }
    if (command === "recover") {
      return workflow.recover(rest[0] ?? workflow.activeId(), rest.slice(1).join(" "));
    }
    if (command === "hook") {
      return workflow.hook(rest[0], await stdin());
    }
    if (command === "doctor") {
      return {
        node: process.version,
        repository: hash(workflow.root),
        source: workflow.source(),
        activeTask: workflow.activeId(),
        hookEvents: workflow.db
          .prepare("SELECT event,COUNT(*) AS count FROM hook_events GROUP BY event")
          .all(),
        limitation: "Hook adapter tests are not proof that the active IDE/CLI discovers the hooks.",
        modelCallAccounting:
          "Unavailable in these tool lifecycle hooks; model-call limits are rejected rather than silently ignored.",
      };
    }
    throw new WorkflowError(
      "usage",
      "Commands: approve, run [id] [reproduce|verify], status, finish, checkpoint, recover, agent, hook, doctor",
    );
  } finally {
    workflow.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  try {
    const result = await cli();
    console.log(JSON.stringify(result, null, 2));
    if (result?.status === "failed") {
      process.exitCode = 1;
    }
  } catch (error) {
    const hook = process.argv[2] === "hook";
    const code = error instanceof WorkflowError ? error.code : "workflow_infrastructure_error";
    console.log(
      JSON.stringify(
        hook
          ? {
              permissionDecision: "deny",
              permissionDecisionReason: code,
              decision: "block",
              reason: code,
            }
          : {
              status: "blocked",
              error: code,
              errorType: error instanceof Error ? error.name : "UnknownError",
            },
      ),
    );
    process.exitCode = hook ? 0 : 1;
  }
}
