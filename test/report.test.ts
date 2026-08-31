import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateReviewResult, validateWorkerResult } from "../src/codex.js";
import { ensurePrivateDir, writeJsonAtomic, writeTextAtomic } from "../src/fs-atomic.js";
import {
  buildReleaseReportModel,
  exportReleaseReport,
  renderPullRequestBody,
  renderReleaseReport,
} from "../src/report.js";
import { JobStore } from "../src/state.js";
import type { CodexRunRecord, JobState, ReviewResult, ValidationReceipt, WorkerResult } from "../src/types.js";
import { digestJson, nowIso, sha256PrefixedUtf8 } from "../src/util.js";
import {
  TestGitClient,
  createTestRepo,
  git,
  testConfig,
  testPlan,
  writeInputs,
} from "./support.js";

test("review bundle renders every Job status from one bounded, redacted model", async () => {
  const fixture = reportFixture();
  try {
    const model = await buildReleaseReportModel({
      job: fixture.job,
      config: fixture.config,
      jobRoot: fixture.store.root(fixture.job.id),
      git: fixture.gitClient,
    });
    const report = renderReleaseReport(model);
    const body = renderPullRequestBody(model);

    for (const heading of [
      "## Result",
      "## Goal and scope",
      "## Change summary",
      "## Checks actually executed",
      "## Agent self-review",
      "## Aggregate review",
      "## Remaining concerns",
      "## How to review",
      "<summary>Technical details</summary>",
    ]) assert.match(report, new RegExp(escapeRegex(heading)));
    assert.match(report, /Baseline.*PASS/);
    assert.match(report, /Issue #1.*FAIL/);
    assert.match(report, /CI.*verify.*PASS/);
    assert.match(report, /minor.*src\/report\.ts:12/);
    assert.match(report, /Agent-reported; this is not Controller proof/);
    assert.match(report, /Reviewer judgment; this is not deterministic proof/);
    assert.match(body, /1 files, 2 changed lines/);
    assert.match(body, /PASS: Aggregate candidate is reviewable/);
    assert.match(body, new RegExp(fixture.job.candidateSha!));
    assert.match(body, /Keep the fallback visible/);
    assert.ok(Buffer.byteLength(report, "utf8") < 512 * 1024);
    for (const forbidden of [
      fixture.repo.root,
      "/Users/operator/private.txt",
      "github_pat_secretvalue",
      "PROMPT_SENTINEL",
      "EVENT_SENTINEL",
      "SECRET_ENV_SENTINEL",
    ]) assert.equal(report.includes(forbidden), false, forbidden);
    assert.equal(report.includes("x".repeat(2_000)), false);

    const statuses: Array<[JobState["status"], JobState["phase"], string]> = [
      ["running", "implement", "RUNNING"],
      ["blocked", "release_validate", "BLOCKED"],
      ["completed", "complete", "COMPLETED"],
      ["failed", "review", "FAILED"],
    ];
    for (const [status, phase, expected] of statuses) {
      const job = structuredClone(fixture.job);
      job.status = status;
      job.phase = phase;
      job.blocked = status === "blocked" ? {
        code: "replan_required",
        message: "release scope changed at /Users/operator/private.txt",
        fromPhase: phase,
        createdAt: nowIso(),
        detailsPath: join(fixture.store.root(job.id), "private-details.json"),
      } : null;
      const statusModel = await buildReleaseReportModel({
        job,
        config: fixture.config,
        jobRoot: fixture.store.root(job.id),
        git: fixture.gitClient,
      });
      const statusReport = renderReleaseReport(statusModel);
      assert.match(statusReport, new RegExp(`Status: \\*\\*${expected}\\*\\*`));
      if (status === "blocked") assert.match(statusReport, /Abort this Job, return to Planner/);
    }
  } finally {
    fixture.repo.cleanup();
  }
});

test("report export CLI is outside private state, conflict-aware, and byte-idempotent", async () => {
  const fixture = reportFixture();
  try {
    const publicRoot = join(fixture.repo.root, "public");
    mkdirSync(publicRoot, { mode: 0o700 });
    const output = join(publicRoot, "review.md");
    const first = await exportReleaseReport({
      store: fixture.store,
      git: fixture.gitClient,
      jobId: fixture.job.id,
      outputPath: output,
    });
    const firstBytes = readFileSync(output);
    const second = await exportReleaseReport({
      store: fixture.store,
      git: fixture.gitClient,
      jobId: fixture.job.id,
      outputPath: output,
    });
    assert.equal(first.writeStatus, "created");
    assert.equal(second.writeStatus, "unchanged");
    assert.equal(second.sha256, first.sha256);
    assert.deepEqual(readFileSync(output), firstBytes);

    await assert.rejects(exportReleaseReport({
      store: fixture.store,
      git: fixture.gitClient,
      jobId: fixture.job.id,
      outputPath: join(fixture.config.stateDir, "review.md"),
    }), (error: any) => error?.code === "report_export_output_private_path");
    const conflict = join(publicRoot, "conflict.md");
    writeFileSync(conflict, "different\n", { mode: 0o644 });
    await assert.rejects(exportReleaseReport({
      store: fixture.store,
      git: fixture.gitClient,
      jobId: fixture.job.id,
      outputPath: conflict,
    }), (error: any) => error?.code === "report_export_output_conflict");

    const cliOutput = join(publicRoot, "cli-review.md");
    const cli = spawnSync("node", [
      resolve("dist/src/cli.js"), "report", "export",
      "--config", fixture.configPath,
      "--job", fixture.job.id,
      "--out", cliOutput,
      "--json",
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(String(cli.stdout)).writeStatus, "created");
    assert.match(readFileSync(cliOutput, "utf8"), /# Release Review/);
  } finally {
    fixture.repo.cleanup();
  }
});

function reportFixture() {
  const repo = createTestRepo();
  const config = testConfig(repo);
  const plan = testPlan([1]);
  const { configPath, planPath } = writeInputs(repo, config, plan);
  const store = new JobStore(config);
  let job = store.create({
    configPath,
    planPath,
    plan,
    configDigest: digestJson(config),
    planDigest: digestJson(plan),
  });
  job.baseSha = git(repo.source, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo.source, "report-target.txt"), "first\nsecond\n", "utf8");
  git(repo.source, ["add", "report-target.txt"]);
  git(repo.source, ["commit", "-m", "add report target"]);
  job.candidateSha = git(repo.source, ["rev-parse", "HEAD"]);
  job.phase = "ci";
  job.pullRequest = {
    number: 77,
    url: "https://github.com/example/project/pull/77",
    state: "OPEN",
    headRef: job.branch,
    baseRef: job.baseRef,
    headSha: job.candidateSha,
    mergeSha: null,
  };
  job.ciGate = {
    version: 1,
    candidateSha: job.candidateSha,
    checkContractDigest: "a".repeat(64),
    firstObservedAt: nowIso(),
    firstAppearanceDeadlineAt: nowIso(),
    pendingDeadlineAt: null,
    postMergeDeadlineAt: null,
    attempts: 1,
    lastObservation: {
      state: "success",
      missing: [],
      pending: [],
      failures: [],
      successes: [{ name: "verify", state: "SUCCESS", link: "https://github.com/example/project/actions/runs/1" }],
    },
  };

  addValidation(store, job, "setup-1", "setup", true, "npm test", [
    `${repo.root} /Users/operator/private.txt github_pat_secretvalue`,
    "x".repeat(20_000),
  ].join("\n"));
  addValidation(store, job, "issue-1", "issue", false, "npm run typecheck", "type error summary");

  const worker: WorkerResult = validateWorkerResult({
    status: "completed",
    summary: `Implemented the change without exposing ${repo.root}.`,
    selfReview: {
      performed: true,
      findingsFixed: ["Fixed an edge case."],
      remainingConcerns: ["Keep the fallback visible."],
    },
    testsRun: [{ command: "npm test", outcome: "passed" }],
    residualRisks: ["Keep the fallback visible."],
    observedRiskClasses: [],
    blockedReason: null,
    blockedKind: null,
  });
  addRun(store, job, "worker-1", "worker", worker, 1);

  const review: ReviewResult = validateReviewResult({
    status: "pass",
    summary: "Aggregate candidate is reviewable.",
    findings: [{
      severity: "minor",
      path: "src/report.ts",
      line: 12,
      summary: "Small follow-up.",
      rationale: "It does not block delivery.",
      recommendation: "Track it later.",
      relatedIssues: [1],
    }],
  });
  const reviewPath = addRun(store, job, "review-1", "review", review, null);
  job.lastReviewPath = reviewPath;
  job.reviewRound = 1;
  store.save(job);

  const promptPath = join(store.runsRoot(job.id), "worker-1", "prompt.md");
  const eventsPath = join(store.runsRoot(job.id), "worker-1", "events.jsonl");
  writeTextAtomic(promptPath, "PROMPT_SENTINEL SECRET_ENV_SENTINEL\n");
  writeTextAtomic(eventsPath, "EVENT_SENTINEL\n");
  job = store.load(job.id);
  return { repo, config, configPath, store, job, gitClient: new TestGitClient(config) };
}

function addValidation(
  store: JobStore,
  job: JobState,
  id: string,
  scope: "setup" | "issue" | "release",
  passed: boolean,
  command: string,
  stdoutTail: string,
): void {
  const root = ensurePrivateDir(join(store.validationsRoot(job.id), id));
  const identity = {
    version: 2 as const,
    id,
    scope,
    issueNumber: scope === "issue" ? 1 : null,
    candidateSha: job.candidateSha!,
    sourceWorktreeDigest: "b".repeat(64),
    commandCount: 1,
    passed,
    commands: [{
      command,
      oracles: [],
      timeoutMs: 60_000,
      exitCode: passed ? 0 : 1,
      signal: null,
      timedOut: false,
      durationMs: 1_234,
      stdoutPath: join(root, "stdout.log"),
      stderrPath: join(root, "stderr.log"),
      stdoutSha256: sha256PrefixedUtf8(stdoutTail),
      stderrSha256: sha256PrefixedUtf8(""),
      stdoutTail,
      stderrTail: passed ? "" : "bounded failure",
      verifiedAt: nowIso(),
    }],
    createdAt: nowIso(),
  };
  const receipt: ValidationReceipt = { ...identity, digest: digestJson(identity) };
  const path = join(root, "receipt.json");
  writeJsonAtomic(path, receipt);
  job.validations.push({ id, scope, issueNumber: receipt.issueNumber, path, passed, digest: receipt.digest });
}

function addRun(
  store: JobStore,
  job: JobState,
  id: string,
  kind: CodexRunRecord["kind"],
  result: WorkerResult | ReviewResult,
  issueNumber: number | null,
): string {
  const root = ensurePrivateDir(join(store.runsRoot(job.id), id));
  const resultPath = join(root, "result.json");
  writeJsonAtomic(resultPath, result);
  const record: CodexRunRecord = {
    id,
    kind,
    issueNumber,
    startedAt: nowIso(),
    completedAt: nowIso(),
    baseHeadSha: job.candidateSha!,
    finalHeadSha: job.candidateSha!,
    exitCode: 0,
    signal: null,
    timedOut: false,
    promptPath: join(root, "prompt.md"),
    eventsPath: join(root, "events.jsonl"),
    stderrPath: join(root, "stderr.log"),
    resultPath,
    resultDigest: digestJson(result),
  };
  writeTextAtomic(record.promptPath, "PROMPT_SENTINEL\n");
  writeTextAtomic(record.eventsPath, "EVENT_SENTINEL\n");
  writeTextAtomic(record.stderrPath, "");
  job.runs.push(record);
  return resultPath;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
