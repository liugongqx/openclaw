import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { protectedPolicyChanges } from "./dev-workflow-policy.mjs";
import {
  DevelopmentWorkflow,
  WorkflowError,
  executeCommand,
  probeRuntime,
  superviseAgent,
  terminateOwnedProcessTree,
  validateContract,
} from "./dev-workflow.mjs";

let root;
let now = Date.parse("2030-01-01T00:00:00Z");
let fixtureNumber = 0;
before(() => {
  // openclaw-temp-dir: allow this bootstrap suite verifies real Git and isolated SQLite ownership.
  root = mkdtempSync(join(tmpdir(), "openclaw-dev-workflow-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

function fixture(options = {}) {
  const directory = join(root, String(++fixtureNumber));
  mkdirSync(join(directory, "src"), { recursive: true });
  mkdirSync(join(directory, "acceptance"), { recursive: true });
  writeFileSync(join(directory, ".gitignore"), ".local/\n");
  writeFileSync(join(directory, ".gitattributes"), "* -text\n");
  writeFileSync(join(directory, "src", "app.mjs"), "export const correct = false;\n");
  writeFileSync(join(directory, "acceptance", "check.mjs"), "// immutable test\n");
  execFileSync("git", ["init", "--quiet", directory]);
  execFileSync("git", ["-C", directory, "add", "."]);
  execFileSync("git", [
    "-C",
    directory,
    "-c",
    "user.name=Workflow Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const workflow = new DevelopmentWorkflow(directory, { clock: () => now, ...options });
  const contract = {
    version: 1,
    id: "fix-login",
    objective: "Reach the actual rendered login form.",
    nonGoals: ["Never submit credentials."],
    scope: ["src/"],
    protectedPaths: ["acceptance/check.mjs"],
    criteria: { "login-form": "A real form is visible." },
    checks: [
      {
        id: "acceptance",
        argv: ["node", "acceptance/check.mjs"],
        timeoutSeconds: 10,
        criteria: ["login-form"],
      },
    ],
    budget: { minutes: 15, attempts: 5, toolCalls: 10 },
    runtime: null,
    regression: true,
  };
  return { directory, workflow, contract };
}

function evidenceExecutor(passed, changes) {
  return async (request) => {
    changes?.(request);
    writeFileSync(
      request.environment.OPENCLAW_DEV_EVIDENCE,
      JSON.stringify({
        version: 1,
        runId: request.environment.OPENCLAW_DEV_RUN_ID,
        source: request.environment.OPENCLAW_DEV_SOURCE,
        criteria: { "login-form": passed },
      }),
    );
    return { exitCode: passed ? 0 : 1, timedOut: false, outputDigest: "test", durationMs: 1 };
  };
}

test("a real subdirectory is not admitted as the repository root", () => {
  const { workflow, directory } = fixture();
  workflow.close();
  assert.throws(
    () => new DevelopmentWorkflow(join(directory, "src")),
    errorCode("wrong_repository_root"),
  );
});

test("an approved checkout alias admits its own file paths but not a symlink escape", () => {
  const { workflow, directory, contract } = fixture();
  workflow.close();
  const alias = join(root, `alias-${fixtureNumber}`);
  symlinkSync(directory, alias, "junction");
  const same = new DevelopmentWorkflow(alias);
  try {
    same.approve(contract);
    assert.equal(
      same.hook("preToolUse", {
        toolName: "edit",
        toolArgs: { path: join(alias, "src", "app.mjs") },
      }).permissionDecision,
      "allow",
    );
    const outside = join(root, `outside-${fixtureNumber}`);
    mkdirSync(outside);
    symlinkSync(outside, join(directory, "src", "escape"), "junction");
    assert.equal(
      same.hook("preToolUse", {
        toolName: "edit",
        toolArgs: { path: join(alias, "src", "escape", "new.mjs") },
      }).permissionDecision,
      "deny",
    );
  } finally {
    same.close();
  }
});

function errorCode(code) {
  return (error) => error instanceof WorkflowError && error.code === code;
}

test(
  "Windows drive-letter casing does not create a different repository identity",
  { skip: process.platform !== "win32" },
  () => {
    const { workflow, directory } = fixture();
    const source = workflow.source();
    workflow.close();
    const lowerDrive = directory.replace(/^[A-Z]:/u, (drive) => drive.toLowerCase());
    const same = new DevelopmentWorkflow(lowerDrive);
    try {
      assert.equal(same.head().length, 40);
      assert.equal(same.source(), source);
    } finally {
      same.close();
    }
  },
);

test("a real failing acceptance criterion is required before claiming a regression fix", async () => {
  const { workflow, contract } = fixture({ executor: evidenceExecutor(false) });
  try {
    workflow.approve(contract);
    await assert.rejects(workflow.run(contract.id), errorCode("original_failure_not_reproduced"));
    const red = await workflow.run(contract.id, "reproduce");
    assert.equal(red.status, "reproduced");
    assert.equal(workflow.status().reproduced, true);
    assert.throws(() => workflow.finish(), errorCode("current_acceptance_proof_required"));
    workflow.executor = evidenceExecutor(true);
    const green = await workflow.run(contract.id);
    assert.equal(green.status, "passed");
    assert.equal(workflow.finish().status, "verified");
  } finally {
    workflow.close();
  }
});

test("a check exiting zero without the required evidence is not success", async () => {
  const { workflow, contract } = fixture({
    executor: async () => ({ exitCode: 0, timedOut: false, outputDigest: "empty", durationMs: 1 }),
  });
  try {
    workflow.approve({ ...contract, regression: false });
    assert.equal((await workflow.run(contract.id)).status, "failed");
    assert.throws(() => workflow.finish(), errorCode("current_acceptance_proof_required"));
  } finally {
    workflow.close();
  }
});

test("an infrastructure error is not the original regression", async () => {
  const { workflow, contract } = fixture({
    executor: async () => {
      throw new Error("missing executable");
    },
  });
  try {
    workflow.approve(contract);
    const result = await workflow.run(contract.id, "reproduce");
    assert.equal(result.status, "failed");
    assert.equal(result.error, "validation_infrastructure_error");
    assert.equal(workflow.status().reproduced, false);
  } finally {
    workflow.close();
  }
});

test("changing source invalidates proof even when the Git commit did not change", async () => {
  const { workflow, contract, directory } = fixture({ executor: evidenceExecutor(true) });
  try {
    workflow.approve({ ...contract, regression: false });
    assert.equal((await workflow.run(contract.id)).status, "passed");
    writeFileSync(join(directory, "src", "app.mjs"), "export const changed = true;\n");
    assert.equal(workflow.status().currentProof, false);
    assert.throws(() => workflow.finish(), errorCode("current_acceptance_proof_required"));
  } finally {
    workflow.close();
  }
});

test("changes made by a check invalidate that check's own proof", async () => {
  const { workflow, contract, directory } = fixture();
  try {
    workflow.executor = evidenceExecutor(true, () =>
      writeFileSync(join(directory, "src", "app.mjs"), "export const changed = true;\n"),
    );
    workflow.approve({ ...contract, regression: false });
    const result = await workflow.run(contract.id);
    assert.equal(result.status, "failed");
    assert.equal(result.error, "source_changed_during_validation");
  } finally {
    workflow.close();
  }
});

test("out-of-scope files are blocked, including untracked files", async () => {
  const { workflow, contract, directory } = fixture({ executor: evidenceExecutor(true) });
  try {
    workflow.approve({ ...contract, regression: false });
    writeFileSync(join(directory, "surprise.mjs"), "export const newOwner = true;\n");
    await assert.rejects(workflow.run(contract.id), errorCode("scope_drift"));
  } finally {
    workflow.close();
  }
});

test("pre-existing unrelated work is preserved but cannot be changed", async () => {
  const { workflow, contract, directory } = fixture({ executor: evidenceExecutor(true) });
  try {
    writeFileSync(join(directory, "personal-note.txt"), "leave unchanged\n");
    workflow.approve({ ...contract, regression: false });
    assert.equal((await workflow.run(contract.id)).status, "passed");
    writeFileSync(join(directory, "personal-note.txt"), "changed\n");
    await assert.rejects(workflow.run(contract.id), errorCode("scope_drift"));
  } finally {
    workflow.close();
  }
});

test("deleting or reverting pre-existing unrelated changes cannot escape the scope gate", () => {
  const { workflow, contract, directory } = fixture();
  try {
    writeFileSync(join(directory, "unrelated.txt"), "pre-existing user note");
    writeFileSync(join(directory, "acceptance", "check.mjs"), "// user's existing edits\n");
    workflow.approve({ ...contract, protectedPaths: [] });
    rmSync(join(directory, "unrelated.txt"));
    assert.throws(() => workflow.guard(workflow.task()), errorCode("scope_drift"));
    writeFileSync(join(directory, "unrelated.txt"), "pre-existing user note");
    writeFileSync(join(directory, "acceptance", "check.mjs"), "// immutable test\n");
    assert.throws(() => workflow.guard(workflow.task()), errorCode("scope_drift"));
  } finally {
    workflow.close();
  }
});

test("frozen acceptance files cannot be weakened after approval", async () => {
  const { workflow, contract, directory } = fixture({ executor: evidenceExecutor(true) });
  try {
    workflow.approve({ ...contract, regression: false, scope: ["src/", "acceptance/"] });
    writeFileSync(join(directory, "acceptance", "check.mjs"), "// assert true\n");
    await assert.rejects(workflow.run(contract.id), errorCode("protected_file_changed"));
  } finally {
    workflow.close();
  }
});

test("two identical failures require reassessment, not another automatic attempt", async () => {
  const { workflow, contract } = fixture({ executor: evidenceExecutor(false) });
  try {
    workflow.approve({ ...contract, regression: false });
    assert.equal((await workflow.run(contract.id)).reassessmentRequired, false);
    assert.equal((await workflow.run(contract.id)).reassessmentRequired, true);
    assert.equal(workflow.status().status, "blocked");
    await assert.rejects(workflow.run(contract.id), errorCode("task_blocked_or_closed"));
  } finally {
    workflow.close();
  }
});

test("elapsed time includes pauses and reopening the ledger", async () => {
  const { workflow, contract, directory } = fixture();
  workflow.approve(contract);
  workflow.close();
  now += 15 * 60000;
  const resumed = new DevelopmentWorkflow(directory, { clock: () => now });
  try {
    assert.equal(resumed.status().violation, "task_deadline_exceeded");
    await assert.rejects(resumed.run(contract.id), errorCode("task_deadline_exceeded"));
  } finally {
    resumed.close();
  }
});

test("simultaneous check owners cannot both dispatch", async () => {
  let release;
  const entered = new Promise((resolveEntered) => {
    release = resolveEntered;
  });
  let continueExecution;
  const hold = new Promise((resolveHold) => {
    continueExecution = resolveHold;
  });
  const { workflow, contract } = fixture({
    executor: async (request) => {
      release();
      await hold;
      return evidenceExecutor(true)(request);
    },
  });
  try {
    workflow.approve({ ...contract, regression: false });
    const running = workflow.run(contract.id);
    await entered;
    await assert.rejects(workflow.run(contract.id), errorCode("run_in_progress"));
    continueExecution();
    assert.equal((await running).status, "passed");
  } finally {
    workflow.close();
  }
});

test("the acceptance report is bound to its run and source bytes", async () => {
  const { workflow, contract } = fixture({
    executor: async (request) => {
      writeFileSync(
        request.environment.OPENCLAW_DEV_EVIDENCE,
        JSON.stringify({
          version: 1,
          runId: "another-run",
          source: request.environment.OPENCLAW_DEV_SOURCE,
          criteria: { "login-form": true },
        }),
      );
      return { exitCode: 0, timedOut: false, outputDigest: "forged", durationMs: 1 };
    },
  });
  try {
    workflow.approve({ ...contract, regression: false });
    const result = await workflow.run(contract.id);
    assert.equal(result.error, "invalid_acceptance_evidence");
  } finally {
    workflow.close();
  }
});

test("wrong runtime identity stops before any test or model command", async () => {
  let called = false;
  const { workflow, contract } = fixture({
    probe: async () => {
      throw new WorkflowError("wrong_runtime_instance");
    },
    executor: async () => {
      called = true;
    },
  });
  try {
    workflow.approve({
      ...contract,
      regression: false,
      runtime: {
        url: "http://127.0.0.1:8876/identity",
        expected: {
          instanceId: "expected",
          dataDirId: "expected",
          profileId: "test",
          revision: "$HEAD",
          sourceDigest: "$SOURCE",
        },
      },
    });
    assert.equal((await workflow.run(contract.id)).error, "wrong_runtime_instance");
    assert.equal(called, false);
  } finally {
    workflow.close();
  }
});

test("runtime identity is checked again after validation", async () => {
  let calls = 0;
  const { workflow, contract } = fixture({
    probe: async () => ({ instanceId: String(++calls) }),
    executor: evidenceExecutor(true),
  });
  try {
    workflow.approve({
      ...contract,
      regression: false,
      runtime: {
        url: "http://127.0.0.1:8876/identity",
        expected: {
          instanceId: "expected",
          dataDirId: "expected",
          profileId: "test",
          revision: "$HEAD",
          sourceDigest: "$SOURCE",
        },
      },
    });
    assert.equal((await workflow.run(contract.id)).error, "runtime_changed_during_validation");
  } finally {
    workflow.close();
  }
});

test("the HTTP boundary verifies an actual response, not its successful status alone", async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        instanceId: "real-instance",
        dataDirId: "directory-hash",
        profileId: "isolated",
        revision: "abc",
        sourceDigest: "source",
      }),
    );
  });
  await new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const runtime = {
      url: `http://127.0.0.1:${server.address().port}/identity`,
      expected: {
        instanceId: "real-instance",
        dataDirId: "directory-hash",
        profileId: "isolated",
        revision: "$HEAD",
        sourceDigest: "$SOURCE",
      },
    };
    assert.equal((await probeRuntime(runtime, "abc", "source")).revision, "abc");
    await assert.rejects(
      probeRuntime(runtime, "stale-build", "source"),
      errorCode("wrong_runtime_instance"),
    );
    await assert.rejects(
      probeRuntime(runtime, "abc", "dirty-source"),
      errorCode("wrong_runtime_instance"),
    );
    await assert.rejects(
      probeRuntime(
        { ...runtime, expected: { ...runtime.expected, revision: "abc", sourceDigest: "source" } },
        "candidate-revision",
        "candidate-source",
      ),
      errorCode("wrong_runtime_instance"),
    );
  } finally {
    await new Promise((resolveClose) => {
      server.close(resolveClose);
    });
  }
});

test("the real process runner produces an exit receipt without forwarding unrelated secrets", async () => {
  process.env.DEV_WORKFLOW_TEST_SECRET = "never-forward";
  try {
    const result = await executeCommand({
      argv: ["node", "-e", "process.exit(process.env.DEV_WORKFLOW_TEST_SECRET ? 42 : 0)"],
      cwd: root,
      timeoutMs: 5000,
      environment: {},
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.outputDigest.length, 64);
  } finally {
    delete process.env.DEV_WORKFLOW_TEST_SECRET;
  }
});

test("hooks block premature completion and unapproved shell execution", async () => {
  const { workflow, contract } = fixture({ executor: evidenceExecutor(true) });
  try {
    assert.equal(
      workflow.hook("sessionStart", { sessionId: "probe" }).additionalContext.length > 0,
      true,
    );
    assert.equal(
      workflow.hook("preToolUse", {
        toolName: "powershell",
        toolArgs: { command: "node -e process.exit(0)" },
      }).permissionDecision,
      "deny",
    );
    workflow.approve({ ...contract, regression: false });
    assert.equal(workflow.hook("agentStop", {}).decision, "block");
    assert.equal(
      workflow.hook("preToolUse", {
        toolName: "edit",
        toolArgs: { path: "src/app.mjs" },
      }).permissionDecision,
      "allow",
    );
    assert.equal(
      workflow.hook("preToolUse", {
        toolName: "edit",
        toolArgs: { path: "acceptance/check.mjs" },
      }).permissionDecision,
      "deny",
    );
    assert.equal(
      workflow.hook("preToolUse", {
        toolName: "powershell",
        toolArgs: { command: "git push origin main" },
      }).permissionDecision,
      "deny",
    );
    await workflow.run(contract.id);
    assert.deepEqual(workflow.hook("agentStop", {}), {});
  } finally {
    workflow.close();
  }
});

test("hook patch validation includes renamed destinations and Windows absolute paths", () => {
  const { workflow, contract, directory } = fixture();
  try {
    workflow.approve(contract);
    assert.equal(
      workflow.hook("preToolUse", {
        toolName: "apply_patch",
        toolArgs: {
          input: `*** Update File: ${join(directory, "src", "app.mjs")}\n@@\n-old\n+new`,
        },
      }).permissionDecision,
      "allow",
    );
    assert.equal(
      workflow.hook("preToolUse", {
        toolName: "apply_patch",
        toolArgs: { input: "*** Update File: src/app.mjs\n*** Move to: acceptance/check.mjs\n" },
      }).permissionDecision,
      "deny",
    );
    assert.equal(
      workflow.hook("preToolUse", {
        toolName: "apply_patch",
        toolArgs: "*** Begin Patch\n*** Add File: forbidden.txt\n+SYNTHETIC\n*** End Patch\n",
      }).permissionDecisionReason,
      "edit_outside_approved_scope",
    );
  } finally {
    workflow.close();
  }
});

test("blocked checkpoints end honestly without demanding an impossible successful retry", () => {
  const { workflow, contract } = fixture();
  try {
    workflow.approve(contract);
    assert.equal(
      workflow.checkpoint(contract.id, "Provider requires manual authentication.").status,
      "blocked",
    );
    const stop = workflow.hook("agentStop", {});
    assert.equal(stop.decision, undefined);
    assert.match(stop.additionalContext, /not complete/u);
  } finally {
    workflow.close();
  }
});

test("a finite tool budget cannot be bypassed with repeated reads", () => {
  const { workflow, contract } = fixture();
  try {
    workflow.approve({ ...contract, budget: { ...contract.budget, toolCalls: 1 } });
    const call = { toolName: "view", toolArgs: { path: "src/app.mjs" } };
    assert.equal(workflow.hook("preToolUse", call).permissionDecision, "allow");
    assert.equal(workflow.hook("preToolUse", call).permissionDecision, "deny");
    assert.equal(
      workflow.hook("preToolUse", {
        toolName: "powershell",
        toolArgs: { command: "node scripts/dev-workflow.mjs status" },
      }).permissionDecision,
      "allow",
    );
  } finally {
    workflow.close();
  }
});

test("another workspace, shell injection and Git output writes are rejected", () => {
  const { workflow, contract } = fixture();
  try {
    workflow.approve(contract);
    for (const command of [
      "git diff --output=acceptance/check.mjs",
      "git status; node arbitrary.mjs",
      "node scripts/dev-workflow.mjs approve other-contract.json",
      "node scripts/dev-workflow.mjs run fix-login | node other.mjs",
      "node scripts/dev-workflow.mjs status $(node scripts/dev-workflow.mjs approve evil.json)",
      "git status $(node unsafe.mjs)",
      "node scripts/dev-workflow.mjs status %EXECUTE%",
    ]) {
      assert.equal(
        workflow.hook("preToolUse", {
          toolName: "powershell",
          toolArgs: { command },
        }).permissionDecision,
        "deny",
      );
    }
    assert.equal(
      workflow.hook("preToolUse", {
        cwd: tmpdir(),
        toolName: "edit",
        toolArgs: { path: "src/app.mjs" },
      }).permissionDecision,
      "deny",
    );
  } finally {
    workflow.close();
  }
});

test("successful completion retires execution authority without losing its receipt", async () => {
  const { workflow, contract } = fixture({ executor: evidenceExecutor(true) });
  try {
    workflow.approve({ ...contract, regression: false });
    assert.equal((await workflow.run(contract.id)).status, "passed");
    assert.equal(workflow.finish(contract.id).status, "verified");
    assert.equal(workflow.activeId(), null);
    assert.equal(workflow.task(contract.id).status, "completed");
    await assert.rejects(workflow.run(contract.id), errorCode("task_not_active_for_execution"));
    assert.equal(workflow.task(contract.id).status, "completed");
    now += 16 * 60000;
    assert.equal(
      workflow.hook("preToolUse", {
        toolName: "view",
        toolArgs: { path: "src/app.mjs" },
      }).permissionDecision,
      "allow",
    );
    assert.deepEqual(workflow.hook("agentStop", {}), {});
    assert.equal(workflow.task(contract.id).status, "completed");
  } finally {
    workflow.close();
  }
});

test("actual supervisor cancellation recovers a nested running check without replay", async () => {
  const { workflow, contract, directory } = fixture();
  mkdirSync(join(directory, "scripts"));
  copyFileSync(
    new URL("./dev-workflow.mjs", import.meta.url),
    join(directory, "scripts", "dev-workflow.mjs"),
  );
  writeFileSync(
    join(directory, "acceptance", "check.mjs"),
    `
    import {writeFileSync} from 'node:fs';
    writeFileSync('.local/child-ready', 'ready');
    setInterval(() => {}, 1000);
  `,
  );
  workflow.approve({ ...contract, regression: false });
  const controller = new AbortController();
  const watcher = watch(join(directory, ".local"), (event, name) => {
    if (name === "child-ready") {
      controller.abort();
    }
  });
  try {
    const result = await superviseAgent(
      workflow,
      contract.id,
      ["node", join(directory, "scripts", "dev-workflow.mjs"), "run", contract.id],
      { signal: controller.signal },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.execution.cancelled, true);
    assert.equal(workflow.task(contract.id).running, null);
    assert.equal(workflow.task(contract.id).status, "blocked");
    assert.equal(workflow.task(contract.id).verified_source, null);
    assert.equal(workflow.task(contract.id).attempts, 1);
    workflow.approve({ ...contract, id: "next-approved-strategy", regression: false });
    assert.equal(workflow.activeId(), "next-approved-strategy");
  } finally {
    watcher.close();
    controller.abort();
    workflow.close();
  }
});

test("the real command deadline terminates a command that never finishes", async () => {
  const started = Date.now();
  const result = await executeCommand({
    argv: ["node", "-e", "setInterval(() => {}, 1000)"],
    cwd: root,
    timeoutMs: 50,
    environment: {},
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  assert.ok(Date.now() - started < 5000, "Owned-process teardown exceeded the bounded grace time.");
});

test("abandoned run ownership can be recovered only after confirmed owner exit", () => {
  let live = true;
  const { workflow, contract } = fixture({ processAlive: () => live });
  try {
    workflow.approve(contract);
    workflow.db.prepare("UPDATE tasks SET running='orphan' WHERE id=?").run(contract.id);
    workflow.db
      .prepare(`INSERT INTO runs
      (id,task_id,started,phase,source,owner_pid) VALUES(?,?,?,?,?,?)`)
      .run("orphan", contract.id, now, "verify", workflow.source(), 12345);
    assert.throws(
      () => workflow.recover(contract.id, "Interrupted task owner."),
      errorCode("command_still_running"),
    );
    live = false;
    const recovered = workflow.recover(contract.id, "Confirmed owner process exited.");
    assert.equal(recovered.status, "interrupted");
    assert.equal(workflow.task(contract.id).status, "blocked");
    assert.equal(workflow.task(contract.id).running, null);
    assert.equal(workflow.task(contract.id).verified_source, null);
    workflow.approve({ ...contract, id: "new-strategy" });
    assert.equal(workflow.activeId(), "new-strategy");
  } finally {
    workflow.close();
  }
});

test("only the protected read-only verifier can be delegated", () => {
  const { workflow, contract } = fixture();
  try {
    workflow.approve(contract);
    assert.equal(
      workflow.hook("preToolUse", {
        toolName: "task",
        toolArgs: { agent_type: "development-verifier" },
      }).permissionDecision,
      "allow",
    );
    assert.equal(
      workflow.hook("preToolUse", {
        toolName: "task",
        toolArgs: { agent_type: "general-purpose" },
      }).permissionDecision,
      "deny",
    );
  } finally {
    workflow.close();
  }
});

test("owned process-tree cancellation stops a real child and its descendant", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.log(child.pid);
    setInterval(()=>{},1000);
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let descendant;
  try {
    const [chunk] = await once(child.stdout, "data");
    descendant = Number(String(chunk).trim());
    assert.ok(Number.isInteger(descendant) && descendant > 0);
    const stopped = once(child, "close");
    await terminateOwnedProcessTree(child);
    await stopped;
    try {
      process.kill(descendant, 0);
      assert.notEqual(process.platform, "win32", "The owned descendant is still alive.");
      const state = execFileSync("ps", ["-p", String(descendant), "-o", "stat="], {
        encoding: "utf8",
      }).trim();
      assert.ok(
        state.startsWith("Z"),
        "A descendant must be gone or awaiting OS reaping, not running.",
      );
    } catch (error) {
      if (error.code !== "ESRCH" && !(error.status === 1 && process.platform !== "win32")) {
        throw error;
      }
    }
  } finally {
    if (child.exitCode === null) {
      await terminateOwnedProcessTree(child);
    }
  }
});

test("repository hook configuration uses the actual Copilot CLI event/output contract", () => {
  const hooks = JSON.parse(
    readFileSync(new URL("../.github/copilot/settings.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(Object.keys(hooks.hooks), [
    "sessionStart",
    "preToolUse",
    "postToolUse",
    "agentStop",
  ]);
  for (const [event, definitions] of Object.entries(hooks.hooks)) {
    assert.equal(definitions.length, 1);
    assert.match(definitions[0].bash, new RegExp(`hook ${event}$`, "u"));
    assert.match(definitions[0].powershell, new RegExp(`hook ${event}$`, "u"));
    assert.equal(definitions[0].timeoutSec, 20);
  }
  for (const agent of ["development-implementer", "development-verifier"]) {
    const text = readFileSync(
      new URL(`../.github/agents/${agent}.agent.md`, import.meta.url),
      "utf8",
    );
    assert.match(text, /^---\r?\nname: /u);
    assert.match(text, /\ndescription: "/u);
    if (agent.endsWith("verifier")) {
      assert.match(text, /\ntools: \[read, search\]/u);
      assert.doesNotMatch(text, /\ntools:.*(?:edit|execute)/u);
    }
  }
});

test("trusted-base CI policy rejects changes to its own gate and agent controls", () => {
  assert.deepEqual(
    protectedPolicyChanges([
      "src/example.ts",
      "docs/example.md",
      ".github/workflows/development-policy.yml",
      "scripts/dev-workflow.mjs",
      ".github/copilot/settings.json",
      ".github/agents/development-verifier.agent.md",
      "AGENTS.md",
    ]),
    [
      ".github/workflows/development-policy.yml",
      "scripts/dev-workflow.mjs",
      ".github/copilot/settings.json",
      ".github/agents/development-verifier.agent.md",
      "AGENTS.md",
    ],
  );
  assert.deepEqual(protectedPolicyChanges(["src/gateway/example.ts", "docs/help/example.md"]), []);
});

test("contract validation rejects ignored fields, absent criteria, wildcards and unobservable budgets", () => {
  const { workflow, contract } = fixture();
  try {
    for (const invalid of [
      { ...contract, typo: true },
      { ...contract, criteria: {} },
      { ...contract, scope: ["../outside"] },
      { ...contract, runtime: { url: "https://example.com", expected: {} } },
      { ...contract, budget: { ...contract.budget, modelCalls: 5 } },
      { ...contract, checks: [{ ...contract.checks[0], criteria: [] }] },
    ]) {
      assert.throws(() => validateContract(invalid), WorkflowError);
    }
  } finally {
    workflow.close();
  }
});

test("approval and evidence persist without changing the user's tracked files", async () => {
  const { workflow, contract, directory } = fixture({ executor: evidenceExecutor(true) });
  workflow.approve({ ...contract, regression: false });
  await workflow.run(contract.id);
  workflow.close();
  const reopened = new DevelopmentWorkflow(directory, { clock: () => now });
  try {
    assert.equal(reopened.finish().status, "verified");
    assert.equal(reopened.git(["status", "--porcelain"]), "");
    assert.equal(
      readFileSync(join(directory, "src", "app.mjs"), "utf8"),
      "export const correct = false;\n",
    );
  } finally {
    reopened.close();
  }
});
