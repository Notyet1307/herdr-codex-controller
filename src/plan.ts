import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ControllerConfig,
  ReleasePlan,
  ReleasePlanIssue,
  ReleasePlanIssueV1,
  ReleasePlanIssueV2,
  ReleasePlanV1,
  ReleasePlanV2,
} from "./types.js";
import {
  boundedExactText,
  boundedStringArray,
  boundedText,
  parsePositiveInteger,
  safeToken,
} from "./util.js";
import { expectExactKeys, expectObject, validateCommands } from "./config.js";
import { ControllerError } from "./errors.js";

const PLAN_KEYS_V1 = [
  "id", "issues", "objective", "parentIssue", "releaseAcceptanceCriteria", "reviewFocus", "title", "version",
];
const PLAN_KEYS_V2 = [...PLAN_KEYS_V1, "source"];
const ISSUE_KEYS_V1 = [
  "acceptanceCriteria", "allowNoop", "dependsOn", "number", "objective", "order", "suggestedValidation",
];
const ISSUE_KEYS_V2 = [...ISSUE_KEYS_V1, "expectedBodyHash", "expectedTitle"];
const SHA256_PREFIXED_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function loadPlan(path: string): ReleasePlan {
  const absolute = resolve(path);
  const value = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
  return validatePlan(value);
}

export function validatePlan(value: unknown): ReleasePlan {
  const object = expectObject(value, "plan");
  if (object.version === 1) return validatePlanV1(object);
  if (object.version === 2) return validatePlanV2(object);
  throw new Error("plan.version must be 1 or 2");
}

export function isReleasePlanV2(plan: ReleasePlan): plan is ReleasePlanV2 {
  return plan.version === 2;
}

export function assertPlanCompatibleWithConfig(plan: ReleasePlan, config: ControllerConfig): void {
  if (!isReleasePlanV2(plan)) {
    if (config.executionMode === "release-plan-v2-direct") {
      throw new ControllerError(
        "production_plan_v1_rejected",
        "release-plan-v2-direct mode rejects Release Plan v1.",
      );
    }
    return;
  }
  if (plan.source.repo !== config.repo) {
    throw new ControllerError(
      "plan_source_repo_mismatch",
      "Release Plan v2 source.repo does not exactly match config.repo.",
    );
  }
  if (plan.source.baseRef !== config.baseRef) {
    throw new ControllerError(
      "plan_source_base_ref_mismatch",
      "Release Plan v2 source.baseRef does not exactly match config.baseRef.",
    );
  }
}

function validatePlanV1(object: Record<string, unknown>): ReleasePlanV1 {
  expectExactKeys(object, PLAN_KEYS_V1, "plan");
  const issues = validateIssueGraph(object.issues, validateIssueV1);
  return {
    version: 1,
    id: safeToken(boundedText(object.id, "plan.id", 120)),
    title: boundedText(object.title, "plan.title", 500),
    objective: boundedText(object.objective, "plan.objective", 8_000),
    parentIssue: object.parentIssue === null
      ? null
      : parsePositiveInteger(object.parentIssue, "plan.parentIssue", 1, Number.MAX_SAFE_INTEGER),
    issues,
    releaseAcceptanceCriteria: boundedStringArray(
      object.releaseAcceptanceCriteria,
      "plan.releaseAcceptanceCriteria",
      50,
      2_000,
    ),
    reviewFocus: boundedStringArray(object.reviewFocus, "plan.reviewFocus", 50, 2_000),
  };
}

function validatePlanV2(object: Record<string, unknown>): ReleasePlanV2 {
  expectExactKeys(object, PLAN_KEYS_V2, "plan");
  const parentIssue = parsePositiveInteger(object.parentIssue, "plan.parentIssue", 1, Number.MAX_SAFE_INTEGER);
  const source = validateSourceV2(object.source);
  if (source.parentBinding.number !== parentIssue) {
    throw new Error("plan.source.parentBinding.number must equal plan.parentIssue");
  }
  const releaseAcceptanceCriteria = boundedStringArray(
    object.releaseAcceptanceCriteria,
    "plan.releaseAcceptanceCriteria",
    50,
    2_000,
  );
  if (releaseAcceptanceCriteria.length === 0) {
    throw new Error("plan.releaseAcceptanceCriteria must contain 1 to 50 entries");
  }
  return {
    version: 2,
    source,
    id: safeToken(boundedText(object.id, "plan.id", 120)),
    title: boundedText(object.title, "plan.title", 500),
    objective: boundedText(object.objective, "plan.objective", 8_000),
    parentIssue,
    issues: validateIssueGraph(object.issues, validateIssueV2),
    releaseAcceptanceCriteria,
    reviewFocus: boundedStringArray(object.reviewFocus, "plan.reviewFocus", 20, 2_000),
  };
}

function validateSourceV2(value: unknown): ReleasePlanV2["source"] {
  const object = expectObject(value, "plan.source");
  expectExactKeys(object, [
    "baseRef", "baseSha", "deliveryGraphDigest", "parentBinding", "planner", "repo", "specContentHash",
  ], "plan.source");
  if (object.planner !== "pi-ticket-planning") {
    throw new Error('plan.source.planner must be "pi-ticket-planning"');
  }
  const repo = boundedExactText(object.repo, "plan.source.repo", 300);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("plan.source.repo must be OWNER/REPO");
  }
  const baseSha = boundedExactText(object.baseSha, "plan.source.baseSha", 40);
  if (!/^[a-f0-9]{40}$/.test(baseSha)) {
    throw new Error("plan.source.baseSha must be exactly 40 lowercase hexadecimal characters");
  }
  const parentBinding = expectObject(object.parentBinding, "plan.source.parentBinding");
  expectExactKeys(parentBinding, ["expectedBodyHash", "expectedTitle", "number"], "plan.source.parentBinding");
  return {
    planner: "pi-ticket-planning",
    repo,
    baseRef: safeGitRefName(object.baseRef, "plan.source.baseRef"),
    baseSha,
    parentBinding: {
      number: parsePositiveInteger(
        parentBinding.number,
        "plan.source.parentBinding.number",
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      expectedTitle: boundedExactText(
        parentBinding.expectedTitle,
        "plan.source.parentBinding.expectedTitle",
        500,
      ),
      expectedBodyHash: prefixedHash(
        parentBinding.expectedBodyHash,
        "plan.source.parentBinding.expectedBodyHash",
      ),
    },
    specContentHash: prefixedHash(object.specContentHash, "plan.source.specContentHash"),
    deliveryGraphDigest: prefixedHash(object.deliveryGraphDigest, "plan.source.deliveryGraphDigest"),
  };
}

function validateIssueV1(value: unknown, index: number): ReleasePlanIssueV1 {
  const label = `plan.issues[${index}]`;
  const object = expectObject(value, label);
  expectExactKeys(object, ISSUE_KEYS_V1, label);
  const common = validateIssueCommon(object, label);
  if (object.allowNoop !== true && object.allowNoop !== false) {
    throw new Error(`${label}.allowNoop must be boolean`);
  }
  return {
    ...common,
    objective: object.objective === null ? null : boundedText(object.objective, `${label}.objective`, 8_000),
    acceptanceCriteria: boundedStringArray(object.acceptanceCriteria, `${label}.acceptanceCriteria`, 50, 2_000),
    suggestedValidation: validateCommands(object.suggestedValidation, `${label}.suggestedValidation`, 20),
    allowNoop: object.allowNoop,
  };
}

function validateIssueV2(value: unknown, index: number): ReleasePlanIssueV2 {
  const label = `plan.issues[${index}]`;
  const object = expectObject(value, label);
  expectExactKeys(object, ISSUE_KEYS_V2, label);
  const common = validateIssueCommon(object, label);
  const acceptanceCriteria = boundedStringArray(object.acceptanceCriteria, `${label}.acceptanceCriteria`, 8, 2_000);
  if (acceptanceCriteria.length < 3) {
    throw new Error(`${label}.acceptanceCriteria must contain 3 to 8 entries`);
  }
  if (!Array.isArray(object.suggestedValidation) || object.suggestedValidation.length !== 0) {
    throw new Error(`${label}.suggestedValidation must be exactly []`);
  }
  if (object.allowNoop !== false) throw new Error(`${label}.allowNoop must be false`);
  return {
    ...common,
    objective: boundedText(object.objective, `${label}.objective`, 8_000),
    acceptanceCriteria,
    suggestedValidation: [],
    allowNoop: false,
    expectedTitle: boundedExactText(object.expectedTitle, `${label}.expectedTitle`, 500),
    expectedBodyHash: prefixedHash(object.expectedBodyHash, `${label}.expectedBodyHash`),
  };
}

function validateIssueCommon(object: Record<string, unknown>, label: string): Pick<
  ReleasePlanIssue,
  "number" | "order" | "dependsOn"
> {
  const number = parsePositiveInteger(object.number, `${label}.number`, 1, Number.MAX_SAFE_INTEGER);
  const order = parsePositiveInteger(object.order, `${label}.order`, 1, 10_000);
  if (!Array.isArray(object.dependsOn) || object.dependsOn.length > 50) {
    throw new Error(`${label}.dependsOn is invalid`);
  }
  const dependsOn = object.dependsOn.map((entry, dependencyIndex) => (
    parsePositiveInteger(entry, `${label}.dependsOn[${dependencyIndex}]`, 1, Number.MAX_SAFE_INTEGER)
  ));
  if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`${label}.dependsOn contains duplicates`);
  return { number, order, dependsOn };
}

function validateIssueGraph<T extends ReleasePlanIssue>(
  value: unknown,
  validateIssue: (entry: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new Error("plan.issues must contain 1 to 50 issues");
  }
  const issues = value.map((entry, index) => validateIssue(entry, index));
  const numbers = issues.map((issue) => issue.number);
  if (new Set(numbers).size !== numbers.length) throw new Error("plan.issues contains duplicate issue numbers");
  const orders = issues.map((issue) => issue.order);
  if (new Set(orders).size !== orders.length) throw new Error("plan.issues contains duplicate order values");
  issues.sort((left, right) => left.order - right.order);
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  for (const issue of issues) {
    if (issue.dependsOn.includes(issue.number)) throw new Error(`issue #${issue.number} depends on itself`);
    for (const dependency of issue.dependsOn) {
      const dependencyIssue = byNumber.get(dependency);
      if (!dependencyIssue) throw new Error(`issue #${issue.number} depends on missing issue #${dependency}`);
      if (dependencyIssue.order >= issue.order) {
        throw new Error(`issue #${issue.number} depends on issue #${dependency} that does not precede it`);
      }
    }
  }
  return issues;
}

function prefixedHash(value: unknown, label: string): string {
  const text = boundedExactText(value, label, 71);
  if (!SHA256_PREFIXED_PATTERN.test(text)) {
    throw new Error(`${label} must match sha256:<64 lowercase hexadecimal characters>`);
  }
  return text;
}

function safeGitRefName(value: unknown, label: string): string {
  const text = boundedExactText(value, label, 300);
  const segments = text.split("/");
  if (!/^[A-Za-z0-9._/-]+$/.test(text)
    || text === "@"
    || text.includes("..")
    || text.includes("@{")
    || text.includes("//")
    || text.startsWith("/")
    || text.endsWith("/")
    || text.endsWith(".")
    || segments.some((segment) => segment.startsWith(".") || segment.endsWith(".lock"))) {
    throw new Error(`${label} is not a safe Git ref name`);
  }
  return text;
}
