import { resolve } from "node:path";
import type { CodexPort, GitHubPort, GitPort, ValidationPort } from "./ports.js";
import type { ControllerConfig, StepResult, ValidationCommandConfig, ValidationReceipt } from "./types.js";
import type { GoalRuntimePort, GoalRecord } from "./goal-app-server.js";
import type { GoalIssueState, GoalReleaseResultV1, GoalRunState } from "./goal-state.js";
import {
  GOAL_RESULT_SCHEMA,
  GoalStore,
  assertGoalReleaseResult,
  goalJobView,
} from "./goal-state.js";
import { ControllerError } from "./errors.js";
import { expectedPathMatches } from "./scope.js";
import { renderIssueGoalPrompt, renderReleaseReviewPrompt } from "./prompts.js";
import { assertValidationReceipt } from "./validator.js";
import { readJsonFile, writePublicJsonAtomic } from "./fs-atomic.js";
import { requiredCheckNames } from "./config.js";
import { digestJson, nowIso, pathWithin } from "./util.js";

export class GoalRunner {
  constructor(private readonly deps: {
    config: ControllerConfig;
    store: GoalStore;
    git: GitPort;
    github: GitHubPort;
    validator: ValidationPort;
    reviewer: CodexPort;
    goal: GoalRuntimePort;
  }) {}

  async step(state: GoalRunState): Promise<StepResult> {
    if (state.status === "blocked") return result("goal_blocked", false, true, state.blocked?.message ?? "Goal run is blocked.");
    if (state.status === "review_ready") return result("goal_review_ready", false, true, "Candidate is review-ready and awaits human PR/merge.");
    if (state.status === "completed" || state.status === "failed") return result("goal_terminal", false, true, "Goal run is terminal.");
    if (state.phase === "prepare") return this.prepare(state);
    if (state.phase === "implement") return this.implement(state);
    if (state.phase === "validate") return this.validateIssue(state);
    if (state.phase === "release_validate") return this.validateRelease(state);
    if (state.phase === "review") return this.review(state);
    if (state.phase === "handoff") return result("goal_review_ready", false, true, "Candidate awaits human PR/merge.");
    return result("goal_complete", false, true, "Goal release is complete.");
  }

  async resume(state: GoalRunState): Promise<GoalRunState> {
    if (state.status !== "blocked" || !state.blocked) throw new ControllerError("goal_not_blocked", "Goal run is not blocked.");
    if (state.blocked.kind === "replan_required") {
      throw new ControllerError("replan_required", "This Goal run requires a new approved Plan and handoff.");
    }
    const issue = currentIssue(state);
    if (issue?.threadId && issue.goalStatus !== "complete") {
      updateGoal(issue, await this.deps.goal.setStatus(issue.threadId, "paused", state.worktreePath, state.codexHomePath));
      issue.status = "running";
    }
    state.status = "running";
    state.blocked = null;
    this.deps.store.save(state);
    return state;
  }

  private async prepare(state: GoalRunState): Promise<StepResult> {
    await this.deps.git.preflight();
    await this.deps.goal.preflight(state.codexHomePath);
    await this.deps.reviewer.preflight();
    await this.deps.validator.preflight();
    const observedBase = await this.deps.git.fetchBase();
    if (observedBase !== state.baseSha) throw new ControllerError("goal_base_drift", "Remote base no longer matches the approved Goal handoff.");
    const parent = await this.deps.github.fetchIssue(state.plan.parentIssue, { allowClosed: true });
    if (parent.state !== "OPEN") throw new ControllerError("plan_parent_not_open", `Parent Issue #${parent.number} is not OPEN.`);
    for (const issue of state.issues) {
      const snapshot = await this.deps.github.fetchIssue(issue.number, { allowClosed: true });
      if (snapshot.state !== "OPEN") throw new ControllerError("plan_issue_not_open", `Child Issue #${snapshot.number} is not OPEN.`);
      issue.snapshot = snapshot;
    }
    this.deps.store.save(state);
    const job = goalJobView(state);
    await this.deps.git.ensureWorktree(job);
    if (await this.deps.git.head(state.worktreePath) !== state.baseSha || !(await this.deps.git.isClean(state.worktreePath))) {
      throw new ControllerError("goal_worktree_unsafe", "Goal Worktree is not the exact clean approved base.");
    }
    await this.deps.validator.runDevelopmentGate({
      job,
      validationsRoot: this.deps.store.validationsRoot(state.id),
    });
    await this.assertWorktreeIdentity(state, state.baseSha, true);
    state.phase = "implement";
    this.deps.store.save(state);
    return result("goal_prepared", true, false, `Goal run ${state.id} prepared at ${state.baseSha}.`);
  }

  private async implement(state: GoalRunState): Promise<StepResult> {
    let issue = currentIssue(state);
    if (!issue) {
      issue = nextPendingIssue(state);
      if (!issue) {
        state.phase = "release_validate";
        this.deps.store.save(state);
        return result("goal_issues_complete", true, false, "All Goal Tickets are committed; release validation is next.");
      }
      assertDependenciesCommitted(state, issue);
      issue.status = "running";
      issue.inputHeadSha = await this.deps.git.head(state.worktreePath);
      state.currentIssueNumber = issue.number;
      this.deps.store.save(state);
    }
    const planIssue = state.plan.issues.find((entry) => entry.number === issue!.number);
    if (!planIssue || !issue.snapshot || !issue.inputHeadSha) throw new ControllerError("goal_issue_identity_missing", "Goal Ticket identity is incomplete.");
    await this.assertWorktreeIdentity(state, issue.inputHeadSha, false);
    await this.assertIssueScope(state, issue);
    const objective = goalObjective(state, issue);

    if (!issue.threadId) {
      const goal = await this.deps.goal.createThread({ cwd: state.worktreePath, codexHome: state.codexHomePath, objective });
      assertGoalIdentity(goal, goal.threadId, objective);
      issue.threadId = goal.threadId;
      updateGoal(issue, goal);
      this.deps.store.save(state);
      return result("goal_thread_created", true, false, `Fresh Goal thread created for Ticket #${issue.number}.`);
    }

    if (issue.activeTurnId) {
      const baselineTurnIds = issue.activeTurnBaselineIds;
      if (baselineTurnIds === null) throw new ControllerError("goal_turn_identity_ambiguous", "Recorded Goal turn has no persisted-history baseline.");
      const inspection = await this.deps.goal.inspect(issue.threadId, state.worktreePath, state.codexHomePath);
      if (!inspection.goal) throw new ControllerError("goal_identity_missing", "Recorded Codex Thread has no Goal.");
      assertGoalIdentity(inspection.goal, issue.threadId, objective);
      updateGoal(issue, inspection.goal);
      if (inspection.goal.status === "active") {
        throw new ControllerError("goal_turn_identity_ambiguous", "Active Goal turn cannot be safely associated with stable legacy history; explicit resume is required.");
      }
      const baseline = new Set(baselineTurnIds);
      const cycleTurns = inspection.turns.filter((turn) => !baseline.has(turn.id));
      if (cycleTurns.length === 0) {
        throw new ControllerError("goal_turn_identity_ambiguous", "Recorded Goal cycle has no new persisted turn after its baseline.");
      }
      if (cycleTurns.some((turn) => turn.status === "inProgress")) {
        return result("goal_turn_active", false, false, `Goal turn ${issue.activeTurnId} is still active.`);
      }
      if (!cycleTurns.some((turn) => turn.status === "completed")) {
        throw new ControllerError("goal_turn_interrupted", "Goal cycle ended without a completed persisted turn.");
      }
      const liveTurnId = issue.activeTurnId;
      issue.activeTurnId = null;
      issue.activeTurnBaselineIds = null;
      this.advanceAfterGoalTurn(state, issue);
      this.deps.store.save(state);
      return result("goal_turn_reconciled", true, false, `Recovered completed Goal cycle for live turn ${liveTurnId}.`);
    }

    const previous = issue.lastValidationId ? this.readValidation(state, issue.lastValidationId) : null;
    const job = goalJobView(state);
    const jobIssue = job.issues.find((entry) => entry.number === issue!.number)!;
    const prompt = renderIssueGoalPrompt({ job, issue: jobIssue, planIssue, validationReceipt: previous });
    const turn = await this.deps.goal.runTurn({
      cwd: state.worktreePath,
      codexHome: state.codexHomePath,
      threadId: issue.threadId,
      prompt,
      onStarted: (turnId, baselineTurnIds) => {
        issue!.activeTurnId = turnId;
        issue!.activeTurnBaselineIds = baselineTurnIds;
        this.deps.store.save(state);
      },
    });
    issue.activeTurnId = null;
    issue.activeTurnBaselineIds = null;
    assertGoalTurn(turn.turnStatus);
    assertGoalIdentity(turn.goal, issue.threadId, objective);
    updateGoal(issue, turn.goal);
    await this.assertWorktreeIdentity(state, issue.inputHeadSha, false);
    await this.assertIssueScope(state, issue);
    this.advanceAfterGoalTurn(state, issue);
    this.deps.store.save(state);
    return result("goal_turn_completed", true, false, `Goal turn completed for Ticket #${issue.number} with status ${issue.goalStatus}.`);
  }

  private advanceAfterGoalTurn(state: GoalRunState, issue: GoalIssueState): void {
    if (issue.goalStatus === "complete") {
      issue.status = "validating";
      state.phase = "validate";
      return;
    }
    if (issue.goalStatus === "active") return;
    issue.status = "blocked";
    throw new ControllerError(`goal_${String(issue.goalStatus).toLowerCase()}`, `Goal for Ticket #${issue.number} stopped as ${issue.goalStatus}.`);
  }

  private async validateIssue(state: GoalRunState): Promise<StepResult> {
    const issue = currentIssue(state);
    if (!issue?.inputHeadSha || !issue.threadId) throw new ControllerError("goal_issue_identity_missing", "Goal validation has no current Ticket.");
    const planIssue = state.plan.issues.find((entry) => entry.number === issue.number);
    if (!planIssue) throw new ControllerError("goal_issue_identity_missing", "Goal Plan Ticket is missing.");
    await this.assertWorktreeIdentity(state, issue.inputHeadSha, false);
    await this.assertIssueScope(state, issue);
    const job = goalJobView(state);
    const beforeDigest = await this.deps.git.worktreeDigest(state.worktreePath);
    const validation = await this.deps.validator.run({
      job,
      scope: "issue",
      issueNumber: issue.number,
      commands: issueValidationCommands(this.deps.config, planIssue.oracleCommands),
      validationsRoot: this.deps.store.validationsRoot(state.id),
      sourceHeadSha: issue.inputHeadSha,
      sourceWorktreeDigest: beforeDigest,
    });
    if (await this.deps.git.worktreeDigest(state.worktreePath) !== beforeDigest) {
      throw new ControllerError("goal_validator_mutated_worktree", "Goal validation changed the candidate Worktree.");
    }
    appendValidation(state, validation.receipt, validation.path);
    issue.lastValidationId = validation.receipt.id;
    if (!validation.receipt.passed) {
      if (issue.validationRounds >= this.deps.config.policy.maxIssueRepairRounds) {
        issue.status = "blocked";
        throw new ControllerError("goal_validation_exhausted", `Ticket #${issue.number} failed deterministic validation.` , validation.path);
      }
      issue.validationRounds += 1;
      updateGoal(issue, await this.deps.goal.setStatus(issue.threadId, "paused", state.worktreePath, state.codexHomePath));
      issue.status = "running";
      state.phase = "implement";
      this.deps.store.save(state);
      return result("goal_validation_repair", true, false, `Ticket #${issue.number} validation failed; the same Goal thread will repair it.`);
    }
    const commit = await this.deps.git.commitIssue(job, issue.number, issue.snapshot?.title ?? `Issue #${issue.number}`);
    if (await this.deps.git.commitParent(job, commit.sha) !== validation.receipt.candidateSha) {
      throw new ControllerError("goal_validation_binding_mismatch", "Goal Ticket commit is not based on the validated candidate.");
    }
    await this.assertCommitScope(state, issue, commit.sha);
    if (!(await this.deps.git.isClean(state.worktreePath))) throw new ControllerError("goal_commit_worktree_dirty", "Goal checkpoint commit did not leave a clean Worktree.");
    issue.status = "committed";
    issue.commitSha = commit.sha;
    state.currentIssueNumber = null;
    state.phase = nextPendingIssue(state) ? "implement" : "release_validate";
    this.deps.store.save(state);
    return result("goal_ticket_committed", true, false, `Ticket #${issue.number} committed as ${commit.sha}.`);
  }

  private async validateRelease(state: GoalRunState): Promise<StepResult> {
    if (state.issues.some((issue) => issue.status !== "committed")) throw new ControllerError("goal_release_incomplete", "Release validation requires every Ticket commit.");
    if (!(await this.deps.git.isClean(state.worktreePath))) throw new ControllerError("goal_release_worktree_dirty", "Release validation requires a clean Worktree.");
    const head = await this.deps.git.head(state.worktreePath);
    const beforeDigest = await this.deps.git.worktreeDigest(state.worktreePath);
    const validation = await this.deps.validator.run({
      job: goalJobView(state),
      scope: "release",
      issueNumber: null,
      commands: this.deps.config.validation.release,
      validationsRoot: this.deps.store.validationsRoot(state.id),
      sourceHeadSha: head,
      sourceWorktreeDigest: beforeDigest,
    });
    if (await this.deps.git.worktreeDigest(state.worktreePath) !== beforeDigest) {
      throw new ControllerError("goal_validator_mutated_worktree", "Goal release validation changed the candidate Worktree.");
    }
    appendValidation(state, validation.receipt, validation.path);
    if (!validation.receipt.passed) throw new ControllerError("goal_release_validation_failed", "Goal release validation failed.", validation.path);
    state.candidateSha = head;
    state.phase = "review";
    this.deps.store.save(state);
    return result("goal_release_validated", true, false, `Candidate ${head} passed release validation.`);
  }

  private async review(state: GoalRunState): Promise<StepResult> {
    if (!state.candidateSha || !(await this.deps.git.isClean(state.worktreePath))
      || await this.deps.git.head(state.worktreePath) !== state.candidateSha) {
      throw new ControllerError("goal_review_candidate_drift", "Goal review requires the exact clean validated candidate.");
    }
    const validation = [...state.validations].reverse().find((entry) => entry.scope === "release" && entry.passed);
    if (!validation) throw new ControllerError("goal_release_validation_missing", "Goal review requires a passed release validation receipt.");
    const receipt = this.readValidation(state, validation.id);
    const job = goalJobView(state);
    const execution = await this.deps.reviewer.run({
      job,
      kind: "review",
      issueNumber: null,
      prompt: renderReleaseReviewPrompt({ job, validationReceipt: receipt }),
      runsRoot: this.deps.store.reviewsRoot(state.id),
    });
    if (await this.deps.git.head(state.worktreePath) !== state.candidateSha || !(await this.deps.git.isClean(state.worktreePath))) {
      throw new ControllerError("goal_reviewer_mutated_candidate", "Goal release Reviewer changed the candidate.", execution.record.resultPath);
    }
    if (execution.record.exitCode !== 0 || execution.record.signal !== null || execution.record.timedOut
      || execution.record.outputLimitExceeded) {
      throw new ControllerError("goal_review_failed", "Goal release Reviewer did not complete successfully.", execution.record.stderrPath);
    }
    if (!execution.reviewResult) throw new ControllerError("goal_review_result_missing", "Goal release Reviewer produced no valid result.", execution.record.resultPath);
    if (execution.reviewResult.status !== "pass") throw new ControllerError("goal_review_blocked", execution.reviewResult.summary, execution.record.resultPath);
    state.review = {
      runId: execution.record.id,
      path: execution.record.resultPath,
      digest: `sha256:${digestJson(execution.reviewResult)}`,
      result: execution.reviewResult,
    };
    state.status = "review_ready";
    state.phase = "handoff";
    this.deps.store.save(state);
    return result("goal_review_passed", true, true, `Candidate ${state.candidateSha} passed detached review and awaits human merge.`);
  }

  private async assertWorktreeIdentity(state: GoalRunState, expectedHead: string, clean: boolean): Promise<void> {
    const job = goalJobView(state);
    await this.deps.git.verifyWorktree(job);
    if (await this.deps.git.head(state.worktreePath) !== expectedHead || await this.deps.git.branch(state.worktreePath) !== state.branch) {
      throw new ControllerError("goal_worktree_identity_drift", "Goal Worktree HEAD or branch changed outside its authority.");
    }
    if (clean && !(await this.deps.git.isClean(state.worktreePath))) throw new ControllerError("goal_worktree_dirty", "Goal Worktree must be clean.");
  }

  private async assertIssueScope(state: GoalRunState, issue: GoalIssueState): Promise<void> {
    const planIssue = state.plan.issues.find((entry) => entry.number === issue.number)!;
    if (planIssue.expectedPaths.length === 0) return;
    const changed = await this.deps.git.changedPaths(state.worktreePath);
    if (changed.some((path) => !planIssue.expectedPaths.some((pattern) => expectedPathMatches(pattern, path)))) {
      throw new ControllerError("goal_scope_path_drift", `Ticket #${issue.number} changed a path outside expectedPaths.`);
    }
  }

  private async assertCommitScope(state: GoalRunState, issue: GoalIssueState, sha: string): Promise<void> {
    const stats = await this.deps.git.commitStats(goalJobView(state), sha);
    const planIssue = state.plan.issues.find((entry) => entry.number === issue.number)!;
    if (stats.entries.some((entry) => entry.binary)
      || stats.files > this.deps.config.policy.maxChangedFiles
      || stats.changedLines > this.deps.config.policy.maxChangedLines) {
      throw new ControllerError("goal_scope_budget_exceeded", `Ticket #${issue.number} exceeds the configured change budget.`);
    }
    if (planIssue.expectedPaths.length > 0
      && stats.paths.some((path) => !planIssue.expectedPaths.some((pattern) => expectedPathMatches(pattern, path)))) {
      throw new ControllerError("goal_scope_path_drift", `Ticket #${issue.number} commit changed a path outside expectedPaths.`);
    }
  }

  private readValidation(state: GoalRunState, id: string): ValidationReceipt {
    const binding = state.validations.find((entry) => entry.id === id);
    if (!binding || !pathWithin(this.deps.store.root(state.id), binding.path)) throw new Error("Goal validation binding is invalid.");
    const receipt = readJsonFile<ValidationReceipt>(binding.path);
    assertValidationReceipt(receipt);
    if (receipt.digest !== binding.digest) throw new Error("Goal validation receipt drifted.");
    return receipt;
  }
}

export async function exportGoalReleaseResult(input: {
  config: ControllerConfig;
  store: GoalStore;
  git: GitPort;
  github: GitHubPort;
  state: GoalRunState;
  pullRequestNumber: number;
  outputPath: string;
}): Promise<GoalReleaseResultV1> {
  const { state } = input;
  if (state.status !== "review_ready" || state.phase !== "handoff" || !state.candidateSha || !state.review) {
    throw new ControllerError("goal_result_not_ready", "Goal release has no exact reviewed candidate.");
  }
  const observed = await input.github.inspectPullRequest(input.pullRequestNumber);
  const pull = observed.pullRequest;
  if (pull.number !== input.pullRequestNumber || pull.state !== "MERGED" || !pull.mergeSha || observed.mergedAt === null
    || pull.headSha !== state.candidateSha || pull.headRef !== state.branch || pull.baseRef !== state.baseRef
    || observed.checks.state !== "success") {
    throw new ControllerError("goal_result_pr_unverified", "Pull request, required checks, or reviewed candidate identity is not exact.");
  }
  await input.git.fetchBase();
  for (const issue of state.issues) {
    if (!issue.commitSha || !(await input.git.verifyIssueCommit({
      jobId: state.id,
      planDigest: state.planDigest,
      issueNumber: issue.number,
      sha: issue.commitSha,
      candidateSha: state.candidateSha,
    }))) throw new ControllerError("goal_result_issue_commit_invalid", `Ticket #${issue.number} commit is not an exact Goal candidate ancestor.`);
  }
  if (!(await input.git.isAncestorOfRemoteBase(pull.mergeSha))) {
    throw new ControllerError("goal_result_merge_unverified", "Goal merge is not present on the current remote base.");
  }
  if (await input.git.verifyMergeResult({
    mergeSha: pull.mergeSha,
    candidateSha: state.candidateSha,
    baseSha: state.baseSha,
    mergeMethod: input.config.delivery.mergeMethod,
  }) !== "verified") {
    throw new ControllerError("goal_result_merge_unverified", "Merged tree does not reproduce the reviewed Goal candidate.");
  }
  const completedAt = new Date(observed.mergedAt).toISOString();
  const releaseResult: GoalReleaseResultV1 = {
    schema: GOAL_RESULT_SCHEMA,
    releaseId: state.id,
    planDigest: state.planDigest,
    baseSha: state.baseSha,
    channel: state.channel,
    runnerRef: state.runnerRef,
    handoffDigest: state.handoffDigest,
    status: "merged",
    candidateSha: state.candidateSha,
    pullRequest: { number: pull.number, url: pull.url },
    requiredChecks: { names: requiredCheckNames(input.config), status: "passed" },
    mergeSha: pull.mergeSha,
    completedAt,
    reviewReportDigest: state.review.digest,
  };
  assertGoalReleaseResult(releaseResult);
  const output = resolve(input.outputPath);
  if (pathWithin(input.config.stateDir, output) || pathWithin(input.config.worktreeRoot, output)) {
    throw new ControllerError("goal_result_output_private_path", "Goal Release Result must be written outside private runtime state.");
  }
  writePublicJsonAtomic(output, releaseResult);
  state.result = releaseResult;
  state.status = "completed";
  state.phase = "complete";
  input.store.save(state);
  return releaseResult;
}

function goalObjective(state: GoalRunState, issue: GoalIssueState): string {
  return [
    `Complete approved Ticket #${issue.number} in Release ${state.id}.`,
    "Keep all work inside the exact approved Ticket scope and current Worktree.",
    "Do not commit, push, invoke gh, change branches/remotes, or modify external state.",
    "Mark complete only when every acceptance criterion in the supplied Ticket context has evidence; block if the approved Plan must change.",
  ].join(" ");
}

function assertGoalIdentity(goal: GoalRecord, threadId: string, objective: string): void {
  if (goal.threadId !== threadId || goal.objective !== objective) throw new ControllerError("goal_identity_drift", "Codex Goal identity changed.");
}

function updateGoal(issue: GoalIssueState, goal: GoalRecord): void {
  issue.goalStatus = goal.status;
  issue.goalTokensUsed = goal.tokensUsed;
  issue.goalTimeUsedSeconds = goal.timeUsedSeconds;
}

function currentIssue(state: GoalRunState): GoalIssueState | null {
  return state.currentIssueNumber === null ? null : state.issues.find((issue) => issue.number === state.currentIssueNumber) ?? null;
}

function nextPendingIssue(state: GoalRunState): GoalIssueState | null {
  return [...state.issues].sort((left, right) => left.order - right.order).find((issue) => issue.status === "pending") ?? null;
}

function assertDependenciesCommitted(state: GoalRunState, issue: GoalIssueState): void {
  const plan = state.plan.issues.find((entry) => entry.number === issue.number);
  if (!plan) throw new ControllerError("goal_issue_identity_missing", "Goal Plan Ticket is missing.");
  for (const dependency of plan.dependsOn) {
    if (state.issues.find((entry) => entry.number === dependency)?.status !== "committed") {
      throw new ControllerError("goal_dependency_incomplete", `Ticket #${issue.number} depends on uncommitted Ticket #${dependency}.`);
    }
  }
}

function issueValidationCommands(config: ControllerConfig, oracleCommands: string[]): ValidationCommandConfig[] {
  const oracle = oracleCommands.map((command) => config.validation.release.find((entry) => entry.command === command)!).filter(Boolean);
  const seen = new Set<string>();
  return [...oracle, ...config.validation.issue].filter((command) => {
    const key = `${command.command}\n${command.timeoutMs ?? "default"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function appendValidation(state: GoalRunState, receipt: ValidationReceipt, path: string): void {
  state.validations.push({
    id: receipt.id,
    scope: receipt.scope === "release" ? "release" : "issue",
    issueNumber: receipt.issueNumber,
    path,
    passed: receipt.passed,
    digest: receipt.digest,
  });
}

function assertGoalTurn(status: string): void {
  if (status === "interrupted") throw new ControllerError("goal_turn_interrupted", "Codex Goal turn was interrupted.");
  if (status !== "completed") throw new ControllerError("goal_turn_failed", `Codex Goal turn ended as ${status}.`);
}

function result(action: string, progressed: boolean, terminal: boolean, message: string): StepResult {
  return { action, progressed, terminal, retryAfterMs: null, message };
}
