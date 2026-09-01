import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { CommandConfig, ControllerConfig, RequiredCheckContractV1, ValidationBootstrapConfig } from "./types.js";
import { assertAbsolutePath, boundedStringArray, boundedText, parsePositiveInteger, pathWithin } from "./util.js";
import { parseRemoteIdentityContract } from "./remote-identity.js";

export function loadConfig(path: string): ControllerConfig {
  return validateConfig(JSON.parse(readFileSync(resolve(path), "utf8")) as unknown, resolve(path));
}

export function validateConfig(value: unknown, _sourcePath = "config.json"): ControllerConfig {
  const root = expectObject(value, "config");
  expectExactKeys(root, [
    "baseRef", "branchPrefix", "codex", "delivery", "localPath", "policy", "remote", "remoteIdentity", "repo",
    "reviewDemo", "shell", "stateDir", "validation", "version", "worktreeRoot",
  ], "config", ["reviewDemo"]);
  if (root.version !== 4) throw new Error("config.version must be 4");
  const repo = boundedText(root.repo, "config.repo", 300);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) throw new Error("config.repo must be OWNER/REPO");
  const localPath = canonicalDirectory(root.localPath, "config.localPath", false);
  const stateDir = assertAbsolutePath(boundedText(root.stateDir, "config.stateDir", 4_096), "config.stateDir");
  const worktreeRoot = assertAbsolutePath(boundedText(root.worktreeRoot, "config.worktreeRoot", 4_096), "config.worktreeRoot");
  if (pathsOverlap(localPath, stateDir) || pathsOverlap(localPath, worktreeRoot) || pathsOverlap(stateDir, worktreeRoot)) {
    throw new Error("localPath, stateDir, and worktreeRoot must not overlap");
  }
  const validation = validateValidation(root.validation);
  if ([localPath, stateDir, worktreeRoot].some((entry) => pathsOverlap(entry, validation.sandbox.root))) {
    throw new Error("validation sandbox root must not overlap localPath, stateDir, or worktreeRoot");
  }
  return {
    version: 4,
    repo,
    localPath,
    stateDir,
    worktreeRoot,
    baseRef: safeGitName(root.baseRef, "config.baseRef"),
    remote: safeGitName(root.remote, "config.remote"),
    remoteIdentity: parseRemoteIdentityContract(root.remoteIdentity, repo),
    branchPrefix: branchPrefix(root.branchPrefix),
    shell: assertAbsolutePath(boundedText(root.shell, "config.shell", 4_096), "config.shell"),
    codex: validateCodex(root.codex),
    validation,
    policy: validatePolicy(root.policy),
    reviewDemo: validateReviewDemo(root.reviewDemo),
    delivery: validateDelivery(root.delivery),
  };
}

export function requiredCheckContract(config: Pick<ControllerConfig, "delivery">): RequiredCheckContractV1 {
  return config.delivery.requiredChecks;
}

export function requiredCheckNames(config: Pick<ControllerConfig, "delivery">): string[] {
  return config.delivery.requiredChecks.checks.filter((check) => check.required).map((check) => check.name);
}

function validateCodex(value: unknown): ControllerConfig["codex"] {
  const object = expectObject(value, "config.codex");
  expectExactKeys(object, [
    "bin", "maxAggregateBytes", "maxEventBytes", "maxResultBytes", "maxStderrBytes",
    "reviewerTimeoutMs", "terminationGraceMs", "workerTimeoutMs",
  ], "config.codex");
  const maxEventBytes = parsePositiveInteger(object.maxEventBytes, "config.codex.maxEventBytes", 4_096, 16 * 1024 * 1024);
  const maxStderrBytes = parsePositiveInteger(object.maxStderrBytes, "config.codex.maxStderrBytes", 4_096, 16 * 1024 * 1024);
  const maxResultBytes = parsePositiveInteger(object.maxResultBytes, "config.codex.maxResultBytes", 4_096, 4 * 1024 * 1024);
  const maxAggregateBytes = parsePositiveInteger(object.maxAggregateBytes, "config.codex.maxAggregateBytes", 4_096, 32 * 1024 * 1024);
  if (maxAggregateBytes < Math.max(maxEventBytes, maxStderrBytes, maxResultBytes)) {
    throw new Error("config.codex.maxAggregateBytes must cover each Codex output limit");
  }
  return {
    bin: assertAbsolutePath(boundedText(object.bin, "config.codex.bin", 4_096), "config.codex.bin"),
    workerTimeoutMs: parsePositiveInteger(object.workerTimeoutMs, "config.codex.workerTimeoutMs", 60_000, 8 * 60 * 60_000),
    reviewerTimeoutMs: parsePositiveInteger(object.reviewerTimeoutMs, "config.codex.reviewerTimeoutMs", 60_000, 4 * 60 * 60_000),
    terminationGraceMs: parsePositiveInteger(object.terminationGraceMs, "config.codex.terminationGraceMs", 1_000, 60_000),
    maxEventBytes,
    maxStderrBytes,
    maxResultBytes,
    maxAggregateBytes,
  };
}

function validateValidation(value: unknown): ControllerConfig["validation"] {
  const object = expectObject(value, "config.validation");
  expectExactKeys(object, [
    "bootstrap", "issue", "maxAggregateBytes", "maxOutputBytes", "maxStderrBytes", "maxStdoutBytes", "release", "sandbox", "setup",
  ], "config.validation", ["bootstrap"]);
  const maxStdoutBytes = parsePositiveInteger(object.maxStdoutBytes, "config.validation.maxStdoutBytes", 4_096, 8 * 1024 * 1024);
  const maxStderrBytes = parsePositiveInteger(object.maxStderrBytes, "config.validation.maxStderrBytes", 4_096, 8 * 1024 * 1024);
  const maxAggregateBytes = parsePositiveInteger(object.maxAggregateBytes, "config.validation.maxAggregateBytes", 4_096, 16 * 1024 * 1024);
  if (maxAggregateBytes < Math.max(maxStdoutBytes, maxStderrBytes)) {
    throw new Error("config.validation.maxAggregateBytes must cover each stream limit");
  }
  return {
    ...(object.bootstrap === undefined ? {} : { bootstrap: validateBootstrap(object.bootstrap) }),
    setup: validateCommands(object.setup, "config.validation.setup", 30),
    issue: validateCommands(object.issue, "config.validation.issue", 50),
    release: validateCommands(object.release, "config.validation.release", 50),
    maxOutputBytes: parsePositiveInteger(object.maxOutputBytes, "config.validation.maxOutputBytes", 4_096, 8 * 1024 * 1024),
    maxStdoutBytes,
    maxStderrBytes,
    maxAggregateBytes,
    sandbox: validateSandbox(object.sandbox),
  };
}

function validateBootstrap(value: unknown): ValidationBootstrapConfig | null {
  if (value === null) return null;
  const object = expectObject(value, "config.validation.bootstrap");
  expectExactKeys(object, ["command", "networkAccess", "timeoutMs"], "config.validation.bootstrap");
  if (typeof object.networkAccess !== "boolean") throw new Error("config.validation.bootstrap.networkAccess must be boolean");
  return {
    command: boundedText(object.command, "config.validation.bootstrap.command", 8_192),
    timeoutMs: parsePositiveInteger(object.timeoutMs, "config.validation.bootstrap.timeoutMs", 1_000, 8 * 60 * 60_000),
    networkAccess: object.networkAccess,
  };
}

function validateSandbox(value: unknown): NonNullable<ControllerConfig["validation"]["sandbox"]> {
  const object = expectObject(value, "config.validation.sandbox");
  expectExactKeys(object, ["bin", "environmentPath", "provider", "root", "version"], "config.validation.sandbox");
  if (object.version !== 1 || object.provider !== "codex-permission-profile") throw new Error("config.validation.sandbox is invalid");
  const bin = assertAbsolutePath(boundedText(object.bin, "config.validation.sandbox.bin", 4_096), "config.validation.sandbox.bin");
  const root = canonicalDirectory(object.root, "config.validation.sandbox.root", true);
  for (const sensitive of [homedir(), tmpdir(), "/tmp", "/private/tmp"].filter((entry) => existsSync(entry))) {
    if (pathWithin(realpathSync(sensitive), root)) throw new Error("config.validation.sandbox.root must be outside home and system temp");
  }
  const environmentPath = boundedStringArray(object.environmentPath, "config.validation.sandbox.environmentPath", 30, 4_096);
  if (environmentPath.length === 0 || environmentPath.some((entry) => !entry.startsWith("/"))) {
    throw new Error("config.validation.sandbox.environmentPath must contain absolute directories");
  }
  return { version: 1, provider: "codex-permission-profile", bin, root, environmentPath };
}

function validatePolicy(value: unknown): ControllerConfig["policy"] {
  const object = expectObject(value, "config.policy");
  expectExactKeys(object, [
    "maxChangedFiles", "maxChangedLines", "maxCodeRepairRounds", "maxInfrastructureReruns", "maxIssueRepairRounds", "maxIssues",
  ], "config.policy");
  return {
    maxIssueRepairRounds: parsePositiveInteger(object.maxIssueRepairRounds, "config.policy.maxIssueRepairRounds", 0, 2),
    maxCodeRepairRounds: parsePositiveInteger(object.maxCodeRepairRounds, "config.policy.maxCodeRepairRounds", 0, 3),
    maxInfrastructureReruns: parsePositiveInteger(object.maxInfrastructureReruns, "config.policy.maxInfrastructureReruns", 0, 3),
    maxIssues: parsePositiveInteger(object.maxIssues, "config.policy.maxIssues", 1, 50),
    maxChangedFiles: parsePositiveInteger(object.maxChangedFiles, "config.policy.maxChangedFiles", 1, 1_000),
    maxChangedLines: parsePositiveInteger(object.maxChangedLines, "config.policy.maxChangedLines", 1, 100_000),
  };
}

function validateReviewDemo(value: unknown): NonNullable<ControllerConfig["reviewDemo"]> | null {
  if (value === undefined || value === null) return null;
  const object = expectObject(value, "config.reviewDemo");
  expectExactKeys(object, ["command", "maxOutputBytes", "networkAccess", "required", "timeoutMs"], "config.reviewDemo");
  if (typeof object.required !== "boolean" || typeof object.networkAccess !== "boolean") throw new Error("config.reviewDemo flags must be boolean");
  return {
    command: boundedText(object.command, "config.reviewDemo.command", 8_192),
    required: object.required,
    networkAccess: object.networkAccess,
    timeoutMs: parsePositiveInteger(object.timeoutMs, "config.reviewDemo.timeoutMs", 1_000, 60 * 60_000),
    maxOutputBytes: parsePositiveInteger(object.maxOutputBytes, "config.reviewDemo.maxOutputBytes", 4_096, 8 * 1024 * 1024),
  };
}

function validateDelivery(value: unknown): ControllerConfig["delivery"] {
  const object = expectObject(value, "config.delivery");
  expectExactKeys(object, ["draft", "mergeMethod", "pollIntervalMs", "requiredChecks"], "config.delivery");
  if (typeof object.draft !== "boolean") throw new Error("config.delivery.draft must be boolean");
  if (object.mergeMethod !== "merge" && object.mergeMethod !== "squash" && object.mergeMethod !== "rebase") {
    throw new Error("config.delivery.mergeMethod is invalid");
  }
  return {
    draft: object.draft,
    mergeMethod: object.mergeMethod,
    requiredChecks: validateRequiredChecks(object.requiredChecks),
    pollIntervalMs: parsePositiveInteger(object.pollIntervalMs, "config.delivery.pollIntervalMs", 1_000, 10 * 60_000),
  };
}

function validateRequiredChecks(value: unknown): RequiredCheckContractV1 {
  const object = expectObject(value, "config.delivery.requiredChecks");
  expectExactKeys(object, ["checks", "firstAppearanceTimeoutMs", "pendingTimeoutMs", "version"], "config.delivery.requiredChecks");
  if (object.version !== 1 || !Array.isArray(object.checks) || object.checks.length === 0 || object.checks.length > 100) {
    throw new Error("config.delivery.requiredChecks must be a non-empty version 1 contract");
  }
  const checks = object.checks.map((entry, index) => {
    const check = expectObject(entry, `config.delivery.requiredChecks.checks[${index}]`);
    expectExactKeys(check, ["acceptedConclusions", "appId", "name", "required", "workflowName"], `config.delivery.requiredChecks.checks[${index}]`);
    if (check.appId !== null && (!Number.isSafeInteger(check.appId) || Number(check.appId) < 1)) throw new Error("required check appId is invalid");
    if (check.workflowName !== null && typeof check.workflowName !== "string") throw new Error("required check workflowName is invalid");
    if (typeof check.required !== "boolean") throw new Error("required check required flag is invalid");
    const acceptedConclusions = boundedStringArray(check.acceptedConclusions, "required check acceptedConclusions", 3, 20);
    if (acceptedConclusions.some((item) => !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(item))) throw new Error("required check conclusion is invalid");
    return {
      name: boundedText(check.name, "required check name", 500),
      appId: check.appId === null ? null : Number(check.appId),
      workflowName: check.workflowName === null ? null : boundedText(check.workflowName, "required check workflowName", 500),
      acceptedConclusions: acceptedConclusions as Array<"SUCCESS" | "NEUTRAL" | "SKIPPED">,
      required: check.required,
    };
  });
  if (new Set(checks.map(({ name }) => name)).size !== checks.length
    || checks.filter(({ required }) => required).length === 0
    || checks.some((check) => check.required && check.appId === null && check.workflowName === null)) {
    throw new Error("required check identities are invalid");
  }
  return {
    version: 1,
    firstAppearanceTimeoutMs: parsePositiveInteger(object.firstAppearanceTimeoutMs, "required checks firstAppearanceTimeoutMs", 1_000, 7 * 24 * 60 * 60_000),
    pendingTimeoutMs: parsePositiveInteger(object.pendingTimeoutMs, "required checks pendingTimeoutMs", 1_000, 7 * 24 * 60 * 60_000),
    checks,
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
        timeoutMs: parsePositiveInteger(object.timeoutMs, `${label}[${index}].timeoutMs`, 1_000, 8 * 60 * 60_000),
      }),
    };
  });
}

export function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function expectExactKeys(value: Record<string, unknown>, allowed: string[], label: string, optional: string[] = []): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  const missing = allowed.filter((key) => !optional.includes(key) && !(key in value));
  if (missing.length > 0) throw new Error(`${label} is missing keys: ${missing.join(", ")}`);
}

function canonicalDirectory(value: unknown, label: string, allowMissing: boolean): string {
  const requested = assertAbsolutePath(boundedText(value, label, 4_096), label);
  if (!existsSync(requested)) {
    if (!allowMissing) return requested;
    const parent = realpathSync(dirname(requested));
    const path = join(parent, basename(requested));
    if (!pathWithin(parent, path)) throw new Error(`${label} has an unsafe parent`);
    return path;
  }
  const stat = lstatSync(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a canonical directory`);
  return realpathSync(requested);
}

function branchPrefix(value: unknown): string {
  const prefix = boundedText(value, "config.branchPrefix", 120);
  if (!/^[A-Za-z0-9._/-]+$/u.test(prefix) || prefix.startsWith("/") || prefix.endsWith("/")) {
    throw new Error("config.branchPrefix is unsafe");
  }
  return prefix;
}

function safeGitName(value: unknown, label: string): string {
  const text = boundedText(value, label, 300);
  if (!/^[A-Za-z0-9._/-]+$/u.test(text) || text.includes("..") || text.startsWith("/") || text.endsWith("/")) {
    throw new Error(`${label} is unsafe`);
  }
  return text;
}

function pathsOverlap(left: string, right: string): boolean {
  return pathWithin(left, right) || pathWithin(right, left);
}
