import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ControllerConfig, ReleasePlan, ReleasePlanIssue } from "./types.js";
import { boundedExactText, boundedStringArray, boundedText, parsePositiveInteger, safeToken } from "./util.js";
import { expectExactKeys, expectObject } from "./config.js";
import { ControllerError } from "./errors.js";

const PLAN_KEYS = [
  "baseRef", "baseSha", "controllerContractVersion", "id", "issues", "objective", "parentIssue",
  "plannerContextDigest", "releaseAcceptanceCriteria", "repo", "reviewFocus", "title",
];
const ISSUE_KEYS = [
  "acceptanceCriteria", "dependsOn", "expectedPaths", "number", "objective", "oracleCommands", "order", "risk", "scopeBudget",
];

export function loadPlan(path: string): ReleasePlan {
  return validatePlan(JSON.parse(readFileSync(resolve(path), "utf8")) as unknown);
}

export function validatePlan(value: unknown): ReleasePlan {
  const object = expectObject(value, "plan");
  expectExactKeys(object, PLAN_KEYS, "plan", ["plannerContextDigest"]);
  if (object.controllerContractVersion !== 2) {
    throw new ControllerError("unsupported_controller_contract_version", "controllerContractVersion must be 2.");
  }
  const issues = validateIssueGraph(object.issues);
  const id = boundedText(object.id, "plan.id", 80);
  if (safeToken(id) !== id) throw new Error("plan.id must be a lowercase safe token of at most 80 characters");
  const repo = boundedExactText(object.repo, "plan.repo", 300);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) throw new Error("plan.repo must be OWNER/REPO");
  const baseSha = boundedExactText(object.baseSha, "plan.baseSha", 40);
  if (!/^[a-f0-9]{40}$/u.test(baseSha)) throw new Error("plan.baseSha must be 40 lowercase hexadecimal characters");
  return {
    controllerContractVersion: 2,
    id,
    title: boundedText(object.title, "plan.title", 500),
    objective: boundedText(object.objective, "plan.objective", 8_000),
    repo,
    baseRef: safeGitRefName(object.baseRef, "plan.baseRef"),
    baseSha,
    parentIssue: parsePositiveInteger(object.parentIssue, "plan.parentIssue", 1, Number.MAX_SAFE_INTEGER),
    issues,
    releaseAcceptanceCriteria: boundedStringArray(object.releaseAcceptanceCriteria, "plan.releaseAcceptanceCriteria", 50, 2_000),
    reviewFocus: boundedStringArray(object.reviewFocus, "plan.reviewFocus", 20, 2_000),
    ...(object.plannerContextDigest === undefined ? {} : {
      plannerContextDigest: boundedExactText(object.plannerContextDigest, "plan.plannerContextDigest", 256),
    }),
  };
}

export function assertPlanCompatibleWithConfig(plan: ReleasePlan, config: ControllerConfig): void {
  if (plan.repo !== config.repo) {
    throw new ControllerError("plan_repo_mismatch", "Release Plan repo does not exactly match config.repo.");
  }
  if (plan.baseRef !== config.baseRef) {
    throw new ControllerError("plan_base_ref_mismatch", "Release Plan baseRef does not exactly match config.baseRef.");
  }
  for (const issue of plan.issues) {
    if (issue.scopeBudget.maxFiles > config.policy.maxChangedFiles || issue.scopeBudget.maxChangedLines > config.policy.maxChangedLines) {
      throw new ControllerError("issue_scope_budget_exceeds_policy", `Issue #${issue.number} scopeBudget exceeds configured change limits.`);
    }
    for (const command of issue.oracleCommands) {
      const matches = config.validation.release.filter((entry) => entry.command === command);
      if (matches.length !== 1) {
        throw new ControllerError(
          matches.length === 0 ? "oracle_validation_command_missing" : "oracle_validation_command_ambiguous",
          `Issue #${issue.number} Oracle command must match one configured release validation command.`,
        );
      }
    }
  }
}

function validateIssueGraph(value: unknown): ReleasePlanIssue[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new Error("plan.issues must contain 1 to 50 issues");
  }
  const issues = value.map((entry, index) => validateIssue(entry, index));
  if (new Set(issues.map(({ number }) => number)).size !== issues.length) throw new Error("plan.issues contains duplicate issue numbers");
  if (new Set(issues.map(({ order }) => order)).size !== issues.length) throw new Error("plan.issues contains duplicate order values");
  issues.sort((left, right) => left.order - right.order);
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  for (const issue of issues) {
    for (const dependency of issue.dependsOn) {
      const predecessor = byNumber.get(dependency);
      if (!predecessor) throw new Error(`issue #${issue.number} depends on missing issue #${dependency}`);
      if (predecessor.order >= issue.order) throw new Error(`issue #${issue.number} depends on issue #${dependency} that does not precede it`);
    }
  }
  return issues;
}

function validateIssue(value: unknown, index: number): ReleasePlanIssue {
  const label = `plan.issues[${index}]`;
  const object = expectObject(value, label);
  expectExactKeys(object, ISSUE_KEYS, label);
  const number = parsePositiveInteger(object.number, `${label}.number`, 1, Number.MAX_SAFE_INTEGER);
  const dependsOn = integerArray(object.dependsOn, `${label}.dependsOn`, 50);
  if (dependsOn.includes(number)) throw new Error(`issue #${number} depends on itself`);
  if (object.risk !== "low" && object.risk !== "normal" && object.risk !== "high") {
    throw new Error(`${label}.risk must be low, normal, or high`);
  }
  const oracleCommands = boundedStringArray(object.oracleCommands, `${label}.oracleCommands`, 20, 512);
  if ((object.risk === "high" && oracleCommands.length === 0) || (object.risk !== "high" && oracleCommands.length > 0)) {
    throw new Error(`${label}.oracleCommands must be non-empty for high-risk work and empty otherwise`);
  }
  return {
    number,
    order: parsePositiveInteger(object.order, `${label}.order`, 1, 10_000),
    dependsOn,
    objective: boundedText(object.objective, `${label}.objective`, 8_000),
    acceptanceCriteria: nonEmptyStrings(object.acceptanceCriteria, `${label}.acceptanceCriteria`, 20, 2_000),
    expectedPaths: nonEmptyPaths(object.expectedPaths, `${label}.expectedPaths`, 20),
    scopeBudget: scopeBudget(object.scopeBudget, `${label}.scopeBudget`),
    risk: object.risk,
    oracleCommands,
  };
}

function nonEmptyPaths(value: unknown, label: string, maximum: number): string[] {
  const paths = pathArray(value, label, maximum);
  if (paths.length === 0) throw new Error(`${label} must not be empty`);
  return paths;
}

function scopeBudget(value: unknown, label: string): { maxFiles: number; maxChangedLines: number } {
  const object = expectObject(value, label);
  expectExactKeys(object, ["maxFiles", "maxChangedLines"], label);
  return {
    maxFiles: parsePositiveInteger(object.maxFiles, `${label}.maxFiles`, 1, 1_000),
    maxChangedLines: parsePositiveInteger(object.maxChangedLines, `${label}.maxChangedLines`, 1, 100_000),
  };
}

function integerArray(value: unknown, label: string, maximum: number): number[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} is invalid`);
  const result = value.map((entry, index) => parsePositiveInteger(entry, `${label}[${index}]`, 1, Number.MAX_SAFE_INTEGER));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}

function nonEmptyStrings(value: unknown, label: string, maximum: number, maximumBytes: number): string[] {
  const result = boundedStringArray(value, label, maximum, maximumBytes);
  if (result.length === 0) throw new Error(`${label} must not be empty`);
  return result;
}

function pathArray(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} is invalid`);
  const result = value.map((entry, index) => expectedRepoPath(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}

function expectedRepoPath(value: unknown, label: string): string {
  const text = boundedExactText(value, label, 2_048);
  const segments = text.split("/");
  if (segments[0]?.includes("*") || text.startsWith("/") || /^[A-Za-z]:/u.test(text) || text.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || /[?[\]{}\u0000\r\n]/u.test(text) || text.includes("**")) {
    throw new Error(`invalid_expected_path_pattern:${label}`);
  }
  return text;
}

function safeGitRefName(value: unknown, label: string): string {
  const text = boundedExactText(value, label, 300);
  const segments = text.split("/");
  if (!/^[A-Za-z0-9._/-]+$/u.test(text) || text === "@" || text.includes("..") || text.includes("@{")
    || text.includes("//") || text.startsWith("/") || text.endsWith("/") || text.endsWith(".")
    || segments.some((segment) => segment.startsWith(".") || segment.endsWith(".lock"))) {
    throw new Error(`${label} is not a safe Git ref name`);
  }
  return text;
}
