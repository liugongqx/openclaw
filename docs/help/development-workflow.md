---
summary: "Repository-scoped development contracts, evidence gates, and Copilot hook verification"
title: "Development workflow"
read_when:
  - Implementing a scoped feature or regression fix in this fork
  - Checking whether agent completion is backed by current acceptance evidence
  - Configuring or verifying the coding harness hooks
---

# Development workflow

This fork adds a development admission layer, not another OpenClaw runtime.
It leaves upstream tool ownership, test-lane classification, PR reviews, and
release authorization intact. One implementer owns each task. An independent
read-only verifier challenges substantial changes; the deterministic runner
owns execution and evidence.

## What is enforced

- A frozen, operator-approved objective, non-goals, path scope, and named criteria.
- Acceptance files and workflow infrastructure pinned by content hashes.
- A reproduced criterion failure before a regression can be verified.
- All required commands and criterion results, not an exit code or a test count alone.
- Evidence bound to the Git commit, dirty source bytes, and untracked source files.
- Optional live instance, data-directory, profile, revision, and source-digest binding.
- One running check owner, finite attempts and tool calls, and a deadline that survives
  restarts and includes time spent waiting for a human.
- Reassessment after two identical validation failures. A checkpoint is blocked,
  never passed.
- Copilot edit/execution/completion decisions, where the selected harness loads the hooks.

These are cooperative development controls, **not an OS security sandbox**.
An administrator or another process running as the same user can alter local files,
SQLite state, or hook settings. For publication, require independently controlled
GitHub checks/reviews. A repository hook cannot give itself that authority.

## Bootstrap and commands

Use the Node version required by `package.json` for repository work. The standalone
hook/ledger scripts also work on Node 22.23+ so that an older IDE launcher can reject
unsafe work before project dependencies are installed; this does not change the
supported OpenClaw runtime. Older Node SQLite versions may print an experimental warning.
No Python, new orchestration framework, or new package dependency is required.

```sh
node --test scripts/dev-workflow.test.mjs
node scripts/dev-workflow-demo.mjs
node scripts/dev-workflow.mjs doctor
```

The demo creates and removes its own Git repository, HTTP service, and SQLite ledger.
It proves wrong-instance rejection, an actual HTTP regression, refusal of premature
completion, stale-build rejection, red-to-green verification, and invalidation after
a later edit. No model, real account, or external website is used.

The equivalent package commands are `pnpm test:dev-workflow`,
`pnpm dev:workflow:demo`, and `pnpm dev:workflow <command>`.

## Start a task

1. Identify the existing owner and define the user-visible outcome. Include non-goals
   and explicit negative cases. Prefer configuration or the existing plugin surface
   over a competing implementation.
2. Write the acceptance test before implementation. It must distinguish the intended
   symptom from missing tools, network failures, and test-fixture bugs.
3. Adapt `.github/development-workflow.example.json`. Its example test path and runtime
   are placeholders; the example is not an installed working login test.
4. The operator approves the exact contract once:

```sh
node scripts/dev-workflow.mjs approve path/to/task.json
node scripts/dev-workflow.mjs run example-rendered-login reproduce
```

The implementer may not call `approve`, reset the task, or edit frozen acceptance files
through the gated tools. If the original acceptance test passes already, investigate
the discrepancy; do not invent a failure to unlock implementation.

Contracts use literal repository-relative paths, with a trailing `/` for a directory.
Wildcards, parent traversal, missing protected files, uncovered criteria, unknown
fields, and contradictory runtime identities are rejected. Existing unrelated
changes are preserved and become part of the baseline, not newly approved scope.

## Acceptance evidence

Each check with criterion IDs writes exactly one report with `writeAcceptance`:

```js
import { writeAcceptance } from "../scripts/dev-workflow.mjs";

const passed = await exerciseTheActualEntryPoint();
writeAcceptance({ "rendered-login": passed.formVisible, "manual-boundary": passed.noCredentials });
process.exitCode = passed.formVisible && passed.noCredentials ? 0 : 1;
```

The helper uses runner-supplied paths, run IDs, and source digests. Missing, stale,
malformed, or incomplete evidence is a failure. Ordinary lint/unit commands can have
an empty `criteria` array, but every declared acceptance criterion must be covered.
Commands are frozen argument arrays, executed without a shell and without forwarding
unrelated API-key environment variables. Use Node entrypoints or explicit platform
executables rather than relying on shell-specific command chaining.

The private ledger and reports live beneath ignored `.local/dev-workflow/`.
The ledger records state; JSON reports are inspectable result artifacts.
Output is hashed rather than persisted as potentially sensitive raw tool logs.
Tests that need additional diagnostics should write appropriately sanitized artifacts.
Never put credentials or real account identifiers in a contract or test report.

## Runtime identity and deployed checks

`runtime: null` explicitly means **source checks only**. Such proof cannot establish
that a restarted application or a remote site works.

A runtime-bound contract names an explicit loopback identity endpoint and expected:

- `instanceId`: the test-owned application instance, not merely a listening port.
- `dataDirId`: an opaque identity for its data directory.
- `profileId`: the isolated browser/application profile.
- `revision`: normally `$HEAD`, bound to the candidate commit.
- `sourceDigest`: normally `$SOURCE`, bound to the exact candidate source bytes.

The application/test launcher must expose its actual built identities. Echoing values
from a query parameter or blindly proxying the runner environment is not proof.
An HTTP 200 with the wrong identities fails before the acceptance command runs.
Identities are checked again after validation.

This infrastructure does not add a production identity endpoint to OpenClaw. A
specific application acceptance suite must use a supported owner-level diagnostic
adapter or its own isolated fixture. Do not label a mock as live deployment proof.

## Implement, verify, and stop

```sh
node scripts/dev-workflow.mjs run example-rendered-login verify
node scripts/dev-workflow.mjs finish example-rendered-login
```

Use the existing `scripts/check-changed.mjs` and test entrypoints to choose relevant
checks; do not duplicate their path-to-test-lane rules in the contract runner.
Run independent cheap checks concurrently where the existing runner supports it.
External browsers, shared accounts, and live-provider trials stay serial.

If blocked:

```sh
node scripts/dev-workflow.mjs checkpoint example-rendered-login "The site requires manual authentication."
```

Read-only diagnostics remain possible; another attempt needs a genuinely new,
operator-approved contract. Do not extend an expired deadline or merely rename the
same strategy. Never replay an uncertain external effect.

Successful `finish` retires the active task while retaining its receipt. Completed
tasks cannot execute again; later read-only sessions do not inherit their expired
gate. Use `status <task-id>` to inspect historical results.

If the runner was forcibly interrupted, the operator can recover its abandoned claim:

```sh
node scripts/dev-workflow.mjs recover example-rendered-login "The recorded owner process exited."
```

Recovery verifies that the recorded owner is no longer alive, marks the attempt
interrupted, and blocks the task without replaying it. An alive or unverifiable
owner cannot be cleared. The agent supervisor performs this recovery after it
confirms termination of its own process tree.

For an unattended coding-agent process, the operator can additionally supervise it:

```sh
node scripts/dev-workflow.mjs agent example-rendered-login -- copilot --agent development-implementer --no-ask-user -p "Implement the approved contract."
```

The supervisor applies the remaining deadline and terminates its owned process tree.
Commands must remain foreground and own their children; this is not a containment
boundary against a malicious process that escapes ownership. On Windows, use an
executable CLI or an explicit PowerShell launcher if the installed command is a `.ps1`.

The observable budgets are wall time, check attempts, and tool calls. Copilot tool
hooks do **not** provide a trustworthy count of all provider requests. The contract
rejects a `modelCalls` budget rather than silently claiming to enforce it. Provider
cost/call accounting requires an explicitly instrumented model owner.

## Copilot integration

The repository settings in `.github/copilot/settings.json` use the Copilot CLI/SDK
event names and top-level decision schema,
not the similarly named VS Code Local-harness schema. Hook discovery and events
vary by host. Start a new trusted session in this repository after installing them.

The implementer can read, make scoped edits, run frozen checks through the runner,
and delegate only to `development-verifier`. Arbitrary shell commands, self-approval,
publication, and unknown edit payloads are denied rather than guessed safe.
The verifier has only read/search tools; its review is not another execution receipt.

`doctor` shows observed hook events. Unit tests of hook JSON do not prove that the
IDE actually loads it. Verify a real session starts the hook, permits a read, and
denies a deliberate out-of-scope edit in a disposable checkout before relying on it.
The tests and demo do not themselves claim live Copilot discovery.

`node scripts/dev-workflow-hook-probe.mjs` runs the installed CLI in a disposable
repository and requires observed session, pre-tool, post-tool, and stop events,
including an actual denied write. On Windows, pass `--copilot-script` with the
installed CLI's PowerShell launcher if necessary. This is opt-in and uses the
configured model/provider.

Copilot CLI 1.0.95 requires trusted-workspace admission before loading repository
hooks; `--add-dir` alone is not that admission. The probe uses the CLI's documented
`COPILOT_ALLOW_ALL=true` only in the disposable child, with available tools limited
to file viewing/creation/patching and no shell or network tools. This deliberately
tests that the hook denies an out-of-scope write despite host tool permission.
It does not change global settings, and that environment variable should not be
set globally for ordinary work. Trust the real repository once in the selected
IDE/CLI harness, then confirm events with `doctor`.

## CI and publication

The `Development workflow gates` workflow runs the contract tests and real HTTP demo
on Linux and Windows without credentials. It does not replace upstream product CI.
Enable the two OS contract checks and `Protected development policy` as required
checks on the fork's protected branch before calling publication enforcement active.
The policy workflow runs trusted base-branch code, fetches the candidate only as
Git objects, and never executes candidate code. It rejects changes to itself,
the hooks, gate implementation, example contract, and agent instructions.
Policy maintenance needs a deliberate operator-controlled baseline update; a PR
cannot waive its own gate by modifying the candidate workflow. Use independent
review for such changes. This is not an automatic upstream merge/release workflow.

A local receipt is not a signature from an external authority. Do not trust a
submitted receipt instead of rerunning the required checks on the exact candidate.
Likewise, CI passing on an earlier commit does not validate later edits.

## Human involvement

Ask once for task scope and consequential permissions. Automate ordinary testing,
instance discovery, and synthetic recovery. Human credential entry, MFA, consent,
and decisions that materially change the approved goal are real boundaries, not
failures to be hidden or automated around.
