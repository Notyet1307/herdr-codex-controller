import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type {
  CodexRunRecord,
  ControllerConfig,
  IssueSnapshot,
  JobState,
  PullRequestState,
  ReleasePlan,
  ReviewResult,
  RunKind,
  WorkerResult,
} from "../src/types.js";
import type { CodexPort, GitHubPort } from "../src/ports.js";
import { digestJson, nowIso } from "../src/util.js";
import { ensurePrivateDir, writeJsonAtomic, writeTextAtomic } from "../src/fs-atomic.js";
import { GitClient } from "../src/git.js";
import { configuredRemoteIdentity } from "../src/remote-identity.js";

export const testSandboxBin = process.env.HERDR_TEST_SANDBOX_BIN ?? resolve("node_modules/.bin/codex");

export type TestRepo = {
  root: string;
  source: string;
  remote: string;
  state: string;
  worktrees: string;
  sandbox: string;
  cleanup(): void;
};

const ORACLE_FIXTURES = [1, 2].map((number) => {
  const suffix = String(number).padStart(2, "0");
  const scriptName = `verify:oracle:o${suffix}`;
  const definition = `node scripts/verify-o${suffix}.mjs`;
  return {
    command: `npm run ${scriptName}`,
    scriptName,
    definition,
    files: [
      { path: `scripts/lib/o${suffix}-helper.mjs`, content: `export const oracleId = "O${suffix}";\n` },
      { path: `scripts/verify-o${suffix}.mjs`, content: `import { oracleId } from "./lib/o${suffix}-helper.mjs";\nif (oracleId !== "O${suffix}") process.exit(1);\n` },
    ],
  };
});

export function createTestRepo(): TestRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-codex-test-")));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const state = join(root, "state");
  const worktrees = join(root, "worktrees");
  const sandbox = realpathSync(mkdtempSync(join("/var/tmp", "herdr-codex-sandbox-test-")));
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(worktrees, { mode: 0o700 });
  git(root, ["init", "--bare", remote]);
  git(root, ["init", source]);
  git(source, ["config", "user.name", "Herdr Test"]);
  git(source, ["config", "user.email", "herdr@example.invalid"]);
  writeFileSync(join(source, "README.md"), "# Fixture\n", "utf8");
  writeFileSync(join(source, "package.json"), `${JSON.stringify({
    scripts: Object.fromEntries(ORACLE_FIXTURES.map(({ scriptName, definition }) => [scriptName, definition])),
  })}\n`, "utf8");
  mkdirSync(join(source, "scripts", "lib"), { recursive: true, mode: 0o700 });
  for (const fixture of ORACLE_FIXTURES) {
    for (const file of fixture.files) writeFileSync(join(source, file.path), file.content, "utf8");
  }
  git(source, ["add", "."]);
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
    sandbox,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

export function testConfig(repo: TestRepo, overrides: Partial<ControllerConfig> = {}): ControllerConfig {
  const base: ControllerConfig = {
    version: 4,
    repo: "example/project",
    localPath: repo.source,
    stateDir: repo.state,
    worktreeRoot: repo.worktrees,
    baseRef: "main",
    remote: "origin",
    remoteIdentity: {
      version: 1,
      fetchUrl: "https://github.com/example/project.git",
      pushUrl: "https://github.com/example/project.git",
    },
    branchPrefix: "agent/release",
    shell: "/bin/bash",
    codex: {
      bin: resolve("node_modules/.bin/codex"),
      workerTimeoutMs: 300_000,
      reviewerTimeoutMs: 300_000,
      terminationGraceMs: 2_000,
      maxEventBytes: 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
      maxResultBytes: 256 * 1024,
      maxAggregateBytes: 2 * 1024 * 1024,
    },
    validation: {
      setup: [],
      issue: [{ command: "test -f issue-$HERDR_ISSUE_NUMBER.txt" }],
      release: [
        { command: ORACLE_FIXTURES[0]!.command, timeoutMs: 45_000 },
        { command: ORACLE_FIXTURES[1]!.command, timeoutMs: 60_000 },
        { command: "test -f README.md" },
      ],
      maxOutputBytes: 64 * 1024,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
      maxAggregateBytes: 96 * 1024,
      sandbox: {
        version: 1,
        provider: "codex-permission-profile",
        bin: testSandboxBin,
        root: repo.sandbox,
        environmentPath: [dirname(realpathSync(process.argv[0]!)), "/usr/bin", "/bin"],
      },
    },
    policy: {
      maxIssueRepairRounds: 1,
      maxCodeRepairRounds: 1,
      maxInfrastructureReruns: 1,
      maxIssues: 8,
      maxChangedFiles: 50,
      maxChangedLines: 4_000,
    },
    reviewDemo: null,
    delivery: {
      draft: false,
      mergeMethod: "squash",
      requiredChecks: {
        version: 1,
        firstAppearanceTimeoutMs: 60_000,
        pendingTimeoutMs: 60_000,
        checks: [{
          name: "verify",
          appId: 15368,
          workflowName: null,
          acceptedConclusions: ["SUCCESS", "NEUTRAL", "SKIPPED"],
          required: true,
        }],
      },
      pollIntervalMs: 1_000,
    },
  };
  return deepMerge(base, overrides);
}

export class TestGitClient extends GitClient {
  constructor(private readonly testControllerConfig: ControllerConfig) {
    super(testControllerConfig);
  }

  override async preflight(): Promise<void> {}

  override async fetchBase(): Promise<string> {
    git(this.testControllerConfig.localPath, ["fetch", "--prune", this.testControllerConfig.remote, this.testControllerConfig.baseRef]);
    return git(this.testControllerConfig.localPath, ["rev-parse", `${this.testControllerConfig.remote}/${this.testControllerConfig.baseRef}^{commit}`]);
  }

  override async push(job: JobState): Promise<void> {
    git(job.worktreePath, ["push", "--no-verify", "--set-upstream", job.remote, job.branch]);
  }

  override async quarantineRemoteBranch(job: JobState, candidateSha: string): Promise<void> {
    const ref = `refs/heads/${job.branch}`;
    const observed = spawnSync("git", ["-C", this.testControllerConfig.localPath, "ls-remote", "--heads", job.remote, ref], { encoding: "utf8" });
    if (observed.status !== 0) throw new Error(String(observed.stderr || "cannot read remote branch"));
    const line = String(observed.stdout).trim();
    if (!line) return;
    const [sha, observedRef] = line.split(/\s+/u);
    if (sha !== candidateSha || observedRef !== ref) throw new Error("remote quarantine branch identity mismatch");
    git(this.testControllerConfig.localPath, ["push", "--no-verify", `--force-with-lease=${ref}:${candidateSha}`, job.remote, `:${ref}`]);
    if (git(this.testControllerConfig.localPath, ["ls-remote", "--heads", job.remote, ref])) {
      throw new Error("remote release branch quarantine was not read back");
    }
  }

  protected override async verifiedRemoteIdentity() {
    return configuredRemoteIdentity(this.testControllerConfig);
  }
}

export function testPlan(repo: TestRepo, issueNumbers = [1, 2]): ReleasePlan {
  return {
    controllerContractVersion: 2,
    id: "release-fixture",
    title: "Fixture release",
    objective: "Implement all fixture issues as one coherent release.",
    repo: "example/project",
    baseRef: "main",
    baseSha: git(repo.source, ["rev-parse", "origin/main"]),
    parentIssue: 100,
    issues: issueNumbers.map((number, index) => ({
      number,
      order: index + 1,
      dependsOn: index === 0 ? [] : [issueNumbers[index - 1]!],
      objective: `Implement fixture issue ${number}.`,
      acceptanceCriteria: [`issue-${number}.txt exists`],
      expectedPaths: index === 0 ? [`issue-${number}.txt`, "hardening.txt"] : [`issue-${number}.txt`],
      scopeBudget: { maxFiles: 10, maxChangedLines: 1_000 },
      risk: "normal",
      oracleCommands: [],
    })),
    releaseAcceptanceCriteria: ["All issue files exist."],
    reviewFocus: ["Cross-issue correctness."],
  };
}

export function highRiskPlan(repo: TestRepo, issueNumbers = [1, 2]): ReleasePlan {
  const plan = testPlan(repo, issueNumbers);
  plan.id = "high-risk-release-fixture";
  plan.title = "High-risk fixture release";
  plan.issues.forEach((issue, index) => {
    issue.risk = "high";
    issue.oracleCommands = [ORACLE_FIXTURES[index]!.command];
  });
  return plan;
}

export function writeInputs(repo: TestRepo, config: ControllerConfig, plan: ReleasePlan): { configPath: string; planPath: string } {
  const configPath = join(repo.root, "config.json");
  const planPath = join(repo.root, "plan.json");
  writeJsonAtomic(configPath, config);
  writeJsonAtomic(planPath, plan);
  return { configPath, planPath };
}

export function configInput(config: ControllerConfig): Record<string, unknown> {
  return structuredClone(config) as unknown as Record<string, unknown>;
}

export class FakeGitHub implements GitHubPort {
  async preflight(): Promise<void> {}
  async fetchIssue(number: number): Promise<IssueSnapshot> {
    const identity = {
      number,
      title: `Issue ${number}`,
      state: "OPEN" as const,
      labels: ["ready"],
      assignees: [],
      url: `https://github.com/example/project/issues/${number}`,
      fetchedAt: nowIso(),
    };
    return { ...identity, digest: digestJson(identity) };
  }
  async findPullRequest(_job: JobState): Promise<PullRequestState | null> { return null; }
  async createPullRequest(_job: JobState, _deliveryRoot: string, _body: string): Promise<PullRequestState> { throw new Error("not used"); }
  async inspectPullRequest(_number: number): Promise<{ pullRequest: PullRequestState; checks: any; mergedAt: string | null }> { throw new Error("not used"); }
  async baseAllowsUpToDateAutoMerge(): Promise<boolean> { return true; }
  async enableAutoMerge(_number: number, _candidateSha: string): Promise<void> { throw new Error("not used"); }
  async disableAutoMerge(_number: number, _candidateSha: string): Promise<void> { throw new Error("not used"); }
  async fetchCheckFailureEvidence(_check: any, _candidateSha: string): Promise<any> { throw new Error("not used"); }
  async rerunCheck(_check: any, _candidateSha: string): Promise<void> { throw new Error("not used"); }
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
  async run(input: { job: JobState; kind: RunKind; issueNumber: number | null; prompt: string; runsRoot: string; runId?: string }) {
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
      workerResult = completedWorker(`Implemented Issue #${input.issueNumber}.`);
    }
    if (input.kind === "release-repair" && !workerResult) {
      writeFileSync(join(input.job.worktreePath, "hardening.txt"), `hardening ${invocation}\n`, "utf8");
      workerResult = completedWorker("Applied release repair.");
    }
    if (input.kind === "review" && !reviewResult) reviewResult = { status: "pass", summary: "Aggregate candidate passes.", findings: [] };
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

export function completedWorker(summary: string): WorkerResult {
  return {
    status: "completed",
    summary,
    selfReview: { performed: true, findingsFixed: [], remainingConcerns: [] },
    testsRun: [],
    residualRisks: [],
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
