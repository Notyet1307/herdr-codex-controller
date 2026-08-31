import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type {
  ControllerConfig,
  ControllerIdentity,
  ControllerProvenance,
  JobState,
  ReleasePlan,
  RetryAuthorization,
} from "./types.js";
import { copyJsonSnapshot, ensurePrivateDir, readJsonFile, writeJsonAtomic } from "./fs-atomic.js";
import { digestJson, nowIso, pathWithin, safeToken, sha256 } from "./util.js";
import { assertPlanCompatibleWithConfig, isReleasePlanV2 } from "./plan.js";
import { ControllerError } from "./errors.js";
import {
  assertControllerProvenance,
  createControllerProvenance,
  readControllerIdentity,
} from "./provenance.js";

export const REPLAN_REQUIRED_CODE = "replan_required";

const REPLAN_CAUSES = new Set([
  "codex_hardening_blocked",
  "codex_hardening_replan_required",
  "codex_worker_blocked",
  "codex_worker_replan_required",
  "issue_dependency_incomplete",
  "issue_oracle_validation_missing",
  "issue_risk_class_drift",
  "issue_scope_budget_exceeded",
  "issue_scope_path_drift",
  "invalid_expected_path_pattern",
  "hardening_scope_unattributed",
  "oracle_binding_drift",
  "oracle_verifier_drift",
  "plan_base_drift",
  "plan_drift",
  "plan_issue_drift",
  "plan_issue_missing",
  "plan_issue_not_open",
  "plan_parent_drift",
  "plan_parent_not_open",
  "unknown_risk_class",
  "plan_version_mismatch",
  "protected_path_changed",
  "release_diff_too_large",
  "release_hardening_exhausted",
  "release_oracle_validation_missing",
  "release_review_blocked",
  "release_too_many_issues",
  "runtime_child_binding_drift",
  "runtime_parent_binding_drift",
  "runtime_source_base_drift",
]);

export class JobStore {
  readonly jobsRoot: string;

  constructor(
    readonly config: ControllerConfig,
    private readonly identityProvider: () => ControllerIdentity = readControllerIdentity,
  ) {
    this.jobsRoot = ensurePrivateDir(join(config.stateDir, "jobs"));
  }

  currentProvenance(plan: ReleasePlan): ControllerProvenance {
    return createControllerProvenance(
      this.identityProvider(),
      this.config,
      digestJson(this.config),
      plan,
    );
  }

  create(input: {
    configPath: string;
    planPath: string;
    plan: ReleasePlan;
    configDigest: string;
    planDigest: string;
    expectedControllerProvenanceDigest?: string;
  }): JobState {
    assertPlanCompatibleWithConfig(input.plan, this.config);
    if (input.configDigest !== digestJson(this.config)) throw new Error("job configDigest is not the current validated config digest");
    if (input.planDigest !== digestJson(input.plan)) throw new Error("job planDigest is not the current validated plan digest");
    const provenance = this.currentProvenance(input.plan);
    if (input.expectedControllerProvenanceDigest !== undefined
      && provenance.digest !== input.expectedControllerProvenanceDigest) {
      throw new ControllerError(
        "controller_provenance_drift",
        "Controller provenance changed between the start gate and Job creation.",
      );
    }
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
      version: this.config.version === 3 ? 4 : this.config.version === 2 ? 3 : 2,
      id,
      provenance,
      configPath: resolve(input.configPath),
      configDigest: input.configDigest,
      planPath: resolve(input.planPath),
      planDigest: input.planDigest,
      repo: this.config.repo,
      plan: input.plan,
      baseRef: this.config.baseRef,
      baseSha: null,
      remote: this.config.remote,
      remoteIdentityDigest: provenance.remoteIdentity?.digest ?? null,
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
      hardeningRounds: 0,
      ciRepairRounds: 0,
      releaseValidationRepairRounds: 0,
      reviewRepairRounds: 0,
      ciCodeRepairRounds: 0,
      ciInfrastructureReruns: 0,
      providerRetryAttempts: 0,
      lastReviewPath: null,
      hardeningReasonPath: null,
      pullRequest: null,
      ciGate: null,
      deliveryAuthority: null,
      completion: null,
      publicCompletion: null,
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
    if (job.blocked && REPLAN_CAUSES.has(job.blocked.code)) {
      job.blocked = {
        ...job.blocked,
        code: REPLAN_REQUIRED_CODE,
        message: `${job.blocked.code}: ${job.blocked.message}`,
      };
    }
    if (job.retryAuthorizations === undefined) job.retryAuthorizations = [];
    if (job.completion === undefined) job.completion = null;
    if (job.version < 4) {
      job.releaseValidationRepairRounds ??= 0;
      job.reviewRepairRounds ??= 0;
      job.ciCodeRepairRounds ??= 0;
      job.ciInfrastructureReruns ??= 0;
      job.providerRetryAttempts ??= 0;
      job.ciGate ??= null;
      job.deliveryAuthority ??= null;
      job.publicCompletion ??= null;
    }
    assertJob(job);
    assertRetryEvidence(job, this.root(job.id));
    return job;
  }

  save(job: JobState): void {
    assertJob(job);
    assertRetryEvidence(job, this.root(job.id));
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
}

export function currentIssue(job: JobState) {
  if (job.currentIssueNumber === null) return null;
  return job.issues.find((issue) => issue.number === job.currentIssueNumber) ?? null;
}

export function nextPendingIssue(job: JobState) {
  return [...job.issues].sort((left, right) => left.order - right.order).find((issue) => issue.status === "pending") ?? null;
}

export function blockJob(job: JobState, code: string, message: string, detailsPath: string | null = null): JobState {
  const replanRequired = REPLAN_CAUSES.has(code);
  return {
    ...job,
    status: "blocked",
    blocked: {
      code: replanRequired ? REPLAN_REQUIRED_CODE : code,
      message: replanRequired ? `${code}: ${message}` : message,
      fromPhase: job.phase,
      createdAt: nowIso(),
      detailsPath,
    },
    activeRun: null,
  };
}

export function retryBlockedJob(job: JobState, authorization?: RetryAuthorization, jobRoot?: string): JobState {
  if (job.status !== "blocked" || !job.blocked) throw new Error("job is not blocked");
  if (job.blocked.code === REPLAN_REQUIRED_CODE) {
    throw new ControllerError(REPLAN_REQUIRED_CODE, "This Job requires abort, a new Release Plan v2, and a new Job.");
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
  if (!job || (job.version !== 2 && job.version !== 3 && job.version !== 4) || !job.id || !job.plan || job.planDigest !== digestJson(job.plan)) {
    throw new Error("job state is invalid or its plan digest drifted");
  }
  assertControllerProvenance(job.provenance);
  if ((job.version === 2 && job.provenance.version !== 1)
    || (job.version === 3 && job.provenance.version !== 2)
    || (job.version === 4 && job.provenance.version !== 3)) {
    throw new Error("job state and Controller provenance versions differ");
  }
  if (job.version >= 3 && job.remoteIdentityDigest !== job.provenance.remoteIdentity?.digest) {
    throw new Error("job Git remote identity does not match Controller provenance");
  }
  if (job.version === 4) {
    for (const value of [job.releaseValidationRepairRounds, job.reviewRepairRounds, job.ciCodeRepairRounds, job.ciInfrastructureReruns, job.providerRetryAttempts]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("job repair counters are invalid");
    }
    if (job.ciGate && (job.ciGate.version !== 1 || job.ciGate.candidateSha !== job.candidateSha
      || job.ciGate.checkContractDigest !== job.provenance.requiredCheckContractDigest
      || !isCanonicalIsoTime(job.ciGate.firstObservedAt)
      || !isCanonicalIsoTime(job.ciGate.firstAppearanceDeadlineAt)
      || (job.ciGate.pendingDeadlineAt !== null && !isCanonicalIsoTime(job.ciGate.pendingDeadlineAt))
      || (job.ciGate.postMergeDeadlineAt !== null && !isCanonicalIsoTime(job.ciGate.postMergeDeadlineAt))
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
  }
  if (job.provenance.configDigest !== job.configDigest
    || job.provenance.releasePlan.version !== job.plan.version
    || job.provenance.releasePlan.digest !== job.planDigest) {
    throw new Error("job Controller provenance does not bind its config and Release Plan");
  }
  if (isReleasePlanV2(job.plan) && job.baseSha !== null && job.baseSha !== job.plan.source.baseSha) {
    throw new Error("job base SHA differs from its Release Plan v2 source binding");
  }
  const issueNumbers = job.issues.map((issue) => issue.number);
  if (new Set(issueNumbers).size !== issueNumbers.length) throw new Error("job contains duplicate issues");
  if (job.currentIssueNumber !== null && !issueNumbers.includes(job.currentIssueNumber)) {
    throw new Error("job current issue is missing");
  }
  if (job.status === "blocked" && !job.blocked) throw new Error("blocked job has no blocked record");
  if (job.status !== "blocked" && job.blocked) throw new Error("non-blocked job has a blocked record");
  if (!Array.isArray(job.retryAuthorizations)) throw new Error("job retry authorizations are invalid");
  for (const authorization of job.retryAuthorizations) assertRetryAuthorization(authorization);
  if (job.status === "completed" && job.phase !== "complete") throw new Error("completed job must be in complete phase");
  if (job.provenance.version === 3 && job.status === "completed" && (!job.completion || !job.publicCompletion)) {
    throw new Error("completed production job must have private and public completion checkpoints");
  }
  if (job.publicCompletion !== null) {
    const { digest, ...body } = job.publicCompletion;
    if (job.provenance.version !== 3 || job.status !== "completed"
      || digest !== `sha256:${digestJson(body)}`
      || job.publicCompletion.controllerProvenance.digest !== job.provenance.digest
      || job.publicCompletion.candidateSha !== job.candidateSha
      || job.publicCompletion.pullRequest.mergeSha !== job.pullRequest?.mergeSha) {
      throw new Error("job public completion checkpoint is invalid");
    }
  }
  if (job.completion !== null) {
    const { digest, ...identity } = job.completion;
    if (job.status !== "completed"
      || digest !== digestJson(identity)
      || job.completion.planDigest !== job.planDigest
      || job.completion.controllerProvenanceDigest !== job.provenance.digest
      || job.completion.candidateSha !== job.candidateSha
      || job.completion.pullRequest.number !== job.pullRequest?.number
      || job.completion.pullRequest.mergeSha !== job.pullRequest?.mergeSha
      || job.completion.mergedMainSha !== job.completion.pullRequest.mergeSha
      || !isCanonicalIsoTime(job.completion.completedAt)) {
      throw new Error("job completion evidence is invalid");
    }
  }
  if (job.activeRun && job.status !== "running") throw new Error("only running jobs may have an active run");
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
  return ["prepare", "implement", "issue_validate", "release_validate", "review", "harden", "deliver", "ci", "awaiting_merge", "complete"].includes(String(value));
}

function isCanonicalIsoTime(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

export function readJobRaw(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
