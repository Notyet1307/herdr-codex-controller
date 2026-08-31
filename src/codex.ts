import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
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
import { requireCommandSuccess, runCommand } from "./command.js";
import { ensurePrivateDir, writeTextAtomic } from "./fs-atomic.js";
import { digestJson, newId, nowIso } from "./util.js";
import type { GitClient } from "./git.js";
import { ControllerError } from "./errors.js";
import {
  codexRuntimeControlArgs,
  readExecutionRuntimeIdentity,
  REVIEWER_MODEL,
  REVIEWER_REASONING_EFFORT,
  WORKER_MODEL,
  WORKER_REASONING_EFFORT,
} from "./runtime-identity.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER_SCHEMA = join(PACKAGE_ROOT, "schemas", "worker-result.schema.json");
const REVIEW_SCHEMA = join(PACKAGE_ROOT, "schemas", "review-result.schema.json");
const MAX_PROMPT_BYTES = 8 * 1024 * 1024;

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
      stdoutByteLimit: 64 * 1024,
      stderrByteLimit: 64 * 1024,
      aggregateByteLimit: 128 * 1024,
    });
    requireCommandSuccess(version, "codex --version");
    const surface = await runCommand({
      command: this.config.codex.bin,
      args: ["exec", "--help"],
      cwd: this.config.localPath,
      timeoutMs: 30_000,
      maxTailBytes: 128 * 1024,
      stdoutByteLimit: 128 * 1024,
      stderrByteLimit: 64 * 1024,
      aggregateByteLimit: 192 * 1024,
    });
    requireCommandSuccess(surface, "codex exec --help");
    for (const flag of ["--ignore-user-config", "--ignore-rules", "--output-schema", "--output-last-message"]) {
      if (!surface.stdoutTail.includes(flag)) throw new Error(`Codex runtime does not support required flag ${flag}`);
    }
    const auth = await runCommand({
      command: this.config.codex.bin,
      args: ["login", "status"],
      cwd: this.config.localPath,
      timeoutMs: 30_000,
      maxTailBytes: 64 * 1024,
      stdoutByteLimit: 64 * 1024,
      stderrByteLimit: 64 * 1024,
      aggregateByteLimit: 128 * 1024,
    });
    requireCommandSuccess(auth, "codex login status");
  }

  async run(input: {
    job: JobState;
    kind: RunKind;
    issueNumber: number | null;
    prompt: string;
    runsRoot: string;
    runId?: string;
  }): Promise<CodexExecution> {
    if (Buffer.byteLength(input.prompt, "utf8") > MAX_PROMPT_BYTES) {
      throw new ControllerError("codex_prompt_too_large", `Codex prompt exceeds ${MAX_PROMPT_BYTES} bytes.`);
    }
    if (input.job.provenance.version >= 2) {
      const current = readExecutionRuntimeIdentity(this.config);
      if (current.digest !== input.job.provenance.executionRuntime?.digest) {
        throw new ControllerError(
          "execution_runtime_drift",
          "Codex executable bytes, version, profile policy, or fixed runtime controls changed after Job creation.",
        );
      }
    }
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
      ...codexRuntimeControlArgs(this.config, input.job.worktreePath),
      "--json",
      "--strict-config",
      "--sandbox", isReview ? "read-only" : "workspace-write",
      "--cd", input.job.worktreePath,
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
      stdoutByteLimit: this.config.codex.maxEventBytes,
      stderrByteLimit: this.config.codex.maxStderrBytes,
      aggregateByteLimit: Math.max(0, this.config.codex.maxAggregateBytes - this.config.codex.maxResultBytes),
      watchedFileLimits: [{ path: resultPath, maxBytes: this.config.codex.maxResultBytes }],
    });
    const finalHeadSha = await this.git.head(input.job.worktreePath);
    const resultFile = existsSync(resultPath)
      ? readBoundedResult(resultPath, this.config.codex.maxResultBytes)
      : { bytes: null, byteCount: 0, tooLarge: false };
    const aggregateExceeded = command.stdoutBytes + command.stderrBytes + resultFile.byteCount > this.config.codex.maxAggregateBytes;
    const outputLimitExceeded = command.outputLimitExceeded || resultFile.tooLarge || aggregateExceeded;
    if (resultFile.tooLarge && existsSync(resultPath)) unlinkSync(resultPath);
    const rawResult = outputLimitExceeded || resultFile.bytes === null
      ? null
      : Buffer.from(resultFile.bytes).toString("utf8");
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
      outputLimitExceeded,
      terminationReason: outputLimitExceeded ? "output_limit" : command.terminationReason,
      eventsBytes: command.stdoutBytes,
      stderrBytes: command.stderrBytes,
      resultBytes: resultFile.byteCount,
      eventsSha256: command.stdoutSha256,
      stderrSha256: command.stderrSha256,
      promptPath,
      eventsPath,
      stderrPath,
      resultPath,
      resultDigest: parsed === null ? null : digestJson(parsed),
    };
    return { record, workerResult, reviewResult };
  }
}

function readBoundedResult(path: string, maximumBytes: number): {
  bytes: Uint8Array | null;
  byteCount: number;
  tooLarge: boolean;
} {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new ControllerError("codex_result_file_unsafe", "Codex final result is not a safe regular file.");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 0 || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new ControllerError("codex_result_file_unsafe", "Codex final result is not a safe regular file.");
    }
    if (stat.size > maximumBytes) return { bytes: null, byteCount: stat.size, tooLarge: true };
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (after.size !== stat.size || after.nlink !== 1 || bytes.byteLength !== stat.size
      || pathAfter.isSymbolicLink() || pathAfter.nlink !== 1 || pathAfter.dev !== stat.dev || pathAfter.ino !== stat.ino) {
      throw new ControllerError("codex_result_file_unsafe", "Codex final result changed while it was read.");
    }
    return { bytes, byteCount: bytes.byteLength, tooLarge: false };
  } finally {
    closeSync(fd);
  }
}

export function validateWorkerResult(value: unknown): WorkerResult {
  const object = exactObject(value, ["blockedKind", "blockedReason", "observedRiskClasses", "residualRisks", "selfReview", "status", "summary", "testsRun"], "worker result");
  if (object.status !== "completed" && object.status !== "blocked") throw new Error("worker result status is invalid");
  if (object.blockedKind !== null && object.blockedKind !== "recoverable" && object.blockedKind !== "replan_required") {
    throw new Error("worker blockedKind is invalid");
  }
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
    observedRiskClasses: stringArray(object.observedRiskClasses, "worker observedRiskClasses", 16, 64),
    blockedReason: object.blockedReason === null ? null : text(object.blockedReason, "worker blockedReason", 2000),
    blockedKind: object.blockedKind,
  };
  if (result.status === "blocked" && (!result.blockedReason || result.blockedKind === null)) {
    throw new Error("blocked worker result requires blockedReason and blockedKind");
  }
  if (result.status === "completed" && (result.blockedReason !== null || result.blockedKind !== null)) {
    throw new Error("completed worker result cannot include blockedReason or blockedKind");
  }
  if (new Set(result.observedRiskClasses).size !== result.observedRiskClasses.length
    || result.observedRiskClasses.some((risk) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(risk))) {
    throw new Error("worker observedRiskClasses is invalid");
  }
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
  if (new Set(findings.map((finding) => digestJson(finding))).size !== findings.length) {
    throw new Error("review findings contain duplicates");
  }
  const hasBlockingFinding = findings.some((finding) => finding.severity === "critical" || finding.severity === "major");
  if (object.status === "pass" && hasBlockingFinding) {
    throw new Error("pass review cannot contain blocking findings");
  }
  if (object.status === "changes" && !hasBlockingFinding) {
    throw new Error("changes review requires at least one blocking finding");
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
