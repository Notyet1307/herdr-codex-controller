import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { GitClient } from "../src/git.js";
import { Validator } from "../src/validator.js";
import { JobStore } from "../src/state.js";
import { ReleaseController } from "../src/controller.js";
import { digestJson } from "../src/util.js";
import {
  FakeCodex,
  FakeGitHub,
  completedWorker,
  createTestRepo,
  git,
  testConfig,
  testPlan,
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

test("two ordered Issues use fresh Workers, one aggregate review, and Controller-owned commits", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlan([1, 2]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new GitClient(config);
    const codex = new FakeCodex(gitClient);
    const controller = new ReleaseController({ store, git: gitClient, github: new FakeGitHub(), codex, validator: new Validator(config) });
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    const final = await runToTerminal(controller, store, job.id);
    assert.equal(final.status, "completed");
    assert.equal(final.phase, "complete");
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
    const plan = testPlan([1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new GitClient(config);
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
    const final = await runToTerminal(controller, store, job.id);
    assert.equal(final.status, "completed");
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
    const plan = testPlan([1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new GitClient(config);
    let reviews = 0;
    const codex = new FakeCodex(gitClient, async (input) => {
      if (input.kind === "review") {
        reviews += 1;
        return reviews === 1
          ? { review: { status: "changes", summary: "Needs hardening", findings: [{ severity: "major", path: "issue-1.txt", line: 1, summary: "Missing hardening evidence", rationale: "Fixture", recommendation: "Add hardening.txt", relatedIssues: [1] }] } }
          : { review: { status: "pass", summary: "Hardened candidate passes", findings: [] } };
      }
      return {};
    });
    const controller = new ReleaseController({ store, git: gitClient, github: new FakeGitHub(), codex, validator: new Validator(config) });
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    const final = await runToTerminal(controller, store, job.id);
    assert.equal(final.status, "completed");
    assert.equal(final.hardeningRounds, 1);
    assert.equal(final.reviewRound, 2);
    assert.equal(codex.calls.filter((call) => call.kind === "release-harden").length, 1);
    assert.equal(git(final.worktreePath, ["rev-list", "--count", "HEAD"]), "3");
  } finally { repo.cleanup(); }
});

test("an interrupted Worker run is reconciled as a fresh recovery run without session resume", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: { setup: [], issue: [], release: [], maxOutputBytes: 64 * 1024 },
      review: { enabled: false, blockingSeverities: ["critical", "major"] },
    } as any);
    const plan = testPlan([1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new GitClient(config);
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
    assert.equal(active.phase, "implement");
  } finally { repo.cleanup(); }
});

test("delivery binds one exact PR candidate and stops at a manual merge gate", async () => {
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
        createPullRequest: true,
        draft: false,
        autoMerge: false,
        mergeMethod: "squash",
        allowNoChecks: false,
        pollIntervalMs: 1_000,
      },
    } as any);
    const plan = testPlan([1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new GitClient(config);
    class DeliveryGitHub extends FakeGitHub {
      pr: any = null;
      merged = false;
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
        const pullRequest = { ...this.pr, state: this.merged ? "MERGED" : "OPEN", mergeSha: this.merged ? "f".repeat(40) : null };
        return { pullRequest, checks: { state: "success" as const, failures: [], pending: [] }, mergedAt: this.merged ? new Date().toISOString() : null };
      }
    }
    const github = new DeliveryGitHub();
    const controller = new ReleaseController({ store, git: gitClient, github, codex: new FakeCodex(gitClient), validator: new Validator(config) });
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    let observed = store.load(job.id);
    for (let index = 0; index < 100 && observed.status !== "ready_to_merge"; index += 1) {
      await controller.step(job.id);
      observed = store.load(job.id);
      if (observed.status === "blocked") throw new Error(observed.blocked?.message);
    }
    assert.equal(observed.status, "ready_to_merge");
    assert.equal(observed.pullRequest?.number, 7);
    assert.equal(observed.pullRequest?.headSha, observed.candidateSha);
    github.merged = true;
    const result = await controller.step(job.id);
    assert.equal(result.action, "release_merged");
    assert.equal(store.load(job.id).status, "completed");
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
        createPullRequest: true,
        draft: false,
        autoMerge: true,
        mergeMethod: "squash",
        allowNoChecks: false,
        pollIntervalMs: 1_000,
      },
    } as any);
    const plan = testPlan([1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new GitClient(config);
    class AutoMergeGitHub extends FakeGitHub {
      pr: any = null;
      enabled: { number: number; candidateSha: string } | null = null;
      merged = false;
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
          mergeSha: this.merged ? "e".repeat(40) : null,
        };
        return {
          pullRequest,
          checks: { state: "success" as const, failures: [], pending: [] },
          mergedAt: this.merged ? new Date().toISOString() : null,
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
    assert.equal(observed.phase, "awaiting_merge");
    github.merged = true;
    const result = await controller.step(created.id);
    assert.equal(result.action, "release_merged");
    assert.equal(store.load(created.id).status, "completed");
  } finally { repo.cleanup(); }
});

test("delivery rejects an existing PR that targets the wrong base branch", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: { setup: [], issue: [], release: [], maxOutputBytes: 64 * 1024 },
      review: { enabled: false, blockingSeverities: ["critical", "major"] },
      delivery: {
        createPullRequest: true, draft: false, autoMerge: false, mergeMethod: "squash",
        allowNoChecks: false, pollIntervalMs: 1_000,
      },
    } as any);
    const plan = testPlan([1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new GitClient(config);
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
    const plan = testPlan([1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new GitClient(config);
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
    for (let index = 0; index < 100 && job.phase !== "harden"; index += 1) {
      await controller.step(job.id);
      job = store.load(job.id);
      if (job.status === "blocked") throw new Error(job.blocked?.message);
    }
    assert.equal(job.phase, "harden");
    const baseHead = await gitClient.head(job.worktreePath);
    job.activeRun = { id: "crashed-hardening", kind: "release-harden", issueNumber: null, startedAt: new Date().toISOString(), baseHeadSha: baseHead };
    store.save(job);
    writeFileSync(join(job.worktreePath, "hardening.txt"), "fixed\n", "utf8");
    await gitClient.commitHardening(job, "synthetic crash window");
    const result = await controller.step(job.id);
    job = store.load(job.id);
    assert.equal(result.action, "hardening_commit_salvaged");
    assert.equal(job.phase, "release_validate");
    assert.equal(job.activeRun, null);
    assert.equal(reviewCalls, 1);
  } finally { repo.cleanup(); }
});
