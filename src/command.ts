import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandResult } from "./types.js";


export class CommandInterruptedError extends Error {
  readonly signal: string;

  constructor(signal: string) {
    super(`Controller interrupted by ${signal}`);
    this.name = "CommandInterruptedError";
    this.signal = signal;
  }
}

export type RunCommandInput = {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  inheritEnv?: boolean;
  stdin?: string;
  timeoutMs: number;
  terminationGraceMs?: number;
  stdoutPath?: string;
  stderrPath?: string;
  maxTailBytes?: number;
  stdoutByteLimit?: number;
  stderrByteLimit?: number;
  aggregateByteLimit?: number;
  watchedFileLimits?: Array<{ path: string; maxBytes: number }>;
};

export async function runCommand(input: RunCommandInput): Promise<CommandResult> {
  const args = input.args ?? [];
  const startedAt = Date.now();
  const maxTailBytes = input.maxTailBytes ?? 32 * 1024;
  const terminationGraceMs = input.terminationGraceMs ?? 5_000;
  const stdoutByteLimit = byteLimit(input.stdoutByteLimit, "stdoutByteLimit");
  const stderrByteLimit = byteLimit(input.stderrByteLimit, "stderrByteLimit");
  const aggregateByteLimit = byteLimit(input.aggregateByteLimit, "aggregateByteLimit", true);
  const watchedFileLimits = input.watchedFileLimits ?? [];
  for (const watched of watchedFileLimits) byteLimit(watched.maxBytes, "watched file limit");
  if (input.stdoutPath) mkdirSync(dirname(input.stdoutPath), { recursive: true, mode: 0o700 });
  if (input.stderrPath) mkdirSync(dirname(input.stderrPath), { recursive: true, mode: 0o700 });
  const stdoutFd = input.stdoutPath ? openSync(input.stdoutPath, "wx", 0o600) : null;
  const stderrFd = input.stderrPath ? openSync(input.stderrPath, "wx", 0o600) : null;
  const child = spawn(input.command, args, {
    cwd: input.cwd,
    env: commandEnvironment(input.env, input.inheritEnv !== false),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stdoutTail = "";
  let stderrTail = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let persistedStdoutBytes = 0;
  let persistedStderrBytes = 0;
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let timedOut = false;
  let outputLimitExceeded = false;
  let settled = false;
  let ioError: Error | null = null;
  let parentSignal: string | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let killHandle: ReturnType<typeof setTimeout> | null = null;
  let watchHandle: ReturnType<typeof setInterval> | null = null;

  const terminate = async (signal: string): Promise<void> => {
    if (settled || child.pid === undefined) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {}
  };
  const scheduleKill = (): void => {
    if (killHandle === null) {
      killHandle = setTimeout(() => { void terminate("SIGKILL"); }, terminationGraceMs);
    }
  };
  const terminateForOutputLimit = (): void => {
    if (outputLimitExceeded) return;
    outputLimitExceeded = true;
    void terminate("SIGTERM");
    scheduleKill();
  };
  const checkWatchedFiles = (): void => {
    for (const watched of watchedFileLimits) {
      if (!existsSync(watched.path)) continue;
      let stat;
      try { stat = lstatSync(watched.path); }
      catch { terminateForOutputLimit(); continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > watched.maxBytes) {
        terminateForOutputLimit();
      }
    }
  };
  const writeLog = (fd: number | null, chunk: Uint8Array, maximum: number, persisted: number, label: string): number => {
    if (fd === null || ioError) return 0;
    try {
      const aggregatePersisted = persistedStdoutBytes + persistedStderrBytes;
      const allowed = Math.max(0, Math.min(chunk.byteLength, maximum - persisted, aggregateByteLimit - aggregatePersisted));
      let offset = 0;
      while (offset < allowed) offset += writeSync(fd, chunk, offset, allowed - offset);
      return allowed;
    } catch (error) {
      ioError = error instanceof Error ? error : new Error(`${label} write failed`);
      void terminate("SIGTERM");
      scheduleKill();
      return 0;
    }
  };

  child.stdout.on("data", (chunk: Uint8Array) => {
    stdoutHash.update(chunk);
    stdoutBytes += chunk.byteLength;
    persistedStdoutBytes += writeLog(stdoutFd, chunk, stdoutByteLimit, persistedStdoutBytes, "stdout log") ?? 0;
    stdoutTail = appendTail(stdoutTail, chunk, maxTailBytes);
    if (stdoutBytes > stdoutByteLimit || stdoutBytes + stderrBytes > aggregateByteLimit) terminateForOutputLimit();
  });
  child.stderr.on("data", (chunk: Uint8Array) => {
    stderrHash.update(chunk);
    stderrBytes += chunk.byteLength;
    persistedStderrBytes += writeLog(stderrFd, chunk, stderrByteLimit, persistedStderrBytes, "stderr log") ?? 0;
    stderrTail = appendTail(stderrTail, chunk, maxTailBytes);
    if (stderrBytes > stderrByteLimit || stdoutBytes + stderrBytes > aggregateByteLimit) terminateForOutputLimit();
  });
  if (input.stdin !== undefined) child.stdin.end(input.stdin);
  else child.stdin.end();

  const onSignal = (signal: string) => {
    if (parentSignal === null) parentSignal = signal;
    void terminate(signal);
    scheduleKill();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  if (input.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      void terminate("SIGTERM");
      scheduleKill();
    }, input.timeoutMs);
  }
  if (watchedFileLimits.length > 0) {
    watchHandle = setInterval(checkWatchedFiles, 10);
  }

  const outcome = await new Promise<{ exitCode: number | null; signal: string | null }>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (exitCode: number | null, signal: string | null) => {
      checkWatchedFiles();
      resolvePromise({ exitCode, signal });
    });
  }).finally(() => {
    settled = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (killHandle) clearTimeout(killHandle);
    if (watchHandle) clearInterval(watchHandle);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      closeLog(stdoutFd);
    } finally {
      closeLog(stderrFd);
    }
  });
  if (ioError) throw ioError;
  if (parentSignal !== null) throw new CommandInterruptedError(parentSignal);

  return {
    command: input.command,
    args: [...args],
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut,
    durationMs: Math.max(0, Date.now() - startedAt),
    stdoutPath: input.stdoutPath ?? null,
    stderrPath: input.stderrPath ?? null,
    stdoutTail,
    stderrTail,
    stdoutBytes,
    stderrBytes,
    stdoutSha256: `sha256:${stdoutHash.digest("hex")}`,
    stderrSha256: `sha256:${stderrHash.digest("hex")}`,
    outputLimitExceeded,
    terminationReason: outputLimitExceeded ? "output_limit" : timedOut ? "timeout" : outcome.signal ? "signal" : "exit",
  };
}

export function requireCommandSuccess(result: CommandResult, label: string): CommandResult {
  if (result.exitCode === 0 && result.signal === null && !result.timedOut && !result.outputLimitExceeded) return result;
  if (result.outputLimitExceeded) throw new Error(`${label}: output limit exceeded`);
  const diagnostic = result.stderrTail.trim() || result.stdoutTail.trim() || `${result.command} exited ${result.exitCode ?? result.signal ?? "unknown"}`;
  throw new Error(`${label}: ${diagnostic}`);
}

function closeLog(fd: number | null): void {
  if (fd === null) return;
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function appendTail(current: string, chunk: Uint8Array, maxBytes: number): string {
  const next = current + Buffer.from(chunk).toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  const bytes = Buffer.from(next, "utf8");
  return bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString("utf8");
}

function byteLimit(value: number | undefined, label: string, allowZero = false): number {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  return value;
}

function commandEnvironment(
  configured: Record<string, string | undefined> | undefined,
  inherit: boolean,
): Record<string, string> {
  const merged = inherit ? { ...process.env, ...(configured ?? {}) } : { ...(configured ?? {}) };
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
