import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReleasePlan, ReleasePlanIssue } from "./types.js";
import { boundedStringArray, boundedText, parsePositiveInteger, safeToken } from "./util.js";
import { expectExactKeys, expectObject, validateCommands } from "./config.js";

export function loadPlan(path: string): ReleasePlan {
  const absolute = resolve(path);
  const value = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
  return validatePlan(value);
}

export function validatePlan(value: unknown): ReleasePlan {
  const object = expectObject(value, "plan");
  expectExactKeys(object, [
    "id", "issues", "objective", "parentIssue", "releaseAcceptanceCriteria", "reviewFocus", "title", "version",
  ], "plan");
  if (object.version !== 1) throw new Error("plan.version must be 1");
  const id = safeToken(boundedText(object.id, "plan.id", 120));
  const title = boundedText(object.title, "plan.title", 500);
  const objective = boundedText(object.objective, "plan.objective", 8_000);
  const parentIssue = object.parentIssue === null
    ? null
    : parsePositiveInteger(object.parentIssue, "plan.parentIssue", 1, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(object.issues) || object.issues.length === 0 || object.issues.length > 50) {
    throw new Error("plan.issues must contain 1 to 50 issues");
  }
  const issues = object.issues.map((entry, index) => validateIssue(entry, index));
  const numbers = issues.map((issue) => issue.number);
  if (new Set(numbers).size !== numbers.length) throw new Error("plan.issues contains duplicate issue numbers");
  const orders = issues.map((issue) => issue.order);
  if (new Set(orders).size !== orders.length) throw new Error("plan.issues contains duplicate order values");
  issues.sort((left, right) => left.order - right.order);
  for (const issue of issues) {
    if (issue.dependsOn.includes(issue.number)) throw new Error(`issue #${issue.number} depends on itself`);
    for (const dependency of issue.dependsOn) {
      const dependencyIssue = issues.find((candidate) => candidate.number === dependency);
      if (!dependencyIssue) throw new Error(`issue #${issue.number} depends on missing issue #${dependency}`);
      if (dependencyIssue.order >= issue.order) throw new Error(`issue #${issue.number} depends on issue #${dependency} that does not precede it`);
    }
  }
  return {
    version: 1,
    id,
    title,
    objective,
    parentIssue,
    issues,
    releaseAcceptanceCriteria: boundedStringArray(object.releaseAcceptanceCriteria, "plan.releaseAcceptanceCriteria", 50, 2_000),
    reviewFocus: boundedStringArray(object.reviewFocus, "plan.reviewFocus", 50, 2_000),
  };
}

function validateIssue(value: unknown, index: number): ReleasePlanIssue {
  const label = `plan.issues[${index}]`;
  const object = expectObject(value, label);
  expectExactKeys(object, [
    "acceptanceCriteria", "allowNoop", "dependsOn", "number", "objective", "order", "suggestedValidation",
  ], label);
  const number = parsePositiveInteger(object.number, `${label}.number`, 1, Number.MAX_SAFE_INTEGER);
  const order = parsePositiveInteger(object.order, `${label}.order`, 1, 10_000);
  if (!Array.isArray(object.dependsOn) || object.dependsOn.length > 50) throw new Error(`${label}.dependsOn is invalid`);
  const dependsOn = object.dependsOn.map((entry, dependencyIndex) => (
    parsePositiveInteger(entry, `${label}.dependsOn[${dependencyIndex}]`, 1, Number.MAX_SAFE_INTEGER)
  ));
  if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`${label}.dependsOn contains duplicates`);
  if (object.allowNoop !== true && object.allowNoop !== false) throw new Error(`${label}.allowNoop must be boolean`);
  return {
    number,
    order,
    dependsOn,
    objective: object.objective === null ? null : boundedText(object.objective, `${label}.objective`, 8_000),
    acceptanceCriteria: boundedStringArray(object.acceptanceCriteria, `${label}.acceptanceCriteria`, 50, 2_000),
    suggestedValidation: validateCommands(object.suggestedValidation, `${label}.suggestedValidation`, 20),
    allowNoop: object.allowNoop,
  };
}
