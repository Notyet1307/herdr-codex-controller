import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { ControllerError } from "./errors.js";
import { ensurePrivateDir, writeBytesAtomic, writeJsonAtomic } from "./fs-atomic.js";
import type { DemoPort, GitPort } from "./ports.js";
import type { ControllerConfig, JobState, ReviewDemoResult } from "./types.js";
import { digestJson, newId, nowIso, pathWithin } from "./util.js";
import { CodexSandboxProvider } from "./validation-sandbox.js";

const MAX_ARTIFACT_FILES = 50;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const MAX_ARTIFACT_FILE_BYTES = 10 * 1024 * 1024;

export class DemoRunner implements DemoPort {
  constructor(
    private readonly config: ControllerConfig,
    private readonly git: GitPort,
  ) {}

  async run(input: { job: JobState; demoRoot: string }): Promise<{ result: ReviewDemoResult; path: string }> {
    const demo = this.config.reviewDemo;
    const sandbox = this.config.validation.sandbox;
    if (!demo || !sandbox || !input.job.candidateSha
      || await this.git.head(input.job.worktreePath) !== input.job.candidateSha
      || !(await this.git.isClean(input.job.worktreePath))) {
      throw new ControllerError("review_demo_candidate_invalid", "Review Demo requires a configured exact clean candidate.");
    }
    const id = newId("review-demo");
    const evidenceRoot = ensurePrivateDir(join(input.demoRoot, id));
    const sandboxRoot = ensurePrivateDir(join(sandbox.root, "review-demo", input.job.id));
    const runRoot = ensurePrivateDir(join(sandboxRoot, id));
    const workspace = join(runRoot, "workspace");
    const provider = new CodexSandboxProvider({
      codexBin: sandbox.bin,
      shell: this.config.shell,
      environmentPath: sandbox.environmentPath,
      deniedReadPaths: [this.config.localPath, this.config.stateDir, this.config.worktreeRoot],
      networkAccess: demo.networkAccess,
      terminationGraceMs: this.config.codex.terminationGraceMs,
    });
    const stdoutPath = join(evidenceRoot, "stdout.log");
    const stderrPath = join(evidenceRoot, "stderr.log");
    let command: Awaited<ReturnType<typeof provider.run>> | null = null;
    let artifacts: ReviewDemoResult["artifacts"] = [];
    let error: string | null = null;
    try {
      const projection = await this.git.createValidationProjection(input.job.worktreePath, workspace);
      command = await provider.run({
        runRoot,
        workspace,
        command: demo.command,
        environment: {
          HERDR_RELEASE_ID: input.job.plan.id,
          HERDR_CANDIDATE_SHA: input.job.candidateSha,
          HERDR_REVIEW_DEMO: "1",
        },
        timeoutMs: demo.timeoutMs,
        stdoutPath,
        stderrPath,
        stdoutByteLimit: demo.maxOutputBytes,
        stderrByteLimit: demo.maxOutputBytes,
        aggregateByteLimit: demo.maxOutputBytes,
      });
      try {
        await this.git.verifyValidationProjection(workspace, projection.manifest);
        artifacts = copyArtifacts(workspace, evidenceRoot);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
    const passed = error === null && command?.exitCode === 0 && command.signal === null
      && !command.timedOut && !command.outputLimitExceeded;
    const body = {
      version: 1 as const,
      id,
      candidateSha: input.job.candidateSha,
      command: demo.command,
      required: demo.required,
      networkAccess: demo.networkAccess,
      sandboxPolicyDigest: provider.policyDigest,
      passed,
      exitCode: command?.exitCode ?? null,
      signal: command?.signal ?? null,
      timedOut: command?.timedOut ?? false,
      outputLimitExceeded: command?.outputLimitExceeded ?? false,
      durationMs: command?.durationMs ?? 0,
      stdoutTail: command?.stdoutTail ?? "",
      stderrTail: command?.stderrTail ?? "",
      artifacts,
      error,
      createdAt: nowIso(),
    };
    const result: ReviewDemoResult = { ...body, digest: digestJson(body) };
    const path = join(evidenceRoot, "result.json");
    writeJsonAtomic(path, result);
    return { result, path };
  }
}

export function assertReviewDemoResult(value: ReviewDemoResult): void {
  const { digest, ...body } = value;
  if (!value || value.version !== 1 || !value.id || !/^[a-f0-9]{40}$/u.test(value.candidateSha)
    || typeof value.command !== "string" || typeof value.required !== "boolean" || typeof value.networkAccess !== "boolean"
    || !/^[a-f0-9]{64}$/u.test(value.sandboxPolicyDigest) || typeof value.passed !== "boolean"
    || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || !Array.isArray(value.artifacts)
    || value.artifacts.length > MAX_ARTIFACT_FILES || digest !== digestJson(body)) {
    throw new Error("review Demo result is invalid");
  }
  let total = 0;
  for (const artifact of value.artifacts) {
    if (!artifact.path.startsWith(".herdr-review-output/") || artifact.path.includes("..")
      || typeof artifact.mediaType !== "string" || !Number.isSafeInteger(artifact.bytes)
      || artifact.bytes < 0 || artifact.bytes > MAX_ARTIFACT_FILE_BYTES) {
      throw new Error("review Demo artifact binding is invalid");
    }
    total += artifact.bytes;
  }
  if (total > MAX_ARTIFACT_BYTES || value.passed !== (
    value.error === null && value.exitCode === 0 && value.signal === null && !value.timedOut && !value.outputLimitExceeded
  )) throw new Error("review Demo result status is invalid");
}

function copyArtifacts(workspace: string, evidenceRoot: string): ReviewDemoResult["artifacts"] {
  const source = join(workspace, ".herdr-review-output");
  if (!existsSync(source)) return [];
  const rootStat = lstatSync(source);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(source) !== source) {
    throw new Error("review Demo output root is unsafe");
  }
  const files: Array<{ source: string; path: string; bytes: number }> = [];
  const pending = [source];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("review Demo output contains a symlink");
      if (stat.isDirectory()) {
        if (realpathSync(path) !== path || !pathWithin(source, path)) throw new Error("review Demo output directory escapes its root");
        pending.push(path);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("review Demo output contains a hardlink, device, FIFO, or socket");
      if (stat.size > MAX_ARTIFACT_FILE_BYTES) throw new Error("review Demo output file exceeds its byte limit");
      const relativePath = relative(source, path).split("\\").join("/");
      if (!relativePath || relativePath.startsWith("../") || relativePath.includes("/../")
        || relativePath.includes("\\") || /[\u0000\r\n]/u.test(relativePath)) {
        throw new Error("review Demo output path escapes its root");
      }
      files.push({ source: path, path: relativePath, bytes: stat.size });
      if (files.length > MAX_ARTIFACT_FILES
        || files.reduce((total, file) => total + file.bytes, 0) > MAX_ARTIFACT_BYTES) {
        throw new Error("review Demo outputs exceed their aggregate limits");
      }
    }
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const destination = ensurePrivateDir(join(evidenceRoot, "artifacts"));
  return files.map((file) => {
    const output = resolve(destination, file.path);
    if (!pathWithin(destination, output)) throw new Error("review Demo artifact destination escapes its root");
    writeBytesAtomic(output, readSafeArtifact(file.source, file.bytes));
    return { path: `.herdr-review-output/${file.path}`, mediaType: mediaType(file.path), bytes: file.bytes };
  });
}

function readSafeArtifact(path: string, expectedBytes: number): Uint8Array {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== expectedBytes) {
    throw new Error("review Demo artifact changed before copy");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== expectedBytes
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("review Demo artifact changed while opening");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (bytes.byteLength !== expectedBytes || after.size !== expectedBytes || after.nlink !== 1
      || pathAfter.isSymbolicLink() || pathAfter.nlink !== 1
      || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) {
      throw new Error("review Demo artifact changed while copying");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function mediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".json": return "application/json";
    case ".html": return "text/html";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".mp4": return "video/mp4";
    case ".txt": case ".log": case ".md": return "text/plain";
    default: return "application/octet-stream";
  }
}
