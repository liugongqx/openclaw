#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevelopmentWorkflow, probeRuntime } from "./dev-workflow.mjs";

// openclaw-temp-dir: allow the demo proves lifecycle/cleanup of a real isolated checkout and HTTP app.
const root = mkdtempSync(join(tmpdir(), "openclaw-workflow-demo-"));
let workflow;
let server;
try {
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "acceptance"));
  writeFileSync(join(root, ".gitignore"), ".local/\n");
  writeFileSync(join(root, "src", "answer.txt"), "41");
  const moduleUrl = new URL("./dev-workflow.mjs", import.meta.url).href;
  writeFileSync(
    join(root, "acceptance", "http-check.mjs"),
    `
    import { writeAcceptance } from ${JSON.stringify(moduleUrl)};
    const url = new URL('/answer', process.env.OPENCLAW_DEV_RUNTIME_URL);
    const response = await fetch(url);
    const answer = await response.json();
    const passed = response.ok && answer.value === 42;
    writeAcceptance({'correct-result': passed});
    process.exitCode = passed ? 0 : 1;
  `,
  );
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "-c", "core.autocrlf=false", "add", "."]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Workflow Demo",
    "-c",
    "user.email=demo@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Seed the reproducible incorrect answer",
  ]);
  workflow = new DevelopmentWorkflow(root);
  const identity = {
    instanceId: randomUUID(),
    dataDirId: createHash("sha256").update(root).digest("hex"),
    profileId: "isolated-demo",
    revision: workflow.head(),
    sourceDigest: workflow.source(),
  };
  server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        request.url === "/identity"
          ? identity
          : {
              value: Number(readFileSync(join(root, "src", "answer.txt"), "utf8")),
            },
      ),
    );
  });
  await new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const url = `http://127.0.0.1:${server.address().port}/identity`;
  const contract = {
    version: 1,
    id: "real-http-regression",
    objective: "The actual HTTP application returns the correct computed answer.",
    nonGoals: ["No external services, credentials, or user-managed application instances."],
    scope: ["src/"],
    protectedPaths: ["acceptance/http-check.mjs"],
    criteria: { "correct-result": "The HTTP answer is exactly 42, not merely HTTP 200." },
    checks: [
      {
        id: "actual-http",
        argv: ["node", "acceptance/http-check.mjs"],
        timeoutSeconds: 10,
        criteria: ["correct-result"],
      },
    ],
    budget: { minutes: 2, attempts: 5, toolCalls: 20 },
    runtime: {
      url,
      expected: { ...identity, revision: "$HEAD", sourceDigest: "$SOURCE" },
    },
    regression: true,
  };
  workflow.approve(contract);
  const wrong = {
    ...contract.runtime,
    expected: { ...contract.runtime.expected, instanceId: "wrong" },
  };
  await assert.rejects(
    probeRuntime(wrong, workflow.head(), workflow.source()),
    (error) => error.code === "wrong_runtime_instance",
  );
  const red = await workflow.run(contract.id, "reproduce");
  assert.equal(red.status, "reproduced");
  assert.throws(
    () => workflow.finish(),
    (error) => error.code === "current_acceptance_proof_required",
  );
  writeFileSync(join(root, "src", "answer.txt"), "42");
  const staleApp = await workflow.run(contract.id);
  assert.equal(staleApp.error, "wrong_runtime_instance");
  identity.sourceDigest = workflow.source();
  const green = await workflow.run(contract.id);
  assert.equal(green.status, "passed");
  assert.equal(workflow.finish().validationScope, "runtime_bound");
  writeFileSync(join(root, "src", "answer.txt"), "43");
  assert.throws(
    () => workflow.finish(),
    (error) => error.code === "current_acceptance_proof_required",
  );
  console.log(
    JSON.stringify(
      {
        status: "passed",
        checks: {
          wrongInstanceRejected: true,
          originalSymptomReproduced: true,
          prematureCompletionRejected: true,
          staleRunningBuildRejected: true,
          realHttpOutcomeVerified: true,
          changedSourceInvalidatedEvidence: true,
        },
        modelCalls: 0,
        externalServices: false,
        userProfilesAccessed: false,
      },
      null,
      2,
    ),
  );
} finally {
  if (server) {
    await new Promise((resolveClose) => {
      server.close(resolveClose);
    });
  }
  workflow?.close();
  rmSync(root, { recursive: true, force: true });
}
