import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { GitClient } from "../src/git.js";
import { Validator } from "../src/validator.js";
import { blockJob, JobStore, retryBlockedJob } from "../src/state.js";
import { ReleaseController } from "../src/controller.js";
import { digestJson, sha256 } from "../src/util.js";
import { ControllerError } from "../src/errors.js";
import type { JobState, RetryAuthorization } from "../src/types.js";
import { summarizeChecks } from "../src/github.js";
import { exportReleaseResult } from "../src/release-result.js";
import {
  FakeCodex,
  FakeGitHub,
  TestGitClient,
  completedWorker,
  createTestRepo,
  git,
  testConfig,
  testPlan,
  highRiskPlan,
  writeInputs,
} from "./support.js";

async function runToTerminal(controller: ReleaseController, store: JobStore, id: string, maximum = 100) {
  for (let index = 0; index < maximum; index += 1) {
    const result = await controller.step(id);
    const job = store.load(id);
    if (result.terminal || job.status === "blocked" || job.status === "completed" || job.status === "failed") return job;
  }
  throw new Error("controller did not settle");
}

async function runToPhase(controller: ReleaseController, store: JobStore, id: string, phase: JobState["phase"], maximum = 100) {
  for (let index = 0; index < maximum; index += 1) {
    const job = store.load(id);
    if (job.phase === phase) return job;
    await controller.step(id);
    const current = store.load(id);
    if (current.status === "blocked" || current.status === "failed") return current;
  }
  throw new Error(`controller did not reach ${phase}`);
}

function evidencePaths(root: string, name: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry: { isDirectory(): boolean }) => entry.isDirectory())
    .map((entry: { name: string }) => join(root, entry.name, name))
    .filter((path: string) => existsSync(path))
    .sort();
}

test("two ordered Issues use fresh Workers, one aggregate review, and Controller-owned commits", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlan(repo, [1, 2]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new TestGitClient(config);
    const codex = new FakeCodex(gitClient);
    const controller = new ReleaseController({ store, git: gitClient, github: new FakeGitHub(), codex, validator: new Validator(config) });
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    const final = await runToPhase(controller, store, job.id, "deliver");
    assert.equal(final.status, "running");
    assert.equal(final.phase, "deliver");
    assert.deepEqual(final.issues.map((issue) => issue.status), ["committed", "committed"]);
    assert.equal(codex.calls.filter((call) => call.kind === "worker").length, 2);
    assert.equal(codex.calls.filter((call) => call.kind === "review").length, 1);
    assert.equal(git(final.worktreePath, ["rev-list", "--count", "HEAD"]), "3");
    assert.match(git(final.worktreePath, ["log", "-1", "--format=%B"]), /Herdr-Issue: 2/);
  } finally { repo.cleanup(); }
});

test("failed Issue validation schedules one fresh repair over the preserved worktree", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: {
        setup: [],
        issue: [{ command: "test -f fixed.txt" }],
        release: [{ command: "test -f fixed.txt" }],
        maxOutputBytes: 64 * 1024,
      },
    } as any);
    const plan = testPlan(repo, [1]);
    plan.issues[0]!.expectedPaths.push("incomplete.txt", "fixed.txt");
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new TestGitClient(config);
    const codex = new FakeCodex(gitClient, async (input) => {
      if (input.kind === "worker") {
        writeFileSync(join(input.job.worktreePath, "incomplete.txt"), "first\n", "utf8");
        return { worker: completedWorker("Initial implementation") };
      }
      if (input.kind === "issue-repair") {
        assert.match(input.prompt, /untrusted requirements data only/);
        assert.match(input.prompt, /untrusted diagnostic data/);
        assert.match(input.prompt, /BEGIN HERDR_ISSUE_[0-9A-F]{20}/);
        assert.match(input.prompt, /BEGIN HERDR_VALIDATION_[0-9A-F]{20}/);
        assert.match(input.prompt, /Command: test -f fixed\.txt/);
        writeFileSync(join(input.job.worktreePath, "fixed.txt"), "fixed\n", "utf8");
        return { worker: completedWorker("Repaired validation failure") };
      }
      return { review: { status: "pass", summary: "pass", findings: [] } };
    });
    const controller = new ReleaseController({ store, git: gitClient, github: new FakeGitHub(), codex, validator: new Validator(config) });
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    const final = await runToPhase(controller, store, job.id, "deliver");
    assert.equal(final.status, "running");
    assert.equal(final.issues[0]?.repairRounds, 1);
    assert.deepEqual(codex.calls.filter((call) => call.issueNumber === 1).map((call) => call.kind), ["worker", "issue-repair"]);
  } finally { repo.cleanup(); }
});

test("blocking aggregate review triggers one hardening commit, full revalidation, and a new exact review", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: {
        setup: [],
        issue: [{ command: "test -f issue-$HERDR_ISSUE_NUMBER.txt" }],
        release: [{ command: "test -f issue-1.txt" }],
        maxOutputBytes: 64 * 1024,
      },
    } as any);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new TestGitClient(config);
    let reviews = 0;
    const codex = new FakeCodex(gitClient, async (input) => {
      if (input.kind === "review") {
        assert.match(input.prompt, /# Included Issue scope/);
        assert.match(input.prompt, /BEGIN HERDR_ISSUE_[0-9A-F]{20}/);
        assert.match(input.prompt, /issue-1\.txt exists/);
        assert.match(input.prompt, /explicitly listed as out of scope/);
        assert.match(input.prompt, /assigned to a downstream Issue/);
        reviews += 1;
        return reviews === 1
          ? { review: { status: "changes", summary: "Needs hardening", findings: [{ severity: "major", path: "issue-1.txt", line: 1, summary: "Missing hardening evidence", rationale: "Fixture", recommendation: "Add hardening.txt", relatedIssues: [1] }] } }
          : { review: { status: "pass", summary: "Hardened candidate passes", findings: [] } };
      }
      if (input.kind === "release-repair") {
        assert.match(input.prompt, /# Included Issue scope/);
        assert.match(input.prompt, /BEGIN HERDR_ISSUE_[0-9A-F]{20}/);
        assert.match(input.prompt, /issue-1\.txt exists/);
        assert.match(input.prompt, /reject that finding in your self-review/);
        assert.match(input.prompt, /valid in-scope defect/);
      }
      return {};
    });
    const controller = new ReleaseController({ store, git: gitClient, github: new FakeGitHub(), codex, validator: new Validator(config) });
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    const final = await runToPhase(controller, store, job.id, "deliver");
    assert.equal(final.status, "running");
    assert.equal(final.codeRepairRounds, 1);
    assert.equal(final.reviewRound, 2);
    assert.equal(codex.calls.filter((call) => call.kind === "release-repair").length, 1);
    assert.equal(git(final.worktreePath, ["rev-list", "--count", "HEAD"]), "3");
  } finally { repo.cleanup(); }
});

test("semantically inconsistent aggregate review is rejected before push or PR creation", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: { setup: [], issue: [{ command: "test -f issue-$HERDR_ISSUE_NUMBER.txt" }], release: [{ command: "test -f issue-1.txt" }], maxOutputBytes: 64 * 1024 },
    } as any);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    class NoPushGit extends TestGitClient {
      pushes = 0;
      override async push(job: any) { this.pushes += 1; return super.push(job); }
    }
    class NoPrGitHub extends FakeGitHub {
      creates = 0;
      override async createPullRequest(): Promise<any> { this.creates += 1; throw new Error("must not create PR"); }
    }
    const gitClient = new NoPushGit(config);
    const github = new NoPrGitHub();
    const minor = { severity: "minor" as const, path: null, line: null, summary: "audit", rationale: "minor only", recommendation: "later", relatedIssues: [] };
    const codex = new FakeCodex(gitClient, async ({ kind }) => kind === "review"
      ? { review: { status: "changes", summary: "inconsistent", findings: [minor] } }
      : {});
    const controller = new ReleaseController({ store, git: gitClient, github, codex, validator: new Validator(config) });
    const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    const final = await runToTerminal(controller, store, created.id);
    assert.equal(final.status, "blocked");
    assert.equal(gitClient.pushes, 0);
    assert.equal(github.creates, 0);
  } finally { repo.cleanup(); }
});

test("a finding that requires changing bound scope reaches REPLAN_REQUIRED", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: {
        setup: [],
        issue: [{ command: "test -f issue-$HERDR_ISSUE_NUMBER.txt" }],
        release: [{ command: "test -f issue-1.txt" }],
        maxOutputBytes: 64 * 1024,
      },
    } as any);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new TestGitClient(config);
    const codex = new FakeCodex(gitClient, async (input) => {
      if (input.kind === "review") {
        return {
          review: {
            status: "changes",
            summary: "The finding cannot be repaired inside the bound release.",
            findings: [{
              severity: "major",
              path: null,
              line: null,
              summary: "Accepted ADR and dependency handoff must change",
              rationale: "The required behavior is outside the included Issue scope.",
              recommendation: "Return to Planner and bind a new Release Plan.",
              relatedIssues: [1],
            }],
          },
        };
      }
      if (input.kind === "release-repair") {
        assert.match(input.prompt, /accepted ADR/i);
        assert.match(input.prompt, /new Release Plan and a new Job/);
        return {
          worker: {
            status: "blocked",
            summary: "Structural replan required.",
            selfReview: { performed: true, findingsFixed: [], remainingConcerns: [] },
            testsRun: [],
            residualRisks: [],
            blockedReason: "Repair requires changing accepted ADR, Issue scope, and dependency handoff.",
            blockedKind: "replan_required",
          },
        };
      }
      return {};
    });
    const controller = new ReleaseController({
      store,
      git: gitClient,
      github: new FakeGitHub(),
      codex,
      validator: new Validator(config),
    });
    const created = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });

    const settled = await runToTerminal(controller, store, created.id);

    assert.equal(settled.blocked?.code, "replan_required");
    assert.equal(settled.status, "blocked");
    assert.equal(settled.phase, "repair");
  } finally { repo.cleanup(); }
});

test("a recoverable hardening blocker can resume once with new infrastructure evidence", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: {
        setup: [],
        issue: [{ command: "test -f issue-$HERDR_ISSUE_NUMBER.txt" }],
        release: [{ command: "test -f issue-1.txt" }],
        maxOutputBytes: 64 * 1024,
      },
    } as any);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new TestGitClient(config);
    let reviews = 0;
    let hardeningRuns = 0;
    const codex = new FakeCodex(gitClient, async (input) => {
      if (input.kind === "review") {
        reviews += 1;
        return reviews === 1
          ? {
              review: {
                status: "changes",
                summary: "One in-scope repair remains.",
                findings: [{
                  severity: "major",
                  path: "issue-1.txt",
                  line: 1,
                  summary: "Repair fixture",
                  rationale: "The current release needs one bounded repair.",
                  recommendation: "Apply the in-scope hardening change.",
                  relatedIssues: [1],
                }],
              },
            }
          : { review: { status: "pass", summary: "Recovered candidate passes.", findings: [] } };
      }
      if (input.kind === "release-repair") {
        hardeningRuns += 1;
        if (hardeningRuns === 1) {
          return {
            worker: {
              status: "blocked",
              summary: "Local dependency is temporarily unavailable.",
              selfReview: { performed: true, findingsFixed: [], remainingConcerns: [] },
              testsRun: [],
              residualRisks: [],
              blockedReason: "Retry after the local dependency is restored.",
              blockedKind: "recoverable",
            },
          };
        }
      }
      return {};
    });
    const controller = new ReleaseController({
      store,
      git: gitClient,
      github: new FakeGitHub(),
      codex,
      validator: new Validator(config),
    });
    const created = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });
    let job = await runToTerminal(controller, store, created.id);
    assert.equal(job.blocked?.code, "codex_hardening_recoverable");

    const evidencePath = join(store.root(job.id), "dependency-restored.json");
    const evidence = "{\"dependency\":\"ready\"}\n";
    writeFileSync(evidencePath, evidence, "utf8");
    job = retryBlockedJob(job, {
      previousBlockedCode: "codex_hardening_recoverable",
      previousBlockedPhase: "repair",
      previousDetailsPath: job.blocked?.detailsPath ?? null,
      operatorReason: "The local dependency is restored.",
      recoveryEvidencePath: evidencePath,
      evidenceDigest: sha256(evidence),
      authorizedAt: "2026-08-28T10:00:00.000Z",
    }, store.root(job.id));
    store.save(job);

    const completed = await runToPhase(controller, store, job.id, "deliver");
    assert.equal(completed.status, "running");
    assert.equal(hardeningRuns, 2);
    assert.equal(completed.codeRepairRounds, 1);
  } finally { repo.cleanup(); }
});

test("release validation evidence remains exactly bound after hardening exhaustion and restart", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: {
        setup: [],
        issue: [{ command: "test -f issue-$HERDR_ISSUE_NUMBER.txt" }],
        release: [{ command: "test -f missing-release-evidence.txt" }],
        maxOutputBytes: 64 * 1024,
      },
      policy: { ...testConfig(repo).policy, maxCodeRepairRounds: 0 },
    } as any);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new TestGitClient(config);
    const controller = new ReleaseController({
      store,
      git: gitClient,
      github: new FakeGitHub(),
      codex: new FakeCodex(gitClient),
      validator: new Validator(config),
    });
    const created = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });

    const settled = await runToTerminal(controller, store, created.id);
    assert.equal(settled.status, "blocked");
    assert.equal(settled.blocked?.code, "replan_required");
    assert.match(settled.blocked?.message ?? "", /release_repair_exhausted/);

    const restarted = new JobStore(config).load(created.id);
    const releaseBinding = restarted.validations.at(-1);
    assert.equal(releaseBinding?.scope, "release");
    assert.equal(releaseBinding?.passed, false);
    assert.equal(restarted.blocked?.detailsPath, releaseBinding?.path);
    assert.equal(restarted.codeRepairRounds, 0);
    assert.equal(restarted.reviewRound, 0);
    assert.equal(restarted.activeRun, null);

    const receipt = JSON.parse(readFileSync(releaseBinding!.path, "utf8"));
    assert.equal(receipt.digest, releaseBinding?.digest);
    assert.equal(receipt.candidateSha, await gitClient.head(restarted.worktreePath));
    assert.equal(restarted.candidateSha, receipt.candidateSha);
    assert.deepEqual(
      evidencePaths(store.validationsRoot(created.id), "receipt.json"),
      restarted.validations.map((entry) => entry.path).sort(),
    );
  } finally { repo.cleanup(); }
});

test("release validation writes stay disposable and cannot mutate the candidate worktree", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: {
        setup: [],
        issue: [{ command: "test -f issue-$HERDR_ISSUE_NUMBER.txt" }],
        release: [{ command: "printf 'unexpected write\\n' > validation-policy-violation.txt" }],
        maxOutputBytes: 64 * 1024,
      },
    } as any);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new TestGitClient(config);
    const controller = new ReleaseController({
      store,
      git: gitClient,
      github: new FakeGitHub(),
      codex: new FakeCodex(gitClient),
      validator: new Validator(config),
    });
    const created = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });

    const settled = await runToPhase(controller, store, created.id, "deliver");
    assert.equal(settled.status, "running");
    assert.equal(existsSync(join(settled.worktreePath, "validation-policy-violation.txt")), false);

    const restarted = new JobStore(config).load(created.id);
    const releaseBinding = restarted.validations.at(-1);
    const receipt = JSON.parse(readFileSync(releaseBinding!.path, "utf8"));
    assert.equal(releaseBinding?.scope, "release");
    assert.equal(releaseBinding?.passed, true);
    assert.equal(releaseBinding?.digest, receipt.digest);
    assert.equal(restarted.candidateSha, receipt.candidateSha);
    assert.deepEqual(
      evidencePaths(store.validationsRoot(created.id), "receipt.json"),
      restarted.validations.map((entry) => entry.path).sort(),
    );
  } finally { repo.cleanup(); }
});

test("latest blocking review and run remain exactly bound after hardening exhaustion and restart", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: {
        setup: [],
        issue: [{ command: "test -f issue-$HERDR_ISSUE_NUMBER.txt" }],
        release: [{ command: "test -f issue-1.txt" }],
        maxOutputBytes: 64 * 1024,
      },
      policy: { ...testConfig(repo).policy, maxCodeRepairRounds: 1 },
    } as any);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new TestGitClient(config);
    const blockingReview = {
      status: "changes" as const,
      summary: "The exact candidate still needs hardening.",
      findings: [{
        severity: "major" as const,
        path: "issue-1.txt",
        line: 1,
        summary: "Blocking fixture",
        rationale: "The regression requires another bounded hardening round.",
        recommendation: "Apply another repair.",
        relatedIssues: [1],
      }],
    };
    const codex = new FakeCodex(gitClient, async (input) => (
      input.kind === "review" ? { review: blockingReview } : {}
    ));
    const controller = new ReleaseController({
      store,
      git: gitClient,
      github: new FakeGitHub(),
      codex,
      validator: new Validator(config),
    });
    const created = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });

    const settled = await runToTerminal(controller, store, created.id);
    assert.equal(settled.status, "blocked");
    assert.equal(settled.blocked?.code, "replan_required");
    assert.match(settled.blocked?.message ?? "", /release_repair_exhausted/);

    const restarted = new JobStore(config).load(created.id);
    const reviewRuns = restarted.runs.filter((run) => run.kind === "review");
    const latestReview = reviewRuns.at(-1);
    assert.equal(restarted.reviewRound, 2);
    assert.equal(reviewRuns.length, restarted.reviewRound);
    assert.equal(restarted.lastReviewPath, latestReview?.resultPath);
    assert.equal(restarted.blocked?.detailsPath, latestReview?.resultPath);
    assert.equal(latestReview?.resultDigest, digestJson(blockingReview));
    assert.equal(latestReview?.baseHeadSha, restarted.candidateSha);
    assert.equal(latestReview?.finalHeadSha, restarted.candidateSha);
    assert.equal(restarted.codeRepairRounds, 1);
    assert.equal(restarted.activeRun, null);
    assert.deepEqual(
      evidencePaths(store.runsRoot(created.id), "result.json"),
      restarted.runs.map((run) => run.resultPath).sort(),
    );
  } finally { repo.cleanup(); }
});

test("validated review evidence is checkpointed before post-run worktree policy", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: {
        setup: [],
        issue: [{ command: "test -f issue-$HERDR_ISSUE_NUMBER.txt" }],
        release: [{ command: "test -f issue-1.txt" }],
        maxOutputBytes: 64 * 1024,
      },
    } as any);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new TestGitClient(config);
    const passingReview = { status: "pass" as const, summary: "Schema-valid but policy-invalid run.", findings: [] };
    const codex = new FakeCodex(gitClient, async (input) => {
      if (input.kind !== "review") return {};
      writeFileSync(join(input.job.worktreePath, "review-policy-violation.txt"), "unexpected write\n", "utf8");
      return { review: passingReview };
    });
    const controller = new ReleaseController({
      store,
      git: gitClient,
      github: new FakeGitHub(),
      codex,
      validator: new Validator(config),
    });
    const created = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });

    const settled = await runToTerminal(controller, store, created.id);
    assert.equal(settled.status, "blocked");
    assert.equal(settled.blocked?.code, "validator_mutated_worktree");

    const restarted = new JobStore(config).load(created.id);
    const reviewRun = restarted.runs.filter((run) => run.kind === "review").at(-1);
    assert.equal(restarted.reviewRound, 1);
    assert.equal(restarted.lastReviewPath, reviewRun?.resultPath);
    assert.equal(reviewRun?.resultDigest, digestJson(passingReview));
    assert.equal(reviewRun?.baseHeadSha, restarted.candidateSha);
    assert.equal(restarted.activeRun, null);
    assert.deepEqual(
      evidencePaths(store.runsRoot(created.id), "result.json"),
      restarted.runs.map((run) => run.resultPath).sort(),
    );
  } finally { repo.cleanup(); }
});

test("REPLAN_REQUIRED after repair exhaustion cannot be retried", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      policy: { ...testConfig(repo).policy, maxCodeRepairRounds: 1 },
    } as any);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    let job = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });
    job.phase = "review";
    job.codeRepairRounds = 1;
    job = blockJob(
      job,
      "release_repair_exhausted",
      "another round requires operator authority",
      join(store.root(job.id), "review-02.json"),
    );

    assert.equal(job.blocked?.code, "replan_required");
    assert.throws(
      () => retryBlockedJob(job),
      (error: unknown) => error instanceof ControllerError && error.code === "replan_required",
    );
    assert.equal(job.status, "blocked");
    assert.equal(job.codeRepairRounds, 1);

  } finally {
    repo.cleanup();
  }
});

test("REPLAN_REQUIRED after an oversized release diff cannot be retried", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    let job = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });
    job.phase = "verify";
    job.codeRepairRounds = 3;
    job = blockJob(
      job,
      "release_diff_too_large",
      "the release diff exceeds the configured changed-line limit",
      join(store.root(job.id), "release-validation.json"),
    );

    assert.equal(job.blocked?.code, "replan_required");
    assert.throws(
      () => retryBlockedJob(job),
      (error: unknown) => error instanceof ControllerError && error.code === "replan_required",
    );
    assert.equal(job.status, "blocked");
    assert.equal(job.codeRepairRounds, 3);
  } finally {
    repo.cleanup();
  }
});

test("new infrastructure evidence authorizes one fresh recovery without changing release authority", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      policy: { ...testConfig(repo).policy, maxCodeRepairRounds: 0 },
    } as any);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    let job = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });
    job.phase = "deliver";
    job.baseSha = "1".repeat(40);
    job.codeRepairRounds = 2;
    job = blockJob(
      job,
      "ci_failed",
      "CI repair requires operator authority",
      join(store.root(job.id), "hardening-02-ci-failure.md"),
    );
    const authorityBefore = {
      plan: job.plan,
      planDigest: job.planDigest,
      baseSha: job.baseSha,
      issues: job.issues,
    };
    const recoveryEvidencePath = join(store.root(job.id), "ci-recovery.json");
    const recoveryEvidence = "{\"checks\":\"passing\"}\n";
    writeFileSync(recoveryEvidencePath, recoveryEvidence, "utf8");
    const authorization: RetryAuthorization = {
      previousBlockedCode: "ci_failed",
      previousBlockedPhase: "deliver",
      previousDetailsPath: job.blocked?.detailsPath ?? null,
      operatorReason: "GitHub Actions runner recovered and the exact candidate checks were rerun.",
      recoveryEvidencePath,
      evidenceDigest: sha256(recoveryEvidence),
      authorizedAt: "2026-08-28T10:00:00.000Z",
    };

    const retried = retryBlockedJob(job, authorization, store.root(job.id));

    assert.equal(retried.status, "running");
    assert.equal(retried.phase, "deliver");
    assert.equal(retried.codeRepairRounds, 2);
    assert.equal(retried.repairReasonPath, job.repairReasonPath);
    assert.deepEqual(retried.retryAuthorizations, [authorization]);
    assert.deepEqual(
      { plan: retried.plan, planDigest: retried.planDigest, baseSha: retried.baseSha, issues: retried.issues },
      authorityBefore,
    );
    assert.equal(retried.blocked, null);
  } finally {
    repo.cleanup();
  }
});

test("the same blocked code and evidence digest cannot authorize retry twice", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    let job = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });
    const recoveryEvidencePath = join(store.root(job.id), "infrastructure-recovered.json");
    const recoveryEvidence = "{\"status\":\"recovered\"}\n";
    writeFileSync(recoveryEvidencePath, recoveryEvidence, "utf8");
    const evidenceDigest = sha256(recoveryEvidence);
    job = blockJob(job, "setup_validation_failed", "local dependency is unavailable", join(store.root(job.id), "setup-01.json"));
    job = retryBlockedJob(job, {
      previousBlockedCode: "setup_validation_failed",
      previousBlockedPhase: "prepare",
      previousDetailsPath: job.blocked?.detailsPath ?? null,
      operatorReason: "The local dependency was installed.",
      recoveryEvidencePath,
      evidenceDigest,
      authorizedAt: "2026-08-28T10:00:00.000Z",
    }, store.root(job.id));
    store.save(job);

    job = blockJob(store.load(job.id), "setup_validation_failed", "local dependency is still unavailable", join(store.root(job.id), "setup-02.json"));
    assert.throws(
      () => retryBlockedJob(job, {
        previousBlockedCode: "setup_validation_failed",
        previousBlockedPhase: "prepare",
        previousDetailsPath: job.blocked?.detailsPath ?? null,
        operatorReason: "Retry the same recovery claim again.",
        recoveryEvidencePath,
        evidenceDigest,
        authorizedAt: "2026-08-28T10:01:00.000Z",
      }, store.root(job.id)),
      (error: unknown) => error instanceof ControllerError && error.code === "retry_without_new_evidence",
    );
    assert.equal(job.status, "blocked");
  } finally {
    repo.cleanup();
  }
});

test("an interrupted Worker run is reconciled as a fresh recovery run without session resume", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: { setup: [], issue: [], release: [], maxOutputBytes: 64 * 1024 },
    } as any);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new TestGitClient(config);
    const codex = new FakeCodex(gitClient);
    const controller = new ReleaseController({ store, git: gitClient, github: new FakeGitHub(), codex, validator: new Validator(config) });
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    await controller.step(job.id); // prepare
    let active = store.load(job.id);
    active.currentIssueNumber = 1;
    active.issues[0]!.status = "running";
    active.phase = "implement";
    active.activeRun = { id: "interrupted", kind: "worker", issueNumber: 1, startedAt: new Date().toISOString(), baseHeadSha: await gitClient.head(active.worktreePath) };
    writeFileSync(join(active.worktreePath, "partial.txt"), "partial\n", "utf8");
    store.save(active);
    const result = await controller.step(job.id);
    active = store.load(job.id);
    assert.equal(result.action, "interrupted_run_reconciled");
    assert.equal(active.activeRun, null);
    assert.equal(active.issues[0]?.nextRunKind, "recovery");
    assert.equal(active.phase, "repair");
  } finally { repo.cleanup(); }
});

test("production completes only after exact candidate, required checks, and merged-base verification", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: {
        setup: [],
        issue: [{ command: "test -f issue-$HERDR_ISSUE_NUMBER.txt" }],
        release: [{ command: "test -f issue-1.txt" }],
        maxOutputBytes: 64 * 1024,
      },
      delivery: {
        ...testConfig(repo).delivery,
        mergeMethod: "merge",
      },
    } as any);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new TestGitClient(config);
    class DeliveryGitHub extends FakeGitHub {
      pr: any = null;
      merged = false;
      mergeSha: string | null = null;
      autoMergeEnabled = false;
      override async createPullRequest(job: any) {
        this.pr = {
          number: 7,
          url: "https://github.com/example/project/pull/7",
          state: "OPEN",
          headRef: job.branch,
          baseRef: job.baseRef,
          headSha: job.candidateSha,
          mergeSha: null,
        };
        return this.pr;
      }
      override async inspectPullRequest(_number: number) {
        const pullRequest = { ...this.pr, state: this.merged ? "MERGED" : "OPEN", mergeSha: this.mergeSha };
        return {
          pullRequest,
          checks: this.merged
            ? summarizeChecks([], config.delivery.requiredChecks)
            : summarizeChecks([{ name: "verify", status: "COMPLETED", conclusion: "SUCCESS", app: { id: 15368 } }], config.delivery.requiredChecks),
          mergedAt: this.merged ? new Date().toISOString() : null,
          autoMergeEnabled: this.autoMergeEnabled,
        };
      }
      override async enableAutoMerge() { this.autoMergeEnabled = true; }
    }
    const github = new DeliveryGitHub();
    const controller = new ReleaseController({ store, git: gitClient, github, codex: new FakeCodex(gitClient), validator: new Validator(config) });
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    let observed = store.load(job.id);
    for (let index = 0; index < 100 && observed.deliveryAuthority?.status !== "authorized"; index += 1) {
      await controller.step(job.id);
      observed = store.load(job.id);
      if (observed.status === "blocked") throw new Error(observed.blocked?.message);
    }
    assert.equal(observed.status, "running");
    assert.equal(observed.deliveryAuthority?.status, "authorized");
    assert.equal(observed.pullRequest?.number, 7);
    assert.equal(observed.pullRequest?.headSha, observed.candidateSha);
    git(repo.source, ["merge", "--no-ff", observed.candidateSha!, "-m", "merge exact candidate"]);
    git(repo.source, ["push", "origin", "main"]);
    github.mergeSha = git(repo.source, ["rev-parse", "HEAD"]);
    github.merged = true;
    const result = await controller.step(job.id);
    assert.equal(result.action, "release_merged", JSON.stringify(store.load(job.id).blocked));
    const completed = store.load(job.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.candidateSha, completed.candidateSha);
    assert.equal(completed.result?.mergeSha, github.mergeSha);
    assert.deepEqual(completed.result?.requiredChecks.names, ["verify"]);
    const resultPath = join(repo.root, "release-result.json");
    const exported = await exportReleaseResult({ store, git: gitClient, github, jobId: job.id, outputPath: resultPath });
    assert.deepEqual(exported, completed.result);
    assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), completed.result);
    assert.equal("controllerProvenance" in exported, false);
    assert.deepEqual(await exportReleaseResult({ store, git: gitClient, github, jobId: job.id, outputPath: resultPath }), exported);
  } finally { repo.cleanup(); }
});

test("auto-merge receives the exact reviewed candidate identity", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: {
        setup: [],
        issue: [{ command: "test -f issue-$HERDR_ISSUE_NUMBER.txt" }],
        release: [{ command: "test -f issue-1.txt" }],
        maxOutputBytes: 64 * 1024,
      },
      delivery: {
        ...testConfig(repo).delivery,
        mergeMethod: "merge",
      },
    } as any);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new TestGitClient(config);
    class AutoMergeGitHub extends FakeGitHub {
      pr: any = null;
      enabled: { number: number; candidateSha: string } | null = null;
      merged = false;
      mergeSha: string | null = null;
      override async createPullRequest(job: any) {
        this.pr = {
          number: 8,
          url: "https://github.com/example/project/pull/8",
          state: "OPEN",
          headRef: job.branch,
          baseRef: job.baseRef,
          headSha: job.candidateSha,
          mergeSha: null,
        };
        return this.pr;
      }
      override async inspectPullRequest(_number: number) {
        const pullRequest = {
          ...this.pr,
          state: this.merged ? "MERGED" : "OPEN",
          mergeSha: this.mergeSha,
        };
        return {
          pullRequest,
          checks: { state: "success" as const, missing: [], failures: [], pending: [] },
          mergedAt: this.merged ? new Date().toISOString() : null,
          autoMergeEnabled: this.enabled !== null,
        };
      }
      override async enableAutoMerge(number: number, candidateSha: string) {
        this.enabled = { number, candidateSha };
      }
    }
    const github = new AutoMergeGitHub();
    const controller = new ReleaseController({
      store,
      git: gitClient,
      github,
      codex: new FakeCodex(gitClient),
      validator: new Validator(config),
    });
    const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    let observed = store.load(created.id);
    for (let index = 0; index < 100 && github.enabled === null; index += 1) {
      await controller.step(created.id);
      observed = store.load(created.id);
      if (observed.status === "blocked") throw new Error(observed.blocked?.message);
    }
    assert.deepEqual(github.enabled, { number: 8, candidateSha: observed.candidateSha });
    assert.equal(observed.phase, "deliver");
    git(repo.source, ["merge", "--no-ff", observed.candidateSha!, "-m", "merge auto candidate"]);
    git(repo.source, ["push", "origin", "main"]);
    github.mergeSha = git(repo.source, ["rev-parse", "HEAD"]);
    github.merged = true;
    const result = await controller.step(created.id);
    assert.equal(result.action, "release_merged", JSON.stringify(store.load(created.id).blocked));
    assert.equal(store.load(created.id).status, "completed");
  } finally { repo.cleanup(); }
});

test("Git merge-result verification covers merge, squash, and rebase delivery methods", async () => {
  for (const mergeMethod of ["merge", "squash", "rebase"] as const) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo);
      const baseSha = git(repo.source, ["rev-parse", "HEAD"]);
      git(repo.source, ["checkout", "-b", "candidate"]);
      writeFileSync(join(repo.source, "candidate.txt"), "candidate\n", "utf8");
      git(repo.source, ["add", "candidate.txt"]);
      git(repo.source, ["commit", "-m", "candidate"]);
      const candidateSha = git(repo.source, ["rev-parse", "HEAD"]);
      git(repo.source, ["checkout", "main"]);
      if (mergeMethod === "merge") git(repo.source, ["merge", "--no-ff", candidateSha, "-m", "merge candidate"]);
      else if (mergeMethod === "squash") {
        git(repo.source, ["merge", "--squash", candidateSha]);
        git(repo.source, ["commit", "-m", "squash candidate"]);
      } else git(repo.source, ["merge", "--ff-only", candidateSha]);
      const result = await new TestGitClient(config).verifyMergeResult({
        mergeSha: git(repo.source, ["rev-parse", "HEAD"]),
        candidateSha,
        baseSha,
        mergeMethod,
      });
      assert.equal(result, "verified", mergeMethod);
    } finally { repo.cleanup(); }
  }
});

test("a merged PR without Controller authority is rejected before Result creation", async () => {
  for (const scenario of ["base-drift", "child-closed"] as const) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo, {
        delivery: {
          ...testConfig(repo).delivery,
          mergeMethod: "merge",
        },
      } as any);
      const plan = highRiskPlan(repo, [1]);
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
      const baseSha = plan.baseSha;
      git(repo.source, ["checkout", "-b", job.branch]);
      writeFileSync(join(repo.source, "issue-1.txt"), "candidate\n", "utf8");
      git(repo.source, ["add", "issue-1.txt"]);
      git(repo.source, ["commit", "-m", "candidate"]);
      const candidateSha = git(repo.source, ["rev-parse", "HEAD"]);
      git(repo.source, ["checkout", "main"]);
      if (scenario === "base-drift") {
        writeFileSync(join(repo.source, "README.md"), "# Drifted base\n", "utf8");
        git(repo.source, ["add", "README.md"]);
        git(repo.source, ["commit", "-m", "advance base before merge"]);
      }
      git(repo.source, ["merge", "--no-ff", candidateSha, "-m", "merge candidate"]);
      git(repo.source, ["push", "origin", "main"]);
      const mergeSha = git(repo.source, ["rev-parse", "HEAD"]);

      job.baseSha = baseSha;
      job.candidateSha = candidateSha;
      job.phase = "deliver";
      job.status = "running";
      job.pullRequest = {
        number: 20,
        url: "https://github.com/example/project/pull/20",
        state: "OPEN",
        headRef: job.branch,
        baseRef: job.baseRef,
        headSha: candidateSha,
        mergeSha: null,
      };
      store.save(job);
      class MergedSourceGitHub extends FakeGitHub {
        override async fetchIssue(number: number) {
          const issue = await super.fetchIssue(number);
          return scenario === "child-closed" && number === 1 ? { ...issue, state: "CLOSED" as const } : issue;
        }
        override async inspectPullRequest() {
          return {
            pullRequest: { ...job.pullRequest!, state: "MERGED" as const, mergeSha },
            checks: { state: "success" as const, missing: [], failures: [], pending: [] },
            mergedAt: new Date().toISOString(),
          };
        }
      }
      const gitClient = new TestGitClient(config);
      const controller = new ReleaseController({ store, git: gitClient, github: new MergedSourceGitHub(), codex: new FakeCodex(gitClient), validator: new Validator(config) });
      const result = await controller.step(job.id);
      const blocked = store.load(job.id);
      assert.equal(result.action, "blocked", scenario);
      assert.equal(blocked.blocked?.code, "merged_without_controller_authority", scenario);
      assert.notEqual(blocked.status, "completed");
    } finally { repo.cleanup(); }
  }
});

test("required check missing, pending, or failed never authorizes merge", async () => {
  const scenarios = [
    {
      action: "required_check_missing",
      checks: [],
    },
    {
      action: "required_check_pending",
      checks: [{ name: "verify", status: "IN_PROGRESS", conclusion: null, app: { id: 15368 } }],
    },
    {
      action: "blocked",
      checks: [{ name: "verify", status: "COMPLETED", conclusion: "FAILURE", app: { id: 15368 } }],
    },
  ];
  for (const scenario of scenarios) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo, {
        policy: { ...testConfig(repo).policy, maxCodeRepairRounds: 0 },
      } as any);
      const plan = testPlan(repo, [1]);
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const candidateSha = git(repo.source, ["rev-parse", "origin/main"]);
      const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
      job.baseSha = candidateSha;
      job.candidateSha = candidateSha;
      job.phase = "deliver";
      job.pullRequest = {
        number: 18,
        url: "https://github.com/example/project/pull/18",
        state: "OPEN",
        headRef: job.branch,
        baseRef: job.baseRef,
        headSha: candidateSha,
        mergeSha: null,
      };
      store.save(job);
      class ChecksGitHub extends FakeGitHub {
        override async inspectPullRequest() {
          return {
            pullRequest: job.pullRequest!,
            checks: summarizeChecks(scenario.checks, config.delivery.requiredChecks),
            mergedAt: null,
          };
        }
      }
      const gitClient = new TestGitClient(config);
      const controller = new ReleaseController({ store, git: gitClient, github: new ChecksGitHub(), codex: new FakeCodex(gitClient), validator: new Validator(config) });
      const result = await controller.step(job.id);
      assert.equal(result.action, scenario.action);
      const observed = store.load(job.id);
      assert.notEqual(observed.deliveryAuthority?.status, "authorized");
      if (scenario.action === "blocked") assert.equal(observed.blocked?.code, "ci_code_repair_exhausted");
    } finally { repo.cleanup(); }
  }
});

test("auto-merge fails closed when GitHub cannot prove latest-base protection", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    class UnprotectedGitHub extends FakeGitHub {
      enabled = false;
      pr: any = null;
      override async createPullRequest(job: JobState) {
        this.pr = { number: 19, url: "https://github.com/example/project/pull/19", state: "OPEN", headRef: job.branch, baseRef: job.baseRef, headSha: job.candidateSha, mergeSha: null };
        return this.pr;
      }
      override async inspectPullRequest() {
        return {
          pullRequest: this.pr,
          checks: summarizeChecks([{ name: "verify", status: "COMPLETED", conclusion: "SUCCESS", app: { id: 15368 } }], config.delivery.requiredChecks),
          mergedAt: null,
        };
      }
      override async baseAllowsUpToDateAutoMerge() { return false; }
      override async enableAutoMerge() { this.enabled = true; }
    }
    const github = new UnprotectedGitHub();
    const gitClient = new TestGitClient(config);
    const controller = new ReleaseController({ store, git: gitClient, github, codex: new FakeCodex(gitClient), validator: new Validator(config) });
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    const blocked = await runToTerminal(controller, store, job.id);
    assert.equal(blocked.blocked?.code, "base_up_to_date_policy_unverified");
    assert.equal(github.enabled, false);
  } finally { repo.cleanup(); }
});

test("delivery rejects an existing PR that targets the wrong base branch", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: { setup: [], issue: [], release: [], maxOutputBytes: 64 * 1024 },
      delivery: {
        ...testConfig(repo).delivery,
        mergeMethod: "squash",
      },
    } as any);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new TestGitClient(config);
    class WrongBaseGitHub extends FakeGitHub {
      override async createPullRequest(job: any) {
        return {
          number: 9,
          url: "https://github.com/example/project/pull/9",
          state: "OPEN" as const,
          headRef: job.branch,
          baseRef: "wrong-base",
          headSha: job.candidateSha,
          mergeSha: null,
        };
      }
    }
    const controller = new ReleaseController({
      store, git: gitClient, github: new WrongBaseGitHub(),
      codex: new FakeCodex(gitClient), validator: new Validator(config),
    });
    const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    const final = await runToTerminal(controller, store, created.id);
    assert.equal(final.status, "blocked");
    assert.equal(final.blocked?.code, "pull_request_identity_mismatch");
  } finally { repo.cleanup(); }
});

test("abort revokes auto-merge and quarantines the exact remote branch", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new TestGitClient(config);
    const candidateSha = git(repo.source, ["rev-parse", "HEAD"]);
    let autoMergeEnabled = true;
    let disabled = 0;
    class LifecycleGitHub extends FakeGitHub {
      override async inspectPullRequest() {
        return {
          pullRequest: { number: 44, url: "https://github.com/example/project/pull/44", state: "OPEN" as const, headRef: "agent/release/release-fixture", baseRef: "main", headSha: candidateSha, mergeSha: null },
          checks: { state: "success" as const, missing: [], failures: [], pending: [] },
          mergedAt: null,
          autoMergeEnabled,
        };
      }
      override async disableAutoMerge(_number: number, sha: string) {
        assert.equal(sha, candidateSha);
        disabled += 1;
        autoMergeEnabled = false;
      }
    }
    const controller = new ReleaseController({ store, git: gitClient, github: new LifecycleGitHub(), codex: new FakeCodex(gitClient), validator: new Validator(config) });
    let job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.baseSha = plan.baseSha;
    job.candidateSha = candidateSha;
    job.phase = "deliver";
    job.pullRequest = { number: 44, url: "https://github.com/example/project/pull/44", state: "OPEN", headRef: job.branch, baseRef: job.baseRef, headSha: candidateSha, mergeSha: null };
    job.deliveryAuthority = { version: 1, pullRequest: job.pullRequest, candidateSha, proofDigest: "a".repeat(64), status: "authorized", autoMergeEnabled: true, quarantined: false, lastVerifiedAt: new Date().toISOString(), revocationReason: null, error: null };
    store.save(job);
    job = await controller.abort(job.id, "operator requested stop");
    assert.equal(job.status, "failed");
    assert.equal(job.pullRequest?.state, "OPEN");
    assert.equal(job.deliveryAuthority?.status, "revoked");
    assert.equal(job.deliveryAuthority?.quarantined, true);
    assert.equal(disabled, 1);
  } finally { repo.cleanup(); }
});

test("Issue text drift after admission does not invalidate an authorized Job", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: { setup: [], issue: [{ command: "test -f issue-$HERDR_ISSUE_NUMBER.txt" }], release: [{ command: "test -f issue-1.txt" }], maxOutputBytes: 64 * 1024 },
    } as any);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new TestGitClient(config);
    let pr: any = null;
    let autoMergeEnabled = false;
    let drift = false;
    let disabled = 0;
    class DriftGitHub extends FakeGitHub {
      override async fetchIssue(number: number) {
        const snapshot = await super.fetchIssue(number);
        if (!drift || number !== 1) return snapshot;
        const { digest: _digest, ...body } = snapshot;
        const changed = { ...body, title: `${body.title} drifted` };
        return { ...changed, digest: digestJson(changed) };
      }
      override async createPullRequest(job: any) {
        pr = { number: 48, url: "https://github.com/example/project/pull/48", state: "OPEN", headRef: job.branch, baseRef: job.baseRef, headSha: job.candidateSha, mergeSha: null };
        return pr;
      }
      override async inspectPullRequest() {
        return {
          pullRequest: { ...pr, state: "OPEN" as const },
          checks: summarizeChecks([{ name: "verify", status: "COMPLETED", conclusion: "SUCCESS", app: { id: 15368 } }], config.delivery.requiredChecks),
          mergedAt: null,
          autoMergeEnabled,
        };
      }
      override async enableAutoMerge() { autoMergeEnabled = true; }
      override async disableAutoMerge() { autoMergeEnabled = false; disabled += 1; }
    }
    const github = new DriftGitHub();
    const controller = new ReleaseController({ store, git: gitClient, github, codex: new FakeCodex(gitClient), validator: new Validator(config) });
    const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    let job = store.load(created.id);
    for (let index = 0; index < 100 && job.deliveryAuthority?.status !== "authorized"; index += 1) {
      await controller.step(job.id);
      job = store.load(job.id);
      if (job.status === "blocked") throw new Error(job.blocked?.message);
    }
    assert.equal(job.deliveryAuthority?.status, "authorized");
    drift = true;
    const result = await controller.step(job.id);
    job = store.load(job.id);
    assert.equal(result.action, "awaiting_merge");
    assert.equal(job.blocked, null);
    assert.equal(job.deliveryAuthority?.status, "authorized");
    assert.equal(job.pullRequest?.state, "OPEN");
    assert.equal(disabled, 0);
  } finally { repo.cleanup(); }
});

test("revocation refuses a wrong PR identity", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = highRiskPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new TestGitClient(config);
    const candidateSha = git(repo.source, ["rev-parse", "HEAD"]);
    class WrongIdentityGitHub extends FakeGitHub {
      override async inspectPullRequest() {
        return {
          pullRequest: { number: 45, url: "https://github.com/example/project/pull/45", state: "OPEN" as const, headRef: "agent/release/high-risk-release-fixture", baseRef: "main", headSha: "f".repeat(40), mergeSha: null },
          checks: { state: "success" as const, missing: [], failures: [], pending: [] },
          mergedAt: null,
          autoMergeEnabled: true,
        };
      }
    }
    const controller = new ReleaseController({ store, git: gitClient, github: new WrongIdentityGitHub(), codex: new FakeCodex(gitClient), validator: new Validator(config) });
    let job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.baseSha = plan.baseSha;
    job.candidateSha = candidateSha;
    job.phase = "deliver";
    job.pullRequest = { number: 45, url: "https://github.com/example/project/pull/45", state: "OPEN", headRef: job.branch, baseRef: job.baseRef, headSha: candidateSha, mergeSha: null };
    job.deliveryAuthority = { version: 1, pullRequest: job.pullRequest, candidateSha, proofDigest: "b".repeat(64), status: "authorized", autoMergeEnabled: true, quarantined: false, lastVerifiedAt: new Date().toISOString(), revocationReason: null, error: null };
    store.save(job);
    await assert.rejects(() => controller.abort(job.id, "stop"), (error: any) => error?.code === "delivery_authority_revocation_failed");
    assert.equal(store.load(job.id).deliveryAuthority?.status, "revocation_failed");
  } finally { repo.cleanup(); }
});

test("revocation resumes after interruption between disable and quarantine", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = highRiskPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    class InterruptedQuarantineGit extends TestGitClient {
      quarantineAttempts = 0;
      override async quarantineRemoteBranch(job: any, sha: string) {
        this.quarantineAttempts += 1;
        if (this.quarantineAttempts === 1) throw new Error("transport interrupted");
        return super.quarantineRemoteBranch(job, sha);
      }
    }
    const gitClient = new InterruptedQuarantineGit(config);
    const candidateSha = git(repo.source, ["rev-parse", "HEAD"]);
    let autoMergeEnabled = true;
    class InterruptedLifecycleGitHub extends FakeGitHub {
      override async inspectPullRequest() {
        return {
          pullRequest: { number: 49, url: "https://github.com/example/project/pull/49", state: "OPEN" as const, headRef: "agent/release/high-risk-release-fixture", baseRef: "main", headSha: candidateSha, mergeSha: null },
          checks: { state: "success" as const, missing: [], failures: [], pending: [] },
          mergedAt: null,
          autoMergeEnabled,
        };
      }
      override async disableAutoMerge() { autoMergeEnabled = false; }
    }
    const github = new InterruptedLifecycleGitHub();
    const controller = new ReleaseController({ store, git: gitClient, github, codex: new FakeCodex(gitClient), validator: new Validator(config) });
    let job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.baseSha = plan.baseSha;
    job.candidateSha = candidateSha;
    job.phase = "deliver";
    job.pullRequest = { number: 49, url: "https://github.com/example/project/pull/49", state: "OPEN", headRef: job.branch, baseRef: job.baseRef, headSha: candidateSha, mergeSha: null };
    job.deliveryAuthority = { version: 1, pullRequest: job.pullRequest, candidateSha, proofDigest: "e".repeat(64), status: "authorized", autoMergeEnabled: true, quarantined: false, lastVerifiedAt: new Date().toISOString(), revocationReason: null, error: null };
    store.save(job);
    await assert.rejects(() => controller.abort(job.id, "first abort"), (error: any) => error?.code === "delivery_authority_revocation_failed");
    assert.equal(store.load(job.id).deliveryAuthority?.status, "revocation_failed");
    job = await new ReleaseController({ store: new JobStore(config), git: gitClient, github, codex: new FakeCodex(gitClient), validator: new Validator(config) }).abort(job.id, "resume abort");
    assert.equal(job.status, "failed");
    assert.equal(job.deliveryAuthority?.status, "revoked");
    assert.equal(job.pullRequest?.state, "OPEN");
    assert.equal(job.deliveryAuthority?.quarantined, true);
    assert.equal(gitClient.quarantineAttempts, 2);
  } finally { repo.cleanup(); }
});

test("missing and pending required checks reach durable deadlines without resetting on restart", async () => {
  for (const scenario of ["missing", "pending"] as const) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo);
      const contract = config.delivery.requiredChecks as Exclude<typeof config.delivery.requiredChecks, string[]>;
      const plan = highRiskPlan(repo, [1]);
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const gitClient = new TestGitClient(config);
      const candidateSha = git(repo.source, ["rev-parse", "HEAD"]);
      class DeadlineGitHub extends FakeGitHub {
        override async inspectPullRequest() {
          const checks = scenario === "missing"
            ? summarizeChecks([], contract)
            : summarizeChecks([{ name: "verify", status: "IN_PROGRESS", conclusion: null, app: { id: 15368 } }], contract);
          return {
            pullRequest: { number: 46, url: "https://github.com/example/project/pull/46", state: "OPEN" as const, headRef: "agent/release/high-risk-release-fixture", baseRef: "main", headSha: candidateSha, mergeSha: null },
            checks,
            mergedAt: null,
            autoMergeEnabled: false,
          };
        }
      }
      const controller = new ReleaseController({ store, git: gitClient, github: new DeadlineGitHub(), codex: new FakeCodex(gitClient), validator: new Validator(config) });
      let job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
      job.baseSha = plan.baseSha;
      job.candidateSha = candidateSha;
      job.phase = "deliver";
      job.pullRequest = { number: 46, url: "https://github.com/example/project/pull/46", state: "OPEN", headRef: job.branch, baseRef: job.baseRef, headSha: candidateSha, mergeSha: null };
      job.deliveryAuthority = { version: 1, pullRequest: job.pullRequest, candidateSha, proofDigest: "c".repeat(64), status: "pending", autoMergeEnabled: false, quarantined: false, lastVerifiedAt: new Date().toISOString(), revocationReason: null, error: null };
      job.ciGate = {
        version: 1,
        candidateSha,
        checkContractDigest: digestJson(config.delivery.requiredChecks),
        firstObservedAt: "2026-08-30T00:00:00.000Z",
        firstAppearanceDeadlineAt: scenario === "missing" ? "2026-08-30T00:00:01.000Z" : "2099-01-01T00:00:00.000Z",
        pendingDeadlineAt: scenario === "pending" ? "2026-08-30T00:00:01.000Z" : null,
        attempts: 1,
        lastObservation: null,
      };
      store.save(job);
      const first = await controller.step(job.id);
      job = store.load(job.id);
      assert.equal(first.action, "blocked");
      assert.equal(job.blocked?.code, scenario === "missing" ? "required_check_missing_deadline" : "required_check_pending_deadline");
      assert.equal(job.deliveryAuthority?.status, "revoked");
      assert.equal(job.pullRequest?.state, "OPEN");
      const deadline = scenario === "missing" ? job.ciGate?.firstAppearanceDeadlineAt : job.ciGate?.pendingDeadlineAt;
      await controller.step(job.id);
      assert.equal(scenario === "missing" ? store.load(job.id).ciGate?.firstAppearanceDeadlineAt : store.load(job.id).ciGate?.pendingDeadlineAt, deadline);
    } finally { repo.cleanup(); }
  }
});

test("CI code and infrastructure failures consume separate budgets and only code gets bounded evidence", async () => {
  for (const scenario of ["code", "infrastructure"] as const) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo, {
        policy: { ...testConfig(repo).policy, maxCodeRepairRounds: 1 },
      } as any);
      const contract = config.delivery.requiredChecks as Exclude<typeof config.delivery.requiredChecks, string[]>;
      const plan = highRiskPlan(repo, [1]);
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const gitClient = new TestGitClient(config);
      const candidateSha = git(repo.source, ["rev-parse", "HEAD"]);
      let evidenceReads = 0;
      let reruns = 0;
      class ClassifiedGitHub extends FakeGitHub {
        override async inspectPullRequest() {
          const conclusion = scenario === "code" ? "FAILURE" : "CANCELLED";
          return {
            pullRequest: { number: 47, url: "https://github.com/example/project/pull/47", state: "OPEN" as const, headRef: "agent/release/high-risk-release-fixture", baseRef: "main", headSha: candidateSha, mergeSha: null },
            checks: summarizeChecks([{ name: "verify", status: "COMPLETED", conclusion, app: { id: 15368 }, detailsUrl: "https://github.com/example/project/actions/runs/123/job/456" }], contract),
            mergedAt: null,
            autoMergeEnabled: false,
          };
        }
        override async fetchCheckFailureEvidence(check: any, sha: string) {
          evidenceReads += 1;
          const body = { version: 1 as const, candidateSha: sha, check, log: "bounded failure", logBytes: 15, logSha256: `sha256:${"1".repeat(64)}`, observedAt: new Date().toISOString() };
          return { ...body, digest: `sha256:${digestJson(body)}` };
        }
        override async rerunCheck(_check: any, sha: string) { assert.equal(sha, candidateSha); reruns += 1; }
      }
      const controller = new ReleaseController({ store, git: gitClient, github: new ClassifiedGitHub(), codex: new FakeCodex(gitClient), validator: new Validator(config) });
      let job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
      job.baseSha = plan.baseSha;
      job.candidateSha = candidateSha;
      job.phase = "deliver";
      job.pullRequest = { number: 47, url: "https://github.com/example/project/pull/47", state: "OPEN", headRef: job.branch, baseRef: job.baseRef, headSha: candidateSha, mergeSha: null };
      job.deliveryAuthority = { version: 1, pullRequest: job.pullRequest, candidateSha, proofDigest: "d".repeat(64), status: "pending", autoMergeEnabled: false, quarantined: false, lastVerifiedAt: new Date().toISOString(), revocationReason: null, error: null };
      store.save(job);
      const result = await controller.step(job.id);
      job = store.load(job.id);
      if (scenario === "code") {
        assert.equal(result.action, "release_repair_scheduled");
        assert.equal(job.phase, "repair");
        assert.equal(job.codeRepairRounds, 1);
        assert.equal(job.infrastructureReruns, 0);
        assert.equal(evidenceReads, 1);
        assert.equal(reruns, 0);
        assert.equal(job.deliveryAuthority?.status, "revoked");
      } else {
        assert.equal(result.action, "ci_infrastructure_rerun");
        assert.equal(job.phase, "deliver");
        assert.equal(job.infrastructureReruns, 1);
        assert.equal(job.codeRepairRounds, 0);
        assert.equal(evidenceReads, 0);
        assert.equal(reruns, 1);
        assert.equal(job.pullRequest?.state, "OPEN");
      }
    } finally { repo.cleanup(); }
  }
});

test("a Controller hardening commit is salvaged after a crash before job state update", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: {
        setup: [],
        issue: [{ command: "test -f issue-$HERDR_ISSUE_NUMBER.txt" }],
        release: [{ command: "test -f issue-1.txt" }],
        maxOutputBytes: 64 * 1024,
      },
    } as any);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new TestGitClient(config);
    let reviewCalls = 0;
    const codex = new FakeCodex(gitClient, async (input) => {
      if (input.kind === "review") {
        reviewCalls += 1;
        return { review: { status: "changes", summary: "Need fix", findings: [{ severity: "major", path: "issue-1.txt", line: 1, summary: "fixture", rationale: "fixture", recommendation: "fix", relatedIssues: [1] }] } };
      }
      return {};
    });
    const controller = new ReleaseController({ store, git: gitClient, github: new FakeGitHub(), codex, validator: new Validator(config) });
    const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    let job = store.load(created.id);
    for (let index = 0; index < 100 && job.phase !== "repair"; index += 1) {
      await controller.step(job.id);
      job = store.load(job.id);
      if (job.status === "blocked") throw new Error(job.blocked?.message);
    }
    assert.equal(job.phase, "repair");
    const baseHead = await gitClient.head(job.worktreePath);
    job.activeRun = { id: "crashed-hardening", kind: "release-repair", issueNumber: null, startedAt: new Date().toISOString(), baseHeadSha: baseHead };
    store.save(job);
    writeFileSync(join(job.worktreePath, "hardening.txt"), "fixed\n", "utf8");
    await gitClient.commitHardening(job, "synthetic crash window");
    const result = await controller.step(job.id);
    job = store.load(job.id);
    assert.equal(result.action, "hardening_commit_salvaged");
    assert.equal(job.phase, "verify");
    assert.equal(job.activeRun, null);
    assert.equal(reviewCalls, 1);
  } finally { repo.cleanup(); }
});
