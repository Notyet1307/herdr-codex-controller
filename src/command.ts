import { spawn } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
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
  stdin?: string;
  timeoutMs: number;
  terminationGraceMs?: number;
  stdoutPath?: string;
  stderrPath?: string;
  maxTailBytes?: number;
};

export async function runCommand(input: RunCommandInput): Promise<CommandResult> {
  const args = input.args ?? [];
  const startedAt = Date.now();
  const maxTailBytes = input.maxTailBytes ?? 32 * 1024;
  const terminationGraceMs = input.terminationGraceMs ?? 5_000;
  if (input.stdoutPath) mkdirSync(dirname(input.stdoutPath), { recursive: true, mode: 0o700 });
  if (input.stderrPath) mkdirSync(dirname(input.stderrPath), { recursive: true, mode: 0o700 });
  const stdoutFd = input.stdoutPath ? openSync(input.stdoutPath, "wx", 0o600) : null;
  const stderrFd = input.stderrPath ? openSync(input.stderrPath, "wx", 0o600) : null;
  const child = spawn(input.command, args, {
    cwd: input.cwd,
    env: { ...process.env, ...(input.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stdoutTail = "";
  let stderrTail = "";
  let timedOut = false;
  let settled = false;
  let ioError: Error | null = null;
  let parentSignal: string | null = null;

  const terminate = async (signal: string): Promise<void> => {
    if (settled || child.pid === undefined) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {}
  };
  const writeLog = (fd: number | null, chunk: Uint8Array, label: string): void => {
    if (fd === null || ioError) return;
    try {
      writeSync(fd, chunk);
    } catch (error) {
      ioError = error instanceof Error ? error : new Error(`${label} write failed`);
      void terminate("SIGTERM");
    }
  };

  child.stdout.on("data", (chunk: Uint8Array) => {
    writeLog(stdoutFd, chunk, "stdout log");
    stdoutTail = appendTail(stdoutTail, chunk, maxTailBytes);
  });
  child.stderr.on("data", (chunk: Uint8Array) => {
    writeLog(stderrFd, chunk, "stderr log");
    stderrTail = appendTail(stderrTail, chunk, maxTailBytes);
  });
  if (input.stdin !== undefined) child.stdin.end(input.stdin);
  else child.stdin.end();

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let killHandle: ReturnType<typeof setTimeout> | null = null;
  const onSignal = (signal: string) => {
    if (parentSignal === null) parentSignal = signal;
    void terminate(signal);
    if (killHandle === null) {
      killHandle = setTimeout(() => { void terminate("SIGKILL"); }, terminationGraceMs);
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  if (input.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      void terminate("SIGTERM");
      if (killHandle === null) {
        killHandle = setTimeout(() => { void terminate("SIGKILL"); }, terminationGraceMs);
      }
    }, input.timeoutMs);
  }

  const outcome = await new Promise<{ exitCode: number | null; signal: string | null }>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (exitCode: number | null, signal: string | null) => resolvePromise({ exitCode, signal }));
  }).finally(() => {
    settled = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (killHandle) clearTimeout(killHandle);
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
  };
}

export function requireCommandSuccess(result: CommandResult, label: string): CommandResult {
  if (result.exitCode === 0 && result.signal === null && !result.timedOut) return result;
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
