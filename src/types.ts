export type SandboxMode = "read-only" | "workspace-write";
export type ApprovalPolicy = "never";

export type CommandConfig = {
  command: string;
  timeoutMs?: number;
};

export type ControllerConfig = {
  version: 1;
  repo: string;
  localPath: string;
  stateDir: string;
  worktreeRoot: string;
  baseRef: string;
  remote: string;
  branchPrefix: string;
  shell: string;
  codex: {
    bin: string;
    workerProfile: string | null;
    reviewerProfile: string | null;
    workerTimeoutMs: number;
    reviewerTimeoutMs: number;
    terminationGraceMs: number;
    networkAccess: false;
  };
  validation: {
    setup: CommandConfig[];
    issue: CommandConfig[];
    release: CommandConfig[];
    maxOutputBytes: number;
  };
  policy: {
    maxIssueRepairRounds: number;
    maxReleaseHardeningRounds: number;
    maxCiRepairRounds: number;
    maxIssues: number;
    maxChangedFiles: number;
    maxChangedLines: number;
  };
  review: {
    enabled: boolean;
    blockingSeverities: Array<"critical" | "major">;
  };
  delivery: {
    createPullRequest: boolean;
    draft: boolean;
    autoMerge: boolean;
    mergeMethod: "merge" | "squash" | "rebase";
    allowNoChecks: boolean;
    pollIntervalMs: number;
  };
};

export type ReleasePlanIssueV1 = {
  number: number;
  order: number;
  dependsOn: number[];
  objective: string | null;
  acceptanceCriteria: string[];
  suggestedValidation: CommandConfig[];
  allowNoop: boolean;
};

export type ReleasePlanV1 = {
  version: 1;
  id: string;
  title: string;
  objective: string;
  parentIssue: number | null;
  issues: ReleasePlanIssueV1[];
  releaseAcceptanceCriteria: string[];
  reviewFocus: string[];
};

export type ReleasePlanSourceV2 = {
  planner: "pi-ticket-planning";
  repo: string;
  baseRef: string;
  baseSha: string;
  parentBinding: {
    number: number;
    expectedTitle: string;
    expectedBodyHash: string;
  };
  specContentHash: string;
  deliveryGraphDigest: string;
};

export type ReleasePlanIssueV2 = {
  number: number;
  order: number;
  dependsOn: number[];
  objective: string;
  acceptanceCriteria: string[];
  suggestedValidation: [];
  allowNoop: false;
  expectedTitle: string;
  expectedBodyHash: string;
};

export type ReleasePlanV2 = {
  version: 2;
  source: ReleasePlanSourceV2;
  id: string;
  title: string;
  objective: string;
  parentIssue: number;
  issues: ReleasePlanIssueV2[];
  releaseAcceptanceCriteria: string[];
  reviewFocus: string[];
};

export type ReleasePlanIssue = ReleasePlanIssueV1 | ReleasePlanIssueV2;
export type ReleasePlan = ReleasePlanV1 | ReleasePlanV2;

export type IssueSnapshot = {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  assignees: string[];
  url: string;
  fetchedAt: string;
  digest: string;
};

export type WorkerResult = {
  status: "completed" | "blocked";
  summary: string;
  selfReview: {
    performed: boolean;
    findingsFixed: string[];
    remainingConcerns: string[];
  };
  testsRun: Array<{
    command: string;
    outcome: "passed" | "failed" | "not-run";
  }>;
  residualRisks: string[];
  blockedReason: string | null;
};

export type ReviewFinding = {
  severity: "critical" | "major" | "minor";
  path: string | null;
  line: number | null;
  summary: string;
  rationale: string;
  recommendation: string;
  relatedIssues: number[];
};

export type ReviewResult = {
  status: "pass" | "changes" | "blocked";
  summary: string;
  findings: ReviewFinding[];
};

export type ValidationCommandResult = {
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  stdoutTail: string;
  stderrTail: string;
};

export type ValidationReceipt = {
  version: 1;
  id: string;
  scope: "setup" | "issue" | "release";
  issueNumber: number | null;
  candidateSha: string;
  sourceWorktreeDigest: string;
  passed: boolean;
  commands: ValidationCommandResult[];
  createdAt: string;
  digest: string;
};

export type RunKind = "worker" | "issue-repair" | "release-harden" | "review";

export type CodexRunRecord = {
  id: string;
  kind: RunKind;
  issueNumber: number | null;
  startedAt: string;
  completedAt: string;
  baseHeadSha: string;
  finalHeadSha: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  promptPath: string;
  eventsPath: string;
  stderrPath: string;
  resultPath: string;
  resultDigest: string | null;
};

export type IssueExecution = {
  number: number;
  order: number;
  status: "pending" | "running" | "committed" | "blocked";
  snapshot: IssueSnapshot | null;
  commitSha: string | null;
  lastRunId: string | null;
  lastValidationId: string | null;
  repairRounds: number;
  nextRunKind: "worker" | "issue-repair" | "recovery";
};

export type JobStatus = "running" | "blocked" | "ready_to_merge" | "completed" | "failed";
export type JobPhase =
  | "prepare"
  | "implement"
  | "issue_validate"
  | "release_validate"
  | "review"
  | "harden"
  | "deliver"
  | "ci"
  | "awaiting_merge"
  | "complete";

export type BlockedState = {
  code: string;
  message: string;
  fromPhase: JobPhase;
  createdAt: string;
  detailsPath: string | null;
};

export type PullRequestState = {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRef: string;
  baseRef: string;
  headSha: string;
};

export type JobState = {
  version: 1;
  id: string;
  configPath: string;
  configDigest: string;
  planPath: string;
  planDigest: string;
  repo: string;
  plan: ReleasePlan;
  baseRef: string;
  baseSha: string | null;
  remote: string;
  branch: string;
  worktreePath: string;
  status: JobStatus;
  phase: JobPhase;
  issues: IssueExecution[];
  currentIssueNumber: number | null;
  activeRun: {
    id: string;
    kind: RunKind;
    issueNumber: number | null;
    startedAt: string;
    baseHeadSha: string;
  } | null;
  runs: CodexRunRecord[];
  validations: Array<{
    id: string;
    scope: "setup" | "issue" | "release";
    issueNumber: number | null;
    path: string;
    passed: boolean;
    digest: string;
  }>;
  candidateSha: string | null;
  reviewRound: number;
  hardeningRounds: number;
  ciRepairRounds: number;
  lastReviewPath: string | null;
  hardeningReasonPath: string | null;
  pullRequest: PullRequestState | null;
  blocked: BlockedState | null;
  createdAt: string;
  updatedAt: string;
};

export type StepResult = {
  action: string;
  progressed: boolean;
  terminal: boolean;
  retryAfterMs: number | null;
  message: string;
};

export type CommandResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdoutPath: string | null;
  stderrPath: string | null;
  stdoutTail: string;
  stderrTail: string;
};

export type GhCheckSummary = {
  state: "pending" | "success" | "failure" | "none";
  failures: Array<{ name: string; state: string; link: string | null }>;
  pending: Array<{ name: string; state: string; link: string | null }>;
};
