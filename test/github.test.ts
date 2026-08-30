import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { autoMergeArgs, GitHubClient, renderPullRequestBody, summarizeChecks } from "../src/github.js";
import { createTestRepo, testConfig } from "./support.js";

test("auto-merge is bound to the exact reviewed candidate SHA", () => {
  const candidateSha = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(
    autoMergeArgs(149, "example/project", "squash", candidateSha),
    [
      "pr", "merge", "149", "--repo", "example/project",
      "--squash", "--auto", "--match-head-commit", candidateSha,
    ],
  );
});

test("auto-merge rejects an invalid candidate identity before invoking GitHub", () => {
  assert.throws(
    () => autoMergeArgs(149, "example/project", "squash", "not-a-sha"),
    /candidate SHA is invalid/,
  );
});

test("required checks are exact-name gates and NEUTRAL or SKIPPED are not success", () => {
  const missing = summarizeChecks([
    { name: "unrelated", status: "COMPLETED", conclusion: "SUCCESS" },
  ], ["verify"]);
  assert.deepEqual(missing.missing, ["verify"]);
  assert.equal(missing.state, "pending");

  const pending = summarizeChecks([
    { name: "verify", status: "IN_PROGRESS", conclusion: null },
  ], ["verify"]);
  assert.deepEqual(pending.pending.map(({ name }) => name), ["verify"]);

  for (const conclusion of ["FAILURE", "NEUTRAL", "SKIPPED"]) {
    const failed = summarizeChecks([{ name: "verify", status: "COMPLETED", conclusion }], ["verify"]);
    assert.deepEqual(failed.failures.map(({ state }) => state), [conclusion]);
  }

  assert.equal(
    summarizeChecks([{ name: "verify", status: "COMPLETED", conclusion: "SUCCESS" }], ["verify"]).state,
    "success",
  );
});

test("v2 pull request bodies keep source-bound Issues OPEN while legacy delivery keeps closure behavior", () => {
  const job = {
    plan: { version: 2, title: "Release", objective: "Ship it", releaseAcceptanceCriteria: [], issues: [] },
    issues: [{ number: 1 }],
    validations: [],
    candidateSha: "a".repeat(40),
    reviewRound: 1,
    planDigest: "b".repeat(64),
  } as any;
  assert.match(renderPullRequestBody(job), /- Issue #1/);
  assert.doesNotMatch(renderPullRequestBody(job), /Closes #1/);
  job.plan.version = 1;
  assert.match(renderPullRequestBody(job), /- Closes #1/);
});

test("auto-merge policy requires a pull-request rule and strict protection for every configured check", async () => {
  const repo = createTestRepo();
  const fakeBin = mkdtempSync(join(tmpdir(), "herdr-fake-gh-policy-"));
  const ghPath = join(fakeBin, "gh");
  const originalPath = process.env["PATH"];
  const rules = JSON.stringify([
    { type: "pull_request", parameters: {} },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [{ context: "verify" }],
      },
    },
  ]);
  writeFileSync(ghPath, `#!/usr/bin/env node\nconst endpoint=process.argv[3]??'';\nif(endpoint.includes('/rules/branches/')){console.log(${JSON.stringify(rules)});process.exit(0)}\nif(endpoint.includes('/protection')){console.log('{}');process.exit(0)}\nprocess.exit(2);\n`, { mode: 0o700 });
  chmodSync(ghPath, 0o700);
  process.env["PATH"] = `${fakeBin}:${originalPath ?? ""}`;
  try {
    const valid = testConfig(repo, { delivery: { ...testConfig(repo).delivery, requiredChecks: ["verify"] } } as any);
    const missing = testConfig(repo, { delivery: { ...testConfig(repo).delivery, requiredChecks: ["other"] } } as any);
    assert.equal(await new GitHubClient(valid).baseAllowsUpToDateAutoMerge(), true);
    assert.equal(await new GitHubClient(missing).baseAllowsUpToDateAutoMerge(), false);

    const classic = JSON.stringify({
      required_pull_request_reviews: { required_approving_review_count: 0 },
      required_status_checks: { strict: true, contexts: ["verify"], checks: [] },
    });
    writeFileSync(ghPath, `#!/usr/bin/env node\nconst endpoint=process.argv[3]??'';\nif(endpoint.includes('/rules/branches/')){console.log('[]');process.exit(0)}\nif(endpoint.includes('/protection')){console.log(${JSON.stringify(classic)});process.exit(0)}\nprocess.exit(2);\n`, { mode: 0o700 });
    assert.equal(await new GitHubClient(valid).baseAllowsUpToDateAutoMerge(), true);
  } finally {
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    rmSync(fakeBin, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("issue snapshots use assignee login when GitHub returns an empty display name", async () => {
  const repo = createTestRepo();
  const fakeBin = mkdtempSync(join(tmpdir(), "herdr-fake-gh-"));
  const ghPath = join(fakeBin, "gh");
  const originalPath = process.env["PATH"];
  const response = JSON.stringify({
    number: 12,
    title: "Implement the next release task",
    body: "## What to build\n\nImplement it.",
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
    assignees: [{ login: "Notyet1307", name: "" }],
    url: "https://github.com/Notyet1307/Accord/issues/12",
  });
  mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
  writeFileSync(ghPath, `#!/bin/sh\nprintf '%s\\n' '${response}'\n`, { mode: 0o700 });
  chmodSync(ghPath, 0o700);
  process.env["PATH"] = `${fakeBin}:${originalPath ?? ""}`;
  try {
    const issue = await new GitHubClient(testConfig(repo)).fetchIssue(12);
    assert.deepEqual(issue.assignees, ["Notyet1307"]);
  } finally {
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    rmSync(fakeBin, { recursive: true, force: true });
    repo.cleanup();
  }
});
