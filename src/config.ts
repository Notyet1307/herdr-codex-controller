import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CommandConfig, ControllerConfig, ExecutionMode } from "./types.js";
import {
  assertAbsolutePath,
  boundedText,
  parsePositiveInteger,
  pathWithin,
} from "./util.js";

export function loadConfig(path: string): ControllerConfig {
  const absolute = resolve(path);
  const value = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
  return validateConfig(value, absolute);
}

export function validateConfig(value: unknown, sourcePath = "config.json"): ControllerConfig {
  const root = expectObject(value, "config");
  expectExactKeys(root, [
    "baseRef", "branchPrefix", "codex", "delivery", "executionMode", "localPath", "policy", "remote", "repo",
    "review", "shell", "stateDir", "validation", "version", "worktreeRoot",
  ], "config", ["executionMode"]);
  if (root.version !== 1) throw new Error("config.version must be 1");
  const repo = boundedText(root.repo, "config.repo", 300);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("config.repo must be OWNER/REPO");
  const localPath = assertAbsolutePath(boundedText(root.localPath, "config.localPath", 4096), "config.localPath");
  const stateDir = assertAbsolutePath(boundedText(root.stateDir, "config.stateDir", 4096), "config.stateDir");
  const worktreeRoot = assertAbsolutePath(boundedText(root.worktreeRoot, "config.worktreeRoot", 4096), "config.worktreeRoot");
  if (pathsOverlap(localPath, stateDir) || pathsOverlap(localPath, worktreeRoot) || pathsOverlap(stateDir, worktreeRoot)) {
    throw new Error("localPath, stateDir, and worktreeRoot must not overlap");
  }
  if (existsSync(localPath)) {
    const stat = lstatSync(localPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(localPath) !== localPath) {
      throw new Error("config.localPath must be a canonical directory");
    }
  }
  const baseRef = safeGitName(root.baseRef, "config.baseRef");
  const remote = safeGitName(root.remote, "config.remote");
  const branchPrefix = boundedText(root.branchPrefix, "config.branchPrefix", 120);
  if (!/^[A-Za-z0-9._/-]+$/.test(branchPrefix) || branchPrefix.startsWith("/") || branchPrefix.endsWith("/")) {
    throw new Error("config.branchPrefix is not a safe branch prefix");
  }
  const shell = boundedText(root.shell, "config.shell", 4096);
  const codex = validateCodex(root.codex);
  const validation = validateValidation(root.validation);
  const policy = validatePolicy(root.policy);
  const review = validateReview(root.review);
  const delivery = validateDelivery(root.delivery);
  if (!review.enabled && policy.maxReleaseHardeningRounds > 0) {
    // Hardening can still repair release validation/CI; this is intentionally allowed.
  }
  return {
    version: 1,
    executionMode: validateExecutionMode(root.executionMode),
    repo,
    localPath,
    stateDir,
    worktreeRoot,
    baseRef,
    remote,
    branchPrefix,
    shell,
    codex,
    validation,
    policy,
    review,
    delivery,
  };
}

function validateExecutionMode(value: unknown): ExecutionMode {
  if (value === undefined) return "release-plan-v2-direct";
  if (value !== "release-plan-v2-direct"
    && value !== "release-plan-v1-compatibility"
    && value !== "dispatcher-experimental") {
    throw new Error("config.executionMode must be release-plan-v2-direct, release-plan-v1-compatibility, or dispatcher-experimental");
  }
  return value;
}

function validateCodex(value: unknown): ControllerConfig["codex"] {
  const object = expectObject(value, "config.codex");
  expectExactKeys(object, [
    "bin", "networkAccess", "reviewerProfile", "reviewerTimeoutMs", "terminationGraceMs",
    "workerProfile", "workerTimeoutMs",
  ], "config.codex");
  if (object.networkAccess !== false) throw new Error("config.codex.networkAccess must be false in v1");
  return {
    bin: boundedText(object.bin, "config.codex.bin", 4096),
    workerProfile: nullableText(object.workerProfile, "config.codex.workerProfile", 200),
    reviewerProfile: nullableText(object.reviewerProfile, "config.codex.reviewerProfile", 200),
    workerTimeoutMs: parsePositiveInteger(object.workerTimeoutMs, "config.codex.workerTimeoutMs", 60_000, 8 * 60 * 60 * 1000),
    reviewerTimeoutMs: parsePositiveInteger(object.reviewerTimeoutMs, "config.codex.reviewerTimeoutMs", 60_000, 4 * 60 * 60 * 1000),
    terminationGraceMs: parsePositiveInteger(object.terminationGraceMs, "config.codex.terminationGraceMs", 1_000, 60_000),
    networkAccess: false,
  };
}

function validateValidation(value: unknown): ControllerConfig["validation"] {
  const object = expectObject(value, "config.validation");
  expectExactKeys(object, ["issue", "maxOutputBytes", "release", "setup"], "config.validation");
  return {
    setup: validateCommands(object.setup, "config.validation.setup", 30),
    issue: validateCommands(object.issue, "config.validation.issue", 50),
    release: validateCommands(object.release, "config.validation.release", 50),
    maxOutputBytes: parsePositiveInteger(object.maxOutputBytes, "config.validation.maxOutputBytes", 4_096, 8 * 1024 * 1024),
  };
}

function validatePolicy(value: unknown): ControllerConfig["policy"] {
  const object = expectObject(value, "config.policy");
  expectExactKeys(object, [
    "maxChangedFiles", "maxChangedLines", "maxCiRepairRounds", "maxIssueRepairRounds",
    "maxIssues", "maxReleaseHardeningRounds",
  ], "config.policy");
  return {
    maxIssueRepairRounds: parsePositiveInteger(object.maxIssueRepairRounds, "config.policy.maxIssueRepairRounds", 0, 2),
    maxReleaseHardeningRounds: parsePositiveInteger(object.maxReleaseHardeningRounds, "config.policy.maxReleaseHardeningRounds", 0, 2),
    maxCiRepairRounds: parsePositiveInteger(object.maxCiRepairRounds, "config.policy.maxCiRepairRounds", 0, 1),
    maxIssues: parsePositiveInteger(object.maxIssues, "config.policy.maxIssues", 1, 50),
    maxChangedFiles: parsePositiveInteger(object.maxChangedFiles, "config.policy.maxChangedFiles", 1, 1000),
    maxChangedLines: parsePositiveInteger(object.maxChangedLines, "config.policy.maxChangedLines", 1, 100_000),
  };
}

function validateReview(value: unknown): ControllerConfig["review"] {
  const object = expectObject(value, "config.review");
  expectExactKeys(object, ["blockingSeverities", "enabled"], "config.review");
  if (typeof object.enabled !== "boolean") throw new Error("config.review.enabled must be boolean");
  if (!Array.isArray(object.blockingSeverities) || object.blockingSeverities.length === 0) {
    throw new Error("config.review.blockingSeverities must be a non-empty array");
  }
  const severities = object.blockingSeverities.map((entry) => {
    if (entry !== "critical" && entry !== "major") throw new Error("blocking severity must be critical or major");
    return entry;
  });
  return { enabled: object.enabled, blockingSeverities: [...new Set(severities)] };
}

function validateDelivery(value: unknown): ControllerConfig["delivery"] {
  const object = expectObject(value, "config.delivery");
  expectExactKeys(object, [
    "allowNoChecks", "autoMerge", "createPullRequest", "draft", "mergeMethod", "pollIntervalMs",
  ], "config.delivery");
  for (const key of ["allowNoChecks", "autoMerge", "createPullRequest", "draft"] as const) {
    if (typeof object[key] !== "boolean") throw new Error(`config.delivery.${key} must be boolean`);
  }
  if (!object.createPullRequest && object.autoMerge) throw new Error("autoMerge requires createPullRequest");
  if (object.mergeMethod !== "merge" && object.mergeMethod !== "squash" && object.mergeMethod !== "rebase") {
    throw new Error("config.delivery.mergeMethod must be merge, squash, or rebase");
  }
  return {
    createPullRequest: object.createPullRequest as boolean,
    draft: object.draft as boolean,
    autoMerge: object.autoMerge as boolean,
    mergeMethod: object.mergeMethod,
    allowNoChecks: object.allowNoChecks as boolean,
    pollIntervalMs: parsePositiveInteger(object.pollIntervalMs, "config.delivery.pollIntervalMs", 1_000, 10 * 60_000),
  };
}

export function validateCommands(value: unknown, label: string, maximum: number): CommandConfig[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must contain at most ${maximum} commands`);
  return value.map((entry, index) => {
    if (typeof entry === "string") return { command: boundedText(entry, `${label}[${index}]`, 8_192) };
    const object = expectObject(entry, `${label}[${index}]`);
    expectExactKeys(object, ["command", "timeoutMs"], `${label}[${index}]`, ["timeoutMs"]);
    return {
      command: boundedText(object.command, `${label}[${index}].command`, 8_192),
      ...(object.timeoutMs === undefined ? {} : {
        timeoutMs: parsePositiveInteger(object.timeoutMs, `${label}[${index}].timeoutMs`, 1_000, 8 * 60 * 60 * 1000),
      }),
    };
  });
}

export function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function expectExactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
  optional: string[] = [],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  const optionalSet = new Set(optional);
  const missing = allowed.filter((key) => !optionalSet.has(key) && !(key in value));
  if (missing.length > 0) throw new Error(`${label} is missing keys: ${missing.join(", ")}`);
}

function nullableText(value: unknown, label: string, maximumBytes: number): string | null {
  if (value === null) return null;
  return boundedText(value, label, maximumBytes);
}

function safeGitName(value: unknown, label: string): string {
  const text = boundedText(value, label, 300);
  if (!/^[A-Za-z0-9._/-]+$/.test(text) || text.includes("..") || text.startsWith("/") || text.endsWith("/")) {
    throw new Error(`${label} is not a safe Git name`);
  }
  return text;
}

function pathsOverlap(left: string, right: string): boolean {
  return pathWithin(left, right) || pathWithin(right, left);
}
