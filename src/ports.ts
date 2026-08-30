import type {
  CodexRunRecord,
  GhCheckSummary,
  IssueSnapshot,
  JobState,
  PullRequestState,
  QueueIssue,
  ReviewResult,
  RunKind,
  ValidationReceipt,
  WorkerResult,
  WorkflowGateSummary,
  RepositoryFileSnapshot,
  ValidationCommandConfig,
} from "./types.js";

export interface GitPort {
  preflight(): Promise<void>;
  fetchBase(): Promise<string>;
  isAncestorOfRemoteBase(sha: string): Promise<boolean>;
  verifyMergeResult(input: {
    mergeSha: string;
    candidateSha: string;
    baseSha: string;
    mergeMethod: "merge" | "squash" | "rebase";
  }): Promise<"verified" | "base_mismatch" | "candidate_mismatch">;
  ensureWorktree(job: JobState): Promise<void>;
  verifyWorktree(job: JobState): Promise<void>;
  head(cwd: string): Promise<string>;
  branch(cwd: string): Promise<string>;
  isClean(cwd: string): Promise<boolean>;
  changedPaths(cwd: string): Promise<string[]>;
  fileAtRevision(revision: string, path: string): Promise<RepositoryFileSnapshot>;
  fileInWorktree(job: JobState, path: string): Promise<RepositoryFileSnapshot>;
  commitStats(job: JobState, sha: string): Promise<{ files: number; changedLines: number; paths: string[]; entries: Array<{ path: string; changedLines: number; binary: boolean }> }>;
  worktreeDigest(cwd: string): Promise<string>;
  assertAgentDidNotCommit(job: JobState, expectedHead: string): Promise<void>;
  commitIssue(job: JobState, issueNumber: number, title: string, allowNoop: boolean): Promise<{ sha: string; created: boolean }>;
  commitParent(job: JobState, sha: string): Promise<string>;
  salvageIssueCommitAtHead(job: JobState, issueNumber: number): Promise<string | null>;
  salvageHardeningCommitAtHead(job: JobState, round: number): Promise<string | null>;
  commitHardening(job: JobState, reason: string): Promise<{ sha: string; created: boolean }>;
  diffStats(job: JobState): Promise<{ files: number; changedLines: number; summary: string; entries: Array<{ path: string; changedLines: number; binary: boolean }> }>;
  diffText(job: JobState, maximumBytes: number): Promise<string>;
  push(job: JobState): Promise<void>;
  removeWorktree(job: JobState): Promise<void>;
}

export interface GitHubPort {
  preflight(): Promise<void>;
  fetchIssue(number: number, options?: { allowClosed?: boolean }): Promise<IssueSnapshot>;
  findPullRequest(job: JobState): Promise<PullRequestState | null>;
  createPullRequest(job: JobState, deliveryRoot: string): Promise<PullRequestState>;
  inspectPullRequest(number: number): Promise<{
    pullRequest: PullRequestState;
    checks: GhCheckSummary;
    mergedAt: string | null;
  }>;
  baseAllowsUpToDateAutoMerge(): Promise<boolean>;
  enableAutoMerge(number: number, candidateSha: string): Promise<void>;
  currentLogin(): Promise<string>;
  listSubIssues(parentIssue: number): Promise<QueueIssue[]>;
  fetchQueueIssue(number: number): Promise<QueueIssue>;
  claimIssue(number: number, login: string): Promise<void>;
  inspectWorkflowGate(sha: string, requiredWorkflows: string[]): Promise<WorkflowGateSummary>;
}

export interface CodexPort {
  preflight(): Promise<void>;
  run(input: {
    job: JobState;
    kind: RunKind;
    issueNumber: number | null;
    prompt: string;
    runsRoot: string;
    runId?: string;
  }): Promise<{
    record: CodexRunRecord;
    workerResult: WorkerResult | null;
    reviewResult: ReviewResult | null;
  }>;
}

export interface ValidationPort {
  run(input: {
    job: JobState;
    scope: "setup" | "issue" | "release";
    issueNumber: number | null;
    commands: ValidationCommandConfig[];
    validationsRoot: string;
    sourceHeadSha: string;
    sourceWorktreeDigest: string;
  }): Promise<{ receipt: ValidationReceipt; path: string }>;
}
