export type SandboxMode = "read-only" | "workspace-write";
export type ApprovalPolicy = "never";
export type CommandConfig = {
  command: string;
  timeoutMs?: number;
};

export type ValidationBootstrapConfig = {
  command: string;
  timeoutMs: number;
  networkAccess: boolean;
};

export type CheckConclusion = "SUCCESS" | "NEUTRAL" | "SKIPPED" | "FAILURE" | "ACTION_REQUIRED" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "STARTUP_FAILURE" | "STALE";

export type RequiredCheckContractV1 = {
  version: 1;
  firstAppearanceTimeoutMs: number;
  pendingTimeoutMs: number;
  checks: Array<{
    name: string;
    appId: number | null;
    workflowName: string | null;
    acceptedConclusions: Array<"SUCCESS" | "NEUTRAL" | "SKIPPED">;
    required: boolean;
  }>;
};

export type VerifiedGitRemote = {
  remote: string;
  repo: string;
  fetchUrl: string;
  pushUrl: string;
  fetchTransport: "https" | "ssh";
  pushTransport: "https" | "ssh";
};

export type ControllerConfig = {
  version: 4;
  repo: string;
  localPath: string;
  stateDir: string;
  worktreeRoot: string;
  baseRef: string;
  remote: string;
  remoteIdentity: {
    version: 1;
    fetchUrl: string;
    pushUrl: string;
  };
  branchPrefix: string;
  shell: string;
  codex: {
    bin: string;
    workerTimeoutMs: number;
    reviewerTimeoutMs: number;
    terminationGraceMs: number;
    maxEventBytes: number;
    maxStderrBytes: number;
    maxResultBytes: number;
    maxAggregateBytes: number;
  };
  validation: {
    bootstrap?: ValidationBootstrapConfig | null;
    setup: CommandConfig[];
    issue: CommandConfig[];
    release: CommandConfig[];
    maxOutputBytes: number;
    maxStdoutBytes: number;
    maxStderrBytes: number;
    maxAggregateBytes: number;
    sandbox: {
      version: 1;
      provider: "codex-permission-profile";
      bin: string;
      root: string;
      environmentPath: string[];
    };
  };
  policy: {
    maxIssueRepairRounds: number;
    maxCodeRepairRounds: number;
    maxInfrastructureReruns: number;
    maxIssues: number;
    maxChangedFiles: number;
    maxChangedLines: number;
  };
  reviewDemo: {
    command: string;
    required: boolean;
    networkAccess: boolean;
    timeoutMs: number;
    maxOutputBytes: number;
  } | null;
  delivery: {
    draft: boolean;
    mergeMethod: "merge" | "squash" | "rebase";
    requiredChecks: RequiredCheckContractV1;
    pollIntervalMs: number;
  };
};

export type ReleasePlanIssue = {
  number: number;
  order: number;
  dependsOn: number[];
  objective: string;
  acceptanceCriteria: string[];
  expectedPaths: string[];
  risk: "low" | "normal" | "high";
  oracleCommands: string[];
};

export type ReleasePlan = {
  controllerContractVersion: 1;
  id: string;
  title: string;
  objective: string;
  repo: string;
  baseRef: string;
  baseSha: string;
  parentIssue: number;
  issues: ReleasePlanIssue[];
  releaseAcceptanceCriteria: string[];
  reviewFocus: string[];
  plannerContextDigest?: string;
};

export type IssueSnapshot = {
  number: number;
  title: string;
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
  blockedKind: "recoverable" | "replan_required" | null;
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
  timeoutMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  stdoutSha256: string;
  stderrSha256: string;
  stdoutTail: string;
  stderrTail: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  outputLimitExceeded?: boolean;
  terminationReason?: "exit" | "signal" | "timeout" | "output_limit";
  commandIdentityDigest?: string;
  verifiedAt: string;
};

export type ValidationBootstrapResult = ValidationCommandResult & {
  commandIndex: number;
  sourceIntegrityVerified: boolean;
};

export type ValidationIntegrityCheck = {
  commandIndex: number;
  afterBootstrap: boolean;
  afterValidation: boolean | null;
};

export type ValidationCommandConfig = CommandConfig;

export type ValidationProjectionEntry =
  | { path: string; mode: "100644" | "100755"; byteCount: number; sha256: string }
  | { path: string; mode: "120000"; byteCount: number; sha256: string; linkTarget: string };

export type ValidationReceipt = {
  version: 2 | 3 | 4;
  id: string;
  scope: "setup" | "issue" | "release";
  issueNumber: number | null;
  candidateSha: string;
  sourceWorktreeDigest: string;
  candidateTreeSha?: string;
  candidateTreeDigest?: string;
  sandboxPolicyDigest?: string;
  commandSetDigest?: string;
  configuredCommands?: Array<{
    command: string;
    timeoutMs: number;
  }>;
  projectionFileCount?: number;
  projectionByteCount?: number;
  cleanupCompleted?: boolean;
  bootstrap?: null | {
    command: string;
    timeoutMs: number;
    networkAccess: boolean;
    identityDigest: string;
    policyDigest: string;
    runs: ValidationBootstrapResult[];
  };
  integrityChecks?: ValidationIntegrityCheck[];
  commandCount: number;
  passed: boolean;
  commands: ValidationCommandResult[];
  createdAt: string;
  digest: string;
};

export type RunKind = "worker" | "issue-repair" | "release-repair" | "review";

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
  outputLimitExceeded?: boolean;
  terminationReason?: "exit" | "signal" | "timeout" | "output_limit";
  eventsBytes?: number;
  stderrBytes?: number;
  resultBytes?: number;
  eventsSha256?: string;
  stderrSha256?: string;
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

export type JobStatus = "running" | "blocked" | "completed" | "failed";
export type JobPhase =
  | "prepare"
  | "implement"
  | "verify"
  | "review"
  | "repair"
  | "deliver"
  | "complete";

export type BlockedState = {
  code: string;
  message: string;
  fromPhase: JobPhase;
  createdAt: string;
  detailsPath: string | null;
};

export type RetryAuthorization = {
  previousBlockedCode: string;
  previousBlockedPhase: JobPhase;
  previousDetailsPath: string | null;
  operatorReason: string;
  recoveryEvidencePath: string;
  evidenceDigest: string;
  authorizedAt: string;
};

export type PullRequestState = {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRef: string;
  baseRef: string;
  headSha: string;
  mergeSha: string | null;
};

export type ReleaseResultV1 = {
  schema: "herdr-codex-controller:release-result:v1";
  releaseId: string;
  planDigest: string;
  status: "merged";
  baseSha: string;
  candidateSha: string;
  pullRequest: { number: number; url: string };
  requiredChecks: { names: string[]; status: "passed" };
  mergeSha: string;
  completedAt: string;
  reviewReportDigest?: string;
};

export type CiGateState = {
  version: 1;
  candidateSha: string;
  checkContractDigest: string;
  firstObservedAt: string;
  firstAppearanceDeadlineAt: string;
  pendingDeadlineAt: string | null;
  attempts: number;
  lastObservation: GhCheckSummary | null;
};

export type DeliveryAuthorityState = {
  version: 1;
  pullRequest: PullRequestState;
  candidateSha: string;
  proofDigest: string;
  status: "pending" | "authorizing" | "authorized" | "consumed" | "revocation_required" | "revoked" | "revocation_failed";
  autoMergeEnabled: boolean;
  quarantined: boolean;
  lastVerifiedAt: string;
  revocationReason: string | null;
  error: string | null;
};

export type ReviewDemoResult = {
  version: 1;
  id: string;
  candidateSha: string;
  command: string;
  required: boolean;
  networkAccess: boolean;
  sandboxPolicyDigest: string;
  passed: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  artifacts: Array<{ path: string; mediaType: string; bytes: number }>;
  error: string | null;
  createdAt: string;
  digest: string;
};

export type ReviewDemoBinding = {
  candidateSha: string;
  path: string;
  digest: string;
  passed: boolean;
  required: boolean;
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
  codeRepairRounds: number;
  infrastructureReruns: number;
  lastReviewPath: string | null;
  repairReasonPath: string | null;
  pullRequest: PullRequestState | null;
  ciGate: CiGateState | null;
  deliveryAuthority: DeliveryAuthorityState | null;
  reviewDemo: ReviewDemoBinding | null;
  result: ReleaseResultV1 | null;
  blocked: BlockedState | null;
  retryAuthorizations: RetryAuthorization[];
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
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  outputLimitExceeded: boolean;
  terminationReason: "exit" | "signal" | "timeout" | "output_limit";
};

export type GhCheckSummary = {
  state: "pending" | "success" | "failure" | "none";
  missing: string[];
  failures: Array<{ name: string; state: string; link: string | null }>;
  pending: Array<{ name: string; state: string; link: string | null }>;
  successes?: Array<{ name: string; state: string; link: string | null }>;
  ambiguous?: string[];
  observations?: GhCheckObservation[];
  observedAt?: string;
};

export type GhCheckObservation = {
  name: string;
  status: string;
  conclusion: string;
  link: string | null;
  appId: number | null;
  workflowName: string | null;
  runId: number | null;
};

export type CiFailureEvidence = {
  version: 1;
  candidateSha: string;
  check: GhCheckObservation;
  log: string;
  logBytes: number;
  logSha256: string;
  observedAt: string;
  digest: string;
};
