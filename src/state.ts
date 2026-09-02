import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type {
  ControllerConfig,
  BlockedKind,
  BlockedState,
  JobState,
  ReleasePlan,
  RetryAuthorization,
} from "./types.js";
import { copyJsonSnapshot, ensurePrivateDir, readJsonFile, writeJsonAtomic } from "./fs-atomic.js";
import { digestJson, nowIso, pathWithin, safeToken, sha256 } from "./util.js";
import { assertPlanCompatibleWithConfig } from "./plan.js";
import { ControllerError } from "./errors.js";
import { assertReviewDemoResult } from "./demo.js";
import type { ReviewDemoResult } from "./types.js";
import { assertReleaseResult } from "./release-result.js";

export const REPLAN_REQUIRED_CODE = "replan_required";

const REPLAN_CAUSES = new Set([
  REPLAN_REQUIRED_CODE,
  "invalid_expected_path_pattern",
  "plan_base_drift",
  "plan_base_ref_mismatch",
  "plan_drift",
  "plan_issue_not_open",
  "plan_parent_not_open",
  "plan_repo_mismatch",
  "runtime_source_base_drift",
  "unknown_risk_class",
  "unsupported_controller_contract_version",
]);

const RECOVERABLE_CAUSES = new Set([
  "bootstrap_sandbox_capability_unavailable",
  "ci_infrastructure_exhausted",
  "codex_hardening_failed",
  "codex_hardening_recoverable",
  "codex_review_failed",
  "codex_worker_failed",
  "codex_worker_recoverable",
  "development_bootstrap_failed",
  "development_setup_failed",
  "review_demo_runner_missing",
  "setup_validation_failed",
  "validation_sandbox_capability_unavailable",
]);

export function classifyBlock(code: string): BlockedKind {
  if (REPLAN_CAUSES.has(code)) return "replan_required";
  if (RECOVERABLE_CAUSES.has(code)) return "recoverable";
  return "manual";
}

export function effectiveBlockedKind(blocked: BlockedState): BlockedKind {
  return blocked.kind ?? classifyBlock(blocked.code);
}

export class JobStore {
  readonly jobsRoot: string;

  constructor(
    readonly config: ControllerConfig,
  ) {
    this.jobsRoot = ensurePrivateDir(join(config.stateDir, "jobs"));
  }

  create(input: {
    configPath: string;
    planPath: string;
    plan: ReleasePlan;
    configDigest: string;
    planDigest: string;
  }): JobState {
    assertPlanCompatibleWithConfig(input.plan, this.config);
    if (input.configDigest !== digestJson(this.config)) throw new Error("job configDigest is not the current validated config digest");
    if (input.planDigest !== digestJson(input.plan)) throw new Error("job planDigest is not the current validated plan digest");
    const id = safeToken(input.plan.id);
    const root = this.root(id);
    if (existsSync(root)) throw new Error(`job already exists: ${id}`);
    ensurePrivateDir(root);
    copyJsonSnapshot(input.configPath, join(root, "config.snapshot.json"));
    copyJsonSnapshot(input.planPath, join(root, "plan.snapshot.json"));
    const branch = `${this.config.branchPrefix}/${id}`;
    const worktreePath = resolve(this.config.worktreeRoot, id);
    const now = nowIso();
    const job: JobState = {
      version: 1,
      id,
      configPath: resolve(input.configPath),
      configDigest: input.configDigest,
      planPath: resolve(input.planPath),
      planDigest: input.planDigest,
      repo: this.config.repo,
      plan: input.plan,
      baseRef: this.config.baseRef,
      baseSha: null,
      remote: this.config.remote,
      branch,
      worktreePath,
      status: "running",
      phase: "prepare",
      issues: input.plan.issues.map((issue) => ({
        number: issue.number,
        order: issue.order,
        status: "pending",
        snapshot: null,
        commitSha: null,
        lastRunId: null,
        lastValidationId: null,
        repairRounds: 0,
        nextRunKind: "worker",
      })),
      currentIssueNumber: null,
      activeRun: null,
      runs: [],
      validations: [],
      candidateSha: null,
      reviewRound: 0,
      codeRepairRounds: 0,
      infrastructureReruns: 0,
      lastReviewPath: null,
      repairReasonPath: null,
      pullRequest: null,
      ciGate: null,
      deliveryAuthority: null,
      reviewDemo: null,
      result: null,
      blocked: null,
      retryAuthorizations: [],
      createdAt: now,
      updatedAt: now,
    };
    this.save(job);
    return job;
  }

  load(id: string): JobState {
    const job = readJsonFile<JobState>(this.path(id));
    if (job.id !== safeToken(id)) throw new Error("job state identity does not match the requested Job");
    assertJob(job);
    assertRetryEvidence(job, this.root(job.id));
    assertReviewDemoEvidence(job, this.root(job.id));
    return job;
  }

  save(job: JobState): void {
    assertJob(job);
    assertRetryEvidence(job, this.root(job.id));
    assertReviewDemoEvidence(job, this.root(job.id));
    job.updatedAt = nowIso();
    ensurePrivateDir(this.root(job.id));
    writeJsonAtomic(this.path(job.id), job);
  }

  root(id: string): string {
    return resolve(this.jobsRoot, safeToken(id));
  }

  path(id: string): string {
    return join(this.root(id), "job.json");
  }

  repositoryLockPath(): string {
    return join(this.config.stateDir, "repository-controller.lock");
  }

  list(): JobState[] {
    const jobs: JobState[] = [];
    for (const name of readdirSync(this.jobsRoot).sort()) {
      if (safeToken(name) !== name) throw new Error(`unsafe job directory name: ${name}`);
      const root = resolve(this.jobsRoot, name);
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe job directory: ${root}`);
      const jobPath = join(root, "job.json");
      if (!existsSync(jobPath)) throw new Error(`job directory is missing job.json: ${root}`);
      jobs.push(this.load(name));
    }
    return jobs;
  }

  active(excludeId: string | null = null): JobState[] {
    return this.list().filter((job) => job.id !== excludeId && job.status !== "completed" && job.status !== "failed");
  }

  runsRoot(id: string): string {
    return ensurePrivateDir(join(this.root(id), "runs"));
  }

  validationsRoot(id: string): string {
    return ensurePrivateDir(join(this.root(id), "validations"));
  }

  issuesRoot(id: string): string {
    return ensurePrivateDir(join(this.root(id), "issues"));
  }

  deliveryRoot(id: string): string {
    return ensurePrivateDir(join(this.root(id), "delivery"));
  }

  demoRoot(id: string): string {
    return ensurePrivateDir(join(this.root(id), "demo"));
  }
}

export function currentIssue(job: JobState) {
  if (job.currentIssueNumber === null) return null;
  return job.issues.find((issue) => issue.number === job.currentIssueNumber) ?? null;
}

export function nextPendingIssue(job: JobState) {
  return [...job.issues].sort((left, right) => left.order - right.order).find((issue) => issue.status === "pending") ?? null;
}

export function blockJob(job: JobState, code: string, message: string, detailsPath: string | null = null): JobState {
  return {
    ...job,
    status: "blocked",
    blocked: {
      code,
      kind: classifyBlock(code),
      message,
      fromPhase: job.phase,
      createdAt: nowIso(),
      detailsPath,
    },
    activeRun: null,
  };
}

export function retryBlockedJob(job: JobState, authorization?: RetryAuthorization, jobRoot?: string): JobState {
  if (job.status !== "blocked" || !job.blocked) throw new Error("job is not blocked");
  if (effectiveBlockedKind(job.blocked) === "replan_required") {
    throw new ControllerError(REPLAN_REQUIRED_CODE, "This Job requires abort, a new Release Plan, and a new Job.");
  }
  if (!authorization) {
    throw new ControllerError("retry_evidence_required", "Retry requires new recovery evidence.");
  }
  assertRetryAuthorization(authorization, job.blocked);
  if (!jobRoot) throw new ControllerError("retry_evidence_invalid", "Retry requires the Job private root.");
  assertRetryEvidenceBinding(authorization, jobRoot);
  if (job.retryAuthorizations.some((previous) => (
    previous.previousBlockedCode === job.blocked!.code
    && previous.evidenceDigest === authorization.evidenceDigest
  ))) {
    throw new ControllerError("retry_without_new_evidence", "This blocked code has already consumed the same recovery evidence.");
  }
  return {
    ...job,
    status: "running",
    phase: job.blocked.fromPhase,
    blocked: null,
    activeRun: null,
    retryAuthorizations: [...job.retryAuthorizations, authorization],
  };
}

export function assertJob(job: JobState): void {
  if (!job || job.version !== 1 || !job.id || !job.plan || job.planDigest !== digestJson(job.plan)) {
    throw new Error("job state is invalid or its plan digest drifted");
  }
  for (const value of [job.codeRepairRounds, job.infrastructureReruns]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("job repair counters are invalid");
  }
  if (job.ciGate && (job.ciGate.version !== 1 || job.ciGate.candidateSha !== job.candidateSha
    || !/^[a-f0-9]{64}$/u.test(job.ciGate.checkContractDigest)
    || !isCanonicalIsoTime(job.ciGate.firstObservedAt)
    || !isCanonicalIsoTime(job.ciGate.firstAppearanceDeadlineAt)
    || (job.ciGate.pendingDeadlineAt !== null && !isCanonicalIsoTime(job.ciGate.pendingDeadlineAt))
    || !Number.isSafeInteger(job.ciGate.attempts) || job.ciGate.attempts < 0)) {
    throw new Error("job CI gate state is invalid");
  }
  if (job.deliveryAuthority && (job.deliveryAuthority.version !== 1
    || job.deliveryAuthority.candidateSha !== job.deliveryAuthority.pullRequest.headSha
    || (job.deliveryAuthority.status !== "revoked" && job.deliveryAuthority.candidateSha !== job.candidateSha)
    || !/^[a-f0-9]{64}$/u.test(job.deliveryAuthority.proofDigest)
    || !isCanonicalIsoTime(job.deliveryAuthority.lastVerifiedAt))) {
    throw new Error("job delivery authority state is invalid");
  }
  if (job.baseSha !== null && job.baseSha !== job.plan.baseSha) {
    throw new Error("job base SHA differs from its Release Plan binding");
  }
  const issueNumbers = job.issues.map((issue) => issue.number);
  if (new Set(issueNumbers).size !== issueNumbers.length) throw new Error("job contains duplicate issues");
  if (job.currentIssueNumber !== null && !issueNumbers.includes(job.currentIssueNumber)) {
    throw new Error("job current issue is missing");
  }
  if (job.status === "blocked" && !job.blocked) throw new Error("blocked job has no blocked record");
  if (job.status !== "blocked" && job.blocked) throw new Error("non-blocked job has a blocked record");
  if (job.blocked && job.blocked.kind !== undefined
    && !["recoverable", "replan_required", "manual"].includes(job.blocked.kind)) {
    throw new Error("job blocked kind is invalid");
  }
  if (!Array.isArray(job.retryAuthorizations)) throw new Error("job retry authorizations are invalid");
  for (const authorization of job.retryAuthorizations) assertRetryAuthorization(authorization);
  if (job.status === "completed" && job.phase !== "complete") throw new Error("completed job must be in complete phase");
  if (job.status === "completed") {
    if (!job.result) throw new Error("completed Job must have a Release Result");
    assertReleaseResult(job.result);
    if (job.result.releaseId !== job.id || job.result.planDigest !== job.planDigest
      || job.result.candidateSha !== job.candidateSha || job.result.mergeSha !== job.pullRequest?.mergeSha) {
      throw new Error("job Release Result differs from its delivery state");
    }
  } else if (job.result !== null) {
    throw new Error("non-completed Job cannot have a Release Result");
  }
  if (job.activeRun && job.status !== "running") throw new Error("only running jobs may have an active run");
  if (job.reviewDemo && (job.reviewDemo.candidateSha.length !== 40
    || !isAbsolute(job.reviewDemo.path) || !/^[a-f0-9]{64}$/u.test(job.reviewDemo.digest))) {
    throw new Error("job review Demo binding is invalid");
  }
}

function assertRetryAuthorization(authorization: RetryAuthorization, blocked?: NonNullable<JobState["blocked"]>): void {
  if (!authorization || typeof authorization !== "object"
    || !authorization.previousBlockedCode
    || !isJobPhase(authorization.previousBlockedPhase)
    || (authorization.previousDetailsPath !== null && !isAbsolute(authorization.previousDetailsPath))
    || !authorization.operatorReason.trim()
    || Buffer.byteLength(authorization.operatorReason, "utf8") > 4_000
    || !isAbsolute(authorization.recoveryEvidencePath)
    || !/^[a-f0-9]{64}$/.test(authorization.evidenceDigest)
    || !isCanonicalIsoTime(authorization.authorizedAt)) {
    throw new ControllerError("retry_authorization_invalid", "Retry authorization is invalid.");
  }
  if (blocked && (authorization.previousBlockedCode !== blocked.code
    || authorization.previousBlockedPhase !== blocked.fromPhase
    || authorization.previousDetailsPath !== blocked.detailsPath)) {
    throw new ControllerError("retry_authorization_mismatch", "Retry authorization does not match the current blocked state.");
  }
}

function assertRetryEvidence(job: JobState, jobRoot: string): void {
  for (const authorization of job.retryAuthorizations) assertRetryEvidenceBinding(authorization, jobRoot);
}

function assertReviewDemoEvidence(job: JobState, jobRoot: string): void {
  if (!job.reviewDemo) return;
  if (!pathWithin(jobRoot, job.reviewDemo.path)) throw new Error("job review Demo result escapes its private root");
  let result: ReviewDemoResult;
  try { result = readJsonFile<ReviewDemoResult>(job.reviewDemo.path); }
  catch { throw new Error("job review Demo result is missing or unsafe"); }
  assertReviewDemoResult(result);
  if (result.candidateSha !== job.reviewDemo.candidateSha || result.digest !== job.reviewDemo.digest
    || result.passed !== job.reviewDemo.passed || result.required !== job.reviewDemo.required) {
    throw new Error("job review Demo result differs from its binding");
  }
}

function assertRetryEvidenceBinding(authorization: RetryAuthorization, jobRoot: string): void {
  if (!pathWithin(jobRoot, authorization.recoveryEvidencePath)) {
    throw new ControllerError("retry_evidence_invalid", "Retry evidence is outside the Job private root.");
  }
  let stat;
  try { stat = lstatSync(authorization.recoveryEvidencePath); }
  catch { throw new ControllerError("retry_evidence_invalid", "Retry evidence snapshot is missing."); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new ControllerError("retry_evidence_invalid", "Retry evidence snapshot is not a safe regular file.");
  }
  if (sha256(readFileSync(authorization.recoveryEvidencePath)) !== authorization.evidenceDigest) {
    throw new ControllerError("retry_evidence_digest_mismatch", "Retry evidence digest mismatch.");
  }
}

function isJobPhase(value: unknown): boolean {
  return ["prepare", "implement", "verify", "review", "repair", "deliver", "complete"].includes(String(value));
}

function isCanonicalIsoTime(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

export function readJobRaw(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
