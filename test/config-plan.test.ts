import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig } from "../src/config.js";
import { assertPlanCompatibleWithConfig, validatePlan } from "../src/plan.js";
import { digestJson, stableStringify } from "../src/util.js";
import { configInput, createTestRepo, highRiskPlan, testConfig, testPlan } from "./support.js";

test("current config exposes only operator choices", () => {
  const repo = createTestRepo();
  try {
    const input = configInput(testConfig(repo));
    const config = validateConfig(input);
    assert.equal(config.version, 4);
    assert.equal(config.reviewDemo, null);
    for (const mutate of [
      (value: any) => { value.executionMode = "release-plan-v2-direct"; },
      (value: any) => { value.review = { enabled: false }; },
      (value: any) => { value.codex.workerProfile = "custom"; },
      (value: any) => { value.codex.networkAccess = true; },
      (value: any) => { value.delivery.autoMerge = false; },
    ]) {
      const invalid = structuredClone(input) as any;
      mutate(invalid);
      assert.throws(() => validateConfig(invalid), /unknown keys/);
    }
    const old = structuredClone(input) as any;
    old.version = 3;
    assert.throws(() => validateConfig(old), /version must be 4/);
  } finally { repo.cleanup(); }
});

test("semantic Release Plan is closed, deterministic, and supports optional scope and Oracle commands", () => {
  const repo = createTestRepo();
  try {
    const ordinary = validatePlan(testPlan(repo, [1]));
    assert.equal(ordinary.controllerContractVersion, 1);
    assert.deepEqual(ordinary.issues[0]?.oracleCommands, []);
    const high = validatePlan(highRiskPlan(repo, [1]));
    assert.equal(high.issues[0]?.risk, "high");
    assert.equal(high.issues[0]?.oracleCommands.length, 1);
    assert.equal(digestJson(high), digestJson(structuredClone(high)));

    const optional = structuredClone(ordinary) as any;
    delete optional.issues[0].expectedPaths;
    delete optional.issues[0].oracleCommands;
    assert.deepEqual(validatePlan(optional).issues[0]?.expectedPaths, []);

    for (const fixture of [
      { mutate: (plan: any) => { plan.controllerContractVersion = 2; }, code: "unsupported_controller_contract_version" },
      { mutate: (plan: any) => { plan.extra = true; }, pattern: /unknown keys/ },
      { mutate: (plan: any) => { plan.id = "Release-ID"; }, pattern: /lowercase safe token/ },
      { mutate: (plan: any) => { plan.issues[0].risk = "critical"; }, pattern: /low, normal, or high/ },
      { mutate: (plan: any) => { plan.issues[0].oracleCommands = ["npm test"]; }, pattern: /only for high-risk/ },
      { mutate: (plan: any) => { plan.issues[0].expectedPaths = ["*.ts"]; }, pattern: /invalid_expected_path_pattern/ },
      { mutate: (plan: any) => { plan.issues[0].acceptanceCriteria = []; }, pattern: /must not be empty/ },
    ]) {
      const invalid = structuredClone(ordinary) as any;
      fixture.mutate(invalid);
      assert.throws(
        () => validatePlan(invalid),
        fixture.code
          ? (error: unknown) => error instanceof Error && "code" in error && error.code === fixture.code
          : fixture.pattern,
      );
    }
  } finally { repo.cleanup(); }
});

test("plan dependency, repo, baseRef, and Oracle command bindings fail closed", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = highRiskPlan(repo, [1, 2]);
    assert.doesNotThrow(() => assertPlanCompatibleWithConfig(plan, config));
    assert.throws(() => assertPlanCompatibleWithConfig({ ...plan, repo: "other/repo" }, config), (error: any) => error?.code === "plan_repo_mismatch");
    assert.throws(() => assertPlanCompatibleWithConfig({ ...plan, baseRef: "develop" }, config), (error: any) => error?.code === "plan_base_ref_mismatch");
    const missing = structuredClone(config);
    missing.validation.release = missing.validation.release.filter(({ command }) => command !== plan.issues[0]!.oracleCommands[0]);
    assert.throws(() => assertPlanCompatibleWithConfig(plan, missing), (error: any) => error?.code === "oracle_validation_command_missing");
    const future = testPlan(repo, [1, 2]);
    future.issues[0]!.dependsOn = [2];
    assert.throws(() => validatePlan(future), /does not precede/);
  } finally { repo.cleanup(); }
});

test("canonical JSON remains code-unit deterministic", () => {
  const value = { pullRequest: { mergedAt: "a", mergeSha: "b" }, plan: { baseSha: "c", id: "d" } };
  assert.equal(stableStringify(value), '{"plan":{"baseSha":"c","id":"d"},"pullRequest":{"mergeSha":"b","mergedAt":"a"}}');
});
