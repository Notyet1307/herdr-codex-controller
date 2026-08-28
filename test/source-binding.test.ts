import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReleaseController } from "../src/controller.js";
import { GitClient } from "../src/git.js";
import { JobStore } from "../src/state.js";
import { Validator } from "../src/validator.js";
import type { ControllerConfig, IssueSnapshot, JobState } from "../src/types.js";
import { digestJson } from "../src/util.js";
import {
  FakeCodex,
  FakeGitHub,
  createTestRepo,
  testConfig,
  testPlanV2,
  writeInputs,
} from "./support.js";

class CountingGit extends GitClient {
  ensureCalls = 0;
  commitCalls = 0;
  pushCalls = 0;

  constructor(config: ControllerConfig, private readonly baseOverride: string | null = null) {
    super(config);
  }

  override async fetchBase(): Promise<string> {
    return this.baseOverride ?? super.fetchBase();
  }

  override async ensureWorktree(job: JobState): Promise<void> {
    this.ensureCalls += 1;
    return super.ensureWorktree(job);
  }

  override async commitIssue(
    job: JobState,
    issueNumber: number,
    title: string,
    allowNoop: boolean,
  ): Promise<{ sha: string; created: boolean }> {
    this.commitCalls += 1;
    return super.commitIssue(job, issueNumber, title, allowNoop);
  }

  override async push(job: JobState): Promise<void> {
    this.pushCalls += 1;
    return super.push(job);
  }
}

class CountingValidator extends Validator {
  calls = 0;

  override run(input: Parameters<Validator["run"]>[0]) {
    this.calls += 1;
    return super.run(input);
  }
}

class SourceGitHub extends FakeGitHub {
  readonly fetchOrder: number[] = [];
  createPullRequestCalls = 0;

  constructor(private readonly changes = new Map<number, Partial<IssueSnapshot>>()) {
    super();
  }

  override async fetchIssue(number: number): Promise<IssueSnapshot> {
    this.fetchOrder.push(number);
    const snapshot = await super.fetchIssue(number);
    return { ...snapshot, ...this.changes.get(number) };
  }

  override async createPullRequest(job: JobState, deliveryRoot: string) {
    this.createPullRequestCalls += 1;
    return super.createPullRequest(job, deliveryRoot);
  }
}

test("Release Plan v2 verifies exact base, Parent, and every Child before preparing", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlanV2(repo);
    const originalPlan = structuredClone(plan);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const git = new CountingGit(config);
    const github = new SourceGitHub();
    const codex = new FakeCodex(git);
    const validator = new CountingValidator(config);
    const controller = new ReleaseController({ store, git, github, codex, validator });
    const created = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });
    assert.equal(created.baseSha, null);

    writeFileSync(planPath, '{"version":999}\n', "utf8");
    const result = await controller.step(created.id);
    const job = store.load(created.id);

    assert.equal(result.action, "release_prepared");
    assert.equal(job.phase, "implement");
    assert.equal(job.baseSha, plan.source.baseSha);
    assert.deepEqual(job.plan, originalPlan);
    assert.equal(job.planDigest, digestJson(originalPlan));
    assert.deepEqual(github.fetchOrder, [100, 1, 2]);
    assert.equal(git.ensureCalls, 1);
    assert.equal(validator.calls, 1);
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(job.issues.map((issue) => issue.snapshot?.number), [1, 2]);
    const parent = JSON.parse(readFileSync(join(store.issuesRoot(job.id), "parent-issue-100.json"), "utf8"));
    assert.equal(parent.number, 100);
  } finally { repo.cleanup(); }
});

test("every Release Plan v2 source drift fails with zero Worktree, setup, or Codex side effects", async () => {
  const scenarios: Array<{
    name: string;
    code: string;
    baseOverride?: string;
    changes?: Array<[number, Partial<IssueSnapshot>]>;
    secretBody?: string;
  }> = [
    { name: "base drift", code: "plan_base_drift", baseOverride: "f".repeat(40) },
    { name: "Parent closed", code: "plan_parent_not_open", changes: [[100, { state: "CLOSED" }]] },
    { name: "Parent title drift", code: "plan_parent_drift", changes: [[100, { title: "Changed Parent" }]] },
    {
      name: "Parent body drift",
      code: "plan_parent_drift",
      changes: [[100, { body: "PRIVATE PARENT BODY MUST NOT BE ECHOED" }]],
      secretBody: "PRIVATE PARENT BODY MUST NOT BE ECHOED",
    },
    { name: "Child closed", code: "plan_issue_not_open", changes: [[1, { state: "CLOSED" }]] },
    { name: "Child title drift", code: "plan_issue_drift", changes: [[1, { title: "Changed Child" }]] },
    {
      name: "Child body drift",
      code: "plan_issue_drift",
      changes: [[1, { body: "PRIVATE CHILD BODY MUST NOT BE ECHOED" }]],
      secretBody: "PRIVATE CHILD BODY MUST NOT BE ECHOED",
    },
  ];

  for (const scenario of scenarios) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo);
      const plan = testPlanV2(repo);
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const git = new CountingGit(config, scenario.baseOverride ?? null);
      const github = new SourceGitHub(new Map(scenario.changes ?? []));
      const codex = new FakeCodex(git);
      const validator = new CountingValidator(config);
      const controller = new ReleaseController({ store, git, github, codex, validator });
      const created = store.create({
        configPath,
        planPath,
        plan,
        configDigest: digestJson(config),
        planDigest: digestJson(plan),
      });

      const result = await controller.step(created.id);
      const job = store.load(created.id);
      assert.equal(result.action, "blocked", scenario.name);
      assert.match(result.message, /replan_required/, scenario.name);
      assert.equal(job.blocked?.code, "replan_required", scenario.name);
      assert.match(job.blocked?.message ?? "", new RegExp(scenario.code), scenario.name);
      assert.equal(
        job.baseSha,
        scenario.code === "plan_base_drift" ? null : plan.source.baseSha,
        scenario.name,
      );
      assert.equal(git.ensureCalls, 0, scenario.name);
      assert.equal(validator.calls, 0, scenario.name);
      assert.equal(codex.calls.length, 0, scenario.name);
      assert.equal(git.commitCalls, 0, scenario.name);
      assert.equal(git.pushCalls, 0, scenario.name);
      assert.equal(github.createPullRequestCalls, 0, scenario.name);
      assert.equal(existsSync(created.worktreePath), false, scenario.name);
      if (scenario.secretBody) assert.doesNotMatch(job.blocked?.message ?? "", new RegExp(scenario.secretBody));
    } finally { repo.cleanup(); }
  }
});

test("v2 job reload retains the complete plan and rejects config or plan mutation", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlanV2(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const git = new CountingGit(config);
    const controller = new ReleaseController({
      store,
      git,
      github: new SourceGitHub(),
      codex: new FakeCodex(git),
      validator: new CountingValidator(config),
    });
    const created = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });
    assert.deepEqual(store.load(created.id).plan, plan);

    const raw = JSON.parse(readFileSync(store.path(created.id), "utf8"));
    raw.plan.source.specContentHash = `sha256:${"0".repeat(64)}`;
    writeFileSync(store.path(created.id), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    assert.throws(() => store.load(created.id), /plan digest drifted/);
  } finally { repo.cleanup(); }
});

test("v2 config drift blocks before source verification side effects", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlanV2(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const git = new CountingGit(config);
    const codex = new FakeCodex(git);
    const validator = new CountingValidator(config);
    const controller = new ReleaseController({ store, git, github: new SourceGitHub(), codex, validator });
    const created = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });
    config.branchPrefix = "changed/release";
    await controller.step(created.id);
    const job = store.load(created.id);
    assert.equal(job.blocked?.code, "config_drift");
    assert.equal(git.ensureCalls, 0);
    assert.equal(validator.calls, 0);
    assert.equal(codex.calls.length, 0);
  } finally { repo.cleanup(); }
});
