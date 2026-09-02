import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ReleaseController } from "../src/controller.js";
import { JobStore } from "../src/state.js";
import { Validator } from "../src/validator.js";
import type { ControllerConfig, IssueSnapshot, JobState } from "../src/types.js";
import { digestJson } from "../src/util.js";
import { summarizeChecks } from "../src/github.js";
import { FakeCodex, FakeGitHub, TestGitClient, createTestRepo, git, testConfig, testPlan, writeInputs } from "./support.js";

class CountingGit extends TestGitClient {
  ensureCalls = 0;
  pushCalls = 0;
  constructor(config: ControllerConfig, private readonly baseOverride: string | null = null) { super(config); }
  override async fetchBase() { return this.baseOverride ?? super.fetchBase(); }
  override async ensureWorktree(job: JobState) { this.ensureCalls += 1; return super.ensureWorktree(job); }
  override async push(job: JobState) { this.pushCalls += 1; return super.push(job); }
}

class SourceGitHub extends FakeGitHub {
  fetches: number[] = [];
  constructor(private readonly changes = new Map<number, Partial<IssueSnapshot>>()) { super(); }
  override async fetchIssue(number: number) {
    this.fetches.push(number);
    return { ...await super.fetchIssue(number), ...this.changes.get(number) };
  }
}

test("admission verifies exact base and every Parent/Child is open before creating a Worktree", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlan(repo, [1, 2]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new CountingGit(config);
    const github = new SourceGitHub();
    const controller = new ReleaseController({ store, git: gitClient, github, codex: new FakeCodex(gitClient), validator: new Validator(config, gitClient) });
    const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    const result = await controller.step(created.id);
    assert.equal(result.action, "release_prepared");
    assert.deepEqual(github.fetches, [100, 1, 2]);
    assert.equal(gitClient.ensureCalls, 1);
    assert.equal(store.load(created.id).baseSha, plan.baseSha);
  } finally { repo.cleanup(); }
});

test("base or Issue state drift fails before Worktree, validation, or Codex", async () => {
  for (const scenario of ["base", "parent", "child"] as const) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo);
      const plan = testPlan(repo, [1]);
      const changes = new Map<number, Partial<IssueSnapshot>>();
      if (scenario === "parent") changes.set(100, { state: "CLOSED" });
      if (scenario === "child") changes.set(1, { state: "CLOSED" });
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const gitClient = new CountingGit(config, scenario === "base" ? "f".repeat(40) : null);
      const codex = new FakeCodex(gitClient);
      const controller = new ReleaseController({ store, git: gitClient, github: new SourceGitHub(changes), codex, validator: new Validator(config, gitClient) });
      const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
      const result = await controller.step(created.id);
      assert.equal(result.action, "blocked", scenario);
      const blocked = store.load(created.id).blocked;
      assert.equal(blocked?.code, scenario === "base" ? "plan_base_drift" : scenario === "parent" ? "plan_parent_not_open" : "plan_issue_not_open", scenario);
      assert.equal(blocked?.kind, "replan_required", scenario);
      assert.equal(gitClient.ensureCalls, 0, scenario);
      assert.equal(codex.calls.length, 0, scenario);
      assert.equal(existsSync(created.worktreePath), false, scenario);
    } finally { repo.cleanup(); }
  }
});

test("Issue wording changes after admission do not invalidate the running Job", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlan(repo, [1]);
    const changes = new Map<number, Partial<IssueSnapshot>>();
    const github = new SourceGitHub(changes);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new CountingGit(config);
    const controller = new ReleaseController({ store, git: gitClient, github, codex: new FakeCodex(gitClient), validator: new Validator(config, gitClient) });
    const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    await controller.step(created.id);
    changes.set(1, { title: "wording changed" });
    assert.equal((await controller.step(created.id)).action, "worker_completed");
    assert.deepEqual(github.fetches, [100, 1]);
  } finally { repo.cleanup(); }
});

test("remote base is rechecked before delivery and auto-merge authorization", async () => {
  for (const boundary of ["delivery", "authorization"] as const) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo);
      const plan = testPlan(repo, [1]);
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const gitClient = new CountingGit(config);
      class DeliveryGitHub extends FakeGitHub {
        pr: NonNullable<JobState["pullRequest"]> | null = null;
        enabled = false;
        override async createPullRequest(job: JobState) {
          this.pr = { number: 32, url: "https://github.com/example/project/pull/32", state: "OPEN", headRef: job.branch, baseRef: job.baseRef, headSha: job.candidateSha!, mergeSha: null };
          return this.pr;
        }
        override async inspectPullRequest() {
          if (!this.pr) throw new Error("missing PR");
          return { pullRequest: this.pr, checks: summarizeChecks([{ name: "verify", status: "COMPLETED", conclusion: "SUCCESS", app: { id: 15368 } }], config.delivery.requiredChecks), mergedAt: null, autoMergeEnabled: false };
        }
        override async enableAutoMerge() { this.enabled = true; }
      }
      const github = new DeliveryGitHub();
      const controller = new ReleaseController({ store, git: gitClient, github, codex: new FakeCodex(gitClient), validator: new Validator(config, gitClient) });
      const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
      let job = store.load(created.id);
      for (let index = 0; index < 30 && (job.phase !== "deliver" || (boundary === "authorization" && job.pullRequest === null)); index += 1) {
        await controller.step(job.id);
        job = store.load(job.id);
        if (job.status === "blocked") throw new Error(job.blocked?.message);
      }
      writeFileSync(join(repo.source, "README.md"), `# drift ${boundary}\n`, "utf8");
      git(repo.source, ["add", "README.md"]);
      git(repo.source, ["commit", "-m", `drift ${boundary}`]);
      git(repo.source, ["push", "origin", "main"]);
      const result = await controller.step(job.id);
      job = store.load(job.id);
      assert.equal(result.action, "blocked", boundary);
      assert.equal(job.blocked?.code, "runtime_source_base_drift", boundary);
      assert.equal(job.blocked?.kind, "replan_required", boundary);
      assert.equal(github.enabled, false, boundary);
    } finally { repo.cleanup(); }
  }
});

test("Job reload rejects config or Plan digest drift", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new CountingGit(config);
    const controller = new ReleaseController({ store, git: gitClient, github: new SourceGitHub(), codex: new FakeCodex(gitClient), validator: new Validator(config, gitClient) });
    const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    store.config.policy.maxChangedLines += 1;
    const result = await controller.step(created.id);
    assert.equal(result.action, "blocked");
    assert.equal(store.load(created.id).blocked?.code, "config_drift");
  } finally { repo.cleanup(); }
});
