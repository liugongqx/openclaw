#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROTECTED_PREFIXES = [
  "scripts/dev-workflow",
  ".github/copilot/",
  ".github/hooks/",
  ".github/agents/development-",
  ".github/workflows/development-",
  ".github/development-workflow",
];

export function protectedPolicyChanges(paths) {
  return paths.filter(
    (path) => path === "AGENTS.md" || PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix)),
  );
}

export function policyCheck({ base, head, pullRequest, root = process.cwd() }) {
  if (
    !/^[a-f0-9]{40}$/u.test(base ?? "") ||
    !/^[a-f0-9]{40}$/u.test(head ?? "") ||
    !/^[1-9][0-9]*$/u.test(String(pullRequest ?? ""))
  ) {
    throw new Error("Expected exact base/head SHAs and a numeric pull request.");
  }
  const git = (args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
  git(["fetch", "--no-tags", "--depth=1", "origin", `pull/${pullRequest}/head`]);
  if (git(["rev-parse", "FETCH_HEAD"]).trim() !== head) {
    throw new Error("Pull request head changed during policy validation.");
  }
  const paths = git(["diff", "--name-only", "--no-renames", "-z", base, head])
    .split("\0")
    .filter(Boolean);
  const protectedChanges = protectedPolicyChanges(paths);
  return {
    status: protectedChanges.length ? "blocked" : "passed",
    base,
    head,
    protectedChanges,
    policy:
      "Policy changes require a deliberate operator-controlled baseline update; candidate code cannot waive this check.",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = policyCheck({
      base: process.env.DEV_POLICY_BASE,
      head: process.env.DEV_POLICY_HEAD,
      pullRequest: process.env.DEV_POLICY_PR,
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Policy check failed.");
    process.exitCode = 1;
  }
}
