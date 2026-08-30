import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type {
  CodexRunRecord,
  ControllerConfig,
  IssueSnapshot,
  JobState,
  PullRequestState,
  QueueIssue,
  ReleasePlan,
  ReleasePlanV2,
  ReviewResult,
  RunKind,
  WorkerResult,
  WorkflowGateSummary,
} from "../src/types.js";
import type { CodexPort, GitHubPort } from "../src/ports.js";
import { isReleasePlanV2 } from "../src/plan.js";
import { digestJson, nowIso, sha256PrefixedUtf8 } from "../src/util.js";
import { ensurePrivateDir, writeJsonAtomic, writeTextAtomic } from "../src/fs-atomic.js";
import type { GitClient } from "../src/git.js";

export type TestRepo = {
  root: string;
  source: string;
  remote: string;
  state: string;
  worktrees: string;
  cleanup(): void;
};

export function createTestRepo(): TestRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-codex-test-")));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const state = join(root, "state");
  const worktrees = join(root, "worktrees");
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(worktrees, { mode: 0o700 });
  git(root, ["init", "--bare", remote]);
  git(root, ["init", source]);
  git(source, ["config", "user.name", "Herdr Test"]);
  git(source, ["config", "user.email", "herdr@example.invalid"]);
  writeFileSync(join(source, "README.md"), "# Fixture\n", "utf8");
  writeFileSync(join(source, "package.json"), `${JSON.stringify({ scripts: { "verify:oracle": "node -e \"\"" } })}\n`, "utf8");
  mkdirSync(join(source, "fixtures"), { mode: 0o700 });
  writeFileSync(join(source, "fixtures", "oracle.json"), "{\"ok\":true}\n", "utf8");
  git(source, ["add", "README.md", "package.json", "fixtures/oracle.json"]);
  git(source, ["commit", "-m", "initial"]);
  git(source, ["branch", "-M", "main"]);
  git(source, ["remote", "add", "origin", remote]);
  git(source, ["push", "-u", "origin", "main"]);
  return {
    root,
    source: realpathSync(source),
    remote,
    state: realpathSync(state),
    worktrees: realpathSync(worktrees),
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

export function testConfig(repo: TestRepo, overrides: Partial<ControllerConfig> = {}): ControllerConfig {
  const base: ControllerConfig = {
    version: 1,
    executionMode: "release-plan-v1-compatibility",
    repo: "example/project",
    localPath: repo.source,
    stateDir: repo.state,
    worktreeRoot: repo.worktrees,
    baseRef: "main",
    remote: "origin",
    branchPrefix: "agent/release",
    shell: "/bin/bash",
    codex: {
      bin: "codex",
      workerProfile: null,
      reviewerProfile: null,
      workerTimeoutMs: 300_000,
      reviewerTimeoutMs: 300_000,
      terminationGraceMs: 2_000,
      networkAccess: false,
    },
    validation: {
      setup: [],
      issue: [{ command: "test -f issue-$HERDR_ISSUE_NUMBER.txt" }],
      release: [{ command: "test -f issue-1.txt && test -f issue-2.txt" }],
      maxOutputBytes: 64 * 1024,
    },
    policy: {
      maxIssueRepairRounds: 1,
      maxReleaseHardeningRounds: 1,
      maxCiRepairRounds: 0,
      maxIssues: 8,
      maxChangedFiles: 50,
      maxChangedLines: 4_000,
    },
    review: { enabled: true, blockingSeverities: ["critical", "major"] },
    delivery: {
      createPullRequest: false,
      draft: false,
      autoMerge: false,
      mergeMethod: "squash",
      allowNoChecks: false,
      requiredChecks: [],
      pollIntervalMs: 1_000,
    },
  };
  const merged = deepMerge(base, overrides);
  if (merged.executionMode === "release-plan-v2-direct" && overrides.delivery === undefined) {
    merged.delivery.createPullRequest = true;
    merged.delivery.allowNoChecks = false;
    merged.delivery.requiredChecks = ["verify"];
  }
  if (!merged.validation.release.some(({ command }) => command === "npm run verify:oracle")) {
    merged.validation.release.unshift({ command: "npm run verify:oracle" });
  }
  return merged;
}

export function testPlan(issueNumbers = [1, 2]): ReleasePlan {
  return {
    version: 1,
    id: "release-fixture",
    title: "Fixture release",
    objective: "Implement all fixture issues as one coherent release.",
    parentIssue: null,
    issues: issueNumbers.map((number, index) => ({
      number,
      order: index + 1,
      dependsOn: index === 0 ? [] : [issueNumbers[index - 1]!],
      objective: `Implement fixture issue ${number}.`,
      acceptanceCriteria: [`issue-${number}.txt exists`],
      suggestedValidation: [],
      allowNoop: false,
    })),
    releaseAcceptanceCriteria: ["All issue files exist."],
    reviewFocus: ["Cross-issue correctness."],
  };
}

export function testPlanV2(repo: TestRepo, issueNumbers = [1, 2]): ReleasePlanV2 {
  const parentIssue = 100;
  return {
    version: 2,
    source: {
      planner: "pi-ticket-planning",
      repo: "example/project",
      baseRef: "main",
      baseSha: git(repo.source, ["rev-parse", "origin/main"]),
      parentBinding: {
        number: parentIssue,
        expectedTitle: `Issue ${parentIssue}`,
        expectedBodyHash: sha256PrefixedUtf8(`Create issue-${parentIssue}.txt.`),
      },
      specContentHash: sha256PrefixedUtf8("fixture specification"),
      deliveryGraphDigest: sha256PrefixedUtf8("fixture delivery graph"),
      decisionManifestDigest: sha256PrefixedUtf8("fixture decision manifest"),
      predecessorReceiptDigest: null,
      dependencyHandoffDigests: [],
    },
    id: "release-fixture-v2",
    title: "Source-bound fixture release",
    objective: "Implement the exact source-bound fixture issues as one coherent release.",
    parentIssue,
    issues: issueNumbers.map((number, index) => ({
      number,
      order: index + 1,
      dependsOn: index === 0 ? [] : [issueNumbers[index - 1]!],
      objective: `Implement exact fixture issue ${number}.`,
      acceptanceCriteria: [
        `issue-${number}.txt exists`,
        `Issue ${number} behavior is covered`,
        `Issue ${number} remains compatible`,
      ],
      suggestedValidation: [],
      allowNoop: false,
      expectedTitle: `Issue ${number}`,
      expectedBodyHash: sha256PrefixedUtf8(`Create issue-${number}.txt.`),
      oracleBindings: [{
        schema: "pi-ticket-planning:oracle-binding:v1",
        id: `O0${index + 1}`,
        owner: { kind: "INDEPENDENT_VERIFICATION", identity: "fixture-reviewer" },
        artifact: {
          path: "fixtures/oracle.json",
          format: "fixture.oracle/v1",
          baseSha: git(repo.source, ["rev-parse", "origin/main"]),
          sha256: sha256PrefixedUtf8("{\"ok\":true}\n"),
          byteCount: Buffer.byteLength("{\"ok\":true}\n", "utf8"),
        },
        execution: { command: "npm run verify:oracle" },
        workerMutationAllowed: false,
      }],
      riskClasses: ["FIXTURE_BEHAVIOR"],
      scopeBudget: { maxFiles: 8, maxChangedLines: 1_500 },
      expectedPaths: [`issue-${number}.txt`],
      protectedPaths: ["fixtures/oracle.json"],
      replanTriggers: [
        "ACCEPTED_DECISION_CHANGE_REQUIRED",
        "THIRD_RISK_CLASS_DISCOVERED",
        "SCOPE_BUDGET_EXCEEDED",
        "DOWNSTREAM_RELEASE_BEHAVIOR_DISCOVERED",
      ],
      integrationOnly: null,
      waiverDigests: [],
    })),
    releaseAcceptanceCriteria: ["All exact source-bound issue files exist."],
    reviewFocus: ["Cross-issue correctness."],
  };
}

export function writeInputs(repo: TestRepo, config: ControllerConfig, plan: ReleasePlan): { configPath: string; planPath: string } {
  const configPath = join(repo.root, "config.json");
  const planPath = join(repo.root, "plan.json");
  writeJsonAtomic(configPath, config);
  writeJsonAtomic(planPath, plan);
  return { configPath, planPath };
}

export class FakeGitHub implements GitHubPort {
  async preflight(): Promise<void> {}
  async fetchIssue(number: number): Promise<IssueSnapshot> {
    const identity = {
      number,
      title: `Issue ${number}`,
      body: `Create issue-${number}.txt.`,
      state: "OPEN" as const,
      labels: ["ready"],
      assignees: [],
      url: `https://github.com/example/project/issues/${number}`,
      fetchedAt: nowIso(),
    };
    return { ...identity, digest: digestJson(identity) };
  }
  async findPullRequest(_job: JobState): Promise<PullRequestState | null> { return null; }
  async createPullRequest(_job: JobState, _deliveryRoot: string): Promise<PullRequestState> { throw new Error("not used"); }
  async inspectPullRequest(_number: number): Promise<{ pullRequest: PullRequestState; checks: any; mergedAt: string | null }> { throw new Error("not used"); }
  async baseAllowsUpToDateAutoMerge(): Promise<boolean> { return true; }
  async enableAutoMerge(_number: number, _candidateSha: string): Promise<void> { throw new Error("not used"); }
  async currentLogin(): Promise<string> { return "test-user"; }
  async listSubIssues(_parentIssue: number): Promise<QueueIssue[]> { return []; }
  async fetchQueueIssue(_number: number): Promise<QueueIssue> { throw new Error("not used"); }
  async claimIssue(_number: number, _login: string): Promise<void> { throw new Error("not used"); }
  async inspectWorkflowGate(_sha: string, _requiredWorkflows: string[]): Promise<WorkflowGateSummary> {
    throw new Error("not used");
  }
}

export type FakeCodexBehavior = (input: {
  job: JobState;
  kind: RunKind;
  issueNumber: number | null;
  prompt: string;
  invocation: number;
}) => Promise<{ worker?: WorkerResult; review?: ReviewResult }>;

export class FakeCodex implements CodexPort {
  readonly calls: Array<{ kind: RunKind; issueNumber: number | null }> = [];
  constructor(private readonly gitClient: GitClient, private readonly behavior?: FakeCodexBehavior) {}
  async preflight(): Promise<void> {}
  async run(input: {
    job: JobState;
    kind: RunKind;
    issueNumber: number | null;
    prompt: string;
    runsRoot: string;
    runId?: string;
  }) {
    this.calls.push({ kind: input.kind, issueNumber: input.issueNumber });
    const invocation = this.calls.length;
    const runId = input.runId ?? `fake-${invocation}`;
    const runDir = ensurePrivateDir(join(input.runsRoot, runId));
    const promptPath = join(runDir, "prompt.md");
    const eventsPath = join(runDir, "events.jsonl");
    const stderrPath = join(runDir, "stderr.log");
    const resultPath = join(runDir, "result.json");
    writeTextAtomic(promptPath, input.prompt);
    writeTextAtomic(eventsPath, `${JSON.stringify({ type: "fake", kind: input.kind })}\n`);
    writeTextAtomic(stderrPath, "");
    const baseHeadSha = await this.gitClient.head(input.job.worktreePath);
    const custom = this.behavior ? await this.behavior({ ...input, invocation }) : {};
    let workerResult: WorkerResult | null = custom.worker ?? null;
    let reviewResult: ReviewResult | null = custom.review ?? null;
    if ((input.kind === "worker" || input.kind === "issue-repair") && !workerResult) {
      writeFileSync(join(input.job.worktreePath, `issue-${input.issueNumber}.txt`), `issue ${input.issueNumber}\n`, "utf8");
      const risks = isReleasePlanV2(input.job.plan)
        ? input.job.plan.issues.find((issue) => issue.number === input.issueNumber)?.riskClasses ?? []
        : [];
      workerResult = completedWorker(`Implemented Issue #${input.issueNumber}.`, risks);
    }
    if (input.kind === "release-harden" && !workerResult) {
      writeFileSync(join(input.job.worktreePath, "hardening.txt"), `hardening ${invocation}\n`, "utf8");
      const risks = isReleasePlanV2(input.job.plan)
        ? [...new Set(input.job.plan.issues.flatMap((issue) => issue.riskClasses))]
        : [];
      workerResult = completedWorker("Applied release hardening.", risks);
    }
    if (input.kind === "review" && !reviewResult) {
      reviewResult = { status: "pass", summary: "Aggregate candidate passes.", findings: [] };
    }
    const result = input.kind === "review" ? reviewResult : workerResult;
    writeJsonAtomic(resultPath, result);
    const finalHeadSha = await this.gitClient.head(input.job.worktreePath);
    const record: CodexRunRecord = {
      id: runId,
      kind: input.kind,
      issueNumber: input.issueNumber,
      startedAt: nowIso(),
      completedAt: nowIso(),
      baseHeadSha,
      finalHeadSha,
      exitCode: 0,
      signal: null,
      timedOut: false,
      promptPath,
      eventsPath,
      stderrPath,
      resultPath,
      resultDigest: digestJson(result),
    };
    return { record, workerResult, reviewResult };
  }
}

export function completedWorker(summary: string, observedRiskClasses: string[] = []): WorkerResult {
  return {
    status: "completed",
    summary,
    selfReview: { performed: true, findingsFixed: [], remainingConcerns: [] },
    testsRun: [],
    residualRisks: [],
    observedRiskClasses,
    blockedReason: null,
    blockedKind: null,
  };
}

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return String(result.stdout ?? "").trim();
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (!override || typeof override !== "object" || Array.isArray(override)) return (override as T) ?? base;
  const output: any = { ...(base as any) };
  for (const [key, value] of Object.entries(override as any)) {
    if (value && typeof value === "object" && !Array.isArray(value) && output[key] && typeof output[key] === "object") {
      output[key] = deepMerge(output[key], value);
    } else output[key] = value;
  }
  return output;
}
