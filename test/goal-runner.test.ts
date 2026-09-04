import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import test from "node:test";
import type { GoalInspection, GoalRecord, GoalRuntimePort, GoalTurnResult } from "../src/goal-app-server.js";
import {
  GoalStore,
  goalHandoffFingerprint,
  publicGoalStatus,
  validateGoalHandoff,
  type GoalHandoffV1,
  type GoalStatus,
} from "../src/goal-state.js";
import { GoalRunner, exportGoalReleaseResult } from "../src/goal-runner.js";
import { Validator } from "../src/validator.js";
import { writeJsonAtomic } from "../src/fs-atomic.js";
import { digestJson } from "../src/util.js";
import type { GitHubPort } from "../src/ports.js";
import type { PullRequestState, ReleasePlan } from "../src/types.js";
import {
  FakeCodex,
  FakeGitHub,
  TestGitClient,
  createTestRepo,
  git,
  highRiskPlan,
  testConfig,
  testPlan,
  writeInputs,
} from "./support.js";

test("Goal Runner uses one persistent Goal per Ticket, deterministic checkpoints, detached review, and human merge result", async (t: any) => {
  const repo = createTestRepo();
  t.after(() => repo.cleanup());
  const config = testConfig(repo);
  const plan = testPlan(repo);
  const { configPath } = writeInputs(repo, config, plan);
  const handoff = goalHandoff(plan);
  const handoffPath = join(repo.root, "goal-handoff.json");
  writeJsonAtomic(handoffPath, handoff);
  const store = new GoalStore(config);
  const state = store.create({
    configPath,
    handoffPath,
    handoff,
    handoffDigest: goalHandoffFingerprint(handoff),
  });
  const gitClient = new TestGitClient(config);
  const goal = new FakeGoalRuntime();
  const reviewer = new FakeCodex(gitClient);
  const runner = new GoalRunner({
    config,
    store,
    git: gitClient,
    github: new FakeGitHub(),
    validator: new Validator(config, gitClient),
    reviewer,
    goal,
  });

  for (let index = 0; index < 30; index += 1) {
    const current = store.load(state.id);
    if (current.status !== "running") break;
    const step = await runner.step(current);
    assert.equal(step.progressed, true);
  }
  const ready = store.load(state.id);
  assert.equal(ready.status, "review_ready");
  assert.equal(ready.phase, "handoff");
  assert.deepEqual(ready.issues.map((issue) => issue.status), ["committed", "committed"]);
  assert.equal(new Set(ready.issues.map((issue) => issue.threadId)).size, 2);
  assert.equal(goal.createdThreads.length, 2);
  assert.deepEqual(goal.turnsPerThread, [1, 1]);
  assert.deepEqual(reviewer.calls, [{ kind: "review", issueNumber: null }]);
  assert.ok(ready.review?.digest.startsWith("sha256:"));
  assert.equal(git(ready.worktreePath, ["status", "--porcelain"]), "");
  const status = publicGoalStatus(ready);
  assert.equal(status.currentGoal, null);
  assert.equal("worktreePath" in status, false);
  assert.equal("threadId" in JSON.parse(JSON.stringify(status)), false);

  git(repo.source, ["merge", "--squash", ready.candidateSha!]);
  git(repo.source, ["commit", "-m", "merge Goal candidate"]);
  const mergeSha = git(repo.source, ["rev-parse", "HEAD"]);
  git(repo.source, ["push", "origin", "main"]);
  const github = new MergedGoalGitHub(ready.branch, ready.candidateSha!, mergeSha);
  const out = join(repo.root, "goal-release-result.json");
  const releaseResult = await exportGoalReleaseResult({
    config,
    store,
    git: gitClient,
    github,
    state: ready,
    pullRequestNumber: 88,
    outputPath: out,
  });
  assert.equal(releaseResult.schema, "pi-ticket-planning:goal-release-result:v1");
  assert.equal(releaseResult.candidateSha, ready.candidateSha);
  assert.equal(releaseResult.mergeSha, mergeSha);
  assert.equal(store.load(state.id).status, "completed");
});

test("Goal handoff binds channel, runner, Plan, and rejects high-risk work", (t: any) => {
  const repo = createTestRepo();
  t.after(() => repo.cleanup());
  const plan = testPlan(repo, [1]);
  const local = goalHandoff(plan);
  assert.equal(validateGoalHandoff(local).channel, "GOAL_LOCAL");
  assert.throws(() => validateGoalHandoff({ ...local, runnerRef: "remote" }), /GOAL_LOCAL requires/u);
  assert.throws(() => validateGoalHandoff({ ...local, planDigest: "0".repeat(64) }), /does not bind/u);
  assert.throws(() => validateGoalHandoff(goalHandoff(highRiskPlan(repo, [1]))), /High-risk/u);
  assert.equal(validateGoalHandoff({ ...local, channel: "GOAL_REMOTE", runnerRef: "mac-mini" }).runnerRef, "mac-mini");
});

test("legacy turn history blocks instead of clearing an active recovery marker", async (t: any) => {
  const repo = createTestRepo();
  t.after(() => repo.cleanup());
  const config = testConfig(repo);
  const plan = testPlan(repo, [1]);
  const { configPath } = writeInputs(repo, config, plan);
  const handoff = goalHandoff(plan);
  const handoffPath = join(repo.root, "goal-handoff.json");
  writeJsonAtomic(handoffPath, handoff);
  const store = new GoalStore(config);
  const state = store.create({ configPath, handoffPath, handoff, handoffDigest: goalHandoffFingerprint(handoff) });
  const gitClient = new TestGitClient(config);
  const goal = new FakeGoalRuntime();
  const runner = new GoalRunner({ config, store, git: gitClient, github: new FakeGitHub(), validator: new Validator(config, gitClient), reviewer: new FakeCodex(gitClient), goal });
  await runner.step(store.load(state.id));
  await runner.step(store.load(state.id));
  const running = store.load(state.id);
  const issue = running.issues[0]!;
  issue.activeTurnId = "live-turn-unmapped";
  issue.activeTurnBaselineIds = ["older-persisted-turn"];
  goal.inspectionTurns = [{ id: "older-persisted-turn", status: "completed" }];
  await goal.setStatus(issue.threadId!, "active", running.worktreePath, running.codexHomePath);
  store.save(running);
  await assert.rejects(() => runner.step(store.load(state.id)), /cannot be safely associated/u);
  assert.equal(store.load(state.id).issues[0]!.activeTurnId, "live-turn-unmapped");
  await goal.setStatus(issue.threadId!, "complete", running.worktreePath, running.codexHomePath);
  goal.inspectionTurns = [
    { id: "new-failed-turn", status: "failed" },
    { id: "older-persisted-turn", status: "completed" },
  ];
  await assert.rejects(() => runner.step(store.load(state.id)), /without a completed persisted turn/u);
  goal.inspectionTurns[0] = { id: "new-completed-turn", status: "completed" };
  assert.equal((await runner.step(store.load(state.id))).action, "goal_turn_reconciled");
  assert.equal(store.load(state.id).issues[0]!.activeTurnId, null);
});

test("failed deterministic validation returns to the same Ticket Goal thread", async (t: any) => {
  const repo = createTestRepo();
  t.after(() => repo.cleanup());
  const config = testConfig(repo, { validation: { ...testConfig(repo).validation, issue: [{ command: "test -f issue-$HERDR_ISSUE_NUMBER.txt && test -f repair-ok" }] } });
  const plan = testPlan(repo, [1]);
  plan.issues[0]!.expectedPaths.push("repair-ok");
  const { configPath } = writeInputs(repo, config, plan);
  const handoff = goalHandoff(plan);
  const handoffPath = join(repo.root, "goal-handoff.json");
  writeJsonAtomic(handoffPath, handoff);
  const store = new GoalStore(config);
  const state = store.create({ configPath, handoffPath, handoff, handoffDigest: goalHandoffFingerprint(handoff) });
  const gitClient = new TestGitClient(config);
  const goal = new FakeGoalRuntime((input, count, number) => {
    writeFileSync(join(input.cwd, `issue-${number}.txt`), `issue ${number}\n`, "utf8");
    if (count > 1) writeFileSync(join(input.cwd, "repair-ok"), "fixed\n", "utf8");
  });
  const runner = new GoalRunner({ config, store, git: gitClient, github: new FakeGitHub(), validator: new Validator(config, gitClient), reviewer: new FakeCodex(gitClient), goal });
  for (let index = 0; index < 20 && store.load(state.id).status === "running"; index += 1) await runner.step(store.load(state.id));
  const ready = store.load(state.id);
  assert.equal(ready.status, "review_ready");
  assert.equal(goal.createdThreads.length, 1);
  assert.deepEqual(goal.turnsPerThread, [2]);
  assert.equal(ready.issues[0]!.validationRounds, 1);
});

class FakeGoalRuntime implements GoalRuntimePort {
  readonly createdThreads: string[] = [];
  inspectionTurns: GoalInspection["turns"] = [];
  private readonly goals = new Map<string, GoalRecord>();
  private readonly turnCounts = new Map<string, number>();

  constructor(private readonly onTurn?: (input: { cwd: string; threadId: string; prompt: string }, count: number, issueNumber: string) => void) {}

  get turnsPerThread(): number[] { return this.createdThreads.map((id) => this.turnCounts.get(id) ?? 0); }
  async preflight(_codexHome: string): Promise<void> {}
  async createThread(input: { cwd: string; codexHome: string; objective: string }): Promise<GoalRecord> {
    const threadId = `thread-${this.createdThreads.length + 1}`;
    const goal = record(threadId, input.objective, "paused");
    this.createdThreads.push(threadId);
    this.goals.set(threadId, goal);
    return goal;
  }
  async runTurn(input: { cwd: string; codexHome: string; threadId: string; prompt: string; onStarted: (turnId: string, baselineTurnIds: string[]) => void }): Promise<GoalTurnResult> {
    const count = (this.turnCounts.get(input.threadId) ?? 0) + 1;
    this.turnCounts.set(input.threadId, count);
    const turnId = `${input.threadId}-turn-${count}`;
    input.onStarted(turnId, Array.from({ length: count - 1 }, (_, index) => `${input.threadId}-persisted-${index + 1}`));
    const matches = [...input.prompt.matchAll(/"number": (\d+)/gu)];
    const number = matches.at(-1)?.[1];
    if (!number) throw new Error("Ticket number missing from Goal prompt");
    if (this.onTurn) this.onTurn(input, count, number);
    else writeFileSync(join(input.cwd, `issue-${number}.txt`), `issue ${number}\n`, "utf8");
    const current = this.goals.get(input.threadId)!;
    const goal = record(input.threadId, current.objective, "complete", 100, 2);
    this.goals.set(input.threadId, goal);
    return { threadId: input.threadId, turnId, turnStatus: "completed", goal };
  }
  async inspect(threadId: string, _cwd: string, _codexHome: string): Promise<GoalInspection> {
    return { goal: this.goals.get(threadId) ?? null, threadStatus: { type: "idle" }, turns: this.inspectionTurns };
  }
  async setStatus(threadId: string, status: GoalStatus, _cwd: string, _codexHome: string): Promise<GoalRecord> {
    const current = this.goals.get(threadId)!;
    const goal = record(threadId, current.objective, status, current.tokensUsed, current.timeUsedSeconds);
    this.goals.set(threadId, goal);
    return goal;
  }
}

class MergedGoalGitHub extends FakeGitHub implements GitHubPort {
  constructor(private readonly branch: string, private readonly candidate: string, private readonly mergeSha: string) { super(); }
  override async inspectPullRequest(number: number) {
    const pullRequest: PullRequestState = {
      number,
      url: `https://github.com/example/project/pull/${number}`,
      state: "MERGED",
      headRef: this.branch,
      baseRef: "main",
      headSha: this.candidate,
      mergeSha: this.mergeSha,
    };
    return {
      pullRequest,
      checks: { state: "success" as const, missing: [], failures: [], pending: [] },
      mergedAt: "2026-09-03T00:00:00.000Z",
      autoMergeEnabled: false,
    };
  }
}

function goalHandoff(plan: ReleasePlan): GoalHandoffV1 {
  return {
    schema: "pi-ticket-planning:goal-handoff:v1",
    releaseId: plan.id,
    repo: plan.repo,
    baseSha: plan.baseSha,
    planDigest: digestJson(plan),
    channel: "GOAL_LOCAL",
    runnerRef: "local",
    runnerDigest: `sha256:${digestJson({ ref: "local" })}`,
    runnerHost: hostname(),
    releasePlan: plan,
  };
}

function record(threadId: string, objective: string, status: GoalStatus, tokensUsed = 0, timeUsedSeconds = 0): GoalRecord {
  return {
    threadId,
    objective,
    status,
    tokenBudget: null,
    tokensUsed,
    timeUsedSeconds,
    createdAt: 1,
    updatedAt: 1,
  };
}
