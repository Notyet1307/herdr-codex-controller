export type SandboxMode = "read-only" | "workspace-write";
export type ApprovalPolicy = "never";
export type ExecutionMode =
  | "release-plan-v2-direct"
  | "release-plan-v1-compatibility"
  | "dispatcher-experimental";

export type CommandConfig = {
  command: string;
  timeoutMs?: number;
};

export type ControllerConfig = {
  version: 1;
  executionMode: ExecutionMode;
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
    requiredChecks: string[];
    pollIntervalMs: number;
  };
};

export type ControllerIdentity = {
  version: 1;
  sourceRevision: string;
  sourceManifestDigest: string;
  buildDigest: string;
  digest: string;
};

export type ControllerProvenance = {
  version: 1;
  controller: ControllerIdentity;
  executionMode: ExecutionMode;
  configDigest: string;
  releasePlan: {
    version: 1 | 2;
    digest: string;
  };
  digest: string;
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
  decisionManifestDigest: string;
  predecessorReceiptDigest: string | null;
  dependencyHandoffDigests: string[];
};

export type OracleBindingV1 = {
  schema: "pi-ticket-planning:oracle-binding:v1";
  id: string;
  owner: {
    kind: "INDEPENDENT_VERIFICATION";
    identity: string;
  };
  artifact: {
    path: string;
    format: string;
    baseSha: string;
    sha256: string;
    byteCount: number;
  };
  execution: {
    command: string;
  };
  verifier: OracleVerifierManifestV1;
  workerMutationAllowed: false;
};

export type OracleVerifierManifestV1 = {
  schema: "herdr-codex-controller:oracle-verifier-manifest:v1";
  oracleId: string;
  command: string;
  packageScript: {
    name: string;
    definitionSha256: string;
  };
  files: Array<{
    path: string;
    sha256: string;
    byteCount: number;
  }>;
  digest: string;
};

export type ScopeBudget = {
  maxFiles: number;
  maxChangedLines: number;
};

export type IntegrationOnlyContract = {
  noNewProductBehavior: true;
  noSchemaChanges: true;
  noDuplicatedProductionLogic: true;
  missingBehavior: "REPLAN_REQUIRED";
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
  oracleBindings: OracleBindingV1[];
  riskClasses: string[];
  scopeBudget: ScopeBudget;
  expectedPaths: string[];
  protectedPaths: string[];
  replanTriggers: string[];
  integrationOnly: IntegrationOnlyContract | null;
  waiverDigests: string[];
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
  observedRiskClasses: string[];
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
  oracles: OracleExecutionRef[];
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
  verifiedAt: string;
};

export type OracleExecutionRef = {
  issueNumber: number;
  oracleId: string;
};

export type ValidationCommandConfig = CommandConfig & {
  oracles?: OracleExecutionRef[];
};

export type RepositoryFileSnapshot = {
  sha256: string;
  byteCount: number;
  bytes: Uint8Array;
};

export type ValidationReceipt = {
  version: 2;
  id: string;
  scope: "setup" | "issue" | "release";
  issueNumber: number | null;
  candidateSha: string;
  sourceWorktreeDigest: string;
  commandCount: number;
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

export type QueueIssue = {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  assignees: string[];
  url: string;
  openBlockers: number;
};

export type WorkflowGateSummary = {
  state: "pending" | "success" | "failure";
  sha: string;
  missing: string[];
  pending: Array<{ name: string; status: string; url: string | null }>;
  failures: Array<{ name: string; conclusion: string; url: string | null }>;
  successes: Array<{ name: string; url: string | null }>;
  observedAt: string;
};

export type DispatcherConfig = {
  version: 1;
  parentIssue: number;
  readyLabel: string;
  releaseAcceptanceCriteria: string[];
  reviewFocus: string[];
  postMerge: {
    requiredWorkflows: string[];
    pollIntervalMs: number;
    timeoutMs: number;
  };
};

export type DispatcherCurrent = {
  issueNumber: number;
  issueTitle: string;
  issueBodyHash: string;
  issueUrl: string;
  login: string;
  selectedAt: string;
  phase: "selected" | "claimed" | "plan_ready" | "job_running" | "post_merge";
  planId: string | null;
  planPath: string | null;
  jobId: string | null;
  sourceVerifiedAt: string | null;
  postMergeStartedAt: string | null;
};

export type DispatcherState = {
  version: 1;
  repo: string;
  parentIssue: number;
  controllerConfigPath: string;
  controllerConfigDigest: string;
  dispatcherConfigPath: string;
  dispatcherConfigDigest: string;
  current: DispatcherCurrent | null;
  blocked: {
    code: string;
    message: string;
    createdAt: string;
    detailsPath: string | null;
  } | null;
  history: Array<{
    issueNumber: number;
    jobId: string;
    pullRequestNumber: number;
    candidateSha: string;
    mergeSha: string;
    workflowGate: WorkflowGateSummary;
    verifiedAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
};

export type DispatcherStepResult = {
  action: string;
  progressed: boolean;
  terminal: boolean;
  retryAfterMs: number | null;
  message: string;
  issueNumber: number | null;
  jobId: string | null;
};

export type JobCompletionEvidence = {
  version: 1;
  planDigest: string;
  controllerProvenanceDigest: string;
  sourceBaseSha: string;
  candidateSha: string;
  issueCommits: Array<{ issueNumber: number; sha: string }>;
  releaseValidationDigest: string;
  reviewResultDigest: string;
  pullRequest: {
    number: number;
    headRef: string;
    baseRef: string;
    headSha: string;
    mergeSha: string;
    mergedAt: string;
  };
  mergedMainSha: string;
  requiredChecks: string[];
  dependencyHandoffDigests: string[];
  completedAt: string;
  digest: string;
};

export type ReleaseCompletionV1 = {
  schema: "herdr-codex-controller:release-completion:v1";
  releaseId: string;
  repo: string;
  baseRef: string;
  planDigest: string;
  sourceBaseSha: string;
  candidateSha: string;
  issueCommits: Array<{ issueNumber: number; sha: string }>;
  releaseValidationDigest: string;
  reviewResultDigest: string;
  pullRequest: {
    number: number;
    headRef: string;
    headSha: string;
    baseRef: string;
    mergeSha: string;
    mergedAt: string;
  };
  requiredChecks: string[];
  mergedMainSha: string;
  dependencyHandoffDigests: string[];
  controllerProvenance: ControllerProvenance;
  completedAt: string;
  digest: string;
};

export type JobState = {
  version: 2;
  id: string;
  provenance: ControllerProvenance;
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
  completion: JobCompletionEvidence | null;
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
};

export type GhCheckSummary = {
  state: "pending" | "success" | "failure" | "none";
  missing: string[];
  failures: Array<{ name: string; state: string; link: string | null }>;
  pending: Array<{ name: string; state: string; link: string | null }>;
};
