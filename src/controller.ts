import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CommandConfig,
  IssueSnapshot,
  IssueExecution,
  JobState,
  ReviewResult,
  StepResult,
  ValidationReceipt,
} from "./types.js";
import type { CodexPort, GitHubPort, GitPort, ValidationPort } from "./ports.js";
import { ControllerError, asControllerError } from "./errors.js";
import { CommandInterruptedError } from "./command.js";
import { JobStore, blockJob, currentIssue, nextPendingIssue } from "./state.js";
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from "./fs-atomic.js";
import { digestJson, newId, nowIso, sha256PrefixedUtf8 } from "./util.js";
import { assertPlanCompatibleWithConfig, isReleasePlanV2 } from "./plan.js";
import {
  renderIssueWorkerPrompt,
  renderReleaseHardeningPrompt,
  renderReleaseReviewPrompt,
} from "./prompts.js";

const MAX_REVIEW_DIFF_BYTES = 8 * 1024 * 1024;

export type ControllerDependencies = {
  store: JobStore;
  git: GitPort;
  github: GitHubPort;
  codex: CodexPort;
  validator: ValidationPort;
};

export class ReleaseController {
  constructor(private readonly deps: ControllerDependencies) {}

  async step(jobId: string): Promise<StepResult> {
    let job = this.deps.store.load(jobId);
    if (job.status === "completed" || job.status === "failed") {
      return stepResult("terminal", false, true, null, `Job ${job.id} is ${job.status}.`);
    }
    if (job.status === "blocked") {
      return stepResult("blocked", false, true, null, job.blocked?.message ?? "Job is blocked.");
    }
    if (job.status === "ready_to_merge" && job.phase === "awaiting_merge") {
      // A manual merge may have happened since the last observation, so allow one read-only observation step.
    }

    try {
      this.assertCurrentInputs(job);
      if (job.activeRun) return await this.reconcileInterruptedRun(job);
      switch (job.phase) {
        case "prepare": return await this.prepare(job);
        case "implement": return await this.implement(job);
        case "issue_validate": return await this.validateIssue(job);
        case "release_validate": return await this.validateRelease(job);
        case "review": return await this.review(job);
        case "harden": return await this.harden(job);
        case "deliver": return await this.deliver(job);
        case "ci": return await this.observeCi(job);
        case "awaiting_merge": return await this.observeMerge(job);
        case "complete": return stepResult("complete", false, true, null, "Release is complete.");
      }
    } catch (error) {
      if (error instanceof CommandInterruptedError) throw error;
      const classified = asControllerError(error, `phase_${job.phase}_failed`);
      // Reload the latest durable state so an error cannot overwrite a checkpoint saved earlier in this step.
      try { job = this.deps.store.load(jobId); } catch {}
      job = blockJob(job, classified.code, classified.message, classified.detailsPath);
      this.deps.store.save(job);
      return stepResult("blocked", true, true, null, `${classified.code}: ${classified.message}`);
    }
  }

  private assertCurrentInputs(job: JobState): void {
    const currentConfigDigest = digestJson(this.deps.store.config);
    if (currentConfigDigest !== job.configDigest) {
      throw new ControllerError("config_drift", "The current Controller config differs from the job-bound config snapshot.");
    }
    if (digestJson(job.plan) !== job.planDigest) {
      throw new ControllerError("plan_drift", "The job-bound release plan digest changed.");
    }
  }

  private async reconcileInterruptedRun(job: JobState): Promise<StepResult> {
    const active = job.activeRun!;
    if (!existsSync(job.worktreePath)) {
      throw new ControllerError("interrupted_run_worktree_missing", "An interrupted Codex run has no recoverable worktree.");
    }
    await this.deps.git.verifyWorktree(job);
    const head = await this.deps.git.head(job.worktreePath);
    if (head !== active.baseHeadSha) {
      if (active.kind === "release-harden") {
        const salvaged = await this.deps.git.salvageHardeningCommitAtHead(job, job.hardeningRounds);
        if (salvaged === head) {
          const recovered: JobState = {
            ...job,
            activeRun: null,
            status: "running",
            blocked: null,
            candidateSha: null,
            phase: "release_validate",
          };
          this.deps.store.save(recovered);
          return stepResult("hardening_commit_salvaged", true, false, null, `Recovered Controller-owned hardening commit ${salvaged}.`);
        }
      }
      throw new ControllerError(
        "interrupted_run_changed_head",
        "An interrupted Codex run changed Git HEAD; the Controller cannot safely infer commit authority.",
      );
    }
    const next: JobState = { ...job, activeRun: null, status: "running", blocked: null };
    if (active.kind === "worker" || active.kind === "issue-repair") {
      const issue = currentIssue(next);
      if (!issue || issue.number !== active.issueNumber) {
        throw new ControllerError("interrupted_run_issue_mismatch", "Interrupted Worker identity does not match the current Issue.");
      }
      issue.nextRunKind = "recovery";
      issue.status = "running";
      next.phase = "implement";
    } else if (active.kind === "release-harden") {
      next.phase = "harden";
    } else {
      next.phase = "review";
    }
    this.deps.store.save(next);
    return stepResult(
      "interrupted_run_reconciled",
      true,
      false,
      null,
      `Cleared interrupted ${active.kind}; the next step will use a fresh Codex process over the preserved worktree.`,
    );
  }

  private async prepare(job: JobState): Promise<StepResult> {
    assertPlanCompatibleWithConfig(job.plan, this.deps.store.config);
    if (job.plan.issues.length > this.deps.store.config.policy.maxIssues) {
      throw new ControllerError("release_too_many_issues", `Plan has ${job.plan.issues.length} issues; configured maximum is ${this.deps.store.config.policy.maxIssues}.`);
    }
    if (isReleasePlanV2(job.plan)) return this.prepareSourceBoundV2(job);
    return this.prepareV1(job);
  }

  private async prepareV1(job: JobState): Promise<StepResult> {
    await this.deps.git.preflight();
    await this.deps.github.preflight();
    await this.deps.codex.preflight();
    const baseSha = job.baseSha ?? await this.deps.git.fetchBase();
    if (job.baseSha === null) {
      job = { ...job, baseSha };
      this.deps.store.save(job);
    }
    await this.deps.git.ensureWorktree(job);
    if (!(await this.deps.git.isClean(job.worktreePath))) {
      throw new ControllerError("initial_worktree_dirty", "The release worktree is dirty before the first Worker run.");
    }

    const issueRoot = this.deps.store.issuesRoot(job.id);
    for (const issue of job.issues) {
      const snapshot = await this.deps.github.fetchIssue(issue.number);
      writeJsonAtomic(join(issueRoot, `issue-${issue.number}.json`), snapshot);
      issue.snapshot = snapshot;
    }
    return this.runSetupValidation(job, baseSha);
  }

  private async prepareSourceBoundV2(job: JobState): Promise<StepResult> {
    const verified = await this.verifyPlanSourceBeforeSideEffects(job);
    job = { ...job, baseSha: verified.baseSha };
    await this.deps.git.ensureWorktree(job);
    if (!(await this.deps.git.isClean(job.worktreePath))) {
      throw new ControllerError("initial_worktree_dirty", "The release worktree is dirty before the first Worker run.");
    }

    const issueRoot = this.deps.store.issuesRoot(job.id);
    if (verified.parent) {
      writeJsonAtomic(join(issueRoot, `parent-issue-${verified.parent.number}.json`), verified.parent);
    }
    for (const issue of job.issues) {
      const snapshot = verified.issues.get(issue.number);
      if (!snapshot) {
        throw new ControllerError("plan_issue_drift", `Verified snapshot for Issue #${issue.number} is missing.`);
      }
      writeJsonAtomic(join(issueRoot, `issue-${issue.number}.json`), snapshot);
      issue.snapshot = snapshot;
    }
    this.deps.store.save(job);
    return this.runSetupValidation(job, verified.baseSha);
  }

  private async verifyPlanSourceBeforeSideEffects(job: JobState): Promise<{
    baseSha: string;
    parent: IssueSnapshot;
    issues: Map<number, IssueSnapshot>;
  }> {
    if (!isReleasePlanV2(job.plan)) {
      throw new ControllerError("plan_version_mismatch", "Exact source verification requires Release Plan v2.");
    }
    const plan = job.plan;
    await this.deps.git.preflight();
    await this.deps.github.preflight();
    await this.deps.codex.preflight();

    const baseSha = await this.deps.git.fetchBase();
    if (baseSha !== plan.source.baseSha) {
      throw new ControllerError(
        "plan_base_drift",
        "The current remote base commit differs from the Release Plan v2 source binding.",
      );
    }
    if (job.baseSha === null) {
      this.deps.store.save({ ...job, baseSha });
    }

    const parent = await this.deps.github.fetchIssue(plan.source.parentBinding.number, { allowClosed: true });
    if (parent.state !== "OPEN") {
      throw new ControllerError("plan_parent_not_open", `Parent Issue #${plan.parentIssue} is not OPEN.`);
    }
    if (parent.number !== plan.source.parentBinding.number
      || parent.title !== plan.source.parentBinding.expectedTitle
      || sha256PrefixedUtf8(parent.body) !== plan.source.parentBinding.expectedBodyHash) {
      throw new ControllerError(
        "plan_parent_drift",
        `Parent Issue #${plan.parentIssue} no longer matches its exact title/body source binding.`,
      );
    }

    const issues = new Map<number, IssueSnapshot>();
    for (const planIssue of plan.issues) {
      const snapshot = await this.deps.github.fetchIssue(planIssue.number, { allowClosed: true });
      if (snapshot.state !== "OPEN") {
        throw new ControllerError("plan_issue_not_open", `Child Issue #${planIssue.number} is not OPEN.`);
      }
      if (snapshot.number !== planIssue.number
        || snapshot.title !== planIssue.expectedTitle
        || sha256PrefixedUtf8(snapshot.body) !== planIssue.expectedBodyHash) {
        throw new ControllerError(
          "plan_issue_drift",
          `Child Issue #${planIssue.number} no longer matches its exact title/body source binding.`,
        );
      }
      issues.set(planIssue.number, snapshot);
    }
    return { baseSha, parent, issues };
  }

  private async runSetupValidation(job: JobState, baseSha: string): Promise<StepResult> {
    const head = await this.deps.git.head(job.worktreePath);
    const worktreeDigest = await this.deps.git.worktreeDigest(job.worktreePath);
    const setup = await this.deps.validator.run({
      job,
      scope: "setup",
      issueNumber: null,
      commands: this.deps.store.config.validation.setup,
      validationsRoot: this.deps.store.validationsRoot(job.id),
      sourceHeadSha: head,
      sourceWorktreeDigest: worktreeDigest,
    });
    await this.assertValidationDidNotMutate(job, worktreeDigest);
    appendValidation(job, setup.receipt, setup.path);
    if (!setup.receipt.passed) {
      throw new ControllerError("setup_validation_failed", "Release setup validation failed.", setup.path);
    }
    job.phase = "implement";
    job.currentIssueNumber = null;
    this.deps.store.save(job);
    return stepResult("release_prepared", true, false, null, `Release ${job.id} prepared at ${baseSha}.`);
  }

  private async implement(job: JobState): Promise<StepResult> {
    let issue = currentIssue(job);
    if (!issue) {
      issue = nextPendingIssue(job);
      if (!issue) {
        job.phase = "release_validate";
        job.currentIssueNumber = null;
        this.deps.store.save(job);
        return stepResult("all_issues_implemented", true, false, null, "All planned Issues are committed; starting release validation.");
      }
      assertDependenciesCommitted(job, issue);
      issue.status = "running";
      job.currentIssueNumber = issue.number;
      this.deps.store.save(job);
    }
    if (!issue.snapshot) throw new ControllerError("issue_snapshot_missing", `Issue #${issue.number} has no bound snapshot.`);
    const planIssue = job.plan.issues.find((candidate) => candidate.number === issue!.number);
    if (!planIssue) throw new ControllerError("plan_issue_missing", `Issue #${issue.number} is not present in the job plan.`);

    const validationReceipt = issue.lastValidationId
      ? this.readValidation(job, issue.lastValidationId)
      : null;
    const recovery = issue.nextRunKind !== "worker";
    const kind = issue.nextRunKind === "worker" ? "worker" : "issue-repair";
    const prompt = renderIssueWorkerPrompt({ job, issue, planIssue, recovery, validationReceipt });
    const runId = newId(kind);
    const baseHeadSha = await this.deps.git.head(job.worktreePath);
    job.activeRun = { id: runId, kind, issueNumber: issue.number, startedAt: nowIso(), baseHeadSha };
    issue.lastRunId = runId;
    this.deps.store.save(job);

    const execution = await this.deps.codex.run({
      job,
      kind,
      issueNumber: issue.number,
      prompt,
      runsRoot: this.deps.store.runsRoot(job.id),
      runId,
    });
    await this.deps.git.assertAgentDidNotCommit(job, baseHeadSha);
    job.activeRun = null;
    job.runs.push(execution.record);
    if (execution.record.exitCode !== 0 || execution.record.signal !== null || execution.record.timedOut) {
      this.deps.store.save(job);
      throw new ControllerError("codex_worker_failed", `Codex Worker failed for Issue #${issue.number}.`, execution.record.stderrPath);
    }
    const result = execution.workerResult;
    if (!result) {
      this.deps.store.save(job);
      throw new ControllerError("codex_worker_result_missing", `Codex Worker produced no valid structured result for Issue #${issue.number}.`, execution.record.resultPath);
    }
    if (result.status === "blocked") {
      issue.status = "blocked";
      this.deps.store.save(job);
      throw new ControllerError("codex_worker_blocked", result.blockedReason ?? result.summary, execution.record.resultPath);
    }
    if (!result.selfReview.performed) {
      this.deps.store.save(job);
      throw new ControllerError("worker_self_review_missing", `Issue #${issue.number} Worker did not perform its required self-review.`, execution.record.resultPath);
    }
    issue.nextRunKind = "worker";
    job.phase = "issue_validate";
    this.deps.store.save(job);
    return stepResult("worker_completed", true, false, null, `Issue #${issue.number} implementation completed; authoritative validation is next.`);
  }

  private async validateIssue(job: JobState): Promise<StepResult> {
    const issue = currentIssue(job);
    if (!issue) throw new ControllerError("current_issue_missing", "Issue validation has no current Issue.");
    const planIssue = job.plan.issues.find((candidate) => candidate.number === issue.number);
    if (!planIssue || !issue.snapshot) throw new ControllerError("issue_identity_missing", `Issue #${issue.number} identity is incomplete.`);

    const salvaged = await this.deps.git.salvageIssueCommitAtHead(job, issue.number);
    if (salvaged) {
      issue.status = "committed";
      issue.commitSha = salvaged;
      job.currentIssueNumber = null;
      job.phase = nextPendingIssue(job) ? "implement" : "release_validate";
      this.deps.store.save(job);
      return stepResult("issue_commit_salvaged", true, false, null, `Recovered Controller-owned commit ${salvaged} for Issue #${issue.number}.`);
    }

    const commands = dedupeCommands([
      ...this.deps.store.config.validation.issue,
      ...planIssue.suggestedValidation,
    ]);
    const head = await this.deps.git.head(job.worktreePath);
    const beforeDigest = await this.deps.git.worktreeDigest(job.worktreePath);
    const validation = await this.deps.validator.run({
      job,
      scope: "issue",
      issueNumber: issue.number,
      commands,
      validationsRoot: this.deps.store.validationsRoot(job.id),
      sourceHeadSha: head,
      sourceWorktreeDigest: beforeDigest,
    });
    await this.assertValidationDidNotMutate(job, beforeDigest);
    appendValidation(job, validation.receipt, validation.path);
    issue.lastValidationId = validation.receipt.id;
    if (!validation.receipt.passed) {
      if (issue.repairRounds < this.deps.store.config.policy.maxIssueRepairRounds) {
        issue.repairRounds += 1;
        issue.nextRunKind = "issue-repair";
        job.phase = "implement";
        this.deps.store.save(job);
        return stepResult("issue_repair_scheduled", true, false, null, `Issue #${issue.number} validation failed; scheduling bounded fresh repair ${issue.repairRounds}.`);
      }
      issue.status = "blocked";
      this.deps.store.save(job);
      throw new ControllerError("issue_validation_failed", `Issue #${issue.number} validation failed after the allowed repair rounds.`, validation.path);
    }

    const commit = await this.deps.git.commitIssue(job, issue.number, issue.snapshot.title, planIssue.allowNoop);
    issue.status = "committed";
    issue.commitSha = commit.sha;
    issue.nextRunKind = "worker";
    job.currentIssueNumber = null;
    job.phase = nextPendingIssue(job) ? "implement" : "release_validate";
    this.deps.store.save(job);
    return stepResult("issue_committed", true, false, null, `Issue #${issue.number} committed as ${commit.sha}.`);
  }

  private async validateRelease(job: JobState): Promise<StepResult> {
    if (job.issues.some((issue) => issue.status !== "committed")) {
      throw new ControllerError("release_issues_incomplete", "Release validation requires every Issue to be committed.");
    }
    if (!(await this.deps.git.isClean(job.worktreePath))) {
      throw new ControllerError("release_worktree_dirty", "Release validation requires a clean Controller-owned candidate.");
    }
    const head = await this.deps.git.head(job.worktreePath);
    const beforeDigest = await this.deps.git.worktreeDigest(job.worktreePath);
    const validation = await this.deps.validator.run({
      job,
      scope: "release",
      issueNumber: null,
      commands: this.deps.store.config.validation.release,
      validationsRoot: this.deps.store.validationsRoot(job.id),
      sourceHeadSha: head,
      sourceWorktreeDigest: beforeDigest,
    });
    await this.assertValidationDidNotMutate(job, beforeDigest);
    appendValidation(job, validation.receipt, validation.path);
    if (!validation.receipt.passed) {
      return this.scheduleHardening(job, "release-validation", renderValidationFailure(validation.receipt), validation.path);
    }

    job.candidateSha = head;
    const stats = await this.deps.git.diffStats(job);
    if (stats.files > this.deps.store.config.policy.maxChangedFiles
      || stats.changedLines > this.deps.store.config.policy.maxChangedLines) {
      throw new ControllerError(
        "release_diff_too_large",
        `Release diff has ${stats.files} files and ${stats.changedLines} changed lines; configured limits are ${this.deps.store.config.policy.maxChangedFiles} files and ${this.deps.store.config.policy.maxChangedLines} lines.`,
        validation.path,
      );
    }
    job.phase = this.deps.store.config.review.enabled ? "review" : "deliver";
    this.deps.store.save(job);
    return stepResult("release_validated", true, false, null, `Release candidate ${head} passed full validation.`);
  }

  private async review(job: JobState): Promise<StepResult> {
    if (!job.baseSha || !job.candidateSha) throw new ControllerError("review_candidate_missing", "Release review requires exact base and candidate SHAs.");
    if (await this.deps.git.head(job.worktreePath) !== job.candidateSha || !(await this.deps.git.isClean(job.worktreePath))) {
      throw new ControllerError("review_candidate_drift", "The release candidate changed before review.");
    }
    // Explicitly render once here so oversized diffs fail before a Provider call.
    await this.deps.git.diffText(job, MAX_REVIEW_DIFF_BYTES);
    const receipt = this.latestPassedReleaseValidation(job, job.candidateSha);
    const prompt = renderReleaseReviewPrompt({ job, validationReceipt: receipt });
    const runId = newId("review");
    const baseHeadSha = job.candidateSha;
    const beforeDigest = await this.deps.git.worktreeDigest(job.worktreePath);
    job.activeRun = { id: runId, kind: "review", issueNumber: null, startedAt: nowIso(), baseHeadSha };
    this.deps.store.save(job);
    const execution = await this.deps.codex.run({
      job,
      kind: "review",
      issueNumber: null,
      prompt,
      runsRoot: this.deps.store.runsRoot(job.id),
      runId,
    });
    await this.deps.git.assertAgentDidNotCommit(job, baseHeadSha);
    await this.assertValidationDidNotMutate(job, beforeDigest, "release review");
    job.activeRun = null;
    job.runs.push(execution.record);
    job.reviewRound += 1;
    job.lastReviewPath = execution.record.resultPath;
    if (execution.record.exitCode !== 0 || execution.record.signal !== null || execution.record.timedOut || !execution.reviewResult) {
      this.deps.store.save(job);
      throw new ControllerError("codex_review_failed", "Fresh release review did not produce a valid result.", execution.record.stderrPath);
    }
    const review = execution.reviewResult;
    if (review.status === "blocked") {
      this.deps.store.save(job);
      throw new ControllerError("release_review_blocked", review.summary, execution.record.resultPath);
    }
    const blocking = blockingFindings(review, this.deps.store.config.review.blockingSeverities);
    if (review.status === "changes" && blocking.length > 0) {
      return this.scheduleHardening(job, "release-review", renderReviewFailure(review), execution.record.resultPath);
    }
    job.phase = "deliver";
    this.deps.store.save(job);
    return stepResult("release_review_passed", true, false, null, `Candidate ${job.candidateSha} passed aggregate release review.`);
  }

  private async harden(job: JobState): Promise<StepResult> {
    const salvaged = await this.deps.git.salvageHardeningCommitAtHead(job, job.hardeningRounds);
    if (salvaged) {
      job.candidateSha = null;
      job.phase = "release_validate";
      job.activeRun = null;
      this.deps.store.save(job);
      return stepResult("hardening_commit_salvaged", true, false, null, `Recovered Controller-owned hardening commit ${salvaged}.`);
    }
    if (!job.hardeningReasonPath || !existsSync(job.hardeningReasonPath)) {
      throw new ControllerError("hardening_reason_missing", "Release hardening has no durable blocking evidence.");
    }
    const prompt = renderReleaseHardeningPrompt({ job, reasonPath: job.hardeningReasonPath });
    const runId = newId("release-harden");
    const baseHeadSha = await this.deps.git.head(job.worktreePath);
    job.activeRun = { id: runId, kind: "release-harden", issueNumber: null, startedAt: nowIso(), baseHeadSha };
    this.deps.store.save(job);
    const execution = await this.deps.codex.run({
      job,
      kind: "release-harden",
      issueNumber: null,
      prompt,
      runsRoot: this.deps.store.runsRoot(job.id),
      runId,
    });
    await this.deps.git.assertAgentDidNotCommit(job, baseHeadSha);
    job.activeRun = null;
    job.runs.push(execution.record);
    this.deps.store.save(job);
    if (execution.record.exitCode !== 0 || execution.record.signal !== null || execution.record.timedOut || !execution.workerResult) {
      this.deps.store.save(job);
      throw new ControllerError("codex_hardening_failed", "Release hardening Worker did not complete successfully.", execution.record.stderrPath);
    }
    if (execution.workerResult.status === "blocked") {
      this.deps.store.save(job);
      throw new ControllerError("codex_hardening_blocked", execution.workerResult.blockedReason ?? execution.workerResult.summary, execution.record.resultPath);
    }
    if (!execution.workerResult.selfReview.performed) {
      this.deps.store.save(job);
      throw new ControllerError("hardening_self_review_missing", "Release hardening Worker did not perform self-review.", execution.record.resultPath);
    }
    if (await this.deps.git.isClean(job.worktreePath)) {
      this.deps.store.save(job);
      throw new ControllerError("hardening_no_changes", "Release hardening completed without producing a repair diff.", execution.record.resultPath);
    }
    const reason = readFileSync(job.hardeningReasonPath, "utf8");
    const commit = await this.deps.git.commitHardening(job, reason);
    if (!commit.created) throw new ControllerError("hardening_commit_missing", "Hardening changes could not be committed.");
    job.candidateSha = null;
    job.phase = "release_validate";
    this.deps.store.save(job);
    return stepResult("release_hardening_committed", true, false, null, `Hardening round ${job.hardeningRounds} committed as ${commit.sha}; full validation will rerun.`);
  }

  private async deliver(job: JobState): Promise<StepResult> {
    if (!job.candidateSha || await this.deps.git.head(job.worktreePath) !== job.candidateSha || !(await this.deps.git.isClean(job.worktreePath))) {
      throw new ControllerError("delivery_candidate_drift", "Delivery requires the exact clean reviewed candidate.");
    }
    if (!this.deps.store.config.delivery.createPullRequest) {
      job.phase = "complete";
      job.status = "completed";
      this.deps.store.save(job);
      return stepResult("release_completed_without_pr", true, true, null, `Release ${job.id} completed locally at ${job.candidateSha}.`);
    }
    await this.deps.git.push(job);
    const pullRequest = await this.deps.github.createPullRequest(job, this.deps.store.deliveryRoot(job.id));
    assertPullRequestIdentity(job, pullRequest, "OPEN");
    job.pullRequest = pullRequest;
    job.phase = "ci";
    job.status = "running";
    this.deps.store.save(job);
    return stepResult("pull_request_ready", true, false, this.deps.store.config.delivery.pollIntervalMs, `Pull request #${pullRequest.number} created or recovered.`);
  }

  private async observeCi(job: JobState): Promise<StepResult> {
    if (!job.pullRequest || !job.candidateSha) throw new ControllerError("ci_identity_missing", "CI observation has no bound PR or candidate SHA.");
    const observed = await this.deps.github.inspectPullRequest(job.pullRequest.number);
    job.pullRequest = observed.pullRequest;
    if (observed.pullRequest.state === "MERGED" || observed.mergedAt !== null) return this.completeMerged(job);
    if (observed.pullRequest.state === "CLOSED") throw new ControllerError("pull_request_closed", "The release pull request was closed without merge.");
    assertPullRequestIdentity(job, observed.pullRequest, "OPEN");
    if (observed.checks.state === "failure") {
      if (job.ciRepairRounds >= this.deps.store.config.policy.maxCiRepairRounds) {
        const path = this.writeReason(job, "ci-failure", JSON.stringify(observed.checks, null, 2));
        this.deps.store.save(job);
        throw new ControllerError("ci_failed", "Pull request checks failed after the allowed CI repair rounds.", path);
      }
      job.ciRepairRounds += 1;
      return this.scheduleHardening(job, "ci-failure", JSON.stringify(observed.checks, null, 2), null);
    }
    if (observed.checks.state === "pending" || (observed.checks.state === "none" && !this.deps.store.config.delivery.allowNoChecks)) {
      this.deps.store.save(job);
      return stepResult("ci_pending", false, false, this.deps.store.config.delivery.pollIntervalMs, "Waiting for GitHub checks.");
    }
    if (this.deps.store.config.delivery.autoMerge) {
      await this.deps.github.enableAutoMerge(job.pullRequest.number, job.candidateSha);
      job.status = "running";
    } else {
      job.status = "ready_to_merge";
    }
    job.phase = "awaiting_merge";
    this.deps.store.save(job);
    return stepResult(
      this.deps.store.config.delivery.autoMerge ? "auto_merge_enabled" : "ready_to_merge",
      true,
      !this.deps.store.config.delivery.autoMerge,
      this.deps.store.config.delivery.autoMerge ? this.deps.store.config.delivery.pollIntervalMs : null,
      this.deps.store.config.delivery.autoMerge ? "Checks passed; auto-merge is enabled." : "Checks passed; the exact reviewed PR is ready for manual merge.",
    );
  }

  private async observeMerge(job: JobState): Promise<StepResult> {
    if (!job.pullRequest || !job.candidateSha) throw new ControllerError("merge_identity_missing", "Merge observation has no bound PR or candidate SHA.");
    const observed = await this.deps.github.inspectPullRequest(job.pullRequest.number);
    job.pullRequest = observed.pullRequest;
    if (observed.pullRequest.state === "MERGED" || observed.mergedAt !== null) return this.completeMerged(job);
    if (observed.pullRequest.state === "CLOSED") throw new ControllerError("pull_request_closed", "The release pull request was closed without merge.");
    assertPullRequestIdentity(job, observed.pullRequest, "OPEN");
    job.status = this.deps.store.config.delivery.autoMerge ? "running" : "ready_to_merge";
    this.deps.store.save(job);
    return stepResult("awaiting_merge", false, !this.deps.store.config.delivery.autoMerge, this.deps.store.config.delivery.autoMerge ? this.deps.store.config.delivery.pollIntervalMs : null, "Waiting for the exact candidate PR to merge.");
  }

  private completeMerged(job: JobState): StepResult {
    job.status = "completed";
    job.phase = "complete";
    job.blocked = null;
    this.deps.store.save(job);
    return stepResult("release_merged", true, true, null, `Release ${job.id} was merged.`);
  }

  private scheduleHardening(
    job: JobState,
    kind: string,
    evidence: string,
    detailsPath: string | null,
  ): StepResult {
    if (job.hardeningRounds >= this.deps.store.config.policy.maxReleaseHardeningRounds) {
      throw new ControllerError("release_hardening_exhausted", "Release requires another hardening round beyond the configured limit.", detailsPath);
    }
    job.hardeningRounds += 1;
    job.hardeningReasonPath = this.writeReason(job, kind, evidence);
    job.phase = "harden";
    this.deps.store.save(job);
    return stepResult("release_hardening_scheduled", true, false, null, `Scheduled fresh release hardening round ${job.hardeningRounds}.`);
  }

  private writeReason(job: JobState, kind: string, evidence: string): string {
    const path = join(this.deps.store.root(job.id), `hardening-${String(job.hardeningRounds).padStart(2, "0")}-${kind}.md`);
    writeTextAtomic(path, `# ${kind}\n\n${evidence.trim()}\n`);
    return path;
  }

  private latestPassedReleaseValidation(job: JobState, candidateSha: string): ValidationReceipt {
    const entries = [...job.validations].reverse().filter((entry) => entry.scope === "release" && entry.passed);
    for (const entry of entries) {
      const receipt = readJsonFile<ValidationReceipt>(entry.path);
      assertValidationReceipt(receipt);
      if (receipt.digest === entry.digest && receipt.candidateSha === candidateSha && receipt.passed) return receipt;
    }
    throw new ControllerError("release_validation_receipt_missing", "No passed release validation receipt is bound to the current candidate SHA.");
  }

  private readValidation(job: JobState, id: string): ValidationReceipt | null {
    const binding = [...job.validations].reverse().find((entry) => entry.id === id);
    if (!binding) return null;
    const receipt = readJsonFile<ValidationReceipt>(binding.path);
    assertValidationReceipt(receipt);
    if (receipt.digest !== binding.digest) throw new ControllerError("validation_receipt_drift", `Validation receipt ${id} changed.`);
    return receipt;
  }

  private async assertValidationDidNotMutate(job: JobState, beforeDigest: string, label = "validation"): Promise<void> {
    const after = await this.deps.git.worktreeDigest(job.worktreePath);
    if (after !== beforeDigest) {
      throw new ControllerError("validator_mutated_worktree", `${label} changed the Git-visible worktree; validation must be observational.`);
    }
  }
}

function assertPullRequestIdentity(
  job: JobState,
  pullRequest: NonNullable<JobState["pullRequest"]>,
  expectedState: "OPEN",
): void {
  if (!job.candidateSha
    || pullRequest.state !== expectedState
    || pullRequest.headSha !== job.candidateSha
    || pullRequest.headRef !== job.branch
    || pullRequest.baseRef !== job.baseRef) {
    throw new ControllerError(
      "pull_request_identity_mismatch",
      "Observed pull request does not bind the exact release branch, base branch, candidate SHA, and open state.",
    );
  }
}

function appendValidation(job: JobState, receipt: ValidationReceipt, path: string): void {
  job.validations.push({
    id: receipt.id,
    scope: receipt.scope,
    issueNumber: receipt.issueNumber,
    path,
    passed: receipt.passed,
    digest: receipt.digest,
  });
}

function assertDependenciesCommitted(job: JobState, issue: IssueExecution): void {
  const planned = job.plan.issues.find((candidate) => candidate.number === issue.number);
  if (!planned) throw new ControllerError("plan_issue_missing", `Issue #${issue.number} is missing from the plan.`);
  for (const dependency of planned.dependsOn) {
    const state = job.issues.find((candidate) => candidate.number === dependency);
    if (!state || state.status !== "committed") {
      throw new ControllerError("issue_dependency_incomplete", `Issue #${issue.number} depends on uncommitted Issue #${dependency}.`);
    }
  }
}

function dedupeCommands(commands: CommandConfig[]): CommandConfig[] {
  const seen = new Set<string>();
  const result: CommandConfig[] = [];
  for (const command of commands) {
    const key = `${command.command}\n${command.timeoutMs ?? "default"}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(command);
    }
  }
  return result;
}

function renderValidationFailure(receipt: ValidationReceipt): string {
  return receipt.commands
    .filter((command) => command.exitCode !== 0 || command.signal !== null || command.timedOut)
    .map((command) => [
      `Command: ${command.command}`,
      `Exit: ${command.exitCode ?? command.signal ?? "unknown"}`,
      `Timed out: ${command.timedOut}`,
      `stdout tail:\n${command.stdoutTail}`,
      `stderr tail:\n${command.stderrTail}`,
    ].join("\n"))
    .join("\n\n");
}

function renderReviewFailure(review: ReviewResult): string {
  return [
    `Review status: ${review.status}`,
    `Summary: ${review.summary}`,
    "",
    ...review.findings.map((finding, index) => [
      `## Finding ${index + 1}: ${finding.severity}`,
      `Path: ${finding.path ?? "not specified"}${finding.line ? `:${finding.line}` : ""}`,
      `Summary: ${finding.summary}`,
      `Rationale: ${finding.rationale}`,
      `Recommendation: ${finding.recommendation}`,
    ].join("\n")),
  ].join("\n");
}

function blockingFindings(review: ReviewResult, severities: Array<"critical" | "major">) {
  const allowed = new Set(severities);
  return review.findings.filter((finding) => allowed.has(finding.severity as "critical" | "major"));
}

function assertValidationReceipt(receipt: ValidationReceipt): void {
  const { digest, ...identity } = receipt;
  if (digest !== digestJson(identity)) throw new ControllerError("validation_receipt_invalid", `Validation receipt ${receipt.id} failed its self-digest.`);
}

function stepResult(action: string, progressed: boolean, terminal: boolean, retryAfterMs: number | null, message: string): StepResult {
  return { action, progressed, terminal, retryAfterMs, message };
}
