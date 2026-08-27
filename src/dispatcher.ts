import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ControllerConfig,
  DispatcherConfig,
  DispatcherCurrent,
  DispatcherState,
  DispatcherStepResult,
  JobState,
  QueueIssue,
  ReleasePlanV1,
  WorkflowGateSummary,
} from "./types.js";
import type { GitHubPort, GitPort } from "./ports.js";
import type { ReleaseController } from "./controller.js";
import { CommandInterruptedError } from "./command.js";
import { ControllerError, asControllerError } from "./errors.js";
import { ensurePrivateDir, readJsonFile, writeJsonAtomic, writeTextAtomic } from "./fs-atomic.js";
import { loadPlan, validatePlan } from "./plan.js";
import { JobStore } from "./state.js";
import {
  digestJson,
  nowIso,
  pathWithin,
  safeToken,
  sha256PrefixedUtf8,
} from "./util.js";

type DispatcherDependencies = {
  store: JobStore;
  controller: Pick<ReleaseController, "step">;
  git: GitPort;
  github: GitHubPort;
  controllerConfig: ControllerConfig;
  controllerConfigPath: string;
  controllerConfigDigest: string;
  dispatcherConfig: DispatcherConfig;
  dispatcherConfigPath: string;
  dispatcherConfigDigest: string;
};

export class IssueDispatcher {
  readonly stateStore: DispatcherStore;

  constructor(private readonly deps: DispatcherDependencies) {
    this.stateStore = new DispatcherStore(
      deps.controllerConfig,
      deps.controllerConfigPath,
      deps.controllerConfigDigest,
      deps.dispatcherConfig,
      deps.dispatcherConfigPath,
      deps.dispatcherConfigDigest,
    );
  }

  status(): DispatcherState {
    return this.stateStore.loadOrCreate();
  }

  retry(reason: string): { action: string; notePath: string; state: DispatcherState } {
    const state = this.stateStore.loadOrCreate();
    if (!state.blocked) throw new Error("dispatcher is not blocked");
    const notePath = join(this.stateStore.root, `operator-retry-${Date.now()}.md`);
    writeTextAtomic(notePath, [
      "# Dispatcher operator retry",
      "",
      `Time: ${nowIso()}`,
      `Previous code: ${state.blocked.code}`,
      "",
      reason.trim(),
      "",
    ].join("\n"));
    state.blocked = null;
    this.stateStore.save(state);
    return { action: "dispatcher_retry_authorized", notePath, state };
  }

  async step(): Promise<DispatcherStepResult> {
    let state = this.stateStore.loadOrCreate();
    if (state.blocked) {
      return dispatchResult(
        "dispatcher_blocked",
        false,
        true,
        null,
        `${state.blocked.code}: ${state.blocked.message}`,
        state.current,
      );
    }
    try {
      state = this.rebindIdleState(state);
      return await this.stepCurrent(state);
    } catch (error) {
      if (error instanceof CommandInterruptedError) throw error;
      const classified = asControllerError(error, "dispatcher_step_failed");
      state = this.stateStore.loadOrCreate();
      const detailsPath = join(this.stateStore.root, `blocked-${Date.now()}.json`);
      writeJsonAtomic(detailsPath, {
        code: classified.code,
        message: classified.message,
        current: state.current,
        createdAt: nowIso(),
      });
      state.blocked = {
        code: classified.code,
        message: classified.message,
        createdAt: nowIso(),
        detailsPath,
      };
      this.stateStore.save(state);
      return dispatchResult(
        "dispatcher_blocked",
        true,
        true,
        null,
        `${classified.code}: ${classified.message}`,
        state.current,
      );
    }
  }

  private rebindIdleState(state: DispatcherState): DispatcherState {
    const controllerDrift = state.controllerConfigDigest !== this.deps.controllerConfigDigest;
    const dispatcherDrift = state.dispatcherConfigDigest !== this.deps.dispatcherConfigDigest;
    if (!controllerDrift && !dispatcherDrift) return state;
    if (state.current) {
      throw new ControllerError(
        "dispatcher_config_drift",
        "Controller or dispatcher configuration changed while a claimed Issue is active.",
      );
    }
    state.controllerConfigPath = resolve(this.deps.controllerConfigPath);
    state.controllerConfigDigest = this.deps.controllerConfigDigest;
    state.dispatcherConfigPath = resolve(this.deps.dispatcherConfigPath);
    state.dispatcherConfigDigest = this.deps.dispatcherConfigDigest;
    this.stateStore.save(state);
    return state;
  }

  private async stepCurrent(state: DispatcherState): Promise<DispatcherStepResult> {
    if (!state.current) return this.select(state);
    switch (state.current.phase) {
      case "selected": return this.claim(state);
      case "claimed": return this.preparePlan(state);
      case "plan_ready": return this.startJob(state);
      case "job_running": return this.runJobStep(state);
      case "post_merge": return this.verifyPostMerge(state);
    }
  }

  private async select(state: DispatcherState): Promise<DispatcherStepResult> {
    const active = this.deps.store.active();
    if (active.length > 0) {
      return dispatchResult(
        "repository_busy",
        false,
        true,
        null,
        `A release job is already active: ${active.map((job) => `${job.id} (${job.status}/${job.phase})`).join(", ")}.`,
        null,
      );
    }
    const issues = await this.deps.github.listSubIssues(this.deps.dispatcherConfig.parentIssue);
    const issue = selectEligibleIssue(issues, this.deps.dispatcherConfig.readyLabel);
    if (!issue) {
      return dispatchResult(
        "queue_idle",
        false,
        true,
        null,
        `No open, unblocked, unassigned ${this.deps.dispatcherConfig.readyLabel} sub-issue is eligible.`,
        null,
      );
    }
    const login = await this.deps.github.currentLogin();
    state.current = {
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueBodyHash: sha256PrefixedUtf8(issue.body),
      issueUrl: issue.url,
      login,
      selectedAt: nowIso(),
      phase: "selected",
      planId: null,
      planPath: null,
      jobId: null,
      sourceVerifiedAt: null,
      postMergeStartedAt: null,
    };
    this.stateStore.save(state);
    return dispatchResult(
      "issue_selected",
      true,
      false,
      null,
      `Selected Issue #${issue.number} as the first eligible child in parent order.`,
      state.current,
    );
  }

  private async claim(state: DispatcherState): Promise<DispatcherStepResult> {
    const current = requiredCurrent(state);
    let issue = await this.fetchCurrentSubIssue(current);
    assertQueueSource(issue, current, this.deps.dispatcherConfig.readyLabel, false);
    if (issue.assignees.length === 0) {
      await this.deps.github.claimIssue(issue.number, current.login);
      issue = await this.fetchCurrentSubIssue(current);
    }
    assertQueueSource(issue, current, this.deps.dispatcherConfig.readyLabel, true);
    current.phase = "claimed";
    this.stateStore.save(state);
    return dispatchResult(
      "issue_claimed",
      true,
      false,
      null,
      `Claimed Issue #${issue.number} as ${current.login}.`,
      current,
    );
  }

  private async preparePlan(state: DispatcherState): Promise<DispatcherStepResult> {
    const current = requiredCurrent(state);
    const issue = await this.fetchCurrentSubIssue(current);
    assertQueueSource(issue, current, this.deps.dispatcherConfig.readyLabel, true);
    const plan = buildDispatchPlan(issue, this.deps.dispatcherConfig, current.selectedAt);
    const planPath = join(this.stateStore.plansRoot, `${plan.id}.json`);
    if (existsSync(planPath)) {
      const existing = loadPlan(planPath);
      if (digestJson(existing) !== digestJson(plan)) {
        throw new ControllerError("dispatcher_plan_drift", `Existing dispatch plan ${plan.id} differs from the selected Issue.`);
      }
    } else {
      writeJsonAtomic(planPath, plan);
    }
    current.planId = plan.id;
    current.planPath = planPath;
    current.phase = "plan_ready";
    this.stateStore.save(state);
    return dispatchResult(
      "plan_prepared",
      true,
      false,
      null,
      `Prepared one-Issue release plan ${plan.id}.`,
      current,
    );
  }

  private async startJob(state: DispatcherState): Promise<DispatcherStepResult> {
    const current = requiredCurrent(state);
    if (!current.planId || !current.planPath || !pathWithin(this.stateStore.plansRoot, current.planPath)) {
      throw new ControllerError("dispatcher_plan_missing", "Claimed Issue has no safe dispatcher-owned plan path.");
    }
    const plan = loadPlan(current.planPath);
    if (plan.id !== current.planId || plan.issues.length !== 1 || plan.issues[0]?.number !== current.issueNumber) {
      throw new ControllerError("dispatcher_plan_identity_mismatch", "Dispatch plan does not bind exactly the claimed Issue.");
    }

    let job: JobState;
    if (existsSync(this.deps.store.path(plan.id))) {
      job = this.deps.store.load(plan.id);
      assertOwnedJob(job, current, this.deps.controllerConfigDigest);
    } else {
      const active = this.deps.store.active();
      if (active.length > 0) {
        return dispatchResult(
          "repository_busy",
          false,
          true,
          null,
          `Another release job became active before Issue #${current.issueNumber} could start.`,
          current,
        );
      }
      const issue = await this.fetchCurrentSubIssue(current);
      assertQueueSource(issue, current, this.deps.dispatcherConfig.readyLabel, true);
      job = this.deps.store.create({
        configPath: resolve(this.deps.controllerConfigPath),
        planPath: current.planPath,
        plan,
        configDigest: this.deps.controllerConfigDigest,
        planDigest: digestJson(plan),
      });
    }
    current.jobId = job.id;
    current.phase = "job_running";
    this.stateStore.save(state);
    return dispatchResult(
      "job_started",
      true,
      false,
      null,
      `Started Controller job ${job.id} for Issue #${current.issueNumber}.`,
      current,
    );
  }

  private async runJobStep(state: DispatcherState): Promise<DispatcherStepResult> {
    const current = requiredCurrent(state);
    if (!current.jobId) throw new ControllerError("dispatcher_job_missing", "Dispatcher has no Controller job identity.");
    let job = this.deps.store.load(current.jobId);
    assertOwnedJob(job, current, this.deps.controllerConfigDigest);
    if (job.status === "blocked") {
      return dispatchResult(
        "job_blocked",
        false,
        true,
        null,
        `${job.blocked?.code ?? "job_blocked"}: ${job.blocked?.message ?? "Controller job is blocked."}`,
        current,
      );
    }
    if (job.status === "failed") {
      return dispatchResult("job_failed", false, true, null, `Controller job ${job.id} failed.`, current);
    }
    if (job.status === "ready_to_merge") {
      throw new ControllerError("dispatcher_manual_merge_gate", "Dispatcher-owned job unexpectedly stopped at a manual merge gate.");
    }
    if (job.status === "completed") return this.enterPostMerge(state, job);

    if (job.phase === "implement" && current.sourceVerifiedAt === null) {
      const issue = await this.fetchCurrentSubIssue(current);
      assertQueueSource(issue, current, this.deps.dispatcherConfig.readyLabel, true);
      const snapshot = job.issues[0]?.snapshot;
      if (!snapshot
        || snapshot.number !== current.issueNumber
        || snapshot.title !== current.issueTitle
        || sha256PrefixedUtf8(snapshot.body) !== current.issueBodyHash) {
        throw new ControllerError(
          "dispatcher_pre_worker_source_drift",
          "Controller snapshot no longer matches the exact Issue selected before claim.",
        );
      }
      current.sourceVerifiedAt = nowIso();
      this.stateStore.save(state);
      return dispatchResult(
        "pre_worker_source_verified",
        true,
        false,
        null,
        `Verified the exact claimed Issue #${current.issueNumber} immediately before the first Worker.`,
        current,
      );
    }

    const result = await this.deps.controller.step(job.id);
    job = this.deps.store.load(job.id);
    if (job.status === "completed") return this.enterPostMerge(state, job);
    if (job.status === "blocked") {
      return dispatchResult("job_blocked", result.progressed, true, null, result.message, current);
    }
    if (job.status === "failed" || job.status === "ready_to_merge") {
      return dispatchResult(`job_${job.status}`, result.progressed, true, null, result.message, current);
    }
    return dispatchResult(
      `controller_${result.action}`,
      result.progressed,
      false,
      result.retryAfterMs,
      result.message,
      current,
    );
  }

  private enterPostMerge(state: DispatcherState, job: JobState): DispatcherStepResult {
    const current = requiredCurrent(state);
    if (!job.pullRequest || !job.candidateSha) {
      throw new ControllerError("dispatcher_merge_identity_missing", "Completed dispatcher job has no PR or candidate identity.");
    }
    current.phase = "post_merge";
    current.postMergeStartedAt ??= nowIso();
    this.stateStore.save(state);
    return dispatchResult(
      "post_merge_verification_started",
      true,
      false,
      this.deps.dispatcherConfig.postMerge.pollIntervalMs,
      `PR #${job.pullRequest.number} merged; verifying origin/${job.baseRef}, Issue closure, and required main workflows.`,
      current,
    );
  }

  private async verifyPostMerge(state: DispatcherState): Promise<DispatcherStepResult> {
    const current = requiredCurrent(state);
    if (!current.jobId || !current.postMergeStartedAt) {
      throw new ControllerError("dispatcher_post_merge_state_missing", "Post-merge verification state is incomplete.");
    }
    const job = this.deps.store.load(current.jobId);
    assertOwnedJob(job, current, this.deps.controllerConfigDigest);
    if (job.status !== "completed" || !job.pullRequest || !job.candidateSha) {
      throw new ControllerError("dispatcher_post_merge_job_invalid", "Post-merge verification requires a completed PR delivery job.");
    }
    const observed = await this.deps.github.inspectPullRequest(job.pullRequest.number);
    const pullRequest = observed.pullRequest;
    if (pullRequest.state !== "MERGED" || observed.mergedAt === null || !pullRequest.mergeSha) {
      throw new ControllerError("dispatcher_merge_not_durable", "GitHub no longer reports a durable merged PR with a merge commit.");
    }
    if (pullRequest.headSha !== job.candidateSha
      || pullRequest.headRef !== job.branch
      || pullRequest.baseRef !== job.baseRef) {
      throw new ControllerError("dispatcher_merged_identity_mismatch", "Merged PR does not bind the exact reviewed candidate.");
    }
    job.pullRequest = pullRequest;
    this.deps.store.save(job);

    await this.deps.git.fetchBase();
    const mergedOnBase = await this.deps.git.isAncestorOfRemoteBase(pullRequest.mergeSha);
    const issue = await this.deps.github.fetchQueueIssue(current.issueNumber);
    const workflowGate = await this.deps.github.inspectWorkflowGate(
      pullRequest.mergeSha,
      this.deps.dispatcherConfig.postMerge.requiredWorkflows,
    );
    if (workflowGate.state === "failure") {
      const detailsPath = this.writePostMergeEvidence(current, "workflow-failure", { workflowGate, issue, mergedOnBase });
      throw new ControllerError("post_merge_ci_failed", "A required main-branch workflow failed.", detailsPath);
    }
    if (!mergedOnBase || issue.state !== "CLOSED" || workflowGate.state === "pending") {
      if (postMergeTimedOut(current.postMergeStartedAt, this.deps.dispatcherConfig.postMerge.timeoutMs)) {
        const detailsPath = this.writePostMergeEvidence(current, "timeout", { workflowGate, issue, mergedOnBase });
        throw new ControllerError(
          "post_merge_verification_timeout",
          "Post-merge base, Issue closure, or required workflow evidence did not become complete before the timeout.",
          detailsPath,
        );
      }
      return dispatchResult(
        "post_merge_pending",
        false,
        false,
        this.deps.dispatcherConfig.postMerge.pollIntervalMs,
        `Waiting for post-merge evidence: base=${mergedOnBase}, issue=${issue.state}, workflows=${workflowGate.state}.`,
        current,
      );
    }

    const verifiedAt = nowIso();
    state.history.push({
      issueNumber: current.issueNumber,
      jobId: job.id,
      pullRequestNumber: pullRequest.number,
      candidateSha: job.candidateSha,
      mergeSha: pullRequest.mergeSha,
      workflowGate,
      verifiedAt,
    });
    if (state.history.length > 100) state.history.splice(0, state.history.length - 100);
    state.current = null;
    state.blocked = null;
    this.stateStore.save(state);
    return dispatchResult(
      "issue_completed_verified",
      true,
      false,
      null,
      `Issue #${current.issueNumber} merged as ${pullRequest.mergeSha}; origin/${job.baseRef}, Issue closure, and required main workflows are verified.`,
      current,
    );
  }

  private writePostMergeEvidence(current: DispatcherCurrent, kind: string, value: unknown): string {
    const path = join(this.stateStore.root, `post-merge-${current.issueNumber}-${kind}-${Date.now()}.json`);
    writeJsonAtomic(path, { issueNumber: current.issueNumber, jobId: current.jobId, ...asRecord(value), createdAt: nowIso() });
    return path;
  }

  private async fetchCurrentSubIssue(current: DispatcherCurrent): Promise<QueueIssue> {
    const issues = await this.deps.github.listSubIssues(this.deps.dispatcherConfig.parentIssue);
    const matches = issues.filter((issue) => issue.number === current.issueNumber);
    if (matches.length !== 1) {
      throw new ControllerError(
        "dispatcher_parent_membership_drift",
        `Selected Issue #${current.issueNumber} is no longer exactly one child of parent #${this.deps.dispatcherConfig.parentIssue}.`,
      );
    }
    return matches[0]!;
  }
}

export class DispatcherStore {
  readonly root: string;
  readonly plansRoot: string;
  readonly statePath: string;

  constructor(
    private readonly controllerConfig: ControllerConfig,
    private readonly controllerConfigPath: string,
    private readonly controllerConfigDigest: string,
    private readonly dispatcherConfig: DispatcherConfig,
    private readonly dispatcherConfigPath: string,
    private readonly dispatcherConfigDigest: string,
  ) {
    this.root = ensurePrivateDir(join(controllerConfig.stateDir, "dispatcher"));
    this.plansRoot = ensurePrivateDir(join(this.root, "plans"));
    this.statePath = join(this.root, "state.json");
  }

  loadOrCreate(): DispatcherState {
    if (existsSync(this.statePath)) {
      const state = readJsonFile<DispatcherState>(this.statePath);
      assertDispatcherState(state, this.controllerConfig.repo, this.dispatcherConfig.parentIssue);
      return state;
    }
    const now = nowIso();
    const state: DispatcherState = {
      version: 1,
      repo: this.controllerConfig.repo,
      parentIssue: this.dispatcherConfig.parentIssue,
      controllerConfigPath: resolve(this.controllerConfigPath),
      controllerConfigDigest: this.controllerConfigDigest,
      dispatcherConfigPath: resolve(this.dispatcherConfigPath),
      dispatcherConfigDigest: this.dispatcherConfigDigest,
      current: null,
      blocked: null,
      history: [],
      createdAt: now,
      updatedAt: now,
    };
    this.save(state);
    return state;
  }

  save(state: DispatcherState): void {
    assertDispatcherState(state, this.controllerConfig.repo, this.dispatcherConfig.parentIssue);
    state.updatedAt = nowIso();
    writeJsonAtomic(this.statePath, state);
  }
}

export function selectEligibleIssue(issues: QueueIssue[], readyLabel: string): QueueIssue | null {
  const numbers = issues.map((issue) => issue.number);
  if (new Set(numbers).size !== numbers.length) throw new Error("parent sub-issue list contains duplicate Issue numbers");
  return issues.find((issue) => (
    issue.state === "OPEN"
    && issue.labels.includes(readyLabel)
    && issue.assignees.length === 0
    && issue.openBlockers === 0
  )) ?? null;
}

export function buildDispatchPlan(
  issue: QueueIssue,
  config: DispatcherConfig,
  selectedAt: string,
): ReleasePlanV1 {
  const objective = markdownSection(issue.body, "What to build");
  if (!objective) throw new ControllerError("dispatcher_issue_objective_missing", "Eligible Issue has no non-empty What to build section.");
  const acceptanceSection = markdownSection(issue.body, "Acceptance criteria");
  const acceptanceCriteria = acceptanceSection
    .split(/\r?\n/)
    .map((line) => /^\s*-\s*\[[ xX]\]\s+(.+?)\s*$/.exec(line)?.[1] ?? null)
    .filter((entry): entry is string => entry !== null);
  if (acceptanceCriteria.length === 0) {
    throw new ControllerError("dispatcher_issue_acceptance_missing", "Eligible Issue has no checklist Acceptance criteria.");
  }
  const timestamp = selectedAt.replace(/\.\d{3}Z$/, "Z");
  const id = safeToken(`dispatch-issue-${issue.number}-${timestamp}-${sha256PrefixedUtf8(issue.body).slice(7, 15)}`);
  const plan: ReleasePlanV1 = {
    version: 1,
    id,
    title: issue.title,
    objective: `Deliver Issue #${issue.number}: ${objective}`,
    parentIssue: config.parentIssue,
    issues: [{
      number: issue.number,
      order: 1,
      dependsOn: [],
      objective,
      acceptanceCriteria,
      suggestedValidation: [],
      allowNoop: false,
    }],
    releaseAcceptanceCriteria: config.releaseAcceptanceCriteria,
    reviewFocus: config.reviewFocus,
  };
  const validated = validatePlan(plan);
  if (validated.version !== 1) throw new Error("dispatcher built an unexpected plan version");
  return validated;
}

function markdownSection(body: string, heading: string): string {
  const lines = body.split(/\r?\n/);
  const expected = heading.trim().toLowerCase();
  const start = lines.findIndex((line) => {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    return match?.[1]?.trim().toLowerCase() === expected;
  });
  if (start < 0) return "";
  const content: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^##\s+/.test(line)) break;
    content.push(line);
  }
  return content.join("\n").trim();
}

function assertQueueSource(
  issue: QueueIssue,
  current: DispatcherCurrent,
  readyLabel: string,
  requireClaim: boolean,
): void {
  if (issue.number !== current.issueNumber
    || issue.title !== current.issueTitle
    || sha256PrefixedUtf8(issue.body) !== current.issueBodyHash
    || issue.url !== current.issueUrl) {
    throw new ControllerError("dispatcher_issue_source_drift", "Selected Issue title, body, URL, or number changed.");
  }
  if (issue.state !== "OPEN") throw new ControllerError("dispatcher_issue_closed", "Selected Issue is no longer open.");
  if (!issue.labels.includes(readyLabel)) {
    throw new ControllerError("dispatcher_issue_not_ready", `Selected Issue no longer has ${readyLabel}.`);
  }
  if (issue.openBlockers !== 0) {
    throw new ControllerError("dispatcher_issue_blocked", "Selected Issue has an open native dependency blocker.");
  }
  if (requireClaim) {
    if (issue.assignees.length !== 1 || issue.assignees[0] !== current.login) {
      throw new ControllerError("dispatcher_claim_conflict", "Selected Issue is not assigned exclusively to the dispatcher identity.");
    }
  } else if (issue.assignees.length > 0
    && (issue.assignees.length !== 1 || issue.assignees[0] !== current.login)) {
    throw new ControllerError("dispatcher_claim_conflict", "Another assignee claimed the selected Issue.");
  }
}

function assertOwnedJob(job: JobState, current: DispatcherCurrent, configDigest: string): void {
  if (job.configDigest !== configDigest
    || job.issues.length !== 1
    || job.issues[0]?.number !== current.issueNumber) {
    throw new ControllerError("dispatcher_job_identity_mismatch", "Controller job is not owned by the current dispatcher claim.");
  }
}

function requiredCurrent(state: DispatcherState): DispatcherCurrent {
  if (!state.current) throw new Error("dispatcher current Issue is missing");
  return state.current;
}

function postMergeTimedOut(startedAt: string, timeoutMs: number): boolean {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) throw new Error("dispatcher post-merge start time is invalid");
  return Date.now() - started >= timeoutMs;
}

function assertDispatcherState(state: DispatcherState, repo: string, parentIssue: number): void {
  if (!state || state.version !== 1 || state.repo !== repo || state.parentIssue !== parentIssue) {
    throw new Error("dispatcher state identity is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(state.controllerConfigDigest)
    || !/^[a-f0-9]{64}$/.test(state.dispatcherConfigDigest)) {
    throw new Error("dispatcher state config digest is invalid");
  }
  if (!Array.isArray(state.history) || state.history.length > 100) throw new Error("dispatcher history is invalid");
  if (state.blocked && (!state.blocked.code || !state.blocked.message)) throw new Error("dispatcher blocked state is invalid");
  if (state.current) {
    const phases: DispatcherCurrent["phase"][] = ["selected", "claimed", "plan_ready", "job_running", "post_merge"];
    if (!Number.isSafeInteger(state.current.issueNumber)
      || state.current.issueNumber < 1
      || !state.current.issueTitle
      || !/^sha256:[a-f0-9]{64}$/.test(state.current.issueBodyHash)
      || !state.current.login
      || !phases.includes(state.current.phase)) {
      throw new Error("dispatcher current Issue state is invalid");
    }
  }
}

function dispatchResult(
  action: string,
  progressed: boolean,
  terminal: boolean,
  retryAfterMs: number | null,
  message: string,
  current: DispatcherCurrent | null,
): DispatcherStepResult {
  return {
    action,
    progressed,
    terminal,
    retryAfterMs,
    message,
    issueNumber: current?.issueNumber ?? null,
    jobId: current?.jobId ?? null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}
