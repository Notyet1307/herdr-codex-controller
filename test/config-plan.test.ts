import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig } from "../src/config.js";
import { assertPlanCompatibleWithConfig, isReleasePlanV2, validatePlan } from "../src/plan.js";
import { boundedExactText, digestJson, sha256PrefixedUtf8, stableStringify } from "../src/util.js";
import { createTestRepo, testConfig, testPlan, testPlanV2 } from "./support.js";

test("config and ordered plan validate with isolated paths", () => {
  const repo = createTestRepo();
  try {
    const config = validateConfig(testConfig(repo));
    const plan = validatePlan(testPlan());
    assert.equal(config.codex.networkAccess, false);
    assert.deepEqual(plan.issues.map((issue) => issue.number), [1, 2]);
  } finally { repo.cleanup(); }
});

test("canonical JSON uses recursive code-unit key order", () => {
  const value = {
    pullRequest: { mergedAt: "a", mergeSha: "b" },
    controllerProvenance: {
      releasePlan: { version: 2, digest: "d" },
      controller: { sourceRevision: "r", sourceManifestDigest: "m" },
    },
  };
  assert.equal(
    stableStringify(value),
    '{"controllerProvenance":{"controller":{"sourceManifestDigest":"m","sourceRevision":"r"},"releasePlan":{"digest":"d","version":2}},"pullRequest":{"mergeSha":"b","mergedAt":"a"}}',
  );
  assert.equal(stableStringify(value), stableStringify(structuredClone(value)));
});

test("plan rejects a dependency that does not precede the issue", () => {
  const plan: any = testPlan();
  plan.issues[0].dependsOn = [2];
  assert.throws(() => validatePlan(plan), /does not precede|depends on/);
});

test("config rejects overlapping source and state paths", () => {
  const repo = createTestRepo();
  try {
    const config: any = testConfig(repo);
    config.stateDir = `${repo.source}/state`;
    assert.throws(() => validateConfig(config), /must not overlap/);
  } finally { repo.cleanup(); }
});

test("execution mode defaults to v2 direct and legacy paths require explicit opt-in", () => {
  const repo = createTestRepo();
  try {
    const raw: any = testConfig(repo);
    raw.delivery.createPullRequest = true;
    raw.delivery.requiredChecks = ["verify"];
    delete raw.executionMode;
    const direct = validateConfig(raw);
    assert.equal(direct.executionMode, "release-plan-v2-direct");
    assert.throws(
      () => assertPlanCompatibleWithConfig(testPlan([1]), direct),
      (error: any) => error?.code === "production_plan_v1_rejected",
    );

    const compatibility = validateConfig({ ...raw, executionMode: "release-plan-v1-compatibility" });
    assert.doesNotThrow(() => assertPlanCompatibleWithConfig(testPlan([1]), compatibility));
    assert.throws(
      () => validateConfig({ ...raw, executionMode: "qualified-dispatcher" }),
      /config\.executionMode/,
    );
  } finally { repo.cleanup(); }
});

test("production direct delivery policy requires a PR and exact non-empty checks", () => {
  const repo = createTestRepo();
  try {
    const valid = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    assert.doesNotThrow(() => validateConfig(valid));
    const cases: Array<(config: any) => void> = [
      (config) => { config.delivery.createPullRequest = false; },
      (config) => { config.delivery.allowNoChecks = true; },
      (config) => { config.delivery.requiredChecks = []; },
      (config) => { config.delivery.requiredChecks = ["verify", "verify"]; },
    ];
    for (const mutate of cases) {
      const config = structuredClone(valid) as any;
      mutate(config);
      assert.throws(
        () => validateConfig(config),
        (error: any) => error?.code === "production_delivery_policy_invalid",
      );
    }
  } finally { repo.cleanup(); }
});

test("Release Plan v1 keeps its existing nullable and operator-supplied fields", () => {
  const plan: any = testPlan([1]);
  plan.parentIssue = null;
  plan.issues[0].objective = null;
  plan.issues[0].suggestedValidation = [{ command: "npm test" }];
  plan.issues[0].allowNoop = true;
  const validated = validatePlan(plan);
  assert.equal(validated.version, 1);
  assert.equal(validated.parentIssue, null);
  assert.equal(validated.issues[0]?.objective, null);
  assert.deepEqual(validated.issues[0]?.suggestedValidation, [{ command: "npm test" }]);
  assert.equal(validated.issues[0]?.allowNoop, true);
  assert.throws(() => validatePlan({ ...plan, unexpected: true }), /unknown keys/);
});

test("Release Plan v2 validates its complete source contract and preserves exact titles", () => {
  const repo = createTestRepo();
  try {
    const raw = structuredClone(testPlanV2(repo));
    raw.source.parentBinding.expectedTitle = "  Parent title\n";
    raw.issues[0]!.expectedTitle = "\tIssue title with exact whitespace  ";
    const plan = validatePlan(raw);
    assert.equal(isReleasePlanV2(plan), true);
    if (!isReleasePlanV2(plan)) throw new Error("expected v2");
    assert.equal(plan.source.parentBinding.expectedTitle, "  Parent title\n");
    assert.equal(plan.issues[0]?.expectedTitle, "\tIssue title with exact whitespace  ");
    assert.equal(digestJson(plan), digestJson(structuredClone(plan)));
    assert.equal(sha256PrefixedUtf8(""), "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(boundedExactText("  exact\n", "fixture", 20), "  exact\n");
  } finally { repo.cleanup(); }
});

test("Release Plan v2 rejects every closed source-contract shape", () => {
  const repo = createTestRepo();
  try {
    const cases: Array<{ name: string; mutate(plan: any): void; pattern: RegExp }> = [
      { name: "top-level extra key", mutate: (plan) => { plan.extra = true; }, pattern: /unknown keys/ },
      { name: "source extra key", mutate: (plan) => { plan.source.extra = true; }, pattern: /plan\.source has unknown keys/ },
      { name: "parent binding extra key", mutate: (plan) => { plan.source.parentBinding.extra = true; }, pattern: /parentBinding has unknown keys/ },
      { name: "Issue extra key", mutate: (plan) => { plan.issues[0].extra = true; }, pattern: /issues\[0\].*unknown keys/ },
      { name: "missing field", mutate: (plan) => { delete plan.source.specContentHash; }, pattern: /missing keys/ },
      { name: "invalid base SHA", mutate: (plan) => { plan.source.baseSha = "A".repeat(40); }, pattern: /lowercase hexadecimal/ },
      { name: "invalid body hash", mutate: (plan) => { plan.issues[0].expectedBodyHash = "sha256:ABC"; }, pattern: /must match sha256/ },
      { name: "missing Oracle", mutate: (plan) => { plan.issues[0].oracleBindings = []; }, pattern: /oracleBindings must contain 1 to 8/ },
      { name: "missing verifier", mutate: (plan) => { delete plan.issues[0].oracleBindings[0].verifier; }, pattern: /missing keys/ },
      { name: "verifier extra key", mutate: (plan) => { plan.issues[0].oracleBindings[0].verifier.extra = true; }, pattern: /unknown keys/ },
      { name: "verifier Oracle mismatch", mutate: (plan) => { plan.issues[0].oracleBindings[0].verifier.oracleId = "O99"; }, pattern: /does not bind/ },
      { name: "verifier command mismatch", mutate: (plan) => { plan.issues[0].oracleBindings[0].verifier.command = "npm run verify:other"; }, pattern: /does not bind/ },
      { name: "verifier script mismatch", mutate: (plan) => { plan.issues[0].oracleBindings[0].verifier.packageScript.name = "verify:other"; }, pattern: /does not match/ },
      { name: "verifier digest mismatch", mutate: (plan) => { plan.issues[0].oracleBindings[0].verifier.digest = `sha256:${"0".repeat(64)}`; }, pattern: /digest is invalid/ },
      { name: "verifier package path", mutate: (plan) => { plan.issues[0].oracleBindings[0].verifier.files[0].path = "package.json"; }, pattern: /excluding package\.json/ },
      { name: "duplicate verifier path", mutate: (plan) => { plan.issues[0].oracleBindings[0].verifier.files.push(plan.issues[0].oracleBindings[0].verifier.files[0]); }, pattern: /unique, sorted/ },
      { name: "Oracle base mismatch", mutate: (plan) => { plan.issues[0].oracleBindings[0].artifact.baseSha = "f".repeat(40); }, pattern: /Oracle artifact baseSha must equal/ },
      { name: "unprotected Oracle", mutate: (plan) => { plan.issues[0].protectedPaths = ["fixtures/other.json"]; }, pattern: /must include every Oracle/ },
      { name: "missing replan trigger", mutate: (plan) => { plan.issues[0].replanTriggers.pop(); }, pattern: /missing a controlled trigger/ },
      { name: "parent mismatch", mutate: (plan) => { plan.source.parentBinding.number += 1; }, pattern: /must equal plan\.parentIssue/ },
      { name: "validation commands", mutate: (plan) => { plan.issues[0].suggestedValidation = [{ command: "npm test" }]; }, pattern: /exactly \[\]/ },
      { name: "allow no-op", mutate: (plan) => { plan.issues[0].allowNoop = true; }, pattern: /must be false/ },
      { name: "unknown risk class", mutate: (plan) => { plan.issues[0].riskClasses = ["BOUNDED_CHANGE"]; }, pattern: /unknown_risk_class/ },
      { name: "root wildcard expected path", mutate: (plan) => { plan.issues[0].expectedPaths = ["*.ts"]; }, pattern: /invalid_expected_path_pattern/ },
      { name: "null objective", mutate: (plan) => { plan.issues[0].objective = null; }, pattern: /must be a string/ },
      { name: "too few criteria", mutate: (plan) => { plan.issues[0].acceptanceCriteria = ["one", "two"]; }, pattern: /3 to 8/ },
      { name: "too many criteria", mutate: (plan) => { plan.issues[0].acceptanceCriteria = Array.from({ length: 9 }, (_, index) => `criterion ${index}`); }, pattern: /at most 8/ },
      { name: "future dependency", mutate: (plan) => { plan.issues[0].dependsOn = [plan.issues[1].number]; }, pattern: /does not precede/ },
      { name: "empty release criteria", mutate: (plan) => { plan.releaseAcceptanceCriteria = []; }, pattern: /1 to 50/ },
      { name: "too much review focus", mutate: (plan) => { plan.reviewFocus = Array.from({ length: 21 }, (_, index) => `focus ${index}`); }, pattern: /at most 20/ },
      { name: "unsafe base ref", mutate: (plan) => { plan.source.baseRef = "refs/../main"; }, pattern: /safe Git ref/ },
    ];
    for (const fixture of cases) {
      const plan = structuredClone(testPlanV2(repo)) as any;
      fixture.mutate(plan);
      assert.throws(() => validatePlan(plan), fixture.pattern, fixture.name);
    }
    const boundedWildcard = structuredClone(testPlanV2(repo)) as any;
    boundedWildcard.issues[0].expectedPaths = ["src/*.ts"];
    assert.doesNotThrow(() => validatePlan(boundedWildcard));
  } finally { repo.cleanup(); }
});

test("Release Plan v2 config binding fails closed with stable error codes", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlanV2(repo);
    assert.doesNotThrow(() => assertPlanCompatibleWithConfig(plan, config));
    assert.throws(
      () => assertPlanCompatibleWithConfig({ ...plan, source: { ...plan.source, repo: "other/project" } }, config),
      (error: any) => error?.code === "plan_source_repo_mismatch",
    );
    assert.throws(
      () => assertPlanCompatibleWithConfig({ ...plan, source: { ...plan.source, baseRef: "develop" } }, config),
      (error: any) => error?.code === "plan_source_base_ref_mismatch",
    );
    const missingOracleCommand = structuredClone(config);
    missingOracleCommand.validation.release = missingOracleCommand.validation.release
      .filter(({ command }) => command !== plan.issues[0]!.oracleBindings[0]!.execution.command);
    assert.throws(
      () => assertPlanCompatibleWithConfig(plan, missingOracleCommand),
      (error: any) => error?.code === "oracle_validation_command_missing",
    );
    const duplicateOracleCommand = structuredClone(config);
    duplicateOracleCommand.validation.release.push(
      duplicateOracleCommand.validation.release.find(({ command }) => (
        command === plan.issues[0]!.oracleBindings[0]!.execution.command
      ))!,
    );
    assert.throws(
      () => assertPlanCompatibleWithConfig(plan, duplicateOracleCommand),
      (error: any) => error?.code === "oracle_validation_command_ambiguous",
    );
  } finally { repo.cleanup(); }
});

test("exact title limits use original UTF-8 bytes", () => {
  assert.equal(boundedExactText("界".repeat(166), "title", 500), "界".repeat(166));
  assert.throws(() => boundedExactText("界".repeat(167), "title", 500), /exceeds 500 bytes/);
});
