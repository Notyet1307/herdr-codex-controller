import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { CommandConfig, ControllerConfig, ExecutionMode } from "./types.js";
import {
  assertAbsolutePath,
  boundedStringArray,
  boundedText,
  parsePositiveInteger,
  pathWithin,
} from "./util.js";
import { ControllerError } from "./errors.js";
import { parseRemoteIdentityContract } from "./remote-identity.js";

export function loadConfig(path: string): ControllerConfig {
  const absolute = resolve(path);
  const value = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
  return validateConfig(value, absolute);
}

export function validateConfig(value: unknown, sourcePath = "config.json", options: { allowHistoricalDirectV2?: boolean } = {}): ControllerConfig {
  const root = expectObject(value, "config");
  if (root.version !== 1 && root.version !== 2 && root.version !== 3 && root.version !== 4) {
    throw new Error("config.version must be 4");
  }
  const version = root.version;
  if (version !== 4 && !options.allowHistoricalDirectV2) {
    throw new ControllerError("production_config_migration_required", "New Jobs require Controller config version 4.");
  }
  const keys = version === 4
    ? [
      "baseRef", "branchPrefix", "codex", "delivery", "localPath", "policy", "remote", "remoteIdentity", "repo",
      "shell", "stateDir", "validation", "version", "worktreeRoot",
    ]
    : [
      "baseRef", "branchPrefix", "codex", "delivery", "executionMode", "localPath", "policy", "remote", "remoteIdentity",
      "repo", "review", "shell", "stateDir", "validation", "version", "worktreeRoot",
    ];
  expectExactKeys(root, keys, "config", version === 4 ? [] : ["executionMode"]);
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
  const remoteIdentity = version >= 2 ? parseRemoteIdentityContract(root.remoteIdentity, repo) : null;
  const branchPrefix = boundedText(root.branchPrefix, "config.branchPrefix", 120);
  if (!/^[A-Za-z0-9._/-]+$/.test(branchPrefix) || branchPrefix.startsWith("/") || branchPrefix.endsWith("/")) {
    throw new Error("config.branchPrefix is not a safe branch prefix");
  }
  const shell = boundedText(root.shell, "config.shell", 4096);
  const executionMode = version === 4 ? "release-plan-v2-direct" : validateExecutionMode(root.executionMode);
  if (version === 3 && executionMode !== "release-plan-v2-direct") {
    throw new Error("config version 3 is reserved for release-plan-v2-direct production");
  }
  const codex = validateCodex(root.codex, version);
  const validation = validateValidation(root.validation, version);
  if (validation.sandbox && [localPath, stateDir, worktreeRoot].some((entry) => pathsOverlap(entry, validation.sandbox!.root))) {
    throw new Error("validation sandbox root must not overlap localPath, stateDir, or worktreeRoot");
  }
  const policy = validatePolicy(root.policy, version);
  const review = version === 4
    ? { enabled: true as const, blockingSeverities: ["critical", "major"] as Array<"critical" | "major"> }
    : validateReview(root.review);
  const delivery = validateDelivery(root.delivery, executionMode, version);
  const config: ControllerConfig = {
    version,
    executionMode,
    repo,
    localPath,
    stateDir,
    worktreeRoot,
    baseRef,
    remote,
    remoteIdentity,
    branchPrefix,
    shell,
    codex,
    validation,
    policy,
    review,
    delivery,
  };
  if (version === 4) {
    assertProductionDeliveryPolicy(config);
  }
  return config;
}

export function assertProductionDeliveryPolicy(
  config: Pick<ControllerConfig, "version" | "executionMode" | "codex" | "delivery" | "remoteIdentity" | "review" | "shell" | "validation">,
): void {
  if (config.executionMode !== "release-plan-v2-direct") return;
  if (config.version !== 4 || config.validation.sandbox === null || config.remoteIdentity === null) {
    throw new ControllerError(
      "production_config_migration_required",
      "release-plan-v2-direct requires config version 3 with explicit sandbox, check, and merge-authority contracts.",
    );
  }
  if (config.codex.workerProfile !== null
    || config.codex.reviewerProfile !== null
    || !isAbsolute(config.codex.bin)
    || !isAbsolute(config.shell)) {
    throw new ControllerError(
      "production_runtime_policy_invalid",
      "release-plan-v2-direct requires absolute Codex/shell binaries and disallows custom Codex profiles.",
    );
  }
  const checks = requiredCheckContract(config);
  if (!config.review.enabled
    || config.review.blockingSeverities.length !== 2
    || new Set(config.review.blockingSeverities).size !== 2
    || !config.review.blockingSeverities.includes("critical")
    || !config.review.blockingSeverities.includes("major")) {
    throw new ControllerError(
      "production_review_policy_invalid",
      "release-plan-v2-direct requires aggregate review and exact critical/major blocking semantics.",
    );
  }
  if (!config.delivery.createPullRequest
    || !config.delivery.autoMerge
    || config.delivery.allowNoChecks
    || checks === null
    || checks.checks.filter((check) => check.required).length === 0
    || checks.checks.some((check) => check.required && check.appId === null && check.workflowName === null)
    || config.delivery.mergeAuthority?.mode !== "controller-auto-merge"
    || config.delivery.mergeAuthority.quarantine !== "delete-exact-head-branch") {
    throw new ControllerError(
      "production_delivery_policy_invalid",
      "release-plan-v2-direct requires Controller auto-merge, exact required-check contracts, and close-on-revocation authority.",
    );
  }
}

export function requiredCheckContract(config: Pick<ControllerConfig, "delivery">) {
  return Array.isArray(config.delivery.requiredChecks) ? null : config.delivery.requiredChecks;
}

export function requiredCheckNames(config: Pick<ControllerConfig, "delivery">): string[] {
  const contract = requiredCheckContract(config);
  return contract ? contract.checks.filter((check) => check.required).map((check) => check.name) : [...config.delivery.requiredChecks as string[]];
}

function validateExecutionMode(value: unknown): ExecutionMode {
  if (value === undefined) return "release-plan-v2-direct";
  if (value !== "release-plan-v2-direct") throw new Error("historical config is not release-plan-v2-direct");
  return "release-plan-v2-direct";
}

function validateCodex(value: unknown, version: 1 | 2 | 3 | 4): ControllerConfig["codex"] {
  const object = expectObject(value, "config.codex");
  const keys = version === 4
    ? ["bin", "reviewerTimeoutMs", "terminationGraceMs", "workerTimeoutMs"]
    : [
      "bin", "networkAccess", "reviewerProfile", "reviewerTimeoutMs", "terminationGraceMs",
      "workerProfile", "workerTimeoutMs",
    ];
  if (version >= 2) keys.push("maxAggregateBytes", "maxEventBytes", "maxResultBytes", "maxStderrBytes");
  expectExactKeys(object, keys, "config.codex");
  if (version !== 4 && object.networkAccess !== false) throw new Error("config.codex.networkAccess must be false");
  const maxEventBytes = version >= 2
    ? parsePositiveInteger(object.maxEventBytes, "config.codex.maxEventBytes", 4_096, 16 * 1024 * 1024)
    : 8 * 1024 * 1024;
  const maxStderrBytes = version >= 2
    ? parsePositiveInteger(object.maxStderrBytes, "config.codex.maxStderrBytes", 4_096, 16 * 1024 * 1024)
    : 8 * 1024 * 1024;
  const maxResultBytes = version >= 2
    ? parsePositiveInteger(object.maxResultBytes, "config.codex.maxResultBytes", 4_096, 4 * 1024 * 1024)
    : 1024 * 1024;
  const maxAggregateBytes = version >= 2
    ? parsePositiveInteger(object.maxAggregateBytes, "config.codex.maxAggregateBytes", 4_096, 32 * 1024 * 1024)
    : 16 * 1024 * 1024;
  if (maxAggregateBytes < Math.max(maxEventBytes, maxStderrBytes, maxResultBytes)) {
    throw new Error("config.codex.maxAggregateBytes must cover each Codex output limit");
  }
  return {
    bin: boundedText(object.bin, "config.codex.bin", 4096),
    workerProfile: version === 4 ? null : nullableText(object.workerProfile, "config.codex.workerProfile", 200),
    reviewerProfile: version === 4 ? null : nullableText(object.reviewerProfile, "config.codex.reviewerProfile", 200),
    workerTimeoutMs: parsePositiveInteger(object.workerTimeoutMs, "config.codex.workerTimeoutMs", 60_000, 8 * 60 * 60 * 1000),
    reviewerTimeoutMs: parsePositiveInteger(object.reviewerTimeoutMs, "config.codex.reviewerTimeoutMs", 60_000, 4 * 60 * 60 * 1000),
    terminationGraceMs: parsePositiveInteger(object.terminationGraceMs, "config.codex.terminationGraceMs", 1_000, 60_000),
    maxEventBytes,
    maxStderrBytes,
    maxResultBytes,
    maxAggregateBytes,
    networkAccess: false,
  };
}

function validateValidation(value: unknown, version: 1 | 2 | 3 | 4): ControllerConfig["validation"] {
  const object = expectObject(value, "config.validation");
  const version2Keys = [
    "issue", "maxAggregateBytes", "maxOutputBytes", "maxStderrBytes", "maxStdoutBytes", "release", "sandbox", "setup",
  ];
  expectExactKeys(
    object,
    version >= 2 ? version2Keys : ["issue", "maxOutputBytes", "release", "setup"],
    "config.validation",
  );
  const maxOutputBytes = parsePositiveInteger(object.maxOutputBytes, "config.validation.maxOutputBytes", 4_096, 8 * 1024 * 1024);
  if (version === 1) {
    return {
      setup: validateCommands(object.setup, "config.validation.setup", 30),
      issue: validateCommands(object.issue, "config.validation.issue", 50),
      release: validateCommands(object.release, "config.validation.release", 50),
      maxOutputBytes,
      maxStdoutBytes: maxOutputBytes,
      maxStderrBytes: maxOutputBytes,
      maxAggregateBytes: maxOutputBytes * 2,
      sandbox: null,
    };
  }
  const maxStdoutBytes = parsePositiveInteger(object.maxStdoutBytes, "config.validation.maxStdoutBytes", 4_096, 8 * 1024 * 1024);
  const maxStderrBytes = parsePositiveInteger(object.maxStderrBytes, "config.validation.maxStderrBytes", 4_096, 8 * 1024 * 1024);
  const maxAggregateBytes = parsePositiveInteger(object.maxAggregateBytes, "config.validation.maxAggregateBytes", 4_096, 16 * 1024 * 1024);
  if (maxAggregateBytes < Math.max(maxStdoutBytes, maxStderrBytes)) {
    throw new Error("config.validation.maxAggregateBytes must cover each stream limit");
  }
  return {
    setup: validateCommands(object.setup, "config.validation.setup", 30),
    issue: validateCommands(object.issue, "config.validation.issue", 50),
    release: validateCommands(object.release, "config.validation.release", 50),
    maxOutputBytes,
    maxStdoutBytes,
    maxStderrBytes,
    maxAggregateBytes,
    sandbox: validateSandbox(object.sandbox),
  };
}

function validateSandbox(value: unknown): NonNullable<ControllerConfig["validation"]["sandbox"]> {
  const object = expectObject(value, "config.validation.sandbox");
  expectExactKeys(object, ["bin", "environmentPath", "provider", "root", "version"], "config.validation.sandbox");
  if (object.version !== 1) throw new Error("config.validation.sandbox.version must be 1");
  if (object.provider !== "codex-permission-profile") {
    throw new Error("config.validation.sandbox.provider must be codex-permission-profile");
  }
  const bin = assertAbsolutePath(boundedText(object.bin, "config.validation.sandbox.bin", 4096), "config.validation.sandbox.bin");
  const requestedRoot = assertAbsolutePath(boundedText(object.root, "config.validation.sandbox.root", 4096), "config.validation.sandbox.root");
  const parent = realpathSync(dirname(requestedRoot));
  const root = existsSync(requestedRoot) ? realpathSync(requestedRoot) : join(parent, basename(requestedRoot));
  for (const sensitive of [homedir(), tmpdir(), "/tmp", "/private/tmp"].filter((entry) => existsSync(entry))) {
    if (pathWithin(realpathSync(sensitive), root)) {
      throw new Error("config.validation.sandbox.root must be outside the operator home and system temporary directory");
    }
  }
  if (existsSync(root)) {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("config.validation.sandbox.root must be a canonical directory");
    }
  } else {
    if (!pathWithin(parent, root)) throw new Error("config.validation.sandbox.root has an unsafe parent");
  }
  const environmentPath = boundedStringArray(object.environmentPath, "config.validation.sandbox.environmentPath", 30, 4096);
  if (environmentPath.length === 0 || environmentPath.some((entry) => !entry.startsWith("/"))) {
    throw new Error("config.validation.sandbox.environmentPath must contain absolute directories");
  }
  return { version: 1, provider: "codex-permission-profile", bin, root, environmentPath };
}

function validatePolicy(value: unknown, version: 1 | 2 | 3 | 4): ControllerConfig["policy"] {
  const object = expectObject(value, "config.policy");
  const common = ["maxChangedFiles", "maxChangedLines", "maxIssueRepairRounds", "maxIssues"];
  const versioned = version === 4
    ? ["maxCodeRepairRounds", "maxInfrastructureReruns"]
    : version === 3
      ? ["maxCiCodeRepairRounds", "maxCiInfrastructureReruns", "maxProviderRetries", "maxReleaseValidationRepairRounds", "maxReviewRepairRounds"]
      : ["maxCiRepairRounds", "maxReleaseHardeningRounds"];
  expectExactKeys(object, [...common, ...versioned], "config.policy");
  return {
    maxIssueRepairRounds: parsePositiveInteger(object.maxIssueRepairRounds, "config.policy.maxIssueRepairRounds", 0, 2),
    ...(version === 4 ? {
      maxCodeRepairRounds: parsePositiveInteger(object.maxCodeRepairRounds, "config.policy.maxCodeRepairRounds", 0, 3),
      maxInfrastructureReruns: parsePositiveInteger(object.maxInfrastructureReruns, "config.policy.maxInfrastructureReruns", 0, 3),
    } : version === 3 ? {
      maxReleaseValidationRepairRounds: parsePositiveInteger(object.maxReleaseValidationRepairRounds, "config.policy.maxReleaseValidationRepairRounds", 0, 2),
      maxReviewRepairRounds: parsePositiveInteger(object.maxReviewRepairRounds, "config.policy.maxReviewRepairRounds", 0, 2),
      maxCiCodeRepairRounds: parsePositiveInteger(object.maxCiCodeRepairRounds, "config.policy.maxCiCodeRepairRounds", 0, 2),
      maxCiInfrastructureReruns: parsePositiveInteger(object.maxCiInfrastructureReruns, "config.policy.maxCiInfrastructureReruns", 0, 3),
      maxProviderRetries: parsePositiveInteger(object.maxProviderRetries, "config.policy.maxProviderRetries", 0, 3),
    } : {
      maxReleaseHardeningRounds: parsePositiveInteger(object.maxReleaseHardeningRounds, "config.policy.maxReleaseHardeningRounds", 0, 2),
      maxCiRepairRounds: parsePositiveInteger(object.maxCiRepairRounds, "config.policy.maxCiRepairRounds", 0, 1),
    }),
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
  if (new Set(severities).size !== severities.length) throw new Error("config.review.blockingSeverities contains duplicates");
  return { enabled: object.enabled, blockingSeverities: severities };
}

function validateDelivery(value: unknown, executionMode: ExecutionMode, version: 1 | 2 | 3 | 4): ControllerConfig["delivery"] {
  const object = expectObject(value, "config.delivery");
  const keys = version === 4
    ? ["draft", "mergeMethod", "pollIntervalMs", "requiredChecks"]
    : ["allowNoChecks", "autoMerge", "createPullRequest", "draft", "mergeMethod", "pollIntervalMs", "requiredChecks"];
  if (version === 3) keys.push("mergeAuthority");
  expectExactKeys(object, keys, "config.delivery");
  const booleanKeys: Array<"allowNoChecks" | "autoMerge" | "createPullRequest" | "draft"> = version === 4
    ? ["draft"]
    : ["allowNoChecks", "autoMerge", "createPullRequest", "draft"];
  for (const key of booleanKeys) {
    if (typeof object[key] !== "boolean") throw new Error(`config.delivery.${key} must be boolean`);
  }
  if (!object.createPullRequest && object.autoMerge && executionMode !== "release-plan-v2-direct") throw new Error("autoMerge requires createPullRequest");
  if (object.mergeMethod !== "merge" && object.mergeMethod !== "squash" && object.mergeMethod !== "rebase") {
    throw new Error("config.delivery.mergeMethod must be merge, squash, or rebase");
  }
  let requiredChecks: ControllerConfig["delivery"]["requiredChecks"];
  let mergeAuthority: Exclude<ControllerConfig["delivery"]["mergeAuthority"], undefined> = null;
  try {
    requiredChecks = version >= 3
      ? validateRequiredCheckContract(object.requiredChecks, version === 3)
      : boundedStringArray(object.requiredChecks, "config.delivery.requiredChecks", 100, 500);
    mergeAuthority = version === 4
      ? { version: 1, mode: "controller-auto-merge", quarantine: "delete-exact-head-branch" }
      : version === 3 ? validateMergeAuthority(object.mergeAuthority) : null;
  } catch (error) {
    if (executionMode === "release-plan-v2-direct") {
      throw new ControllerError("production_delivery_policy_invalid", error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
  return {
    createPullRequest: version === 4 ? true : object.createPullRequest as boolean,
    draft: object.draft as boolean,
    autoMerge: version === 4 ? true : object.autoMerge as boolean,
    mergeMethod: object.mergeMethod,
    allowNoChecks: version === 4 ? false : object.allowNoChecks as boolean,
    requiredChecks,
    ...(version >= 3 ? { mergeAuthority } : {}),
    pollIntervalMs: parsePositiveInteger(object.pollIntervalMs, "config.delivery.pollIntervalMs", 1_000, 10 * 60_000),
  };
}

function validateRequiredCheckContract(value: unknown, historical = false): ControllerConfig["delivery"]["requiredChecks"] {
  const object = expectObject(value, "config.delivery.requiredChecks");
  expectExactKeys(
    object,
    historical
      ? ["checks", "firstAppearanceTimeoutMs", "pendingTimeoutMs", "postMergeTimeoutMs", "version"]
      : ["checks", "firstAppearanceTimeoutMs", "pendingTimeoutMs", "version"],
    "config.delivery.requiredChecks",
  );
  if (object.version !== 1 || !Array.isArray(object.checks) || object.checks.length === 0 || object.checks.length > 100) {
    throw new Error("config.delivery.requiredChecks must be a non-empty version 1 contract");
  }
  const checks = object.checks.map((value, index) => {
    const check = expectObject(value, `config.delivery.requiredChecks.checks[${index}]`);
    expectExactKeys(check, ["acceptedConclusions", "appId", "name", "required", "workflowName"], `config.delivery.requiredChecks.checks[${index}]`);
    const name = boundedText(check.name, `config.delivery.requiredChecks.checks[${index}].name`, 500);
    if (check.appId !== null && (!Number.isSafeInteger(check.appId) || Number(check.appId) < 1)) throw new Error("required check appId is invalid");
    if (check.workflowName !== null && typeof check.workflowName !== "string") throw new Error("required check workflowName is invalid");
    if (typeof check.required !== "boolean") throw new Error("required check required flag is invalid");
    if (!Array.isArray(check.acceptedConclusions) || check.acceptedConclusions.length === 0) throw new Error("required check acceptedConclusions is invalid");
    const acceptedConclusions = check.acceptedConclusions.map((conclusion) => {
      if (conclusion !== "SUCCESS" && conclusion !== "NEUTRAL" && conclusion !== "SKIPPED") throw new Error("required check accepted conclusion is invalid");
      return conclusion;
    });
    if (new Set(acceptedConclusions).size !== acceptedConclusions.length) throw new Error("required check acceptedConclusions contains duplicates");
    return {
      name,
      appId: check.appId === null ? null : Number(check.appId),
      workflowName: check.workflowName === null ? null : boundedText(check.workflowName, "required check workflowName", 500),
      acceptedConclusions,
      required: check.required,
    };
  });
  if (new Set(checks.map(({ name }) => name)).size !== checks.length) throw new Error("required check contract contains duplicate names");
  return {
    version: 1,
    checks,
    firstAppearanceTimeoutMs: parsePositiveInteger(object.firstAppearanceTimeoutMs, "config.delivery.requiredChecks.firstAppearanceTimeoutMs", 1_000, 7 * 24 * 60 * 60_000),
    pendingTimeoutMs: parsePositiveInteger(object.pendingTimeoutMs, "config.delivery.requiredChecks.pendingTimeoutMs", 1_000, 7 * 24 * 60 * 60_000),
    ...(historical ? {
      postMergeTimeoutMs: parsePositiveInteger(object.postMergeTimeoutMs, "config.delivery.requiredChecks.postMergeTimeoutMs", 1_000, 7 * 24 * 60 * 60_000),
    } : {}),
  };
}

function validateMergeAuthority(value: unknown): Exclude<ControllerConfig["delivery"]["mergeAuthority"], null | undefined> {
  const object = expectObject(value, "config.delivery.mergeAuthority");
  expectExactKeys(object, ["mode", "quarantine", "version"], "config.delivery.mergeAuthority");
  if (object.version !== 1 || object.mode !== "controller-auto-merge" || object.quarantine !== "delete-exact-head-branch") {
    throw new Error("config.delivery.mergeAuthority is invalid");
  }
  return { version: 1, mode: "controller-auto-merge", quarantine: "delete-exact-head-branch" };
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
