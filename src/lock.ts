import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ensurePrivateDir } from "./fs-atomic.js";
import { nowIso } from "./util.js";

type LockRecord = { pid: number; createdAt: string };

export async function withControllerLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  const path = resolve(lockPath);
  ensurePrivateDir(dirname(path));
  const fd = acquire(path);
  try {
    return await operation();
  } finally {
    try { closeSync(fd); } catch {}
    try {
      const holder = readLock(path);
      if (holder.pid === process.pid) unlinkSync(path);
    } catch {}
  }
}

function acquire(path: string): number {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: nowIso() })}\n`, "utf8");
      return fd;
    } catch (error) {
      if (!existsSync(path)) throw error;
      const holder = readLock(path);
      if (processAlive(holder.pid)) {
        throw new Error(`controller lock is already held by pid ${holder.pid} since ${holder.createdAt}`);
      }
      // Only remove a syntactically valid lock whose recorded process is definitely absent.
      unlinkSync(path);
    }
  }
  throw new Error("controller lock could not be acquired after stale-lock recovery");
}

function readLock(path: string): LockRecord {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("controller lock is malformed; remove it only after proving no Controller is running");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("controller lock is invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "createdAt,pid"
    || !Number.isSafeInteger(record.pid) || Number(record.pid) < 1
    || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new Error("controller lock identity is invalid");
  }
  return { pid: Number(record.pid), createdAt: record.createdAt };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ESRCH") return false;
    // EPERM means the process exists but cannot be signalled.
    return true;
  }
}
