import type {
  CodexRunRecord,
  GhCheckSummary,
  IssueSnapshot,
  JobState,
  PullRequestState,
  ReviewResult,
  RunKind,
  ValidationReceipt,
  WorkerResult,
  CommandConfig,
} from "./types.js";

export interface GitPort {
  preflight(): Promise<void>;
  fetchBase(): Promise<string>;
  ensureWorktree(job: JobState): Promise<void>;
  verifyWorktree(job: JobState): Promise<void>;
  head(cwd: string): Promise<string>;
  branch(cwd: string): Promise<string>;
  isClean(cwd: string): Promise<boolean>;
  changedPaths(cwd: string): Promise<string[]>;
  worktreeDigest(cwd: string): Promise<string>;
  assertAgentDidNotCommit(job: JobState, expectedHead: string): Promise<void>;
  commitIssue(job: JobState, issueNumber: number, title: string, allowNoop: boolean): Promise<{ sha: string; created: boolean }>;
  salvageIssueCommitAtHead(job: JobState, issueNumber: number): Promise<string | null>;
  salvageHardeningCommitAtHead(job: JobState, round: number): Promise<string | null>;
  commitHardening(job: JobState, reason: string): Promise<{ sha: string; created: boolean }>;
  diffStats(job: JobState): Promise<{ files: number; changedLines: number; summary: string }>;
  diffText(job: JobState, maximumBytes: number): Promise<string>;
  push(job: JobState): Promise<void>;
  removeWorktree(job: JobState): Promise<void>;
}

export interface GitHubPort {
  preflight(): Promise<void>;
  fetchIssue(number: number): Promise<IssueSnapshot>;
  findPullRequest(job: JobState): Promise<PullRequestState | null>;
  createPullRequest(job: JobState, deliveryRoot: string): Promise<PullRequestState>;
  inspectPullRequest(number: number): Promise<{
    pullRequest: PullRequestState;
    checks: GhCheckSummary;
    mergedAt: string | null;
  }>;
  enableAutoMerge(number: number): Promise<void>;
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
    commands: CommandConfig[];
    validationsRoot: string;
    sourceHeadSha: string;
    sourceWorktreeDigest: string;
  }): Promise<{ receipt: ValidationReceipt; path: string }>;
}
