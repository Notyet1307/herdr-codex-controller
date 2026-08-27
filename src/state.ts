import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ControllerConfig, JobState, ReleasePlan } from "./types.js";
import { copyJsonSnapshot, ensurePrivateDir, readJsonFile, writeJsonAtomic } from "./fs-atomic.js";
import { digestJson, nowIso, safeToken } from "./util.js";
import { assertPlanCompatibleWithConfig, isReleasePlanV2 } from "./plan.js";

export class JobStore {
  readonly jobsRoot: string;

  constructor(readonly config: ControllerConfig) {
    this.jobsRoot = ensurePrivateDir(join(config.stateDir, "jobs"));
  }

  create(input: { configPath: string; planPath: string; plan: ReleasePlan; configDigest: string; planDigest: string }): JobState {
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
      hardeningRounds: 0,
      ciRepairRounds: 0,
      lastReviewPath: null,
      hardeningReasonPath: null,
      pullRequest: null,
      blocked: null,
      createdAt: now,
      updatedAt: now,
    };
    this.save(job);
    return job;
  }

  load(id: string): JobState {
    const job = readJsonFile<JobState>(this.path(id));
    assertJob(job);
    return job;
  }

  save(job: JobState): void {
    assertJob(job);
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
  return {
    ...job,
    status: "blocked",
    blocked: {
      code,
      message,
      fromPhase: job.phase,
      createdAt: nowIso(),
      detailsPath,
    },
    activeRun: null,
  };
}

export function retryBlockedJob(job: JobState): JobState {
  if (job.status !== "blocked" || !job.blocked) throw new Error("job is not blocked");
  const explicitlyAuthorizedHardening = job.blocked.code === "release_hardening_exhausted";
  return {
    ...job,
    status: "running",
    phase: explicitlyAuthorizedHardening ? "harden" : job.blocked.fromPhase,
    hardeningRounds: explicitlyAuthorizedHardening ? job.hardeningRounds + 1 : job.hardeningRounds,
    hardeningReasonPath: explicitlyAuthorizedHardening
      ? job.blocked.detailsPath ?? job.hardeningReasonPath
      : job.hardeningReasonPath,
    blocked: null,
    activeRun: null,
  };
}

export function assertJob(job: JobState): void {
  if (!job || job.version !== 1 || !job.id || !job.plan || job.planDigest !== digestJson(job.plan)) {
    throw new Error("job state is invalid or its plan digest drifted");
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
  if (job.status === "completed" && job.phase !== "complete") throw new Error("completed job must be in complete phase");
  if (job.activeRun && job.status !== "running") throw new Error("only running jobs may have an active run");
}

export function readJobRaw(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
