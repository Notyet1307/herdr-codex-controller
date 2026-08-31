import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { ExecutableIdentity } from "./types.js";
import { sha256, sha256PrefixedUtf8 } from "./util.js";

export function readExecutableIdentity(configuredPath: string, cwd: string, label: string): ExecutableIdentity {
  const realPath = realpathSync(configuredPath);
  const stat = lstatSync(realPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o111) === 0) {
    throw new Error(`${label} is not a safe executable regular file`);
  }
  if (stat.size < 1 || stat.size > 512 * 1024 * 1024) throw new Error(`${label} exceeds its identity byte bound`);
  const before = readFileSync(realPath);
  const beforeDigest = `sha256:${sha256(before)}`;
  const version = spawnSync(realPath, ["--version"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 });
  if (version.status !== 0 || version.signal || version.error) throw new Error(`${label} version probe failed`);
  const versionOutput = String(version.stdout).trim();
  if (!versionOutput || Buffer.byteLength(versionOutput, "utf8") > 4_096) throw new Error(`${label} version output is invalid`);
  const after = readFileSync(realPath);
  const afterStat = lstatSync(realPath);
  if (afterStat.size !== stat.size || afterStat.nlink !== 1 || `sha256:${sha256(after)}` !== beforeDigest) {
    throw new Error(`${label} changed while its identity was read`);
  }
  return {
    configuredPathDigest: sha256PrefixedUtf8(`configured\0${configuredPath}`),
    realPathDigest: sha256PrefixedUtf8(`resolved\0${realPath}`),
    byteCount: stat.size,
    sha256: beforeDigest,
    versionOutput,
  };
}
