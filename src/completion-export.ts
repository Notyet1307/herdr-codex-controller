import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { validateReviewResult } from "./codex.js";
import { ControllerError } from "./errors.js";
import { readJsonFile, writePublicJsonAtomic } from "./fs-atomic.js";
import { isReleasePlanV2 } from "./plan.js";
import { assertControllerProvenance } from "./provenance.js";
import type { GitHubPort, GitPort } from "./ports.js";
import type { JobStore } from "./state.js";
import type {
  ControllerConfig,
  JobCompletionEvidence,
  JobState,
  ReleaseCompletionV1,
  ReleaseCompletionV2,
  ReviewResult,
  ValidationReceipt,
} from "./types.js";
import { digestJson, nowIso, pathWithin } from "./util.js";
import { assertValidationReceipt } from "./validator.js";

const SHA = /^[a-f0-9]{40}$/;
const HEX = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function createCompletionEvidence(input: {
  job: JobState;
  config: ControllerConfig;
  jobRoot: string;
  mergedAt: string;
  mergedMainSha: string;
}): JobCompletionEvidence {
  const proof = privateCompletionProof(input.job, input.config, input.jobRoot);
  const mergedAt = canonicalIso(input.mergedAt);
  if (!input.job.pullRequest?.mergeSha || !mergedAt || !SHA.test(input.mergedMainSha)) {
    throw new ControllerError("completion_evidence_invalid", "Merged completion evidence is incomplete.");
  }
  const body = {
    version: 1 as const,
    planDigest: input.job.planDigest,
    controllerProvenanceDigest: input.job.provenance.digest,
    sourceBaseSha: proof.sourceBaseSha,
    candidateSha: input.job.candidateSha!,
    issueCommits: proof.issueCommits,
    releaseValidationDigest: proof.releaseValidationDigest,
    reviewResultDigest: proof.reviewResultDigest,
    pullRequest: {
      number: input.job.pullRequest.number,
      headRef: input.job.pullRequest.headRef,
      baseRef: input.job.pullRequest.baseRef,
      headSha: input.job.pullRequest.headSha,
      mergeSha: input.job.pullRequest.mergeSha,
      mergedAt,
    },
    mergedMainSha: input.mergedMainSha,
    requiredChecks: [...input.config.delivery.requiredChecks],
    dependencyHandoffDigests: [...proof.dependencyHandoffDigests],
    completedAt: nowIso(),
  };
  return { ...body, digest: digestJson(body) };
}

export async function exportReleaseCompletion(input: {
  store: JobStore;
  git: GitPort;
  github: GitHubPort;
  jobId: string;
  outputPath: string;
}): Promise<ReleaseCompletionV2> {
  const job = input.store.load(input.jobId);
  if (job.status !== "completed" || job.phase !== "complete" || !job.completion) {
    throw new ControllerError("completion_export_not_completed", "The Job has no verified merged completion checkpoint.");
  }
  const config = input.store.config;
  const proof = privateCompletionProof(job, config, input.store.root(job.id));
  assertCompletionEvidence(job.completion, job, proof, config);
  if (input.store.currentProvenance(job.plan).digest !== job.provenance.digest) {
    throw new ControllerError("completion_export_provenance_drift", "Controller provenance differs from the completed Job.");
  }

  let observed;
  try { observed = await input.github.inspectPullRequest(job.completion.pullRequest.number); }
  catch { throw new ControllerError("completion_export_pr_identity_invalid", "The completed pull request cannot be verified."); }
  const pullRequest = observed.pullRequest;
  const expected = job.completion.pullRequest;
  if (pullRequest.state !== "MERGED" || canonicalIso(observed.mergedAt) !== expected.mergedAt
    || pullRequest.number !== expected.number || pullRequest.headRef !== expected.headRef
    || pullRequest.baseRef !== expected.baseRef || pullRequest.headSha !== expected.headSha
    || pullRequest.mergeSha !== expected.mergeSha) {
    throw new ControllerError("completion_export_pr_identity_invalid", "GitHub no longer reports the exact completed pull request identity.");
  }
  const required = new Set(job.completion.requiredChecks);
  if (observed.checks.missing.length > 0
    || observed.checks.pending.some(({ name }) => required.has(name))
    || observed.checks.failures.some(({ name }) => required.has(name))) {
    throw new ControllerError("completion_export_required_checks_unverified", "Required pull request checks are not all present and successful.");
  }

  try {
    for (const commit of proof.issueCommits) {
      if (!(await input.git.verifyIssueCommit({
        jobId: job.id,
        planDigest: job.planDigest,
        issueNumber: commit.issueNumber,
        sha: commit.sha,
        candidateSha: job.completion.candidateSha,
      }))) {
        throw new Error(`Issue #${commit.issueNumber} commit is not bound to the candidate`);
      }
    }
  } catch {
    throw new ControllerError("completion_export_issue_commit_invalid", "Issue commits are not exact Controller-owned ancestors of the completed candidate.");
  }

  try {
    const currentBase = await input.git.fetchBase();
    if (!(await input.git.isAncestorOfRemoteBase(expected.mergeSha))) throw new Error("merge ancestry mismatch");
    const result = await input.git.verifyMergeResult({
      mergeSha: expected.mergeSha,
      candidateSha: job.completion.candidateSha,
      baseSha: job.completion.sourceBaseSha,
      mergeMethod: config.delivery.mergeMethod,
    });
    if (result !== "verified" || !SHA.test(currentBase)) throw new Error("merge result mismatch");
  } catch {
    throw new ControllerError("completion_export_merge_unverified", "The completed merge cannot be verified against the current remote base.");
  }

  const body = {
    schema: "herdr-codex-controller:release-completion:v2" as const,
    releaseId: job.id,
    repo: job.repo,
    baseRef: job.baseRef,
    planDigest: job.planDigest,
    sourceBaseSha: proof.sourceBaseSha,
    candidateSha: job.completion.candidateSha,
    issueCommits: proof.issueCommits,
    releaseValidationDigest: proof.releaseValidationDigest,
    reviewResultDigest: proof.reviewResultDigest,
    pullRequest: { ...job.completion.pullRequest },
    requiredChecks: [...job.completion.requiredChecks],
    mergedMainSha: job.completion.mergedMainSha,
    dependencyHandoffDigests: [...proof.dependencyHandoffDigests],
    controllerProvenance: job.provenance,
    completedAt: job.completion.completedAt,
  };
  const artifact: ReleaseCompletionV2 = { ...body, digest: `sha256:${digestJson(body)}` };
  assertReleaseCompletion(artifact);
  const output = resolve(input.outputPath);
  if (pathWithin(config.stateDir, output)) {
    throw new ControllerError("completion_export_output_private_path", "Completion export must be outside Controller private state.");
  }
  try { writePublicJsonAtomic(output, artifact); }
  catch (error) {
    throw new ControllerError(
      error instanceof Error && error.message.includes("conflicts")
        ? "completion_export_output_conflict"
        : "completion_export_output_invalid",
      "Completion export output is unsafe or conflicts with existing bytes.",
    );
  }
  return artifact;
}

export function assertReleaseCompletion(value: ReleaseCompletionV1 | ReleaseCompletionV2): void {
  const object = recordOrNull(value);
  const pullRequest = recordOrNull(value?.pullRequest);
  const provenance = recordOrNull(value?.controllerProvenance);
  const controller = recordOrNull(value?.controllerProvenance?.controller);
  const releasePlan = recordOrNull(value?.controllerProvenance?.releasePlan);
  if (!object || !pullRequest || !provenance || !controller || !releasePlan
    || !Array.isArray(value.issueCommits) || !Array.isArray(value.requiredChecks)
    || !Array.isArray(value.dependencyHandoffDigests)) {
    throw new ControllerError("completion_export_artifact_invalid", "Release completion artifact is invalid.");
  }
  const keys = [
    "baseRef", "candidateSha", "completedAt", "controllerProvenance", "dependencyHandoffDigests", "digest",
    "issueCommits", "mergedMainSha", "planDigest", "pullRequest", "releaseId", "releaseValidationDigest",
    "repo", "requiredChecks", "reviewResultDigest", "schema", "sourceBaseSha",
  ];
  if (!exactKeys(object, keys)
    || (value.schema !== "herdr-codex-controller:release-completion:v1"
      && value.schema !== "herdr-codex-controller:release-completion:v2")
    || typeof value.releaseId !== "string" || !/^[a-z0-9._-]{1,80}$/.test(value.releaseId)
    || typeof value.repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repo)
    || typeof value.baseRef !== "string" || value.baseRef.length < 1 || value.baseRef.length > 300
    || typeof value.planDigest !== "string" || typeof value.sourceBaseSha !== "string"
    || typeof value.candidateSha !== "string" || typeof value.releaseValidationDigest !== "string"
    || typeof value.reviewResultDigest !== "string" || typeof value.mergedMainSha !== "string"
    || typeof value.completedAt !== "string" || typeof value.digest !== "string"
    || !HEX.test(value.planDigest) || !SHA.test(value.sourceBaseSha)
    || !SHA.test(value.candidateSha) || !HEX.test(value.releaseValidationDigest)
    || !HEX.test(value.reviewResultDigest) || !SHA.test(value.mergedMainSha)
    || !canonicalTime(value.completedAt) || !DIGEST.test(value.digest)
    || value.issueCommits.length === 0 || value.issueCommits.length > 50
    || value.issueCommits.some((commit) => !recordOrNull(commit)
      || !exactKeys(commit as unknown as Record<string, unknown>, ["issueNumber", "sha"])
      || !Number.isSafeInteger(commit.issueNumber) || commit.issueNumber < 1
      || typeof commit.sha !== "string" || !SHA.test(commit.sha))
    || new Set(value.issueCommits.map(({ issueNumber }) => issueNumber)).size !== value.issueCommits.length
    || value.requiredChecks.length === 0 || value.requiredChecks.length > 100
    || new Set(value.requiredChecks).size !== value.requiredChecks.length
    || value.requiredChecks.some((name) => typeof name !== "string" || name.length < 1 || name.length > 500)
    || value.dependencyHandoffDigests.length > 100
    || new Set(value.dependencyHandoffDigests).size !== value.dependencyHandoffDigests.length
    || value.dependencyHandoffDigests.some((digest) => typeof digest !== "string" || !DIGEST.test(digest))
    || (value.controllerProvenance.version === 1
      ? !exactKeys(provenance, ["configDigest", "controller", "digest", "executionMode", "releasePlan", "version"])
      : !exactKeys(provenance, ["configDigest", "controller", "digest", "executionMode", "executionRuntime", "remoteIdentity", "releasePlan", "validationSandbox", "version"]))
    || !exactKeys(controller, ["buildDigest", "digest", "sourceManifestDigest", "sourceRevision", "version"])
    || !exactKeys(releasePlan, ["digest", "version"])
    || value.controllerProvenance.executionMode !== "release-plan-v2-direct"
    || value.controllerProvenance.releasePlan.version !== 2) {
    throw new ControllerError("completion_export_artifact_invalid", "Release completion artifact is invalid.");
  }
  if ((value.schema === "herdr-codex-controller:release-completion:v1" && value.controllerProvenance.version !== 1)
    || (value.schema === "herdr-codex-controller:release-completion:v2" && value.controllerProvenance.version !== 2)) {
    throw new ControllerError("completion_export_artifact_invalid", "Release completion schema and provenance versions differ.");
  }
  if (!exactKeys(pullRequest, ["baseRef", "headRef", "headSha", "mergeSha", "mergedAt", "number"])
    || !Number.isSafeInteger(value.pullRequest.number) || value.pullRequest.number < 1
    || typeof value.pullRequest.headRef !== "string" || value.pullRequest.headRef.length < 1 || value.pullRequest.headRef.length > 300
    || typeof value.pullRequest.baseRef !== "string" || value.pullRequest.baseRef.length < 1 || value.pullRequest.baseRef.length > 300
    || typeof value.pullRequest.headSha !== "string" || typeof value.pullRequest.mergeSha !== "string"
    || typeof value.pullRequest.mergedAt !== "string"
    || !SHA.test(value.pullRequest.headSha)
    || !SHA.test(value.pullRequest.mergeSha) || !canonicalTime(value.pullRequest.mergedAt)
    || value.pullRequest.baseRef !== value.baseRef || value.pullRequest.headSha !== value.candidateSha
    || value.pullRequest.mergeSha !== value.mergedMainSha) {
    throw new ControllerError("completion_export_artifact_invalid", "Release completion pull request is invalid.");
  }
  try { assertControllerProvenance(value.controllerProvenance); }
  catch { throw new ControllerError("completion_export_artifact_invalid", "Release completion provenance is invalid."); }
  if (value.controllerProvenance.releasePlan.digest !== value.planDigest) {
    throw new ControllerError("completion_export_artifact_invalid", "Release completion Plan provenance is invalid.");
  }
  const { digest, ...body } = value;
  if (digest !== `sha256:${digestJson(body)}`) {
    throw new ControllerError("completion_export_artifact_invalid", "Release completion digest is invalid.");
  }
}

function privateCompletionProof(job: JobState, config: ControllerConfig, jobRoot: string) {
  if (config.executionMode !== "release-plan-v2-direct" || job.provenance.executionMode !== "release-plan-v2-direct"
    || !isReleasePlanV2(job.plan) || !config.delivery.createPullRequest || config.delivery.allowNoChecks
    || config.delivery.requiredChecks.length === 0 || !job.candidateSha || !job.pullRequest) {
    throw new ControllerError("completion_export_production_mode_invalid", "Completion export requires production Release Plan v2 direct delivery.");
  }
  const issueCommits = job.plan.issues.map(({ number }) => {
    const issue = job.issues.find((entry) => entry.number === number);
    if (!issue || issue.status !== "committed" || !issue.commitSha || !SHA.test(issue.commitSha)) {
      throw new ControllerError("completion_export_issue_commit_invalid", `Issue #${number} has no exact committed SHA.`);
    }
    return { issueNumber: number, sha: issue.commitSha };
  });
  const validation = [...job.validations].reverse().find((entry) => entry.scope === "release" && entry.passed);
  if (!validation || !pathWithin(jobRoot, validation.path)) {
    throw new ControllerError("completion_export_release_validation_missing", "No safe release validation receipt is bound to completion.");
  }
  let receipt: ValidationReceipt;
  try { receipt = readPrivateJson<ValidationReceipt>(jobRoot, validation.path); assertValidationReceipt(receipt); }
  catch { throw new ControllerError("completion_export_release_validation_missing", "Release validation receipt is missing or invalid."); }
  if (!receipt.passed || receipt.scope !== "release" || receipt.candidateSha !== job.candidateSha
    || receipt.digest !== validation.digest) {
    throw new ControllerError("completion_export_release_validation_missing", "Release validation is not bound to the completed candidate.");
  }
  const run = [...job.runs].reverse().find((entry) => (
    entry.kind === "review" && entry.resultPath === job.lastReviewPath
  ));
  if (!run || !job.lastReviewPath || !pathWithin(jobRoot, job.lastReviewPath)
    || run.baseHeadSha !== job.candidateSha || run.finalHeadSha !== job.candidateSha
    || run.exitCode !== 0 || run.signal !== null || run.timedOut || run.outputLimitExceeded || !run.resultDigest) {
    throw new ControllerError("completion_export_review_missing", "No exact successful aggregate review is bound to completion.");
  }
  let review: ReviewResult;
  try { review = validateReviewResult(readPrivateJson<unknown>(jobRoot, job.lastReviewPath)); }
  catch { throw new ControllerError("completion_export_review_missing", "Aggregate review result is missing or invalid."); }
  if (review.status !== "pass" || digestJson(review) !== run.resultDigest) {
    throw new ControllerError("completion_export_review_missing", "Aggregate review did not PASS for the completed candidate.");
  }
  return {
    sourceBaseSha: job.plan.source.baseSha,
    issueCommits,
    releaseValidationDigest: receipt.digest,
    reviewResultDigest: run.resultDigest,
    dependencyHandoffDigests: job.plan.source.dependencyHandoffDigests,
  };
}

function assertCompletionEvidence(
  evidence: JobCompletionEvidence,
  job: JobState,
  proof: ReturnType<typeof privateCompletionProof>,
  config: ControllerConfig,
): void {
  const { digest, ...body } = evidence;
  if (evidence.version !== 1 || digest !== digestJson(body)
    || evidence.planDigest !== job.planDigest || evidence.controllerProvenanceDigest !== job.provenance.digest
    || evidence.sourceBaseSha !== proof.sourceBaseSha || evidence.candidateSha !== job.candidateSha
    || JSON.stringify(evidence.issueCommits) !== JSON.stringify(proof.issueCommits)
    || evidence.releaseValidationDigest !== proof.releaseValidationDigest
    || evidence.reviewResultDigest !== proof.reviewResultDigest
    || evidence.pullRequest.number !== job.pullRequest?.number
    || evidence.pullRequest.headRef !== job.pullRequest?.headRef
    || evidence.pullRequest.baseRef !== job.pullRequest?.baseRef
    || evidence.pullRequest.headSha !== job.pullRequest?.headSha
    || evidence.pullRequest.mergeSha !== job.pullRequest?.mergeSha
    || !canonicalTime(evidence.pullRequest.mergedAt)
    || JSON.stringify(evidence.requiredChecks) !== JSON.stringify(config.delivery.requiredChecks)
    || JSON.stringify(evidence.dependencyHandoffDigests) !== JSON.stringify(proof.dependencyHandoffDigests)
    || evidence.mergedMainSha !== evidence.pullRequest.mergeSha || !canonicalTime(evidence.completedAt)) {
    throw new ControllerError("completion_export_not_completed", "Completion checkpoint does not match the private Job evidence.");
  }
}

function readPrivateJson<T>(root: string, path: string): T {
  const absolute = resolve(path);
  if (!pathWithin(root, absolute) || realpathSync(absolute) !== absolute) throw new Error("private evidence path is unsafe");
  return readJsonFile<T>(absolute);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalTime(value: string): boolean {
  return canonicalIso(value) === value;
}

function canonicalIso(value: unknown): string | null {
  const match = typeof value === "string"
    ? value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/)
    : null;
  if (!match) return null;
  const canonical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7] ?? "").padEnd(3, "0")}Z`;
  return Number.isFinite(Date.parse(canonical)) && new Date(canonical).toISOString() === canonical ? canonical : null;
}
