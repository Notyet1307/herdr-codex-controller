export type SandboxMode = "read-only" | "workspace-write";
export type ApprovalPolicy = "never";
export type ExecutionMode = "release-plan-v2-direct";

export type CommandConfig = {
  command: string;
  timeoutMs?: number;
};

export type CheckConclusion = "SUCCESS" | "NEUTRAL" | "SKIPPED" | "FAILURE" | "ACTION_REQUIRED" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "STARTUP_FAILURE" | "STALE";

export type RequiredCheckContractV1 = {
  version: 1;
  firstAppearanceTimeoutMs: number;
  pendingTimeoutMs: number;
  postMergeTimeoutMs?: number;
  checks: Array<{
    name: string;
    appId: number | null;
    workflowName: string | null;
    acceptedConclusions: Array<"SUCCESS" | "NEUTRAL" | "SKIPPED">;
    required: boolean;
  }>;
};

export type MergeAuthorityContractV1 = {
  version: 1;
  mode: "controller-auto-merge";
  quarantine: "delete-exact-head-branch";
};

export type ControllerConfig = {
  version: 1 | 2 | 3 | 4;
  executionMode: ExecutionMode;
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
  } | null;
  branchPrefix: string;
  shell: string;
  codex: {
    bin: string;
    workerProfile: string | null;
    reviewerProfile: string | null;
    workerTimeoutMs: number;
    reviewerTimeoutMs: number;
    terminationGraceMs: number;
    maxEventBytes: number;
    maxStderrBytes: number;
    maxResultBytes: number;
    maxAggregateBytes: number;
    networkAccess: false;
  };
  validation: {
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
    } | null;
  };
  policy: {
    maxIssueRepairRounds: number;
    maxReleaseHardeningRounds?: number;
    maxCiRepairRounds?: number;
    maxReleaseValidationRepairRounds?: number;
    maxReviewRepairRounds?: number;
    maxCiCodeRepairRounds?: number;
    maxCiInfrastructureReruns?: number;
    maxProviderRetries?: number;
    maxCodeRepairRounds?: number;
    maxInfrastructureReruns?: number;
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
    requiredChecks: string[] | RequiredCheckContractV1;
    mergeAuthority?: MergeAuthorityContractV1 | null;
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

export type ControllerIdentityHistory = {
  schema: "herdr-codex-controller:identity-history:v1";
  version: 1;
  digestAlgorithm: "utf16-code-unit-canonical-json-v1+sha256-hex";
  entries: Array<{
    identity: ControllerIdentity;
    ownedSchemas: Array<{ schema: string; sha256: string }>;
    qualificationStatus: "qualified";
    activatedAt: string;
    revocation: { revokedAt: string; reason: string } | null;
  }>;
  digest: string;
};

export type ExecutableIdentity = {
  configuredPathDigest: string;
  realPathDigest: string;
  byteCount: number;
  sha256: string;
  versionOutput: string;
};

export type ExecutionRuntimeIdentity = {
  version: 1;
  binary: ExecutableIdentity;
  fixedPolicyDigest: string;
  profilesDisabled: boolean;
  digest: string;
};

export type ValidationSandboxIdentity = {
  version: 1;
  provider: "codex-permission-profile";
  binary: ExecutableIdentity;
  policyDigest: string;
  digest: string;
};

export type GitRemoteIdentity = {
  version: 1;
  remote: string;
  repo: string;
  fetchUrl: string;
  pushUrl: string;
  fetchTransport: "https" | "ssh";
  pushTransport: "https" | "ssh";
  digest: string;
};

export type ControllerProvenance = {
  version: 1 | 2 | 3;
  controller: ControllerIdentity;
  executionRuntime?: ExecutionRuntimeIdentity;
  remoteIdentity?: GitRemoteIdentity;
  validationSandbox?: ValidationSandboxIdentity;
  requiredCheckContractDigest?: string;
  mergeAuthorityDigest?: string;
  identityHistoryDigest?: string;
  executionMode: ExecutionMode;
  configDigest: string;
  releasePlan: {
    version: 1 | 2;
    digest: string;
  };
  digest: string;
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

export type ReleasePlanIssue = ReleasePlanIssueV2;
export type ReleasePlan = ReleasePlanV2;

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
  stdoutBytes?: number;
  stderrBytes?: number;
  outputLimitExceeded?: boolean;
  terminationReason?: "exit" | "signal" | "timeout" | "output_limit";
  commandIdentityDigest?: string;
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

export type ValidationProjectionEntry =
  | { path: string; mode: "100644" | "100755"; byteCount: number; sha256: string }
  | { path: string; mode: "120000"; byteCount: number; sha256: string; linkTarget: string };

export type ValidationReceipt = {
  version: 2 | 3;
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
    oracles: OracleExecutionRef[];
    timeoutMs: number;
  }>;
  projectionFileCount?: number;
  projectionByteCount?: number;
  cleanupCompleted?: boolean;
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

export type ReleaseCompletionV2 = Omit<ReleaseCompletionV1, "schema"> & {
  schema: "herdr-codex-controller:release-completion:v2";
};

export type ReleaseCompletionV3 = Omit<ReleaseCompletionV1, "schema"> & {
  schema: "herdr-codex-controller:release-completion:v3";
  digestAlgorithm: "utf16-code-unit-canonical-json-v1+sha256-hex";
  schemaSha256: string;
  requiredCheckContractDigest: string;
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

export type JobState = {
  version: 2 | 3 | 4;
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
  remoteIdentityDigest?: string | null;
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
  completion: JobCompletionEvidence | null;
  publicCompletion: ReleaseCompletionV3 | null;
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
