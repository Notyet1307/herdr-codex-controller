import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CodexRunRecord,
  ControllerConfig,
  JobState,
  ReviewResult,
  RunKind,
  WorkerResult,
} from "./types.js";
import { runCommand } from "./command.js";
import { ensurePrivateDir, writeTextAtomic } from "./fs-atomic.js";
import { digestJson, newId, nowIso } from "./util.js";
import type { GitClient } from "./git.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER_SCHEMA = join(PACKAGE_ROOT, "schemas", "worker-result.schema.json");
const REVIEW_SCHEMA = join(PACKAGE_ROOT, "schemas", "review-result.schema.json");
const WORKER_MODEL = "gpt-5.6-terra";
const WORKER_REASONING_EFFORT = "high";
const REVIEWER_MODEL = "gpt-5.6-sol";
const REVIEWER_REASONING_EFFORT = "max";

export type CodexExecution = {
  record: CodexRunRecord;
  workerResult: WorkerResult | null;
  reviewResult: ReviewResult | null;
};

export class CodexRunner {
  constructor(
    private readonly config: ControllerConfig,
    private readonly git: GitClient,
  ) {}

  async preflight(): Promise<void> {
    const version = await runCommand({
      command: this.config.codex.bin,
      args: ["--version"],
      cwd: this.config.localPath,
      timeoutMs: 30_000,
      maxTailBytes: 64 * 1024,
    });
    if (version.exitCode !== 0) throw new Error(`codex --version failed: ${version.stderrTail || version.stdoutTail}`);
    const auth = await runCommand({
      command: this.config.codex.bin,
      args: ["login", "status"],
      cwd: this.config.localPath,
      timeoutMs: 30_000,
      maxTailBytes: 64 * 1024,
    });
    if (auth.exitCode !== 0) throw new Error(`codex login status failed: ${auth.stderrTail || auth.stdoutTail}`);
  }

  async run(input: {
    job: JobState;
    kind: RunKind;
    issueNumber: number | null;
    prompt: string;
    runsRoot: string;
    runId?: string;
  }): Promise<CodexExecution> {
    const runId = input.runId ?? newId(input.kind);
    const runDir = ensurePrivateDir(join(input.runsRoot, runId));
    const promptPath = join(runDir, "prompt.md");
    const eventsPath = join(runDir, "events.jsonl");
    const stderrPath = join(runDir, "stderr.log");
    const resultPath = join(runDir, "result.json");
    writeTextAtomic(promptPath, input.prompt);
    const isReview = input.kind === "review";
    const baseHeadSha = await this.git.head(input.job.worktreePath);
    const startedAt = nowIso();
    const args = [
      "--ask-for-approval", "never",
      "exec",
      "--ephemeral",
      "--json",
      "--strict-config",
      "--sandbox", isReview ? "read-only" : "workspace-write",
      "--cd", input.job.worktreePath,
      "--config", "sandbox_workspace_write.network_access=false",
      "--config", 'shell_environment_policy.inherit="core"',
      "--config", "shell_environment_policy.ignore_default_excludes=false",
      "--output-schema", isReview ? REVIEW_SCHEMA : WORKER_SCHEMA,
      "--output-last-message", resultPath,
    ];
    const profile = isReview ? this.config.codex.reviewerProfile : this.config.codex.workerProfile;
    if (profile) args.push("--profile", profile);
    args.push("--model", isReview ? REVIEWER_MODEL : WORKER_MODEL);
    args.push(
      "--config",
      `model_reasoning_effort="${isReview ? REVIEWER_REASONING_EFFORT : WORKER_REASONING_EFFORT}"`,
    );
    args.push("-");
    const command = await runCommand({
      command: this.config.codex.bin,
      args,
      cwd: input.job.worktreePath,
      stdin: input.prompt,
      timeoutMs: isReview ? this.config.codex.reviewerTimeoutMs : this.config.codex.workerTimeoutMs,
      terminationGraceMs: this.config.codex.terminationGraceMs,
      stdoutPath: eventsPath,
      stderrPath,
      maxTailBytes: 128 * 1024,
    });
    const finalHeadSha = await this.git.head(input.job.worktreePath);
    const rawResult = existsSync(resultPath) ? readFileSync(resultPath, "utf8") : null;
    let parsed: unknown = null;
    if (rawResult !== null) {
      try { parsed = JSON.parse(rawResult) as unknown; }
      catch { throw new Error(`Codex final result is not valid JSON: ${resultPath}`); }
    }
    const workerResult = !isReview && parsed !== null ? validateWorkerResult(parsed) : null;
    const reviewResult = isReview && parsed !== null ? validateReviewResult(parsed) : null;
    const record: CodexRunRecord = {
      id: runId,
      kind: input.kind,
      issueNumber: input.issueNumber,
      startedAt,
      completedAt: nowIso(),
      baseHeadSha,
      finalHeadSha,
      exitCode: command.exitCode,
      signal: command.signal,
      timedOut: command.timedOut,
      promptPath,
      eventsPath,
      stderrPath,
      resultPath,
      resultDigest: parsed === null ? null : digestJson(parsed),
    };
    return { record, workerResult, reviewResult };
  }
}

export function validateWorkerResult(value: unknown): WorkerResult {
  const object = exactObject(value, ["blockedReason", "residualRisks", "selfReview", "status", "summary", "testsRun"], "worker result");
  if (object.status !== "completed" && object.status !== "blocked") throw new Error("worker result status is invalid");
  const selfReview = exactObject(object.selfReview, ["findingsFixed", "performed", "remainingConcerns"], "worker selfReview");
  if (typeof selfReview.performed !== "boolean") throw new Error("worker selfReview.performed is invalid");
  const tests = array(object.testsRun, "worker testsRun", 30).map((entry, index) => {
    const test = exactObject(entry, ["command", "outcome"], `worker testsRun[${index}]`);
    if (test.outcome !== "passed" && test.outcome !== "failed" && test.outcome !== "not-run") {
      throw new Error("worker test outcome is invalid");
    }
    return {
      command: text(test.command, "worker test command", 1000),
      outcome: test.outcome as "passed" | "failed" | "not-run",
    };
  });
  const result: WorkerResult = {
    status: object.status,
    summary: text(object.summary, "worker summary", 4000),
    selfReview: {
      performed: selfReview.performed,
      findingsFixed: stringArray(selfReview.findingsFixed, "worker findingsFixed", 20, 500),
      remainingConcerns: stringArray(selfReview.remainingConcerns, "worker remainingConcerns", 20, 500),
    },
    testsRun: tests,
    residualRisks: stringArray(object.residualRisks, "worker residualRisks", 20, 500),
    blockedReason: object.blockedReason === null ? null : text(object.blockedReason, "worker blockedReason", 2000),
  };
  if (result.status === "blocked" && !result.blockedReason) throw new Error("blocked worker result requires blockedReason");
  if (result.status === "completed" && result.blockedReason !== null) throw new Error("completed worker result cannot include blockedReason");
  return result;
}

export function validateReviewResult(value: unknown): ReviewResult {
  const object = exactObject(value, ["findings", "status", "summary"], "review result");
  if (object.status !== "pass" && object.status !== "changes" && object.status !== "blocked") {
    throw new Error("review result status is invalid");
  }
  const findings = array(object.findings, "review findings", 50).map((entry, index) => {
    const finding = exactObject(entry, [
      "line", "path", "rationale", "recommendation", "relatedIssues", "severity", "summary",
    ], `review finding[${index}]`);
    if (finding.severity !== "critical" && finding.severity !== "major" && finding.severity !== "minor") {
      throw new Error("review finding severity is invalid");
    }
    if (finding.line !== null && (!Number.isSafeInteger(finding.line) || Number(finding.line) < 1)) {
      throw new Error("review finding line is invalid");
    }
    return {
      severity: finding.severity as "critical" | "major" | "minor",
      path: finding.path === null ? null : text(finding.path, "review finding path", 1000),
      line: finding.line === null ? null : Number(finding.line),
      summary: text(finding.summary, "review finding summary", 1000),
      rationale: text(finding.rationale, "review finding rationale", 2000),
      recommendation: text(finding.recommendation, "review finding recommendation", 2000),
      relatedIssues: array(finding.relatedIssues, "review relatedIssues", 20).map((issue) => {
        if (!Number.isSafeInteger(issue) || Number(issue) < 1) throw new Error("review related issue is invalid");
        return Number(issue);
      }),
    };
  });
  if (object.status === "pass" && findings.some((finding) => finding.severity !== "minor")) {
    throw new Error("pass review cannot contain blocking findings");
  }
  return { status: object.status, summary: text(object.summary, "review summary", 4000), findings };
}

function exactObject(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join(",") !== [...keys].sort().join(",")) throw new Error(`${label} keys are invalid`);
  return object;
}

function array(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} is invalid`);
  return value;
}

function text(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function stringArray(value: unknown, label: string, maximum: number, maximumBytes: number): string[] {
  return array(value, label, maximum).map((entry, index) => text(entry, `${label}[${index}]`, maximumBytes));
}
