import { resolve } from "node:path";
import { validateReviewResult } from "./codex.js";
import { requiredCheckNames } from "./config.js";
import { ControllerError } from "./errors.js";
import { readJsonFile, writePublicJsonAtomic } from "./fs-atomic.js";
import type { GitHubPort, GitPort } from "./ports.js";
import type { JobStore } from "./state.js";
import type { ControllerConfig, JobState, ReleaseResultV1, ValidationReceipt } from "./types.js";
import { digestJson, pathWithin } from "./util.js";
import { assertValidationReceipt } from "./validator.js";

export function createReleaseResult(input: {
  job: JobState;
  config: ControllerConfig;
  jobRoot: string;
  completedAt: string;
}): ReleaseResultV1 {
  readCandidateProof(input.job, input.jobRoot);
  if (!input.job.candidateSha || !input.job.pullRequest?.mergeSha || input.job.pullRequest.state !== "MERGED") {
    throw new ControllerError("release_result_incomplete", "Merged release identity is incomplete.");
  }
  const result: ReleaseResultV1 = {
    schema: "herdr-codex-controller:release-result:v1",
    releaseId: input.job.plan.id,
    planDigest: input.job.planDigest,
    status: "merged",
    baseSha: input.job.plan.baseSha,
    candidateSha: input.job.candidateSha,
    pullRequest: { number: input.job.pullRequest.number, url: input.job.pullRequest.url },
    requiredChecks: { names: requiredCheckNames(input.config), status: "passed" },
    mergeSha: input.job.pullRequest.mergeSha,
    completedAt: canonicalTime(input.completedAt),
  };
  assertReleaseResult(result);
  return result;
}

export async function exportReleaseResult(input: {
  store: JobStore;
  git: GitPort;
  github: GitHubPort;
  jobId: string;
  outputPath: string;
}): Promise<ReleaseResultV1> {
  const job = input.store.load(input.jobId);
  if (job.status !== "completed" || job.phase !== "complete" || !job.result) {
    throw new ControllerError("release_result_not_completed", "The Job has no verified merged Release Result.");
  }
  assertReleaseResult(job.result);
  const proof = readCandidateProof(job, input.store.root(job.id));
  for (const commit of proof.issueCommits) {
    if (!(await input.git.verifyIssueCommit({
      releaseId: job.plan.id,
      planDigest: job.planDigest,
      issueNumber: commit.issueNumber,
      sha: commit.sha,
      candidateSha: job.result.candidateSha,
    }))) throw new ControllerError("release_result_issue_commit_invalid", "An Issue commit is not an exact Controller-owned candidate ancestor.");
  }
  const observed = await input.github.inspectPullRequest(job.result.pullRequest.number);
  if (observed.pullRequest.state !== "MERGED" || observed.pullRequest.headSha !== job.result.candidateSha
    || observed.pullRequest.mergeSha !== job.result.mergeSha || observed.pullRequest.url !== job.result.pullRequest.url) {
    throw new ControllerError("release_result_pr_unverified", "GitHub no longer reports the exact merged pull request identity.");
  }
  await input.git.fetchBase();
  if (!(await input.git.isAncestorOfRemoteBase(job.result.mergeSha))) {
    throw new ControllerError("release_result_merge_unverified", "The merge SHA is not an ancestor of the current remote base.");
  }
  const merge = await input.git.verifyMergeResult({
    mergeSha: job.result.mergeSha,
    candidateSha: job.result.candidateSha,
    baseSha: job.result.baseSha,
    mergeMethod: input.store.config.delivery.mergeMethod,
  });
  if (merge !== "verified") throw new ControllerError("release_result_merge_unverified", "The merge tree does not reproduce the reviewed candidate.");
  const output = resolve(input.outputPath);
  if (pathWithin(input.store.config.stateDir, output)) {
    throw new ControllerError("release_result_output_private_path", "Release Result output must be outside Controller private state.");
  }
  try { writePublicJsonAtomic(output, job.result); }
  catch (error) {
    throw new ControllerError(
      error instanceof Error && error.message.includes("conflicts")
        ? "release_result_output_conflict"
        : "release_result_output_invalid",
      "Release Result output is unsafe or conflicts with existing bytes.",
    );
  }
  return job.result;
}

export function assertReleaseResult(value: unknown): asserts value is ReleaseResultV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ControllerError("release_result_invalid", "Release Result is invalid.");
  }
  const result = value as ReleaseResultV1;
  const keys = [
    "baseSha", "candidateSha", "completedAt", "mergeSha", "planDigest", "pullRequest", "releaseId",
    "requiredChecks", "schema", "status",
  ];
  if (result.reviewReportDigest !== undefined) keys.push("reviewReportDigest");
  if (Object.keys(result as unknown as Record<string, unknown>).sort().join("\n") !== keys.sort().join("\n")
    || Object.keys(result.pullRequest ?? {}).sort().join("\n") !== "number\nurl"
    || Object.keys(result.requiredChecks ?? {}).sort().join("\n") !== "names\nstatus"
    || result.schema !== "herdr-codex-controller:release-result:v1" || result.status !== "merged"
    || !/^[a-z0-9._-]{1,80}$/u.test(result.releaseId) || !/^[a-f0-9]{64}$/u.test(result.planDigest)
    || !/^[a-f0-9]{40}$/u.test(result.baseSha) || !/^[a-f0-9]{40}$/u.test(result.candidateSha)
    || !/^[a-f0-9]{40}$/u.test(result.mergeSha) || canonicalTime(result.completedAt) !== result.completedAt
    || !Number.isSafeInteger(result.pullRequest?.number) || result.pullRequest.number < 1
    || typeof result.pullRequest.url !== "string" || !result.pullRequest.url.startsWith("https://")
    || result.requiredChecks?.status !== "passed" || !Array.isArray(result.requiredChecks.names)
    || result.requiredChecks.names.length === 0 || result.requiredChecks.names.length > 100
    || new Set(result.requiredChecks.names).size !== result.requiredChecks.names.length
    || result.requiredChecks.names.some((name) => typeof name !== "string" || !name || name.length > 500)
    || (result.reviewReportDigest !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(result.reviewReportDigest))) {
    throw new ControllerError("release_result_invalid", "Release Result is invalid.");
  }
}

export function readCandidateProof(job: JobState, jobRoot: string) {
  if (!job.candidateSha || job.issues.some((issue) => issue.status !== "committed" || !issue.commitSha)) {
    throw new ControllerError("candidate_proof_incomplete", "Issue commits or candidate identity are incomplete.");
  }
  const validation = [...job.validations].reverse().find((entry) => entry.scope === "release" && entry.passed);
  if (!validation || !pathWithin(jobRoot, validation.path)) {
    throw new ControllerError("candidate_validation_missing", "No safe release validation is bound to the candidate.");
  }
  const receipt = readJsonFile<ValidationReceipt>(validation.path);
  assertValidationReceipt(receipt);
  if (!receipt.passed || receipt.candidateSha !== job.candidateSha || receipt.digest !== validation.digest) {
    throw new ControllerError("candidate_validation_missing", "Release validation does not bind the candidate.");
  }
  const run = [...job.runs].reverse().find((entry) => entry.kind === "review" && entry.resultPath === job.lastReviewPath);
  if (!run || !run.resultDigest || run.baseHeadSha !== job.candidateSha || run.finalHeadSha !== job.candidateSha
    || run.exitCode !== 0 || run.signal !== null || run.timedOut || run.outputLimitExceeded) {
    throw new ControllerError("candidate_review_missing", "No successful aggregate review is bound to the candidate.");
  }
  const review = validateReviewResult(readJsonFile<unknown>(run.resultPath));
  if (review.status !== "pass" || digestJson(review) !== run.resultDigest) {
    throw new ControllerError("candidate_review_missing", "Aggregate review did not pass for the candidate.");
  }
  return {
    issueCommits: job.issues.map((issue) => ({ issueNumber: issue.number, sha: issue.commitSha! })),
    validationDigest: receipt.digest,
    reviewDigest: run.resultDigest,
  };
}

function canonicalTime(value: string): string {
  const time = new Date(value).toISOString();
  if (time !== value) throw new ControllerError("release_result_invalid", "Release Result time must be canonical ISO-8601.");
  return time;
}
