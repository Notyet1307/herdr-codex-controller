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
  digestJson,
  parsePositiveInteger,
  safeToken,
} from "./util.js";
import { assertProductionDeliveryPolicy, expectExactKeys, expectObject, validateCommands } from "./config.js";
import { ControllerError } from "./errors.js";
import { assertCanonicalRiskClasses } from "./risk-classes.js";

const PLAN_KEYS_V1 = [
  "id", "issues", "objective", "parentIssue", "releaseAcceptanceCriteria", "reviewFocus", "title", "version",
];
const PLAN_KEYS_V2 = [...PLAN_KEYS_V1, "source"];
const ISSUE_KEYS_V1 = [
  "acceptanceCriteria", "allowNoop", "dependsOn", "number", "objective", "order", "suggestedValidation",
];
const ISSUE_KEYS_V2 = [
  ...ISSUE_KEYS_V1,
  "expectedBodyHash",
  "expectedPaths",
  "expectedTitle",
  "integrationOnly",
  "oracleBindings",
  "protectedPaths",
  "replanTriggers",
  "riskClasses",
  "scopeBudget",
  "waiverDigests",
];
const SHA256_PREFIXED_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REQUIRED_REPLAN_TRIGGERS = [
  "ACCEPTED_DECISION_CHANGE_REQUIRED",
  "THIRD_RISK_CLASS_DISCOVERED",
  "SCOPE_BUDGET_EXCEEDED",
  "DOWNSTREAM_RELEASE_BEHAVIOR_DISCOVERED",
];

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

export function oracleVerifierProtectedPaths(plan: ReleasePlan): string[] {
  if (!isReleasePlanV2(plan)) return [];
  return [...new Set([
    "package.json",
    ...plan.issues.flatMap((issue) => issue.oracleBindings.flatMap((binding) => (
      binding.verifier.files.map(({ path }) => path)
    ))),
  ])].sort();
}

export function assertPlanCompatibleWithConfig(plan: ReleasePlan, config: ControllerConfig): void {
  assertProductionDeliveryPolicy(config);
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
  for (const issue of plan.issues) {
    for (const binding of issue.oracleBindings) {
      const matches = config.validation.release.filter(({ command }) => command === binding.execution.command);
      if (matches.length === 0) {
        throw new ControllerError(
          "oracle_validation_command_missing",
          `Issue #${issue.number} Oracle ${binding.id} command is absent from config.validation.release.`,
        );
      }
      if (matches.length !== 1) {
        throw new ControllerError(
          "oracle_validation_command_ambiguous",
          `Issue #${issue.number} Oracle ${binding.id} command has multiple config.validation.release definitions.`,
        );
      }
    }
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
  const issues = validateIssueGraph(object.issues, validateIssueV2);
  if (issues.some((issue) => issue.oracleBindings.some((binding) => binding.artifact.baseSha !== source.baseSha))) {
    throw new Error("plan Oracle artifact baseSha must equal plan.source.baseSha");
  }
  assertVerifierBindingsConsistent(issues);
  return {
    version: 2,
    source,
    id: safeToken(boundedText(object.id, "plan.id", 120)),
    title: boundedText(object.title, "plan.title", 500),
    objective: boundedText(object.objective, "plan.objective", 8_000),
    parentIssue,
    issues,
    releaseAcceptanceCriteria,
    reviewFocus: boundedStringArray(object.reviewFocus, "plan.reviewFocus", 20, 2_000),
  };
}

function validateSourceV2(value: unknown): ReleasePlanV2["source"] {
  const object = expectObject(value, "plan.source");
  expectExactKeys(object, [
    "baseRef", "baseSha", "decisionManifestDigest", "deliveryGraphDigest", "dependencyHandoffDigests",
    "parentBinding", "planner", "predecessorReceiptDigest", "repo", "specContentHash",
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
    decisionManifestDigest: prefixedHash(object.decisionManifestDigest, "plan.source.decisionManifestDigest"),
    predecessorReceiptDigest: object.predecessorReceiptDigest === null
      ? null
      : prefixedHash(object.predecessorReceiptDigest, "plan.source.predecessorReceiptDigest"),
    dependencyHandoffDigests: digestArray(
      object.dependencyHandoffDigests,
      "plan.source.dependencyHandoffDigests",
      100,
    ),
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
  const oracleBindings = array(object.oracleBindings, `${label}.oracleBindings`, 1, 8)
    .map((binding, oracleIndex) => validateOracleBinding(binding, `${label}.oracleBindings[${oracleIndex}]`));
  if (new Set(oracleBindings.map((binding) => binding.id)).size !== oracleBindings.length) {
    throw new Error(`${label}.oracleBindings contains duplicate ids`);
  }
  const riskClasses = boundedStringArray(object.riskClasses, `${label}.riskClasses`, 16, 64);
  if (riskClasses.length === 0 || riskClasses.some((risk) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(risk))) {
    throw new Error(`${label}.riskClasses is invalid`);
  }
  assertCanonicalRiskClasses(riskClasses, `${label}.riskClasses`);
  const scopeBudget = expectObject(object.scopeBudget, `${label}.scopeBudget`);
  expectExactKeys(scopeBudget, ["maxChangedLines", "maxFiles"], `${label}.scopeBudget`);
  const expectedPaths = pathArray(object.expectedPaths, `${label}.expectedPaths`, 1, 8, true);
  const protectedPaths = pathArray(object.protectedPaths, `${label}.protectedPaths`, 1, 100, false);
  if (oracleBindings.some((binding) => !protectedPaths.includes(binding.artifact.path))) {
    throw new Error(`${label}.protectedPaths must include every Oracle artifact path`);
  }
  const replanTriggers = boundedStringArray(object.replanTriggers, `${label}.replanTriggers`, 32, 128);
  if (REQUIRED_REPLAN_TRIGGERS.some((trigger) => !replanTriggers.includes(trigger))) {
    throw new Error(`${label}.replanTriggers is missing a controlled trigger`);
  }
  return {
    ...common,
    objective: boundedText(object.objective, `${label}.objective`, 8_000),
    acceptanceCriteria,
    suggestedValidation: [],
    allowNoop: false,
    expectedTitle: boundedExactText(object.expectedTitle, `${label}.expectedTitle`, 500),
    expectedBodyHash: prefixedHash(object.expectedBodyHash, `${label}.expectedBodyHash`),
    oracleBindings,
    riskClasses,
    scopeBudget: {
      maxFiles: parsePositiveInteger(scopeBudget.maxFiles, `${label}.scopeBudget.maxFiles`, 1, 1_000),
      maxChangedLines: parsePositiveInteger(
        scopeBudget.maxChangedLines,
        `${label}.scopeBudget.maxChangedLines`,
        1,
        1_000_000,
      ),
    },
    expectedPaths,
    protectedPaths,
    replanTriggers,
    integrationOnly: validateIntegrationOnly(object.integrationOnly, `${label}.integrationOnly`),
    waiverDigests: digestArray(object.waiverDigests, `${label}.waiverDigests`, 8),
  };
}

function validateOracleBinding(value: unknown, label: string): ReleasePlanIssueV2["oracleBindings"][number] {
  const object = expectObject(value, label);
  expectExactKeys(object, ["artifact", "execution", "id", "owner", "schema", "verifier", "workerMutationAllowed"], label);
  if (object.schema !== "pi-ticket-planning:oracle-binding:v1" || object.workerMutationAllowed !== false) {
    throw new Error(`${label} is not an immutable Oracle binding`);
  }
  const id = boundedExactText(object.id, `${label}.id`, 64);
  if (!/^O(?:0[1-9][0-9]*|[1-9][0-9]*)$/.test(id)) throw new Error(`${label}.id is invalid`);
  const owner = expectObject(object.owner, `${label}.owner`);
  expectExactKeys(owner, ["identity", "kind"], `${label}.owner`);
  if (owner.kind !== "INDEPENDENT_VERIFICATION") throw new Error(`${label}.owner.kind is invalid`);
  const artifact = expectObject(object.artifact, `${label}.artifact`);
  expectExactKeys(artifact, ["baseSha", "byteCount", "format", "path", "sha256"], `${label}.artifact`);
  const execution = expectObject(object.execution, `${label}.execution`);
  expectExactKeys(execution, ["command"], `${label}.execution`);
  const command = boundedExactText(execution.command, `${label}.execution.command`, 512);
  if (!/^npm run verify:[A-Za-z0-9:_-]+$/.test(command)) throw new Error(`${label}.execution.command is invalid`);
  const baseSha = boundedExactText(artifact.baseSha, `${label}.artifact.baseSha`, 40);
  if (!/^[a-f0-9]{40}$/.test(baseSha)) throw new Error(`${label}.artifact.baseSha is invalid`);
  const verifier = validateOracleVerifier(object.verifier, `${label}.verifier`, id, command);
  return {
    schema: "pi-ticket-planning:oracle-binding:v1",
    id,
    owner: {
      kind: "INDEPENDENT_VERIFICATION",
      identity: boundedExactText(owner.identity, `${label}.owner.identity`, 256),
    },
    artifact: {
      path: exactRepoPath(artifact.path, `${label}.artifact.path`),
      format: boundedExactText(artifact.format, `${label}.artifact.format`, 256),
      baseSha,
      sha256: prefixedHash(artifact.sha256, `${label}.artifact.sha256`),
      byteCount: parsePositiveInteger(artifact.byteCount, `${label}.artifact.byteCount`, 0, 64 * 1024 * 1024),
    },
    execution: { command },
    verifier,
    workerMutationAllowed: false,
  };
}

function validateOracleVerifier(
  value: unknown,
  label: string,
  oracleId: string,
  command: string,
): ReleasePlanIssueV2["oracleBindings"][number]["verifier"] {
  const object = expectObject(value, label);
  expectExactKeys(object, ["command", "digest", "files", "oracleId", "packageScript", "schema"], label);
  if (object.schema !== "herdr-codex-controller:oracle-verifier-manifest:v1"
    || object.oracleId !== oracleId
    || object.command !== command) {
    throw new Error(`${label} does not bind its Oracle id and command`);
  }
  const packageScript = expectObject(object.packageScript, `${label}.packageScript`);
  expectExactKeys(packageScript, ["definitionSha256", "name"], `${label}.packageScript`);
  const scriptName = boundedExactText(packageScript.name, `${label}.packageScript.name`, 256);
  if (scriptName !== command.slice("npm run ".length)) {
    throw new Error(`${label}.packageScript.name does not match command`);
  }
  const files = array(object.files, `${label}.files`, 1, 100).map((entry, index) => {
    const file = expectObject(entry, `${label}.files[${index}]`);
    expectExactKeys(file, ["byteCount", "path", "sha256"], `${label}.files[${index}]`);
    return {
      path: exactRepoPath(file.path, `${label}.files[${index}].path`),
      sha256: prefixedHash(file.sha256, `${label}.files[${index}].sha256`),
      byteCount: parsePositiveInteger(file.byteCount, `${label}.files[${index}].byteCount`, 0, 64 * 1024 * 1024),
    };
  });
  const paths = files.map(({ path }) => path);
  if (paths.includes("package.json") || new Set(paths).size !== paths.length
    || paths.join("\n") !== [...paths].sort().join("\n")) {
    throw new Error(`${label}.files must be unique, sorted verifier paths excluding package.json`);
  }
  const identity = {
    schema: "herdr-codex-controller:oracle-verifier-manifest:v1" as const,
    oracleId,
    command,
    packageScript: {
      name: scriptName,
      definitionSha256: prefixedHash(
        packageScript.definitionSha256,
        `${label}.packageScript.definitionSha256`,
      ),
    },
    files,
  };
  const digest = prefixedHash(object.digest, `${label}.digest`);
  if (digest !== `sha256:${digestJson(identity)}`) throw new Error(`${label}.digest is invalid`);
  return { ...identity, digest };
}

function assertVerifierBindingsConsistent(issues: ReleasePlanIssueV2[]): void {
  const files = new Map<string, string>();
  const scripts = new Map<string, string>();
  for (const issue of issues) {
    for (const binding of issue.oracleBindings) {
      const script = binding.verifier.packageScript;
      const previousScript = scripts.get(script.name);
      if (previousScript && previousScript !== script.definitionSha256) {
        throw new Error(`Oracle verifier package script ${script.name} has conflicting bindings`);
      }
      scripts.set(script.name, script.definitionSha256);
      for (const file of binding.verifier.files) {
        const identity = `${file.sha256}:${file.byteCount}`;
        const previous = files.get(file.path);
        if (previous && previous !== identity) {
          throw new Error(`Oracle verifier file ${file.path} has conflicting bindings`);
        }
        files.set(file.path, identity);
      }
    }
  }
}

function validateIntegrationOnly(value: unknown, label: string): ReleasePlanIssueV2["integrationOnly"] {
  if (value === null) return null;
  const object = expectObject(value, label);
  expectExactKeys(object, ["missingBehavior", "noDuplicatedProductionLogic", "noNewProductBehavior", "noSchemaChanges"], label);
  if (object.noNewProductBehavior !== true || object.noSchemaChanges !== true
    || object.noDuplicatedProductionLogic !== true || object.missingBehavior !== "REPLAN_REQUIRED") {
    throw new Error(`${label} is invalid`);
  }
  return {
    noNewProductBehavior: true,
    noSchemaChanges: true,
    noDuplicatedProductionLogic: true,
    missingBehavior: "REPLAN_REQUIRED",
  };
}

function array(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain ${minimum} to ${maximum} entries`);
  }
  return value;
}

function digestArray(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} is invalid`);
  const result = value.map((entry, index) => prefixedHash(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}

function pathArray(value: unknown, label: string, minimum: number, maximum: number, allowGlob: boolean): string[] {
  return array(value, label, minimum, maximum).map((entry, index) => (
    allowGlob ? expectedRepoPath(entry, `${label}[${index}]`) : exactRepoPath(entry, `${label}[${index}]`)
  )).filter((entry, index, entries) => {
    if (entries.indexOf(entry) !== index) throw new Error(`${label} contains duplicates`);
    return true;
  });
}

function exactRepoPath(value: unknown, label: string): string {
  const text = boundedExactText(value, label, 2_048);
  const segments = text.split("/");
  if (text.startsWith("/") || /^[A-Za-z]:/.test(text) || text.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || /[*?[\]{}\u0000\r\n]/.test(text)) throw new Error(`${label} is unsafe`);
  return text;
}

function expectedRepoPath(value: unknown, label: string): string {
  const text = boundedExactText(value, label, 2_048);
  const segments = text.split("/");
  if (segments[0]?.includes("*")) throw new Error(`invalid_expected_path_pattern:${label}`);
  if (text.startsWith("/") || /^[A-Za-z]:/.test(text) || text.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || /[?[\]{}\u0000\r\n]/.test(text) || text.includes("**")) {
    throw new Error(`${label} is unsafe`);
  }
  return text;
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
