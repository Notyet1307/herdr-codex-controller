import { existsSync, lstatSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type {
  BlockedKind,
  ControllerConfig,
  IssueSnapshot,
  JobState,
  ReleasePlan,
  ReviewResult,
} from "./types.js";
import { expectExactKeys, expectObject } from "./config.js";
import { assertPlanCompatibleWithConfig, validatePlan } from "./plan.js";
import { copyJsonSnapshot, ensurePrivateDir, readJsonFile, writeJsonAtomic } from "./fs-atomic.js";
import { boundedExactText, boundedText, digestJson, nowIso, pathWithin, safeToken } from "./util.js";
import { ControllerError } from "./errors.js";

export const GOAL_HANDOFF_SCHEMA = "pi-ticket-planning:goal-handoff:v1";
export const GOAL_RESULT_SCHEMA = "pi-ticket-planning:goal-release-result:v1";

export type GoalChannel = "GOAL_LOCAL" | "GOAL_REMOTE";
export type GoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
export type GoalRunPhase = "prepare" | "implement" | "validate" | "release_validate" | "review" | "handoff" | "complete";
export type GoalRunStatus = "running" | "blocked" | "review_ready" | "completed" | "failed";

export type GoalHandoffV1 = {
  schema: typeof GOAL_HANDOFF_SCHEMA;
  releaseId: string;
  repo: string;
  baseSha: string;
  planDigest: string;
  channel: GoalChannel;
  runnerRef: string;
  runnerDigest: string;
  runnerHost: string;
  releasePlan: ReleasePlan;
};

export type GoalIssueState = {
  number: number;
  order: number;
  status: "pending" | "running" | "validating" | "committed" | "blocked";
  snapshot: IssueSnapshot | null;
  inputHeadSha: string | null;
  threadId: string | null;
  activeTurnId: string | null;
  activeTurnBaselineIds: string[] | null;
  goalStatus: GoalStatus | null;
  goalTokensUsed: number;
  goalTimeUsedSeconds: number;
  validationRounds: number;
  lastValidationId: string | null;
  commitSha: string | null;
};

export type GoalValidationBinding = {
  id: string;
  scope: "issue" | "release";
  issueNumber: number | null;
  path: string;
  passed: boolean;
  digest: string;
};

export type GoalRunState = {
  version: 1;
  id: string;
  channel: GoalChannel;
  runnerRef: string;
  runnerDigest: string;
  runnerHost: string;
  codexHomePath: string;
  configPath: string;
  configDigest: string;
  handoffPath: string;
  handoffDigest: string;
  planDigest: string;
  repo: string;
  plan: ReleasePlan;
  baseRef: string;
  baseSha: string;
  remote: string;
  branch: string;
  worktreePath: string;
  status: GoalRunStatus;
  phase: GoalRunPhase;
  issues: GoalIssueState[];
  currentIssueNumber: number | null;
  validations: GoalValidationBinding[];
  candidateSha: string | null;
  review: {
    runId: string;
    path: string;
    digest: string;
    result: ReviewResult;
  } | null;
  blocked: {
    code: string;
    kind: BlockedKind;
    message: string;
    fromPhase: GoalRunPhase;
    createdAt: string;
    detailsPath: string | null;
  } | null;
  result: GoalReleaseResultV1 | null;
  createdAt: string;
  updatedAt: string;
};

export type GoalReleaseResultV1 = {
  schema: typeof GOAL_RESULT_SCHEMA;
  releaseId: string;
  planDigest: string;
  baseSha: string;
  channel: GoalChannel;
  runnerRef: string;
  handoffDigest: string;
  status: "merged";
  candidateSha: string;
  pullRequest: { number: number; url: string };
  requiredChecks: { names: string[]; status: "passed" };
  mergeSha: string;
  completedAt: string;
  reviewReportDigest: string;
};

export function assertGoalReleaseResult(value: unknown): asserts value is GoalReleaseResultV1 {
  const result = expectObject(value, "Goal Release Result") as unknown as GoalReleaseResultV1;
  const keys = [
    "baseSha", "candidateSha", "channel", "completedAt", "handoffDigest", "mergeSha", "planDigest", "pullRequest",
    "releaseId", "requiredChecks", "reviewReportDigest", "runnerRef", "schema", "status",
  ];
  if (Object.keys(result as unknown as Record<string, unknown>).sort().join("\n") !== keys.sort().join("\n")
    || result.schema !== GOAL_RESULT_SCHEMA || result.status !== "merged"
    || !["GOAL_LOCAL", "GOAL_REMOTE"].includes(result.channel)
    || safeToken(result.runnerRef) !== result.runnerRef || !/^sha256:[a-f0-9]{64}$/u.test(result.handoffDigest)
    || safeToken(result.releaseId) !== result.releaseId || !/^[a-f0-9]{64}$/u.test(result.planDigest)
    || !/^[a-f0-9]{40}$/u.test(result.baseSha) || !/^[a-f0-9]{40}$/u.test(result.candidateSha)
    || !/^[a-f0-9]{40}$/u.test(result.mergeSha) || !/^sha256:[a-f0-9]{64}$/u.test(result.reviewReportDigest)
    || !canonicalTime(result.completedAt)
    || Object.keys(result.pullRequest ?? {}).sort().join("\n") !== "number\nurl"
    || !Number.isSafeInteger(result.pullRequest?.number) || result.pullRequest.number < 1
    || typeof result.pullRequest?.url !== "string" || !result.pullRequest.url.startsWith("https://")
    || Object.keys(result.requiredChecks ?? {}).sort().join("\n") !== "names\nstatus"
    || result.requiredChecks?.status !== "passed" || !Array.isArray(result.requiredChecks.names)
    || result.requiredChecks.names.length === 0 || result.requiredChecks.names.length > 100
    || new Set(result.requiredChecks.names).size !== result.requiredChecks.names.length
    || result.requiredChecks.names.some((name) => typeof name !== "string" || !name || name.length > 500)) {
    throw new ControllerError("goal_release_result_invalid", "Goal Release Result is invalid.");
  }
}

export function goalHandoffFingerprint(handoff: GoalHandoffV1): string {
  return `sha256:${digestJson(handoff)}`;
}

export function loadGoalHandoff(path: string): GoalHandoffV1 {
  return validateGoalHandoff(readJsonFile<unknown>(resolve(path)));
}

export function validateGoalHandoff(value: unknown): GoalHandoffV1 {
  const object = expectObject(value, "goal handoff");
  expectExactKeys(object, [
    "baseSha", "channel", "planDigest", "releaseId", "releasePlan", "repo", "runnerDigest", "runnerHost", "runnerRef", "schema",
  ], "goal handoff");
  if (object.schema !== GOAL_HANDOFF_SCHEMA) throw new ControllerError("invalid_goal_handoff", "Goal handoff schema is unsupported.");
  if (object.channel !== "GOAL_LOCAL" && object.channel !== "GOAL_REMOTE") {
    throw new ControllerError("invalid_goal_channel", "Goal channel must be GOAL_LOCAL or GOAL_REMOTE.");
  }
  const plan = validatePlan(object.releasePlan);
  const releaseId = boundedText(object.releaseId, "goal handoff releaseId", 80);
  const repo = boundedExactText(object.repo, "goal handoff repo", 300);
  const baseSha = boundedExactText(object.baseSha, "goal handoff baseSha", 40);
  const planDigest = boundedExactText(object.planDigest, "goal handoff planDigest", 64);
  const runnerRef = boundedText(object.runnerRef, "goal handoff runnerRef", 80);
  const runnerDigest = boundedExactText(object.runnerDigest, "goal handoff runnerDigest", 71);
  const runnerHost = boundedExactText(object.runnerHost, "goal handoff runnerHost", 253);
  if (safeToken(releaseId) !== releaseId || safeToken(runnerRef) !== runnerRef
    || !/^sha256:[a-f0-9]{64}$/u.test(runnerDigest) || !/^(?!-)[A-Za-z0-9._-]{1,253}$/u.test(runnerHost)
    || !/^[a-f0-9]{40}$/u.test(baseSha) || !/^[a-f0-9]{64}$/u.test(planDigest)) {
    throw new ControllerError("invalid_goal_handoff", "Goal handoff digest or base identity is invalid.");
  }
  if (releaseId !== plan.id || repo !== plan.repo || baseSha !== plan.baseSha || planDigest !== digestJson(plan)) {
    throw new ControllerError("goal_handoff_plan_binding_mismatch", "Goal handoff does not bind its embedded Release Plan.");
  }
  if (object.channel === "GOAL_LOCAL" && runnerRef !== "local") {
    throw new ControllerError("invalid_goal_runner_ref", "GOAL_LOCAL requires runnerRef=local.");
  }
  if (plan.issues.some((issue) => issue.risk === "high")) {
    throw new ControllerError("goal_high_risk_requires_controller", "High-risk Release Plans must use the Controller channel.");
  }
  return {
    schema: GOAL_HANDOFF_SCHEMA,
    releaseId,
    repo,
    baseSha,
    planDigest,
    channel: object.channel,
    runnerRef,
    runnerDigest,
    runnerHost,
    releasePlan: plan,
  };
}

export function assertGoalHandoffCompatible(handoff: GoalHandoffV1, config: ControllerConfig, runnerRef: string): void {
  assertPlanCompatibleWithConfig(handoff.releasePlan, config);
  if (safeToken(runnerRef) !== runnerRef || runnerRef !== handoff.runnerRef) {
    throw new ControllerError("goal_runner_ref_mismatch", "This runner identity does not match the approved Goal handoff.");
  }
  if (hostname() !== handoff.runnerHost) {
    throw new ControllerError("goal_runner_host_mismatch", "This host does not match the approved Goal runner host.");
  }
}

export class GoalStore {
  readonly runsRoot: string;

  constructor(readonly config: ControllerConfig) {
    this.runsRoot = ensurePrivateDir(join(config.stateDir, "goal-runs"));
  }

  create(input: {
    configPath: string;
    handoffPath: string | null;
    handoff: GoalHandoffV1;
    handoffDigest: string;
  }): GoalRunState {
    const id = input.handoff.releaseId;
    const root = this.root(id);
    if (existsSync(root)) throw new ControllerError("goal_run_exists", `Goal run already exists: ${id}`);
    ensurePrivateDir(root);
    copyJsonSnapshot(input.configPath, join(root, "config.snapshot.json"));
    const handoffSnapshot = join(root, "goal-handoff.snapshot.json");
    if (input.handoffPath === null) writeJsonAtomic(handoffSnapshot, input.handoff);
    else copyJsonSnapshot(input.handoffPath, handoffSnapshot);
    const now = nowIso();
    const state: GoalRunState = {
      version: 1,
      id,
      channel: input.handoff.channel,
      runnerRef: input.handoff.runnerRef,
      runnerDigest: input.handoff.runnerDigest,
      runnerHost: input.handoff.runnerHost,
      codexHomePath: join(root, "codex-home"),
      configPath: resolve(input.configPath),
      configDigest: digestJson(this.config),
      handoffPath: handoffSnapshot,
      handoffDigest: input.handoffDigest,
      planDigest: input.handoff.planDigest,
      repo: input.handoff.repo,
      plan: input.handoff.releasePlan,
      baseRef: this.config.baseRef,
      baseSha: input.handoff.baseSha,
      remote: this.config.remote,
      branch: `${this.config.branchPrefix}/goal-${id}`,
      worktreePath: resolve(this.config.worktreeRoot, "goal", id),
      status: "running",
      phase: "prepare",
      issues: input.handoff.releasePlan.issues.map((issue) => ({
        number: issue.number,
        order: issue.order,
        status: "pending",
        snapshot: null,
        inputHeadSha: null,
        threadId: null,
        activeTurnId: null,
        activeTurnBaselineIds: null,
        goalStatus: null,
        goalTokensUsed: 0,
        goalTimeUsedSeconds: 0,
        validationRounds: 0,
        lastValidationId: null,
        commitSha: null,
      })),
      currentIssueNumber: null,
      validations: [],
      candidateSha: null,
      review: null,
      blocked: null,
      result: null,
      createdAt: now,
      updatedAt: now,
    };
    this.save(state);
    return state;
  }

  load(id: string): GoalRunState {
    const state = readJsonFile<GoalRunState>(this.path(id));
    if (state.id !== safeToken(id)) throw new Error("Goal run identity mismatch");
    assertGoalRun(state, this.config, this.root(state.id));
    return state;
  }

  save(state: GoalRunState): void {
    state.updatedAt = nowIso();
    assertGoalRun(state, this.config, this.root(state.id));
    ensurePrivateDir(this.root(state.id));
    writeJsonAtomic(this.path(state.id), state);
  }

  list(): GoalRunState[] {
    const result: GoalRunState[] = [];
    for (const name of readdirSync(this.runsRoot).sort()) {
      if (safeToken(name) !== name) throw new Error(`unsafe Goal run directory: ${name}`);
      const root = resolve(this.runsRoot, name);
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe Goal run directory: ${root}`);
      result.push(this.load(name));
    }
    return result;
  }

  active(): GoalRunState[] {
    return this.list().filter((state) => !["completed", "failed"].includes(state.status));
  }

  root(id: string): string { return resolve(this.runsRoot, safeToken(id)); }
  path(id: string): string { return join(this.root(id), "goal-run.json"); }
  repositoryLockPath(): string { return join(this.config.stateDir, "repository-controller.lock"); }
  validationsRoot(id: string): string { return ensurePrivateDir(join(this.root(id), "validations")); }
  reviewsRoot(id: string): string { return ensurePrivateDir(join(this.root(id), "reviews")); }
}

export function goalJobView(state: GoalRunState): JobState {
  return {
    version: 1,
    id: state.id,
    configPath: state.configPath,
    configDigest: state.configDigest,
    planPath: state.handoffPath,
    planDigest: state.planDigest,
    repo: state.repo,
    plan: state.plan,
    baseRef: state.baseRef,
    baseSha: state.baseSha,
    remote: state.remote,
    branch: state.branch,
    worktreePath: state.worktreePath,
    status: state.status === "blocked" ? "blocked" : state.status === "completed" ? "completed" : "running",
    phase: controllerPhase(state.phase),
    issues: state.issues.map((issue) => ({
      number: issue.number,
      order: issue.order,
      status: issue.status === "validating" ? "running" : issue.status,
      snapshot: issue.snapshot,
      commitSha: issue.commitSha,
      lastRunId: issue.activeTurnId,
      lastValidationId: issue.lastValidationId,
      repairRounds: issue.validationRounds,
      nextRunKind: "worker",
    })),
    currentIssueNumber: state.currentIssueNumber,
    activeRun: null,
    runs: [],
    validations: state.validations,
    candidateSha: state.candidateSha,
    reviewRound: state.review ? 1 : 0,
    codeRepairRounds: 0,
    infrastructureReruns: 0,
    lastReviewPath: state.review?.path ?? null,
    repairReasonPath: null,
    pullRequest: null,
    ciGate: null,
    deliveryAuthority: null,
    reviewDemo: null,
    result: null,
    blocked: state.blocked ? {
      code: state.blocked.code,
      kind: state.blocked.kind,
      message: state.blocked.message,
      fromPhase: controllerPhase(state.phase),
      createdAt: state.blocked.createdAt,
      detailsPath: state.blocked.detailsPath,
    } : null,
    retryAuthorizations: [],
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

export function blockGoalRun(state: GoalRunState, error: unknown): GoalRunState {
  const controller = error instanceof ControllerError ? error : new ControllerError("goal_unexpected_error", error instanceof Error ? error.message : String(error));
  return {
    ...state,
    status: "blocked",
    blocked: {
      code: controller.code,
      kind: goalBlockKind(controller.code),
      message: boundedText(controller.message, "Goal block message", 4_000),
      fromPhase: state.phase,
      createdAt: nowIso(),
      detailsPath: controller.detailsPath,
    },
  };
}

export function goalBlockKind(code: string): BlockedKind {
  if (["goal_base_drift", "goal_handoff_plan_binding_mismatch", "plan_issue_not_open", "plan_parent_not_open"].includes(code)) return "replan_required";
  if ([
    "bootstrap_sandbox_capability_unavailable", "codex_preflight_failed", "development_bootstrap_failed",
    "development_setup_failed", "goal_app_server_unavailable", "goal_auth_unavailable", "goal_review_failed",
    "goal_turn_failed", "goal_turn_interrupted", "goal_remote_runner_unavailable", "validation_sandbox_capability_unavailable",
  ].includes(code)) return "recoverable";
  return "manual";
}

export function publicGoalStatus(state: GoalRunState) {
  const issue = state.currentIssueNumber === null ? null : state.issues.find((entry) => entry.number === state.currentIssueNumber) ?? null;
  return {
    id: state.id,
    status: state.status,
    phase: state.phase,
    repo: state.repo,
    planDigest: state.planDigest,
    baseSha: state.baseSha,
    channel: state.channel,
    runnerRef: state.runnerRef,
    runnerDigest: state.runnerDigest,
    runnerHost: state.runnerHost,
    currentIssueNumber: state.currentIssueNumber,
    currentGoal: issue ? {
      status: issue.goalStatus,
      tokensUsed: issue.goalTokensUsed,
      timeUsedSeconds: issue.goalTimeUsedSeconds,
      activeTurn: issue.activeTurnId !== null,
    } : null,
    issues: state.issues.map((entry) => ({ number: entry.number, status: entry.status, commitSha: entry.commitSha })),
    candidateSha: state.candidateSha,
    blocked: state.blocked ? {
      code: state.blocked.code,
      kind: state.blocked.kind,
      message: cleanPublicMessage(state.blocked.message),
      fromPhase: state.blocked.fromPhase,
    } : null,
    result: state.result,
    nextAction: state.status === "blocked"
      ? state.blocked?.kind === "replan_required" ? "NEW_HANDOFF" : "EXPLICIT_RESUME"
      : state.status === "review_ready" ? "HUMAN_MERGE"
        : state.status === "running" ? issue?.activeTurnId ? "WAIT" : "STEP"
          : "NONE",
    updatedAt: state.updatedAt,
  };
}

function assertGoalRun(state: GoalRunState, config: ControllerConfig, root: string): void {
  if (!state || state.version !== 1 || state.id !== safeToken(state.id)
    || state.configDigest !== digestJson(config) || state.planDigest !== digestJson(state.plan)
    || state.repo !== state.plan.repo || state.baseSha !== state.plan.baseSha
    || state.baseRef !== config.baseRef || state.remote !== config.remote
    || state.branch !== `${config.branchPrefix}/goal-${state.id}`
    || state.worktreePath !== resolve(config.worktreeRoot, "goal", state.id)
    || state.codexHomePath !== join(root, "codex-home")
    || state.handoffPath !== join(root, "goal-handoff.snapshot.json")
    || !pathWithin(config.worktreeRoot, state.worktreePath) || !pathWithin(config.stateDir, root)) {
    throw new Error("Goal run state identity is invalid");
  }
  if (!["GOAL_LOCAL", "GOAL_REMOTE"].includes(state.channel) || safeToken(state.runnerRef) !== state.runnerRef
    || !/^sha256:[a-f0-9]{64}$/u.test(state.runnerDigest) || state.runnerHost !== hostname()
    || !["prepare", "implement", "validate", "release_validate", "review", "handoff", "complete"].includes(state.phase)
    || !["running", "blocked", "review_ready", "completed", "failed"].includes(state.status)) {
    throw new Error("Goal run control state is invalid");
  }
  if (!state.handoffDigest.startsWith("sha256:") || state.handoffDigest.length !== 71) throw new Error("Goal handoff digest is invalid");
  if (!state.issues.length || new Set(state.issues.map((issue) => issue.number)).size !== state.issues.length) throw new Error("Goal run issues are invalid");
  if (state.issues.length !== state.plan.issues.length || state.issues.some((issue) => {
    const planIssue = state.plan.issues.find((entry) => entry.number === issue.number);
    return !planIssue || issue.order !== planIssue.order
      || !["pending", "running", "validating", "committed", "blocked"].includes(issue.status)
      || !Number.isSafeInteger(issue.goalTokensUsed) || issue.goalTokensUsed < 0
      || typeof issue.goalTimeUsedSeconds !== "number" || issue.goalTimeUsedSeconds < 0
      || !Number.isSafeInteger(issue.validationRounds) || issue.validationRounds < 0
      || (issue.activeTurnBaselineIds !== null && (!Array.isArray(issue.activeTurnBaselineIds) || issue.activeTurnBaselineIds.length > 1_000
        || new Set(issue.activeTurnBaselineIds).size !== issue.activeTurnBaselineIds.length
        || issue.activeTurnBaselineIds.some((id) => !/^[A-Za-z0-9._-]{1,120}$/u.test(id))))
      || (issue.goalStatus !== null && !["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(issue.goalStatus))
      || (issue.threadId !== null && !/^[A-Za-z0-9._-]{1,120}$/u.test(issue.threadId))
      || (issue.activeTurnId !== null && !/^[A-Za-z0-9._-]{1,120}$/u.test(issue.activeTurnId))
      || ((issue.activeTurnId === null) !== (issue.activeTurnBaselineIds === null));
  })) throw new Error("Goal Ticket state is invalid");
  if (state.currentIssueNumber !== null && !state.issues.some((issue) => issue.number === state.currentIssueNumber)) throw new Error("Goal current Issue is invalid");
  if ((state.status === "blocked") !== (state.blocked !== null)) throw new Error("Goal blocked state is invalid");
  if (state.status === "review_ready" && state.phase !== "handoff") throw new Error("Goal review-ready phase is invalid");
  if (state.status === "completed" && (state.phase !== "complete" || !state.result)) throw new Error("Goal completed state is invalid");
  if (state.status !== "completed" && state.result !== null) throw new Error("Non-completed Goal run cannot contain a Result");
  if (digestJson(readJsonFile<unknown>(join(root, "config.snapshot.json"))) !== state.configDigest) throw new Error("Goal config snapshot drifted");
  if (state.result) {
    assertGoalReleaseResult(state.result);
    if (state.result.releaseId !== state.id || state.result.planDigest !== state.planDigest
      || state.result.baseSha !== state.baseSha || state.result.candidateSha !== state.candidateSha
      || state.result.channel !== state.channel || state.result.runnerRef !== state.runnerRef
      || state.result.handoffDigest !== state.handoffDigest || state.result.reviewReportDigest !== state.review?.digest) {
      throw new Error("Goal Release Result differs from its run state");
    }
  }
  const handoff = validateGoalHandoff(readJsonFile<unknown>(join(root, "goal-handoff.snapshot.json")));
  if (goalHandoffFingerprint(handoff) !== state.handoffDigest || handoff.planDigest !== state.planDigest
    || handoff.channel !== state.channel || handoff.runnerRef !== state.runnerRef
    || handoff.runnerDigest !== state.runnerDigest || handoff.runnerHost !== state.runnerHost) {
    throw new Error("Goal handoff snapshot drifted");
  }
  for (const validation of state.validations) {
    if (!pathWithin(root, validation.path)) throw new Error("Goal validation escapes its private root");
  }
  if (state.blocked?.detailsPath !== null && state.blocked?.detailsPath !== undefined && !pathWithin(root, state.blocked.detailsPath)) {
    throw new Error("Goal blocker evidence escapes its private root");
  }
  if (state.review) {
    if (!pathWithin(root, state.review.path) || state.review.digest !== `sha256:${digestJson(state.review.result)}`
      || digestJson(readJsonFile<unknown>(state.review.path)) !== digestJson(state.review.result)) {
      throw new Error("Goal review evidence is invalid");
    }
  }
}

function controllerPhase(phase: GoalRunPhase): JobState["phase"] {
  if (phase === "validate" || phase === "release_validate") return "verify";
  if (phase === "handoff") return "deliver";
  return phase;
}

function cleanPublicMessage(value: string): string {
  return value
    .replace(/(?:\/Users|\/private|\/var|\/tmp)\/[^\s"']+/gu, "[redacted-path]")
    .replace(/\b(?:api[_-]?key|auth|cookie|password|secret|token|worktreePath|stateDir|detailsPath)\b/giu, "redacted")
    .slice(0, 1_024);
}

function canonicalTime(value: unknown): boolean {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}
