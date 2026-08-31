import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CodexRunRecord,
  CommandConfig,
  GhCheckSummary,
  GhCheckObservation,
  IssueSnapshot,
  IssueExecution,
  JobState,
  OracleExecutionRef,
  ReleasePlanIssueV2,
  RepositoryFileSnapshot,
  ReviewResult,
  StepResult,
  ValidationReceipt,
  ValidationCommandConfig,
} from "./types.js";
import type { CodexPort, GitHubPort, GitPort, ValidationPort } from "./ports.js";
import { ControllerError, asControllerError } from "./errors.js";
import { createCompletionEvidence, createPublicCompletionCheckpoint, readCanonicalCandidateProof } from "./completion-export.js";
import { unknownRiskClasses } from "./risk-classes.js";
import { CommandInterruptedError } from "./command.js";
import { JobStore, blockJob, currentIssue, nextPendingIssue } from "./state.js";
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from "./fs-atomic.js";
import { digestJson, newId, nowIso, sha256PrefixedUtf8 } from "./util.js";
import {
  assertPlanCompatibleWithConfig,
  isReleasePlanV2,
  oracleVerifierProtectedPaths,
  validatePlan,
} from "./plan.js";
import { assertValidationReceipt } from "./validator.js";
import { requiredCheckContract, requiredCheckNames } from "./config.js";
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
      if (isReleasePlanV2(job.plan)
        && !["prepare", "ci", "awaiting_merge", "complete"].includes(job.phase)) {
        await this.assertSourceStillCurrent(job, job.phase);
      }
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
      if (job.deliveryAuthority && job.pullRequest && job.pullRequest.state === "OPEN") {
        try {
          job = await this.revokeDeliveryAuthority(job, `${classified.code}: ${classified.message}`);
        } catch (revocationError) {
          const revocation = asControllerError(revocationError, "delivery_authority_revocation_failed");
          job = blockJob(this.deps.store.load(jobId), revocation.code, revocation.message, revocation.detailsPath);
          this.deps.store.save(job);
          return stepResult("blocked", true, true, null, `${job.blocked!.code}: ${job.blocked!.message}`);
        }
      }
      job = blockJob(job, classified.code, classified.message, classified.detailsPath);
      this.deps.store.save(job);
      return stepResult("blocked", true, true, null, `${job.blocked!.code}: ${job.blocked!.message}`);
    }
  }

  async abort(jobId: string, reason: string): Promise<JobState> {
    let job = this.deps.store.load(jobId);
    if (job.activeRun) throw new Error("cannot abort while an active Codex run is recorded; first reconcile it with step");
    if (job.deliveryAuthority && job.pullRequest && job.pullRequest.state === "OPEN") {
      job = await this.revokeDeliveryAuthority(job, `operator_abort: ${reason}`);
    }
    job.status = "failed";
    job.blocked = null;
    this.deps.store.save(job);
    return job;
  }

  private assertCurrentInputs(job: JobState): void {
    try { validatePlan(job.plan); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes("unknown_risk_class")
        ? "unknown_risk_class"
        : message.includes("invalid_expected_path_pattern")
          ? "invalid_expected_path_pattern"
          : "plan_drift";
      throw new ControllerError(code, message);
    }
    const currentConfigDigest = digestJson(this.deps.store.config);
    if (currentConfigDigest !== job.configDigest) {
      throw new ControllerError("config_drift", "The current Controller config differs from the job-bound config snapshot.");
    }
    if (digestJson(job.plan) !== job.planDigest) {
      throw new ControllerError("plan_drift", "The job-bound release plan digest changed.");
    }
    const currentProvenance = this.deps.store.currentProvenance(job.plan);
    if (currentProvenance.digest !== job.provenance.digest) {
      throw new ControllerError(
        "controller_provenance_drift",
        "The current Controller source or build provenance differs from the Job snapshot.",
      );
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
          await this.assertReleaseCommitProtected(job, salvaged);
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
    await this.deps.validator.preflight();
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
    await this.assertReleaseWorktreeContract(job);

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
    await this.deps.validator.preflight();

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

    const { parent, issues } = await this.fetchCurrentSourceIssues(job, null);
    await this.assertOracleBindingsAtBase(plan);
    return { baseSha, parent, issues };
  }

  private async assertSourceStillCurrent(job: JobState, phase: string): Promise<void> {
    if (!isReleasePlanV2(job.plan)) return;
    this.assertCurrentInputs(job);
    const baseSha = await this.deps.git.fetchBase();
    if (baseSha !== job.plan.source.baseSha) {
      throw new ControllerError(
        "runtime_source_base_drift",
        `The remote base changed during ${phase}; abort this Job and create a fresh Release Plan v2.`,
      );
    }
    await this.fetchCurrentSourceIssues(job, phase);
    await this.assertOracleBindingsAtBase(job.plan);
  }

  private async fetchCurrentSourceIssues(
    job: JobState,
    phase: string | null,
  ): Promise<{ parent: IssueSnapshot; issues: Map<number, IssueSnapshot> }> {
    if (!isReleasePlanV2(job.plan)) throw new ControllerError("plan_version_mismatch", "Exact source verification requires Release Plan v2.");
    const plan = job.plan;
    const parent = await this.deps.github.fetchIssue(plan.source.parentBinding.number, { allowClosed: true });
    if (parent.state !== "OPEN") {
      throw new ControllerError(
        phase === null ? "plan_parent_not_open" : "runtime_parent_binding_drift",
        `Parent Issue #${plan.parentIssue} is not OPEN${phase === null ? "" : ` during ${phase}`}.`,
      );
    }
    if (parent.number !== plan.source.parentBinding.number
      || parent.title !== plan.source.parentBinding.expectedTitle
      || sha256PrefixedUtf8(parent.body) !== plan.source.parentBinding.expectedBodyHash) {
      throw new ControllerError(
        phase === null ? "plan_parent_drift" : "runtime_parent_binding_drift",
        `Parent Issue #${plan.parentIssue} no longer matches its exact title/body source binding.`,
      );
    }

    const issues = new Map<number, IssueSnapshot>();
    for (const planIssue of plan.issues) {
      const snapshot = await this.deps.github.fetchIssue(planIssue.number, { allowClosed: true });
      if (snapshot.state !== "OPEN") {
        throw new ControllerError(
          phase === null ? "plan_issue_not_open" : "runtime_child_binding_drift",
          `Child Issue #${planIssue.number} is not OPEN${phase === null ? "" : ` during ${phase}`}.`,
        );
      }
      if (snapshot.number !== planIssue.number
        || snapshot.title !== planIssue.expectedTitle
        || sha256PrefixedUtf8(snapshot.body) !== planIssue.expectedBodyHash) {
        throw new ControllerError(
          phase === null ? "plan_issue_drift" : "runtime_child_binding_drift",
          `Child Issue #${planIssue.number} no longer matches its exact title/body source binding.`,
        );
      }
      issues.set(planIssue.number, snapshot);
    }
    return { parent, issues };
  }

  private async assertOracleBindingsAtBase(plan: JobState["plan"]): Promise<void> {
    if (!isReleasePlanV2(plan)) return;
    for (const issue of plan.issues) {
      for (const binding of issue.oracleBindings) {
        let observed;
        try { observed = await this.deps.git.fileAtRevision(plan.source.baseSha, binding.artifact.path); }
        catch { throw new ControllerError("oracle_binding_drift", `Oracle ${binding.id} is unavailable at the bound source base.`); }
        if (observed.sha256 !== binding.artifact.sha256 || observed.byteCount !== binding.artifact.byteCount) {
          throw new ControllerError("oracle_binding_drift", `Oracle ${binding.id} does not match its bound bytes.`);
        }
      }
    }
    await this.assertOracleVerifierBindings(
      plan,
      (path) => this.deps.git.fileAtRevision(plan.source.baseSha, path),
      "source base",
    );
  }

  private async assertIssueWorktreeContract(job: JobState, issue: JobState["plan"]["issues"][number]): Promise<void> {
    if (!isReleasePlanV2(job.plan) || !("oracleBindings" in issue)) return;
    await this.assertOracleBindingsInWorktree(job, job.plan.issues);
    const changed = await this.deps.git.changedPaths(job.worktreePath);
    this.assertNoOracleVerifierChanges(changed, job.plan);
    this.assertNoProtectedChanges(changed, job.plan.issues.flatMap((entry) => entry.protectedPaths));
    if (changed.some((path) => !issue.expectedPaths.some((pattern) => expectedPathMatches(pattern, path)))) {
      throw new ControllerError("issue_scope_path_drift", `Issue #${issue.number} changed a path outside its bound expectedPaths.`);
    }
  }

  private async assertReleaseWorktreeContract(job: JobState): Promise<void> {
    if (!isReleasePlanV2(job.plan)) return;
    const issues = job.plan.issues;
    await this.assertOracleBindingsInWorktree(job, issues);
    const changed = await this.deps.git.changedPaths(job.worktreePath);
    this.assertNoOracleVerifierChanges(changed, job.plan);
    this.assertNoProtectedChanges(changed, issues.flatMap((issue) => issue.protectedPaths));
    if (changed.some((path) => owningIssues(issues, path).length !== 1)) {
      throw new ControllerError("hardening_scope_unattributed", "Release hardening changed a path without one exact Ticket owner.");
    }
  }

  private async assertOracleBindingsInWorktree(job: JobState, issues: ReleasePlanIssueV2[]): Promise<void> {
    for (const issue of issues) {
      for (const binding of issue.oracleBindings) {
        let observed;
        try { observed = await this.deps.git.fileInWorktree(job, binding.artifact.path); }
        catch { throw new ControllerError("oracle_binding_drift", `Oracle ${binding.id} is unavailable in the release worktree.`); }
        if (observed.sha256 !== binding.artifact.sha256 || observed.byteCount !== binding.artifact.byteCount) {
          throw new ControllerError("oracle_binding_drift", `Oracle ${binding.id} changed in the release worktree.`);
        }
      }
    }
    await this.assertOracleVerifierBindings(
      job.plan,
      (path) => this.deps.git.fileInWorktree(job, path),
      "release worktree",
    );
  }

  private async assertOracleVerifierBindings(
    plan: JobState["plan"],
    read: (path: string) => Promise<RepositoryFileSnapshot>,
    location: string,
  ): Promise<void> {
    if (!isReleasePlanV2(plan)) return;
    try {
      const cache = new Map<string, RepositoryFileSnapshot>();
      const snapshot = async (path: string) => {
        const existing = cache.get(path);
        if (existing) return existing;
        const observed = await read(path);
        cache.set(path, observed);
        return observed;
      };
      const packageJson = JSON.parse(Buffer.from((await snapshot("package.json")).bytes).toString("utf8")) as unknown;
      if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) throw new Error("package.json is invalid");
      const scripts = (packageJson as Record<string, unknown>).scripts;
      if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) throw new Error("package.json scripts are invalid");
      for (const issue of plan.issues) {
        for (const binding of issue.oracleBindings) {
          const verifier = binding.verifier;
          const definition = (scripts as Record<string, unknown>)[verifier.packageScript.name];
          if (typeof definition !== "string"
            || sha256PrefixedUtf8(definition) !== verifier.packageScript.definitionSha256) {
            throw new Error(`Oracle ${binding.id} package script drifted`);
          }
          const { digest, ...identity } = verifier;
          if (digest !== `sha256:${digestJson(identity)}`) throw new Error(`Oracle ${binding.id} manifest drifted`);
          for (const file of verifier.files) {
            const observed = await snapshot(file.path);
            if (observed.sha256 !== file.sha256 || observed.byteCount !== file.byteCount) {
              throw new Error(`Oracle ${binding.id} verifier file drifted`);
            }
          }
        }
      }
    } catch {
      throw new ControllerError("oracle_verifier_drift", `Oracle verifier bindings do not match the ${location}.`);
    }
  }

  private assertNoOracleVerifierChanges(changed: string[], plan: JobState["plan"]): void {
    const protectedPaths = new Set(oracleVerifierProtectedPaths(plan));
    if (changed.some((path) => protectedPaths.has(path))) {
      throw new ControllerError("oracle_verifier_drift", "An Oracle verifier or package.json changed in the release worktree.");
    }
  }

  private assertNoProtectedChanges(changed: string[], protectedPaths: string[]): void {
    const protectedSet = new Set(protectedPaths);
    if (changed.some((path) => protectedSet.has(path))) {
      throw new ControllerError("protected_path_changed", "A protected Oracle path changed in the release worktree.");
    }
  }

  private async assertIssueCommitContract(
    job: JobState,
    issue: JobState["plan"]["issues"][number],
    sha: string,
  ): Promise<void> {
    if (!isReleasePlanV2(job.plan) || !("scopeBudget" in issue)) return;
    const stats = await this.deps.git.commitStats(job, sha);
    const maxFiles = Math.min(issue.scopeBudget.maxFiles, this.deps.store.config.policy.maxChangedFiles);
    const maxChangedLines = Math.min(issue.scopeBudget.maxChangedLines, this.deps.store.config.policy.maxChangedLines);
    if (stats.entries.some(({ binary }) => binary) || stats.files > maxFiles || stats.changedLines > maxChangedLines) {
      throw new ControllerError(
        "issue_scope_budget_exceeded",
        `Issue #${issue.number} commit exceeds its bound scope budget.`,
      );
    }
    this.assertNoOracleVerifierChanges(stats.paths, job.plan);
    const releaseProtectedPaths = new Set(job.plan.issues.flatMap((entry) => entry.protectedPaths));
    if (stats.paths.some((path) => releaseProtectedPaths.has(path))) {
      throw new ControllerError("protected_path_changed", `Issue #${issue.number} commit changes a protected Oracle path.`);
    }
    if (stats.paths.some((path) => !issue.expectedPaths.some((pattern) => expectedPathMatches(pattern, path)))) {
      throw new ControllerError("issue_scope_path_drift", `Issue #${issue.number} commit changed a path outside its bound expectedPaths.`);
    }
    await this.assertOracleBindingsInWorktree(job, job.plan.issues);
  }

  private async assertReleaseCommitProtected(job: JobState, sha: string): Promise<void> {
    if (!isReleasePlanV2(job.plan)) return;
    const stats = await this.deps.git.commitStats(job, sha);
    this.assertNoOracleVerifierChanges(stats.paths, job.plan);
    const protectedPaths = new Set(job.plan.issues.flatMap((issue) => issue.protectedPaths));
    if (stats.paths.some((path) => protectedPaths.has(path))) {
      throw new ControllerError("protected_path_changed", "Release hardening changed a protected Oracle path.");
    }
    await this.assertOracleBindingsInWorktree(job, job.plan.issues);
    await this.assertReleaseAggregateScope(job);
  }

  private async assertReleaseAggregateScope(job: JobState): Promise<void> {
    if (!isReleasePlanV2(job.plan)) return;
    const stats = await this.deps.git.diffStats(job);
    const groups = new Map<number, typeof stats.entries>();
    for (const entry of stats.entries) {
      const owners = owningIssues(job.plan.issues, entry.path);
      if (owners.length !== 1) {
        throw new ControllerError("hardening_scope_unattributed", "Release hardening has no unique Ticket scope owner.");
      }
      groups.set(owners[0]!.number, [...(groups.get(owners[0]!.number) ?? []), entry]);
    }
    for (const issue of job.plan.issues) {
      const entries = groups.get(issue.number) ?? [];
      const maxFiles = Math.min(issue.scopeBudget.maxFiles, this.deps.store.config.policy.maxChangedFiles);
      const maxChangedLines = Math.min(issue.scopeBudget.maxChangedLines, this.deps.store.config.policy.maxChangedLines);
      if (entries.some(({ binary }) => binary) || entries.length > maxFiles
        || entries.reduce((total, entry) => total + entry.changedLines, 0) > maxChangedLines) {
        throw new ControllerError("issue_scope_budget_exceeded", `Release hardening exceeds Issue #${issue.number} scope budget.`);
      }
    }
  }

  private assertObservedRiskClasses(
    job: JobState,
    observed: string[],
    issueNumber: number | null,
    detailsPath: string,
  ): void {
    if (!isReleasePlanV2(job.plan)) return;
    const expected = issueNumber === null
      ? [...new Set(job.plan.issues.flatMap((issue) => issue.riskClasses))]
      : job.plan.issues.find((issue) => issue.number === issueNumber)?.riskClasses;
    const unknown = unknownRiskClasses([...(expected ?? []), ...observed]);
    if (unknown.length > 0) {
      throw new ControllerError(
        "unknown_risk_class",
        `The Worker or Release Plan reported unknown risk classes: ${unknown.join(", ")}.`,
        detailsPath,
      );
    }
    if (!expected || !sameStringSet(expected, observed)) {
      throw new ControllerError(
        "issue_risk_class_drift",
        "The Worker reported a risk-class set outside the bound Release Plan v2.",
        detailsPath,
      );
    }
  }

  private issueValidationCommands(
    job: JobState,
    issue: JobState["plan"]["issues"][number],
  ): ValidationCommandConfig[] {
    if (!isReleasePlanV2(job.plan) || !("oracleBindings" in issue)) {
      return dedupeCommands([
        ...this.deps.store.config.validation.issue,
        ...issue.suggestedValidation,
      ]);
    }
    return bindOracleValidationCommands(
      this.deps.store.config.validation.issue,
      this.deps.store.config.validation.release,
      oracleRefs([issue]),
    );
  }

  private releaseValidationCommands(job: JobState): ValidationCommandConfig[] {
    if (!isReleasePlanV2(job.plan)) return this.deps.store.config.validation.release;
    return bindOracleValidationCommands(
      this.deps.store.config.validation.release,
      this.deps.store.config.validation.release,
      oracleRefs(job.plan.issues),
    );
  }

  private requirePassedIssueOracleValidation(
    job: JobState,
    issue: IssueExecution,
    planIssue: JobState["plan"]["issues"][number],
  ): ValidationReceipt | null {
    if (!isReleasePlanV2(job.plan) || !("oracleBindings" in planIssue)) return null;
    const receipt = issue.lastValidationId ? this.readValidation(job, issue.lastValidationId) : null;
    if (!receipt || receipt.scope !== "issue" || receipt.issueNumber !== issue.number || !receipt.passed) {
      throw new ControllerError("issue_oracle_validation_missing", `Issue #${issue.number} has no passed durable Oracle validation receipt.`);
    }
    this.assertOracleValidationCoverage(receipt, oracleRefs([planIssue]), "issue_oracle_validation_missing");
    return receipt;
  }

  private assertOracleValidationCoverage(
    receipt: ValidationReceipt,
    expected: BoundOracleRef[],
    code: string,
  ): void {
    if (expected.length === 0) return;
    assertValidationReceipt(receipt);
    const expectedByKey = new Map(expected.map((entry) => [oracleRefKey(entry), entry.command]));
    const observed = new Set<string>();
    for (const result of receipt.commands) {
      for (const oracle of result.oracles) {
        const key = oracleRefKey(oracle);
        if (!expectedByKey.has(key) || expectedByKey.get(key) !== result.command || observed.has(key)) {
          throw new ControllerError(code, `Validation receipt ${receipt.id} has invalid Oracle command bindings.`);
        }
        observed.add(key);
      }
    }
    if (observed.size !== expectedByKey.size) {
      throw new ControllerError(code, `Validation receipt ${receipt.id} is missing an Oracle command result.`);
    }
    if (receipt.scope === "issue"
      && (receipt.issueNumber === null || expected.some(({ issueNumber }) => issueNumber !== receipt.issueNumber))) {
      throw new ControllerError(code, `Validation receipt ${receipt.id} does not bind the expected Issue.`);
    }
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
    await this.assertIssueWorktreeContract(job, planIssue);

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
    this.checkpointCodexRun(job, execution.record);
    await this.deps.git.assertAgentDidNotCommit(job, baseHeadSha);
    await this.assertIssueWorktreeContract(job, planIssue);
    if (execution.record.exitCode !== 0 || execution.record.signal !== null || execution.record.timedOut
      || execution.record.outputLimitExceeded) {
      this.deps.store.save(job);
      throw new ControllerError("codex_worker_failed", `Codex Worker failed for Issue #${issue.number}.`, execution.record.stderrPath);
    }
    const result = execution.workerResult;
    if (!result) {
      this.deps.store.save(job);
      throw new ControllerError("codex_worker_result_missing", `Codex Worker produced no valid structured result for Issue #${issue.number}.`, execution.record.resultPath);
    }
    this.assertObservedRiskClasses(job, result.observedRiskClasses, planIssue.number, execution.record.resultPath);
    if (result.status === "blocked") {
      issue.status = "blocked";
      this.deps.store.save(job);
      const code = result.blockedKind === "replan_required" ? "codex_worker_replan_required" : "codex_worker_recoverable";
      throw new ControllerError(code, result.blockedReason ?? result.summary, execution.record.resultPath);
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
    await this.assertIssueWorktreeContract(job, planIssue);

    const salvaged = await this.deps.git.salvageIssueCommitAtHead(job, issue.number);
    if (salvaged) {
      const receipt = this.requirePassedIssueOracleValidation(job, issue, planIssue);
      if (receipt && await this.deps.git.commitParent(job, salvaged) !== receipt.candidateSha) {
        throw new ControllerError("issue_oracle_validation_missing", `Issue #${issue.number} salvaged commit is not bound to its Oracle validation candidate.`);
      }
      await this.assertIssueCommitContract(job, planIssue, salvaged);
      issue.status = "committed";
      issue.commitSha = salvaged;
      job.currentIssueNumber = null;
      job.phase = nextPendingIssue(job) ? "implement" : "release_validate";
      this.deps.store.save(job);
      return stepResult("issue_commit_salvaged", true, false, null, `Recovered Controller-owned commit ${salvaged} for Issue #${issue.number}.`);
    }

    const commands = this.issueValidationCommands(job, planIssue);
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
    this.deps.store.save(job);
    this.assertOracleValidationCoverage(validation.receipt, oracleRefs([planIssue]), "issue_oracle_validation_missing");
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

    await this.assertSourceStillCurrent(job, `Issue #${issue.number} commit`);
    this.requirePassedIssueOracleValidation(job, issue, planIssue);
    const commit = await this.deps.git.commitIssue(job, issue.number, issue.snapshot.title, planIssue.allowNoop);
    if (isReleasePlanV2(job.plan) && await this.deps.git.commitParent(job, commit.sha) !== validation.receipt.candidateSha) {
      throw new ControllerError("issue_oracle_validation_missing", `Issue #${issue.number} commit is not bound to its Oracle validation candidate.`);
    }
    await this.assertIssueCommitContract(job, planIssue, commit.sha);
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
    await this.assertReleaseWorktreeContract(job);
    const head = await this.deps.git.head(job.worktreePath);
    const beforeDigest = await this.deps.git.worktreeDigest(job.worktreePath);
    const validation = await this.deps.validator.run({
      job,
      scope: "release",
      issueNumber: null,
      commands: this.releaseValidationCommands(job),
      validationsRoot: this.deps.store.validationsRoot(job.id),
      sourceHeadSha: head,
      sourceWorktreeDigest: beforeDigest,
    });
    appendValidation(job, validation.receipt, validation.path);
    job.candidateSha = head;
    this.deps.store.save(job);
    await this.assertValidationDidNotMutate(job, beforeDigest);
    this.assertOracleValidationCoverage(
      validation.receipt,
      isReleasePlanV2(job.plan) ? oracleRefs(job.plan.issues) : [],
      "release_oracle_validation_missing",
    );
    if (!validation.receipt.passed) {
      return this.scheduleHardening(job, "release-validation", renderValidationFailure(validation.receipt), validation.path);
    }

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
    this.checkpointCodexRun(job, execution.record, execution.reviewResult);
    await this.deps.git.assertAgentDidNotCommit(job, baseHeadSha);
    await this.assertValidationDidNotMutate(job, beforeDigest, "release review");
    if (execution.record.exitCode !== 0 || execution.record.signal !== null || execution.record.timedOut
      || execution.record.outputLimitExceeded || !execution.reviewResult) {
      throw new ControllerError("codex_review_failed", "Fresh release review did not produce a valid result.", execution.record.stderrPath);
    }
    const review = execution.reviewResult;
    if (review.status === "blocked") {
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
      await this.assertReleaseCommitProtected(job, salvaged);
      job.candidateSha = null;
      job.phase = "release_validate";
      job.activeRun = null;
      this.deps.store.save(job);
      return stepResult("hardening_commit_salvaged", true, false, null, `Recovered Controller-owned hardening commit ${salvaged}.`);
    }
    if (!job.hardeningReasonPath || !existsSync(job.hardeningReasonPath)) {
      throw new ControllerError("hardening_reason_missing", "Release hardening has no durable blocking evidence.");
    }
    await this.assertReleaseWorktreeContract(job);
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
    this.checkpointCodexRun(job, execution.record);
    await this.deps.git.assertAgentDidNotCommit(job, baseHeadSha);
    await this.assertReleaseWorktreeContract(job);
    if (execution.record.exitCode !== 0 || execution.record.signal !== null || execution.record.timedOut
      || execution.record.outputLimitExceeded || !execution.workerResult) {
      this.deps.store.save(job);
      throw new ControllerError("codex_hardening_failed", "Release hardening Worker did not complete successfully.", execution.record.stderrPath);
    }
    this.assertObservedRiskClasses(job, execution.workerResult.observedRiskClasses, null, execution.record.resultPath);
    if (execution.workerResult.status === "blocked") {
      this.deps.store.save(job);
      const code = execution.workerResult.blockedKind === "replan_required"
        ? "codex_hardening_replan_required"
        : "codex_hardening_recoverable";
      throw new ControllerError(code, execution.workerResult.blockedReason ?? execution.workerResult.summary, execution.record.resultPath);
    }
    if (!execution.workerResult.selfReview.performed) {
      this.deps.store.save(job);
      throw new ControllerError("hardening_self_review_missing", "Release hardening Worker did not perform self-review.", execution.record.resultPath);
    }
    await this.assertSourceStillCurrent(job, "hardening commit");
    if (await this.deps.git.isClean(job.worktreePath)) {
      this.deps.store.save(job);
      throw new ControllerError("hardening_no_changes", "Release hardening completed without producing a repair diff.", execution.record.resultPath);
    }
    const reason = readFileSync(job.hardeningReasonPath, "utf8");
    const commit = await this.deps.git.commitHardening(job, reason);
    if (!commit.created) throw new ControllerError("hardening_commit_missing", "Hardening changes could not be committed.");
    await this.assertReleaseCommitProtected(job, commit.sha);
    job.candidateSha = null;
    job.phase = "release_validate";
    this.deps.store.save(job);
    return stepResult("release_hardening_committed", true, false, null, `Hardening round ${job.hardeningRounds} committed as ${commit.sha}; full validation will rerun.`);
  }

  private async deliver(job: JobState): Promise<StepResult> {
    if (!job.candidateSha || await this.deps.git.head(job.worktreePath) !== job.candidateSha || !(await this.deps.git.isClean(job.worktreePath))) {
      throw new ControllerError("delivery_candidate_drift", "Delivery requires the exact clean reviewed candidate.");
    }
    const production = this.deps.store.config.executionMode === "release-plan-v2-direct";
    const proof = production ? readCanonicalCandidateProof(job, this.deps.store.config, this.deps.store.root(job.id)) : null;
    await this.assertSourceStillCurrent(job, "delivery push");
    if (!this.deps.store.config.delivery.createPullRequest) {
      job.phase = "complete";
      job.status = "completed";
      this.deps.store.save(job);
      return stepResult("release_completed_without_pr", true, true, null, `Release ${job.id} completed locally at ${job.candidateSha}.`);
    }
    await this.deps.git.push(job);
    await this.assertSourceStillCurrent(job, "pull request creation");
    if (await this.deps.git.head(job.worktreePath) !== job.candidateSha || !(await this.deps.git.isClean(job.worktreePath))) {
      throw new ControllerError("delivery_candidate_drift", "The reviewed candidate changed before pull request creation.");
    }
    if (production) readCanonicalCandidateProof(job, this.deps.store.config, this.deps.store.root(job.id));
    const pullRequest = await this.deps.github.createPullRequest(job, this.deps.store.deliveryRoot(job.id));
    assertPullRequestIdentity(job, pullRequest);
    if (pullRequest.state !== "OPEN") {
      throw new ControllerError("pull_request_identity_mismatch", "Delivery requires an OPEN pull request for the exact candidate.");
    }
    job.pullRequest = pullRequest;
    job.ciGate = null;
    job.deliveryAuthority = proof ? {
      version: 1,
      pullRequest,
      candidateSha: job.candidateSha,
      proofDigest: digestJson(proof),
      status: "pending",
      autoMergeEnabled: false,
      quarantined: false,
      lastVerifiedAt: nowIso(),
      revocationReason: null,
      error: null,
    } : null;
    job.phase = "ci";
    job.status = "running";
    this.deps.store.save(job);
    return stepResult("pull_request_ready", true, false, this.deps.store.config.delivery.pollIntervalMs, `Pull request #${pullRequest.number} created or recovered.`);
  }

  private async observeCi(job: JobState): Promise<StepResult> {
    if (!job.pullRequest || !job.candidateSha) throw new ControllerError("ci_identity_missing", "CI observation has no bound PR or candidate SHA.");
    const observed = await this.deps.github.inspectPullRequest(job.pullRequest.number);
    const merged = observed.pullRequest.state === "MERGED" || observed.mergedAt !== null;
    assertPullRequestIdentity(
      job,
      observed.pullRequest,
      job.pullRequest.number,
      merged ? "merged_candidate_mismatch" : "pull_request_identity_mismatch",
    );
    job.pullRequest = observed.pullRequest;
    if (merged) return this.observeMerged(job, observed.checks, observed.mergedAt);
    if (observed.pullRequest.state === "CLOSED") throw new ControllerError("pull_request_closed", "The release pull request was closed without merge.");
    if (observed.pullRequest.state !== "OPEN") throw new ControllerError("pull_request_identity_mismatch", "Observed pull request state is invalid.");
    await this.assertSourceStillCurrent(job, "CI observation");
    if (requiredCheckContract(this.deps.store.config)) {
      return this.observeContractCi(job, observed.checks);
    }
    const required = requiredCheckProblems(observed.checks, requiredCheckNames(this.deps.store.config));
    if (required.failures.length > 0) {
      if (job.ciRepairRounds >= (this.deps.store.config.policy.maxCiRepairRounds ?? 0)) {
        const path = this.writeReason(job, "required-check-failure", JSON.stringify(observed.checks, null, 2));
        this.deps.store.save(job);
        throw new ControllerError("required_check_failed", "A required pull request check failed.", path);
      }
      return this.scheduleHardening(job, "required-check-failure", JSON.stringify(observed.checks, null, 2), null);
    }
    if (required.missing.length > 0) {
      this.deps.store.save(job);
      return stepResult("required_check_missing", false, false, this.deps.store.config.delivery.pollIntervalMs, `Waiting for required checks: ${required.missing.join(", ")}.`);
    }
    if (required.pending.length > 0) {
      this.deps.store.save(job);
      return stepResult("required_check_pending", false, false, this.deps.store.config.delivery.pollIntervalMs, `Waiting for required checks: ${required.pending.map(({ name }) => name).join(", ")}.`);
    }
    if (observed.checks.state === "failure") {
      if (job.ciRepairRounds >= (this.deps.store.config.policy.maxCiRepairRounds ?? 0)) {
        const path = this.writeReason(job, "ci-failure", JSON.stringify(observed.checks, null, 2));
        this.deps.store.save(job);
        throw new ControllerError("ci_failed", "Pull request checks failed after the allowed CI repair rounds.", path);
      }
      return this.scheduleHardening(job, "ci-failure", JSON.stringify(observed.checks, null, 2), null);
    }
    if (observed.checks.state === "pending" || (observed.checks.state === "none" && !this.deps.store.config.delivery.allowNoChecks)) {
      this.deps.store.save(job);
      return stepResult("ci_pending", false, false, this.deps.store.config.delivery.pollIntervalMs, "Waiting for GitHub checks.");
    }
    if (this.deps.store.config.delivery.autoMerge) {
      if (!(await this.deps.github.baseAllowsUpToDateAutoMerge())) {
        throw new ControllerError(
          "base_up_to_date_policy_unverified",
          "Auto-merge requires branch protection or an active ruleset that requires pull requests and every configured required check on the latest base. Configure that server-side policy, or set autoMerge=false and merge manually.",
        );
      }
      await this.assertSourceStillCurrent(job, "auto-merge enablement");
      if (await this.deps.git.head(job.worktreePath) !== job.candidateSha || !(await this.deps.git.isClean(job.worktreePath))) {
        throw new ControllerError("delivery_candidate_drift", "The reviewed candidate changed before auto-merge authorization.");
      }
      await this.deps.github.enableAutoMerge(job.pullRequest.number, job.candidateSha);
      job.status = "running";
    } else {
      await this.assertSourceStillCurrent(job, "ready-to-merge transition");
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

  private async observeContractCi(job: JobState, checks: GhCheckSummary): Promise<StepResult> {
    const contract = requiredCheckContract(this.deps.store.config);
    if (!contract || !job.candidateSha || !job.pullRequest) throw new ControllerError("ci_contract_missing", "Production CI has no exact check contract or candidate identity.");
    const now = nowIso();
    const contractDigest = digestJson(contract);
    if (!job.ciGate || job.ciGate.candidateSha !== job.candidateSha || job.ciGate.checkContractDigest !== contractDigest) {
      job.ciGate = {
        version: 1,
        candidateSha: job.candidateSha,
        checkContractDigest: contractDigest,
        firstObservedAt: now,
        firstAppearanceDeadlineAt: addMilliseconds(now, contract.firstAppearanceTimeoutMs),
        pendingDeadlineAt: null,
        postMergeDeadlineAt: null,
        attempts: 0,
        lastObservation: null,
      };
    }
    job.ciGate.attempts += 1;
    job.ciGate.lastObservation = checks;
    this.deps.store.save(job);

    if ((checks.ambiguous ?? []).length > 0) {
      const path = this.writeCiObservation(job, "ambiguous", checks);
      throw new ControllerError("required_check_identity_ambiguous", "Required check identity is ambiguous.", path);
    }

    const observations = checks.observations ?? [];
    const failed = checks.failures.flatMap(({ name }) => observations.filter((entry) => entry.name === name));
    const infrastructure = failed.filter((entry) => isInfrastructureConclusion(entry.conclusion));
    const codeFailures = failed.filter((entry) => isCodeConclusion(entry.conclusion));
    const configuration = failed.filter((entry) => !isInfrastructureConclusion(entry.conclusion) && !isCodeConclusion(entry.conclusion));
    if (configuration.length > 0) {
      const path = this.writeCiObservation(job, "configuration", checks);
      throw new ControllerError("required_check_configuration_invalid", "A required check produced a non-accepted conclusion that is not code-repairable.", path);
    }
    if (infrastructure.length > 0) {
      const maximum = this.deps.store.config.policy.maxCiInfrastructureReruns ?? 0;
      if (job.ciInfrastructureReruns >= maximum) {
        const path = this.writeCiObservation(job, "infrastructure-exhausted", checks);
        throw new ControllerError("ci_infrastructure_exhausted", "Required check infrastructure retries are exhausted.", path);
      }
      job.ciInfrastructureReruns += 1;
      this.deps.store.save(job);
      try {
        for (const check of infrastructure) await this.deps.github.rerunCheck(check, job.candidateSha);
      } catch {
        const path = this.writeCiObservation(job, "infrastructure-evidence-insufficient", checks);
        throw new ControllerError("ci_infrastructure_evidence_insufficient", "The exact infrastructure run could not be safely rerun.", path);
      }
      return stepResult("ci_infrastructure_rerun", true, false, this.deps.store.config.delivery.pollIntervalMs, "Required check infrastructure rerun requested without changing code.");
    }
    if (codeFailures.length > 0) {
      const maximum = this.deps.store.config.policy.maxCiCodeRepairRounds ?? 0;
      if (job.ciCodeRepairRounds >= maximum) {
        const path = this.writeCiObservation(job, "code-repair-exhausted", checks);
        throw new ControllerError("ci_code_repair_exhausted", "Required check code repair rounds are exhausted.", path);
      }
      let evidence;
      try {
        evidence = await Promise.all(codeFailures.map((check) => this.deps.github.fetchCheckFailureEvidence(check, job.candidateSha!)));
      } catch {
        const path = this.writeCiObservation(job, "code-evidence-insufficient", checks);
        throw new ControllerError("ci_code_evidence_insufficient", "Exact bounded failing check evidence is unavailable; code hardening is forbidden.", path);
      }
      const evidencePath = join(this.deps.store.root(job.id), `ci-code-evidence-${String(job.ciGate.attempts).padStart(3, "0")}.json`);
      writeJsonAtomic(evidencePath, { version: 1, candidateSha: job.candidateSha, contractDigest, evidence });
      job = await this.revokeDeliveryAuthority(job, "ci_code_repair");
      job.pullRequest = null;
      job.ciGate = null;
      this.deps.store.save(job);
      return this.scheduleHardening(job, "ci-code", JSON.stringify(evidence, null, 2), evidencePath);
    }
    if (checks.missing.length > 0) {
      if (deadlineExpired(job.ciGate.firstAppearanceDeadlineAt, now)) {
        const path = this.writeCiObservation(job, "missing-deadline", checks);
        throw new ControllerError("required_check_missing_deadline", "Required checks did not appear before the durable deadline.", path);
      }
      return stepResult("required_check_missing", false, false, this.deps.store.config.delivery.pollIntervalMs, `Waiting for required checks: ${checks.missing.join(", ")}.`);
    }
    if (checks.pending.length > 0) {
      job.ciGate.pendingDeadlineAt ??= addMilliseconds(now, contract.pendingTimeoutMs);
      this.deps.store.save(job);
      if (deadlineExpired(job.ciGate.pendingDeadlineAt, now)) {
        const path = this.writeCiObservation(job, "pending-deadline", checks);
        throw new ControllerError("required_check_pending_deadline", "Required checks did not finish before the durable deadline.", path);
      }
      return stepResult("required_check_pending", false, false, this.deps.store.config.delivery.pollIntervalMs, `Waiting for required checks: ${checks.pending.map(({ name }) => name).join(", ")}.`);
    }

    const proof = readCanonicalCandidateProof(job, this.deps.store.config, this.deps.store.root(job.id));
    if (!(await this.deps.github.baseAllowsUpToDateAutoMerge())) {
      throw new ControllerError("base_up_to_date_policy_unverified", "Controller auto-merge requires strict server-side latest-base and required-check policy.");
    }
    await this.assertSourceStillCurrent(job, "auto-merge authorization");
    if (await this.deps.git.head(job.worktreePath) !== job.candidateSha || !(await this.deps.git.isClean(job.worktreePath))) {
      throw new ControllerError("delivery_candidate_drift", "The reviewed candidate changed before auto-merge authorization.");
    }
    job = await this.authorizeDelivery(job, digestJson(proof));
    job.status = "running";
    job.phase = "awaiting_merge";
    this.deps.store.save(job);
    return stepResult("auto_merge_enabled", true, false, this.deps.store.config.delivery.pollIntervalMs, "Required checks passed; exact-head Controller auto-merge is authorized.");
  }

  private async observeMerge(job: JobState): Promise<StepResult> {
    if (!job.pullRequest || !job.candidateSha) throw new ControllerError("merge_identity_missing", "Merge observation has no bound PR or candidate SHA.");
    const observed = await this.deps.github.inspectPullRequest(job.pullRequest.number);
    const merged = observed.pullRequest.state === "MERGED" || observed.mergedAt !== null;
    assertPullRequestIdentity(
      job,
      observed.pullRequest,
      job.pullRequest.number,
      merged ? "merged_candidate_mismatch" : "pull_request_identity_mismatch",
    );
    job.pullRequest = observed.pullRequest;
    if (merged) return this.observeMerged(job, observed.checks, observed.mergedAt);
    if (observed.pullRequest.state === "CLOSED") throw new ControllerError("pull_request_closed", "The release pull request was closed without merge.");
    if (observed.pullRequest.state !== "OPEN") throw new ControllerError("pull_request_identity_mismatch", "Observed pull request state is invalid.");
    await this.assertSourceStillCurrent(job, "merge observation");
    if (this.deps.store.config.executionMode === "release-plan-v2-direct") {
      readCanonicalCandidateProof(job, this.deps.store.config, this.deps.store.root(job.id));
    }
    job.status = this.deps.store.config.delivery.autoMerge ? "running" : "ready_to_merge";
    this.deps.store.save(job);
    return stepResult("awaiting_merge", false, !this.deps.store.config.delivery.autoMerge, this.deps.store.config.delivery.autoMerge ? this.deps.store.config.delivery.pollIntervalMs : null, "Waiting for the exact candidate PR to merge.");
  }

  private async observeMerged(job: JobState, checks: GhCheckSummary, mergedAt: string | null): Promise<StepResult> {
    if (!job.pullRequest || job.pullRequest.state !== "MERGED") {
      throw new ControllerError("merged_candidate_mismatch", "GitHub merge state is inconsistent with the observed pull request.");
    }
    const contract = requiredCheckContract(this.deps.store.config);
    if (contract) {
      if (!job.deliveryAuthority
        || !["authorizing", "authorized"].includes(job.deliveryAuthority.status)
        || job.deliveryAuthority.candidateSha !== job.candidateSha) {
        throw new ControllerError("merged_without_controller_authority", "The candidate merged without a valid Controller-owned authority checkpoint.");
      }
      const proof = readCanonicalCandidateProof(job, this.deps.store.config, this.deps.store.root(job.id));
      if (job.deliveryAuthority.proofDigest !== digestJson(proof)) {
        throw new ControllerError("merged_without_controller_authority", "The candidate merged without a valid Controller-owned authority checkpoint.");
      }
      const now = nowIso();
      const contractDigest = digestJson(contract);
      job.ciGate ??= {
        version: 1,
        candidateSha: job.candidateSha!,
        checkContractDigest: contractDigest,
        firstObservedAt: now,
        firstAppearanceDeadlineAt: addMilliseconds(now, contract.firstAppearanceTimeoutMs),
        pendingDeadlineAt: null,
        postMergeDeadlineAt: addMilliseconds(now, contract.postMergeTimeoutMs),
        attempts: 0,
        lastObservation: null,
      };
      if (job.ciGate.candidateSha !== job.candidateSha || job.ciGate.checkContractDigest !== contractDigest) {
        throw new ControllerError("ci_contract_drift", "Merged check evidence does not match the candidate-bound contract.");
      }
      job.ciGate.attempts += 1;
      job.ciGate.lastObservation = checks;
      job.ciGate.postMergeDeadlineAt ??= addMilliseconds(now, contract.postMergeTimeoutMs);
      this.deps.store.save(job);
      if ((checks.ambiguous ?? []).length > 0 || checks.failures.length > 0) {
        const path = this.writeCiObservation(job, "post-merge-invalid", checks);
        throw new ControllerError("post_merge_required_check_invalid", "Merged required check evidence is ambiguous or failed.", path);
      }
      if (checks.missing.length > 0 || checks.pending.length > 0) {
        if (deadlineExpired(job.ciGate.postMergeDeadlineAt, now)) {
          const path = this.writeCiObservation(job, "post-merge-deadline", checks);
          throw new ControllerError("post_merge_check_deadline", "Merged required check evidence did not complete before the durable deadline.", path);
        }
        return stepResult("post_merge_checks_pending", true, false, this.deps.store.config.delivery.pollIntervalMs, "Merged candidate is waiting for exact required check evidence.");
      }
    }
    const required = requiredCheckProblems(checks, requiredCheckNames(this.deps.store.config));
    if (required.failures.length > 0) {
      throw new ControllerError("required_check_failed", "A merged pull request has a failed required check.");
    }
    if (required.missing.length > 0 || required.pending.length > 0) {
      this.deps.store.save(job);
      const missing = required.missing.length > 0;
      return stepResult(
        missing ? "required_check_missing" : "required_check_pending",
        true,
        false,
        this.deps.store.config.delivery.pollIntervalMs,
        `Merged candidate is not complete until required checks are ${missing ? "present" : "successful"}.`,
      );
    }
    if (mergedAt === null || !job.pullRequest.mergeSha) {
      throw new ControllerError("merge_commit_missing", "GitHub reports a merged pull request without a durable merge commit identity.");
    }
    this.assertCurrentInputs(job);
    if (isReleasePlanV2(job.plan)) {
      await this.fetchCurrentSourceIssues(job, "merge completion");
      await this.assertOracleBindingsAtBase(job.plan);
    }
    try {
      await this.deps.git.fetchBase();
      if (!(await this.deps.git.isAncestorOfRemoteBase(job.pullRequest.mergeSha))) {
        throw new Error("merge commit is not on the current remote base");
      }
      if (isReleasePlanV2(job.plan)) {
        const result = await this.deps.git.verifyMergeResult({
          mergeSha: job.pullRequest.mergeSha,
          candidateSha: job.candidateSha!,
          baseSha: job.plan.source.baseSha,
          mergeMethod: this.deps.store.config.delivery.mergeMethod,
        });
        if (result === "base_mismatch") {
          throw new ControllerError(
            "runtime_source_base_drift",
            "The merged candidate was not applied to the Release Plan v2 source base.",
          );
        }
        if (result === "candidate_mismatch") {
          throw new ControllerError("merged_candidate_mismatch", "The merge result does not reproduce the exact reviewed candidate.");
        }
      }
    } catch (error) {
      if (error instanceof ControllerError) throw error;
      throw new ControllerError("merge_commit_unverified", "The merge commit cannot be read from Git or is not an ancestor of the current remote base.");
    }
    if (isReleasePlanV2(job.plan)
      && this.deps.store.config.executionMode === "release-plan-v2-direct"
      && this.deps.store.config.review.enabled) {
      if (job.deliveryAuthority) {
        job.deliveryAuthority = {
          ...job.deliveryAuthority,
          pullRequest: job.pullRequest,
          status: "consumed",
          autoMergeEnabled: false,
          lastVerifiedAt: nowIso(),
        };
      }
      job.completion = createCompletionEvidence({
        job,
        config: this.deps.store.config,
        jobRoot: this.deps.store.root(job.id),
        mergedAt,
        mergedMainSha: job.pullRequest.mergeSha,
      });
      if (job.provenance.version === 3) {
        job.publicCompletion = createPublicCompletionCheckpoint({
          job,
          config: this.deps.store.config,
          jobRoot: this.deps.store.root(job.id),
        });
      }
    }
    job.status = "completed";
    job.phase = "complete";
    job.blocked = null;
    this.deps.store.save(job);
    return stepResult("release_merged", true, true, null, `Release ${job.id} was merged.`);
  }

  private checkpointCodexRun(
    job: JobState,
    record: CodexRunRecord,
    reviewResult: ReviewResult | null = null,
  ): void {
    job.activeRun = null;
    job.runs.push(record);
    if (reviewResult) {
      job.reviewRound += 1;
      job.lastReviewPath = record.resultPath;
    }
    this.deps.store.save(job);
  }

  private async authorizeDelivery(job: JobState, proofDigest: string): Promise<JobState> {
    if (!job.pullRequest || !job.candidateSha || !job.deliveryAuthority
      || job.deliveryAuthority.candidateSha !== job.candidateSha
      || job.deliveryAuthority.proofDigest !== proofDigest) {
      throw new ControllerError("delivery_authority_identity_invalid", "Merge authority does not bind the exact candidate proof.");
    }
    job.deliveryAuthority.status = "authorizing";
    job.deliveryAuthority.lastVerifiedAt = nowIso();
    this.deps.store.save(job);
    let observed = await this.deps.github.inspectPullRequest(job.pullRequest.number);
    assertPullRequestIdentity(job, observed.pullRequest, job.pullRequest.number);
    if (observed.pullRequest.state !== "OPEN") throw new ControllerError("delivery_authority_identity_invalid", "Only the exact OPEN candidate can receive merge authority.");
    if (!observed.autoMergeEnabled) {
      await this.deps.github.enableAutoMerge(job.pullRequest.number, job.candidateSha);
      observed = await this.deps.github.inspectPullRequest(job.pullRequest.number);
      assertPullRequestIdentity(job, observed.pullRequest, job.pullRequest.number);
    }
    if (!observed.autoMergeEnabled || observed.pullRequest.state !== "OPEN") {
      throw new ControllerError("delivery_authority_enable_unverified", "GitHub did not read back exact-head auto-merge authority.");
    }
    job.pullRequest = observed.pullRequest;
    job.deliveryAuthority = {
      ...job.deliveryAuthority,
      pullRequest: observed.pullRequest,
      status: "authorized",
      autoMergeEnabled: true,
      quarantined: false,
      lastVerifiedAt: nowIso(),
      revocationReason: null,
      error: null,
    };
    this.deps.store.save(job);
    return job;
  }

  private async revokeDeliveryAuthority(job: JobState, reason: string): Promise<JobState> {
    if (!job.pullRequest || !job.candidateSha || job.pullRequest.state !== "OPEN") return job;
    const authority = job.deliveryAuthority ?? {
      version: 1 as const,
      pullRequest: job.pullRequest,
      candidateSha: job.candidateSha,
      proofDigest: digestJson({ candidateSha: job.candidateSha, pullRequest: job.pullRequest }),
      status: "pending" as const,
      autoMergeEnabled: false,
      quarantined: false,
      lastVerifiedAt: nowIso(),
      revocationReason: null,
      error: null,
    };
    job.deliveryAuthority = { ...authority, status: "revocation_required", revocationReason: reason, error: null };
    this.deps.store.save(job);
    try {
      let observed = await this.deps.github.inspectPullRequest(job.pullRequest.number);
      assertPullRequestIdentity(job, observed.pullRequest, job.pullRequest.number, "delivery_authority_identity_invalid");
      if (observed.pullRequest.state === "MERGED") throw new Error("the candidate merged before authority revocation completed");
      if (observed.autoMergeEnabled) {
        await this.deps.github.disableAutoMerge(job.pullRequest.number, job.candidateSha);
        observed = await this.deps.github.inspectPullRequest(job.pullRequest.number);
        assertPullRequestIdentity(job, observed.pullRequest, job.pullRequest.number, "delivery_authority_identity_invalid");
        if (observed.autoMergeEnabled) throw new Error("auto-merge remains enabled");
      }
      job.pullRequest = observed.pullRequest;
      job.deliveryAuthority = { ...job.deliveryAuthority, pullRequest: observed.pullRequest, autoMergeEnabled: false, lastVerifiedAt: nowIso() };
      this.deps.store.save(job);
      await this.deps.git.quarantineRemoteBranch(job, job.candidateSha);
      job.deliveryAuthority = {
        ...job.deliveryAuthority,
        status: "revoked",
        autoMergeEnabled: false,
        quarantined: true,
        lastVerifiedAt: nowIso(),
        error: null,
      };
      this.deps.store.save(job);
      return job;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.deliveryAuthority = { ...job.deliveryAuthority, status: "revocation_failed", error: message.slice(0, 4_000), lastVerifiedAt: nowIso() };
      this.deps.store.save(job);
      throw new ControllerError("delivery_authority_revocation_failed", `Merge authority could not be safely revoked: ${message}`);
    }
  }

  private writeCiObservation(job: JobState, kind: string, checks: GhCheckSummary): string {
    const path = join(this.deps.store.root(job.id), `ci-${String(job.ciGate?.attempts ?? 0).padStart(3, "0")}-${kind}.json`);
    writeJsonAtomic(path, { version: 1, candidateSha: job.candidateSha, ciGate: job.ciGate, checks });
    return path;
  }

  private scheduleHardening(
    job: JobState,
    kind: string,
    evidence: string,
    detailsPath: string | null,
  ): StepResult {
    const policy = this.deps.store.config.policy;
    const category = kind === "release-validation" ? "validation"
      : kind === "release-review" ? "review"
        : kind === "ci-code" ? "ci"
          : "legacy-ci";
    const used = category === "validation" ? job.releaseValidationRepairRounds
      : category === "review" ? job.reviewRepairRounds
        : category === "ci" ? job.ciCodeRepairRounds
          : job.ciRepairRounds;
    const maximum = category === "validation" ? (policy.maxReleaseValidationRepairRounds ?? policy.maxReleaseHardeningRounds ?? 0)
      : category === "review" ? (policy.maxReviewRepairRounds ?? policy.maxReleaseHardeningRounds ?? 0)
        : category === "ci" ? (policy.maxCiCodeRepairRounds ?? policy.maxCiRepairRounds ?? 0)
          : (policy.maxCiRepairRounds ?? 0);
    if (used >= maximum) {
      const code = category === "ci" || category === "legacy-ci" ? "ci_code_repair_exhausted" : "release_hardening_exhausted";
      const message = "Release requires another hardening round beyond the configured limit.";
      const blocked = blockJob(job, code, message, detailsPath);
      this.deps.store.save(blocked);
      return stepResult("blocked", true, true, null, `${blocked.blocked!.code}: ${blocked.blocked!.message}`);
    }
    if (category === "validation") job.releaseValidationRepairRounds += 1;
    else if (category === "review") job.reviewRepairRounds += 1;
    else if (category === "ci") job.ciCodeRepairRounds += 1;
    else if (category === "legacy-ci") job.ciRepairRounds += 1;
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
  expectedNumber: number | null = null,
  code = "pull_request_identity_mismatch",
): void {
  if (!job.candidateSha
    || (expectedNumber !== null && pullRequest.number !== expectedNumber)
    || pullRequest.headSha !== job.candidateSha
    || pullRequest.headRef !== job.branch
    || pullRequest.baseRef !== job.baseRef) {
    throw new ControllerError(
      code,
      "Observed pull request does not bind the exact PR number, release branch, base branch, and candidate SHA.",
    );
  }
}

function requiredCheckProblems(checks: GhCheckSummary, requiredChecks: string[]): {
  missing: string[];
  failures: GhCheckSummary["failures"];
  pending: GhCheckSummary["pending"];
} {
  const required = new Set(requiredChecks);
  return {
    missing: checks.missing ?? requiredChecks,
    failures: checks.failures.filter(({ name }) => required.has(name)),
    pending: checks.pending.filter(({ name }) => required.has(name)),
  };
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

type BoundOracleRef = OracleExecutionRef & { command: string };

function oracleRefs(issues: JobState["plan"]["issues"]): BoundOracleRef[] {
  return issues.flatMap((issue) => "oracleBindings" in issue
    ? issue.oracleBindings.map((binding) => ({
      issueNumber: issue.number,
      oracleId: binding.id,
      command: binding.execution.command,
    }))
    : []);
}

function bindOracleValidationCommands(
  ordinary: CommandConfig[],
  release: CommandConfig[],
  bindings: BoundOracleRef[],
): ValidationCommandConfig[] {
  const grouped = new Map<string, OracleExecutionRef[]>();
  for (const { command, ...oracle } of bindings) {
    grouped.set(command, [...(grouped.get(command) ?? []), oracle]);
  }
  const oracleCommands = [...grouped].map(([command, oracles]) => {
    const matches = release.filter((entry) => entry.command === command);
    if (matches.length !== 1) {
      throw new ControllerError(
        matches.length === 0 ? "oracle_validation_command_missing" : "oracle_validation_command_ambiguous",
        `Oracle command ${command} must have one exact config.validation.release definition.`,
      );
    }
    return { ...matches[0]!, oracles };
  });
  const oracleNames = new Set(grouped.keys());
  return [
    ...oracleCommands,
    ...dedupeCommands(ordinary.filter(({ command }) => !oracleNames.has(command))),
  ];
}

function oracleRefKey(value: OracleExecutionRef): string {
  return `${value.issueNumber}:${value.oracleId}`;
}

function sameStringSet(left: string[], right: string[]): boolean {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

function owningIssues(issues: ReleasePlanIssueV2[], path: string): ReleasePlanIssueV2[] {
  return issues.filter((issue) => issue.expectedPaths.some((pattern) => expectedPathMatches(pattern, path)));
}

function expectedPathMatches(pattern: string, path: string): boolean {
  if (pattern.split("/", 1)[0]?.includes("*")) return false;
  const source = pattern.split("*").map((part) => part.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&")).join("[^/]*");
  return new RegExp(`^${source}$`, "u").test(path);
}

function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function deadlineExpired(deadline: string, now: string): boolean {
  return Date.parse(now) >= Date.parse(deadline);
}

function isInfrastructureConclusion(value: string): boolean {
  return ["ERROR", "CANCELLED", "TIMED_OUT", "STARTUP_FAILURE", "STALE"].includes(value);
}

function isCodeConclusion(value: string): boolean {
  return value === "FAILURE" || value === "ACTION_REQUIRED";
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

function stepResult(action: string, progressed: boolean, terminal: boolean, retryAfterMs: number | null, message: string): StepResult {
  return { action, progressed, terminal, retryAfterMs, message };
}
