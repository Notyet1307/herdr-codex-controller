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

test("versioned required checks accept configured conclusions and ignore observational failures", () => {
  const contract = {
    version: 1,
    firstAppearanceTimeoutMs: 60_000,
    pendingTimeoutMs: 60_000,
    checks: [
      { name: "verify", appId: 15368, workflowName: "CI", acceptedConclusions: ["SUCCESS", "NEUTRAL", "SKIPPED"], required: true },
      { name: "lint", appId: null, workflowName: null, acceptedConclusions: ["SUCCESS"], required: false },
    ],
  } as any;
  const missing = summarizeChecks([
    { name: "unrelated", status: "COMPLETED", conclusion: "SUCCESS" },
  ], contract);
  assert.deepEqual(missing.missing, ["verify"]);
  assert.equal(missing.state, "pending");

  const pending = summarizeChecks([
    { name: "verify", status: "IN_PROGRESS", conclusion: null, app: { id: 15368 }, workflowName: "CI" },
  ], contract);
  assert.deepEqual(pending.pending.map(({ name }) => name), ["verify"]);

  for (const conclusion of ["SUCCESS", "NEUTRAL", "SKIPPED"]) {
    const passed = summarizeChecks([
      { name: "verify", status: "COMPLETED", conclusion, app: { id: 15368 }, workflowName: "CI" },
      { name: "lint", status: "COMPLETED", conclusion: "FAILURE", app: { id: 1 } },
      { name: "lint", status: "COMPLETED", conclusion: "FAILURE", app: { id: 2 } },
    ], contract);
    assert.equal(passed.state, "success");
  }

  const ambiguous = summarizeChecks([
    { name: "verify", status: "COMPLETED", conclusion: "SUCCESS", app: { id: 15368 }, workflowName: "CI" },
    { name: "verify", status: "COMPLETED", conclusion: "SUCCESS", app: { id: 999 }, workflowName: "other" },
  ], contract);
  assert.deepEqual(ambiguous.ambiguous, ["verify"]);
  assert.equal(ambiguous.state, "failure");
});

test("pull request bodies keep source-bound Issues open", () => {
  const report = {
    result: { releaseId: "release", candidateSha: "a".repeat(40) },
    goal: { objective: "Ship it", issues: [{ number: 1 }] },
    change: { available: true, files: 1, changedLines: 1 },
    checks: [],
    aggregateReview: { status: "PASS", summary: "pass" },
    remainingConcerns: { items: [] },
    technical: { planDigest: "b".repeat(64) },
  } as any;
  assert.match(renderPullRequestBody(report), /- Issue #1/);
  assert.doesNotMatch(renderPullRequestBody(report), /Closes #1/);
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
        required_status_checks: [{ context: "verify", integration_id: 15368 }],
      },
    },
  ]);
  writeFileSync(ghPath, `#!/usr/bin/env node\nconst endpoint=process.argv[3]??'';\nif(endpoint.includes('/rules/branches/')){console.log(${JSON.stringify(rules)});process.exit(0)}\nif(endpoint.includes('/protection')){console.log('{}');process.exit(0)}\nprocess.exit(2);\n`, { mode: 0o700 });
  chmodSync(ghPath, 0o700);
  process.env["PATH"] = `${fakeBin}:${originalPath ?? ""}`;
  try {
    const valid = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    const missing = structuredClone(valid) as any;
    missing.delivery.requiredChecks.checks[0].name = "other";
    assert.equal(await new GitHubClient(valid).baseAllowsUpToDateAutoMerge(), true);
    assert.equal(await new GitHubClient(missing).baseAllowsUpToDateAutoMerge(), false);

    const wrongAppRules = JSON.stringify([
      { type: "pull_request", parameters: {} },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "verify", integration_id: 999 }] } },
    ]);
    writeFileSync(ghPath, `#!/usr/bin/env node\nconst endpoint=process.argv[3]??'';\nif(endpoint.includes('/rules/branches/')){console.log(${JSON.stringify(wrongAppRules)});process.exit(0)}\nif(endpoint.includes('/protection')){console.log('{}');process.exit(0)}\nprocess.exit(2);\n`, { mode: 0o700 });
    assert.equal(await new GitHubClient(valid).baseAllowsUpToDateAutoMerge(), false);

    const classic = JSON.stringify({
      required_pull_request_reviews: { required_approving_review_count: 0 },
      required_status_checks: { strict: true, contexts: [], checks: [{ context: "verify", app_id: 15368 }] },
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

test("PR inspection enriches workflow rollup with candidate-bound GitHub App identity", async () => {
  for (const appId of [15368, 999]) {
    const repo = createTestRepo();
    const fakeBin = mkdtempSync(join(tmpdir(), "herdr-fake-gh-check-app-"));
    const ghPath = join(fakeBin, "gh");
    const originalPath = process.env.PATH;
    const sha = "a".repeat(40);
    writeFileSync(ghPath, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==="pr"&&args[1]==="view") {
  console.log(JSON.stringify({number:88,url:"https://github.com/example/project/pull/88",state:"OPEN",headRefName:"agent/release/test",baseRefName:"main",headRefOid:${JSON.stringify(sha)},mergedAt:null,mergeCommit:null,autoMergeRequest:null,statusCheckRollup:[{__typename:"CheckRun",name:"verify",status:"COMPLETED",conclusion:"SUCCESS",workflowName:"CI",detailsUrl:"https://github.com/example/project/actions/runs/123/job/456"}]}));
  process.exit(0);
}
if(args[0]==="api"&&args[1].includes("/check-runs")) {
  console.log(JSON.stringify({total_count:1,check_runs:[{name:"verify",status:"completed",conclusion:"success",details_url:"https://github.com/example/project/actions/runs/123/job/456",app:{id:${appId}}}]}));
  process.exit(0);
}
process.exit(2);
`, { mode: 0o700 });
    chmodSync(ghPath, 0o700);
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    try {
      const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
      const observed = await new GitHubClient(config).inspectPullRequest(88);
      assert.equal(observed.checks.state, appId === 15368 ? "success" : "failure");
      assert.deepEqual(observed.checks.ambiguous, appId === 15368 ? [] : ["verify"]);
      assert.equal(observed.checks.observations?.[0]?.appId, appId);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(fakeBin, { recursive: true, force: true });
      repo.cleanup();
    }
  }
});
