import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReleaseController } from "../src/controller.js";
import { GitClient } from "../src/git.js";
import { JobStore, retryBlockedJob } from "../src/state.js";
import { Validator } from "../src/validator.js";
import type { ControllerConfig, ControllerIdentity, IssueSnapshot, JobState } from "../src/types.js";
import { digestJson } from "../src/util.js";
import {
  FakeCodex,
  FakeGitHub,
  TestGitClient,
  completedWorker,
  createTestRepo,
  git,
  testConfig,
  testPlanV2,
  writeInputs,
} from "./support.js";
import { readControllerIdentity } from "../src/provenance.js";

class CountingGit extends TestGitClient {
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

  override async createPullRequest(job: JobState, deliveryRoot: string, body: string) {
    this.createPullRequestCalls += 1;
    return super.createPullRequest(job, deliveryRoot, body);
  }
}

class ObservingSourceGitHub extends SourceGitHub {
  observedPullRequest: NonNullable<JobState["pullRequest"]> | null = null;
  autoMergeEnabled = true;

  override async inspectPullRequest() {
    if (!this.observedPullRequest) throw new Error("test pull request is missing");
    return {
      pullRequest: this.observedPullRequest,
      checks: { state: "success" as const, missing: [], failures: [], pending: [] },
      mergedAt: null,
      autoMergeEnabled: this.autoMergeEnabled,
    };
  }

  override async disableAutoMerge() { this.autoMergeEnabled = false; }
  override async closePullRequest() {
    if (!this.observedPullRequest) throw new Error("test pull request is missing");
    this.observedPullRequest = { ...this.observedPullRequest, state: "CLOSED" };
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
    mutatePlan?(plan: ReturnType<typeof testPlanV2>): void;
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
    {
      name: "Oracle bytes drift",
      code: "oracle_binding_drift",
      mutatePlan: (plan) => { plan.issues[0]!.oracleBindings[0]!.artifact.sha256 = `sha256:${"0".repeat(64)}`; },
    },
  ];

  for (const scenario of scenarios) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo);
      const plan = testPlanV2(repo);
      scenario.mutatePlan?.(plan);
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

test("runtime base drift blocks Worker, Delivery, CI, and merge observation", async () => {
  for (const phase of ["implement", "deliver", "ci", "awaiting_merge"] as const) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
      const plan = testPlanV2(repo, [1]);
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const gitClient = new CountingGit(config);
      const codex = new FakeCodex(gitClient);
      const github = new ObservingSourceGitHub();
      const controller = new ReleaseController({
        store,
        git: gitClient,
        github,
        codex,
        validator: new CountingValidator(config),
      });
      const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
      assert.equal((await controller.step(created.id)).action, "release_prepared");
      const job = store.load(created.id);
      job.phase = phase;
      if (phase !== "implement") job.candidateSha = await gitClient.head(job.worktreePath);
      if (phase === "ci" || phase === "awaiting_merge") {
        job.pullRequest = {
          number: 31,
          url: "https://github.com/example/project/pull/31",
          state: "OPEN",
          headRef: job.branch,
          baseRef: job.baseRef,
          headSha: job.candidateSha!,
          mergeSha: null,
        };
        github.observedPullRequest = job.pullRequest;
        job.deliveryAuthority = {
          version: 1,
          pullRequest: job.pullRequest,
          candidateSha: job.candidateSha!,
          proofDigest: "a".repeat(64),
          status: phase === "awaiting_merge" ? "authorized" : "pending",
          autoMergeEnabled: true,
          quarantined: false,
          lastVerifiedAt: new Date().toISOString(),
          revocationReason: null,
          error: null,
        };
      }
      store.save(job);

      writeFileSync(join(repo.source, "README.md"), "# Base moved\n", "utf8");
      git(repo.source, ["add", "README.md"]);
      git(repo.source, ["commit", "-m", "advance base"]);
      git(repo.source, ["push", "origin", "main"]);

      const result = await controller.step(created.id);
      const blocked = store.load(created.id);
      assert.equal(result.action, "blocked", phase);
      assert.equal(blocked.blocked?.code, "replan_required", phase);
      assert.match(blocked.blocked?.message ?? "", /runtime_source_base_drift/, phase);
      assert.equal(codex.calls.length, 0, phase);
      assert.equal(gitClient.pushCalls, 0, phase);
      if (phase === "ci" || phase === "awaiting_merge") {
        assert.equal(blocked.deliveryAuthority?.status, "revoked", phase);
        assert.equal(blocked.pullRequest?.state, "OPEN", phase);
        assert.equal(blocked.deliveryAuthority?.quarantined, true, phase);
      }
    } finally { repo.cleanup(); }
  }
});

test("runtime Parent or Child body drift blocks before a fresh Worker", async () => {
  for (const issueNumber of [100, 1]) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
      const plan = testPlanV2(repo, [1]);
      const changes = new Map<number, Partial<IssueSnapshot>>();
      const github = new SourceGitHub(changes);
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const gitClient = new CountingGit(config);
      const codex = new FakeCodex(gitClient);
      const controller = new ReleaseController({ store, git: gitClient, github, codex, validator: new CountingValidator(config) });
      const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
      assert.equal((await controller.step(created.id)).action, "release_prepared");
      changes.set(issueNumber, { body: "changed after prepare" });

      const result = await controller.step(created.id);
      const blocked = store.load(created.id);
      assert.equal(result.action, "blocked", String(issueNumber));
      assert.equal(blocked.blocked?.code, "replan_required", String(issueNumber));
      assert.match(
        blocked.blocked?.message ?? "",
        issueNumber === 100 ? /runtime_parent_binding_drift/ : /runtime_child_binding_drift/,
      );
      assert.equal(codex.calls.length, 0);
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

test("persisted v2 Jobs revalidate canonical risks and expected paths before later-phase side effects", async () => {
  for (const [kind, mutate, cause] of [
    ["risk", (plan: any) => { plan.issues[0].riskClasses = ["BOUNDED_CHANGE"]; }, "unknown_risk_class"],
    ["path", (plan: any) => { plan.issues[0].expectedPaths = ["*.ts"]; }, "invalid_expected_path_pattern"],
  ] as const) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
      const plan = testPlanV2(repo, [1]);
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const git = new CountingGit(config);
      const validator = new CountingValidator(config);
      const codex = new FakeCodex(git);
      const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
      const job = store.load(created.id);
      mutate(job.plan);
      job.planDigest = digestJson(job.plan);
      job.provenance = store.currentProvenance(job.plan);
      job.phase = "release_validate";
      job.status = "running";
      store.save(job);
      const controller = new ReleaseController({ store, git, github: new SourceGitHub(), codex, validator });
      assert.equal((await controller.step(job.id)).action, "blocked", kind);
      const blocked = store.load(job.id);
      assert.equal(blocked.blocked?.code, "replan_required", kind);
      assert.match(blocked.blocked?.message ?? "", new RegExp(cause), kind);
      assert.equal(validator.calls, 0, kind);
      assert.equal(codex.calls.length, 0, kind);
    } finally { repo.cleanup(); }
  }
});

test("Controller source or build provenance drift blocks before source verification side effects", async () => {
  for (const field of ["sourceManifestDigest", "buildDigest"] as const) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
      const plan = testPlanV2(repo, [1]);
      const { configPath, planPath } = writeInputs(repo, config, plan);
      let identity = readControllerIdentity();
      const store = new JobStore(config, () => identity);
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

      const changed = {
        version: 1 as const,
        sourceRevision: identity.sourceRevision,
        sourceManifestDigest: identity.sourceManifestDigest,
        buildDigest: identity.buildDigest,
        [field]: identity[field] === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64),
      };
      identity = { ...changed, digest: digestJson(changed) } satisfies ControllerIdentity;
      const result = await controller.step(created.id);
      const job = store.load(created.id);

      assert.equal(result.action, "blocked", field);
      assert.equal(job.blocked?.code, "controller_provenance_drift", field);
      assert.equal(git.ensureCalls, 0, field);
      assert.equal(validator.calls, 0, field);
      assert.equal(codex.calls.length, 0, field);
    } finally { repo.cleanup(); }
  }
});

test("v2 Worker Oracle, risk-set drift, or unknown risk is terminal REPLAN_REQUIRED before validation or commit", async () => {
  for (const kind of ["oracle", "risk", "unknown"] as const) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
      const plan = testPlanV2(repo, [1]);
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const git = new CountingGit(config);
      const codex = new FakeCodex(git, async ({ job, kind: runKind }) => {
        if (runKind !== "worker") return {};
        if (kind === "oracle") writeFileSync(join(job.worktreePath, "fixtures/oracle.json"), "{\"ok\":false}\n", "utf8");
        else writeFileSync(join(job.worktreePath, "issue-1.txt"), "implemented\n", "utf8");
        const observed = kind === "risk"
          ? ["BOUNDED_BEHAVIOR_CHANGE", "AUTHORITY_BOUNDARY"]
          : kind === "unknown"
            ? ["BOUNDED_BEHAVIOR_CHANGE", "NEW_BOUNDARY"]
            : ["BOUNDED_BEHAVIOR_CHANGE"];
        return { worker: completedWorker("done", observed) };
      });
      const validator = new CountingValidator(config);
      const controller = new ReleaseController({ store, git, github: new SourceGitHub(), codex, validator });
      const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
      assert.equal((await controller.step(created.id)).action, "release_prepared");
      assert.equal((await controller.step(created.id)).action, "blocked");
      const blocked = store.load(created.id);
      assert.equal(blocked.blocked?.code, "replan_required");
      assert.match(blocked.blocked?.message ?? "", kind === "oracle" ? /oracle_binding_drift/ : kind === "unknown" ? /unknown_risk_class/ : /issue_risk_class_drift/);
      assert.equal(validator.calls, 1);
      assert.equal(git.commitCalls, 0);
      assert.throws(() => retryBlockedJob(blocked), (error: any) => error?.code === "replan_required");
    } finally { repo.cleanup(); }
  }
});

test("every v2 Issue commit enforces its scope budget, including crash salvage", async () => {
  for (const salvage of [false, true]) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
      const plan = testPlanV2(repo, [1]);
      plan.issues[0]!.scopeBudget = { maxFiles: 1, maxChangedLines: 1 };
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const git = new CountingGit(config);
      const codex = new FakeCodex(git, async ({ job, kind }) => {
        if (kind !== "worker") return {};
        writeFileSync(join(job.worktreePath, "issue-1.txt"), "one\ntwo\n", "utf8");
        return { worker: completedWorker("done", ["BOUNDED_BEHAVIOR_CHANGE"]) };
      });
      const controller = new ReleaseController({ store, git, github: new SourceGitHub(), codex, validator: new Validator(config) });
      const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
      assert.equal((await controller.step(created.id)).action, "release_prepared");
      if (salvage) {
        const job = store.load(created.id);
        job.phase = "issue_validate";
        job.currentIssueNumber = 1;
        job.issues[0]!.status = "running";
        writeFileSync(join(job.worktreePath, "issue-1.txt"), "one\ntwo\n", "utf8");
        const binding = plan.issues[0]!.oracleBindings[0]!;
        const command = config.validation.release.find((entry) => entry.command === binding.execution.command)!;
        const validation = await new Validator(config).run({
          job,
          scope: "issue",
          issueNumber: 1,
          commands: [{ ...command, oracles: [{ issueNumber: 1, oracleId: binding.id }] }],
          validationsRoot: store.validationsRoot(job.id),
          sourceHeadSha: await git.head(job.worktreePath),
          sourceWorktreeDigest: await git.worktreeDigest(job.worktreePath),
        });
        job.validations.push({
          id: validation.receipt.id,
          scope: "issue",
          issueNumber: 1,
          path: validation.path,
          passed: true,
          digest: validation.receipt.digest,
        });
        job.issues[0]!.lastValidationId = validation.receipt.id;
        store.save(job);
        await git.commitIssue(job, 1, "Issue 1", false);
      } else {
        assert.equal((await controller.step(created.id)).action, "worker_completed");
      }
      assert.equal((await controller.step(created.id)).action, "blocked");
      const blocked = store.load(created.id);
      assert.equal(blocked.blocked?.code, "replan_required");
      assert.match(blocked.blocked?.message ?? "", /issue_scope_budget_exceeded/);
      assert.throws(() => retryBlockedJob(blocked), (error: any) => error?.code === "replan_required");
    } finally { repo.cleanup(); }
  }
});

test("v2 release hardening cannot modify a protected Oracle or bypass replan", async () => {
  const repo = createTestRepo();
  try {
    const base = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    const config = testConfig(repo, {
      executionMode: "release-plan-v2-direct",
      validation: { ...base.validation, release: [{ command: "test -f issue-1.txt" }] },
    } as any);
    const plan = testPlanV2(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const git = new CountingGit(config);
    const codex = new FakeCodex(git, async ({ job, kind }) => {
      if (kind === "review") return { review: { status: "changes", summary: "hardening", findings: [{ severity: "major", path: "issue-1.txt", line: 1, summary: "fixture", rationale: "fixture", recommendation: "fix", relatedIssues: [1] }] } };
      if (kind === "release-harden") {
        writeFileSync(join(job.worktreePath, "fixtures/oracle.json"), "{\"changed\":true}\n", "utf8");
        return { worker: completedWorker("hardening", ["BOUNDED_BEHAVIOR_CHANGE"]) };
      }
      return {};
    });
    const controller = new ReleaseController({ store, git, github: new SourceGitHub(), codex, validator: new Validator(config) });
    const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    for (let index = 0; index < 10 && store.load(created.id).status !== "blocked"; index += 1) await controller.step(created.id);
    const blocked = store.load(created.id);
    assert.equal(blocked.blocked?.code, "replan_required");
    assert.match(blocked.blocked?.message ?? "", /oracle_binding_drift/);
    assert.throws(() => retryBlockedJob(blocked), (error: any) => error?.code === "replan_required");
  } finally { repo.cleanup(); }
});

test("binary Issue changes cannot count as zero changed lines", async () => {
  const repo = createTestRepo();
  try {
    const base = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    const config = testConfig(repo, {
      executionMode: "release-plan-v2-direct",
      validation: { ...base.validation, issue: [{ command: "test -f asset.bin" }] },
    } as any);
    const plan = testPlanV2(repo, [1]);
    plan.issues[0]!.expectedPaths = ["asset.bin"];
    plan.issues[0]!.scopeBudget = { maxFiles: 1, maxChangedLines: 1 };
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const git = new CountingGit(config);
    const codex = new FakeCodex(git, async ({ job, kind }) => {
      if (kind !== "worker") return {};
      writeFileSync(join(job.worktreePath, "asset.bin"), new Uint8Array([0, 1, 2]));
      return { worker: completedWorker("binary", ["BOUNDED_BEHAVIOR_CHANGE"]) };
    });
    const controller = new ReleaseController({ store, git, github: new SourceGitHub(), codex, validator: new Validator(config) });
    const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    assert.equal((await controller.step(created.id)).action, "release_prepared");
    assert.equal((await controller.step(created.id)).action, "worker_completed");
    assert.equal((await controller.step(created.id)).action, "blocked");
    assert.match(store.load(created.id).blocked?.message ?? "", /issue_scope_budget_exceeded/);
  } finally { repo.cleanup(); }
});

test("v2 hardening aggregate budget applies to normal and every salvage path", async () => {
  for (const mode of ["normal", "salvage", "interrupted-salvage"] as const) {
    const repo = createTestRepo();
    try {
      const base = testConfig(repo, { executionMode: "release-plan-v2-direct" });
      const config = testConfig(repo, {
        executionMode: "release-plan-v2-direct",
        validation: { ...base.validation, release: [{ command: "test -f issue-1.txt" }] },
      } as any);
      const plan = testPlanV2(repo, [1]);
      plan.issues[0]!.scopeBudget = { maxFiles: 1, maxChangedLines: 1 };
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const git = new CountingGit(config);
      const codex = new FakeCodex(git, async ({ job, kind }) => {
        if (kind === "review") return { review: { status: "changes", summary: "hardening", findings: [{ severity: "major", path: "issue-1.txt", line: 1, summary: "fixture", rationale: "fixture", recommendation: "fix", relatedIssues: [1] }] } };
        if (kind === "release-harden") {
          writeFileSync(join(job.worktreePath, "issue-1.txt"), "issue 1\nhardened\n", "utf8");
          return { worker: completedWorker("hardening", ["BOUNDED_BEHAVIOR_CHANGE"]) };
        }
        return {};
      });
      const controller = new ReleaseController({ store, git, github: new SourceGitHub(), codex, validator: new Validator(config) });
      const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
      for (let index = 0; index < 10 && store.load(created.id).phase !== "harden"; index += 1) await controller.step(created.id);
      if (mode !== "normal") {
        const job = store.load(created.id);
        writeFileSync(join(job.worktreePath, "issue-1.txt"), "issue 1\nhardened\n", "utf8");
        if (mode === "interrupted-salvage") {
          job.activeRun = {
            id: "interrupted-hardening",
            kind: "release-harden",
            issueNumber: null,
            startedAt: new Date().toISOString(),
            baseHeadSha: await git.head(job.worktreePath),
          };
          store.save(job);
        }
        await git.commitHardening(job, "fixture");
      }
      assert.equal((await controller.step(created.id)).action, "blocked");
      const blocked = store.load(created.id);
      assert.equal(blocked.blocked?.code, "replan_required");
      assert.match(blocked.blocked?.message ?? "", /issue_scope_budget_exceeded/);
    } finally { repo.cleanup(); }
  }
});
