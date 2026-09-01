import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig } from "../src/config.js";
import { assertPlanCompatibleWithConfig, validatePlan } from "../src/plan.js";
import { boundedExactText, digestJson, sha256PrefixedUtf8, stableStringify } from "../src/util.js";
import { configInput, createTestRepo, testConfig, testPlan, testPlanV2 } from "./support.js";

test("production config v4 exposes only operator choices and synthesizes fixed policy", () => {
  const repo = createTestRepo();
  try {
    const input = configInput(testConfig(repo));
    const config = validateConfig(input);
    assert.equal(config.version, 4);
    assert.equal(config.executionMode, "release-plan-v2-direct");
    assert.deepEqual(config.review, { enabled: true, blockingSeverities: ["critical", "major"] });
    assert.equal(config.codex.workerProfile, null);
    assert.equal(config.codex.reviewerProfile, null);
    assert.equal(config.codex.networkAccess, false);
    assert.equal(config.delivery.createPullRequest, true);
    assert.equal(config.delivery.autoMerge, true);
    assert.equal(config.delivery.allowNoChecks, false);
    assert.deepEqual(config.delivery.mergeAuthority, {
      version: 1,
      mode: "controller-auto-merge",
      quarantine: "delete-exact-head-branch",
    });

    for (const mutate of [
      (value: any) => { value.executionMode = "release-plan-v2-direct"; },
      (value: any) => { value.review = { enabled: false }; },
      (value: any) => { value.codex.workerProfile = "custom"; },
      (value: any) => { value.codex.networkAccess = true; },
      (value: any) => { value.delivery.createPullRequest = false; },
      (value: any) => { value.delivery.autoMerge = false; },
      (value: any) => { value.delivery.allowNoChecks = true; },
      (value: any) => { value.delivery.mergeAuthority = {}; },
    ]) {
      const invalid = structuredClone(input) as any;
      mutate(invalid);
      assert.throws(() => validateConfig(invalid), /unknown keys/);
    }

    const old = structuredClone(input) as any;
    old.version = 3;
    assert.throws(
      () => validateConfig(old),
      (error: any) => error?.code === "production_config_migration_required",
    );
  } finally { repo.cleanup(); }
});

test("config rejects overlapping source and state paths", () => {
  const repo = createTestRepo();
  try {
    const input = configInput(testConfig(repo)) as any;
    input.stateDir = `${repo.source}/state`;
    assert.throws(() => validateConfig(input), /must not overlap/);
  } finally { repo.cleanup(); }
});

test("Release Plan v2 is the only runtime plan and Oracle is optional", () => {
  const repo = createTestRepo();
  try {
    const ordinary = validatePlan(testPlan(repo, [1]));
    assert.equal(ordinary.version, 2);
    assert.deepEqual(ordinary.issues[0]?.oracleBindings, []);
    assert.deepEqual(ordinary.issues[0]?.protectedPaths, []);
    const protectedPlan = validatePlan(testPlanV2(repo, [1]));
    assert.equal(protectedPlan.issues[0]?.oracleBindings.length, 1);
    assert.throws(() => validatePlan({
      version: 1,
      id: "legacy",
      title: "legacy",
      objective: "legacy",
      parentIssue: null,
      issues: [],
      releaseAcceptanceCriteria: [],
      reviewFocus: [],
    }), /version must be 2/);
  } finally { repo.cleanup(); }
});

test("Release Plan v2 validates exact source identity and closed high-risk Oracle bindings", () => {
  const repo = createTestRepo();
  try {
    const raw = structuredClone(testPlanV2(repo, [1]));
    raw.source.parentBinding.expectedTitle = "  Parent title\n";
    raw.issues[0]!.expectedTitle = "\tIssue title with exact whitespace  ";
    const plan = validatePlan(raw);
    assert.equal(plan.source.parentBinding.expectedTitle, "  Parent title\n");
    assert.equal(plan.issues[0]?.expectedTitle, "\tIssue title with exact whitespace  ");
    assert.equal(digestJson(plan), digestJson(structuredClone(plan)));
    assert.equal(sha256PrefixedUtf8(""), "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

    const cases: Array<{ mutate(plan: any): void; pattern: RegExp }> = [
      { mutate: (value) => { value.extra = true; }, pattern: /unknown keys/ },
      { mutate: (value) => { value.source.baseSha = "A".repeat(40); }, pattern: /lowercase hexadecimal/ },
      { mutate: (value) => { value.issues[0].oracleBindings[0].verifier.extra = true; }, pattern: /unknown keys/ },
      { mutate: (value) => { value.issues[0].oracleBindings[0].verifier.digest = `sha256:${"0".repeat(64)}`; }, pattern: /digest is invalid/ },
      { mutate: (value) => { value.issues[0].oracleBindings[0].artifact.baseSha = "f".repeat(40); }, pattern: /baseSha must equal/ },
      { mutate: (value) => { value.issues[0].protectedPaths = []; }, pattern: /must include every Oracle/ },
      { mutate: (value) => { value.issues[0].expectedPaths = ["*.ts"]; }, pattern: /invalid_expected_path_pattern/ },
      { mutate: (value) => { value.issues[0].acceptanceCriteria = ["one", "two"]; }, pattern: /3 to 8/ },
    ];
    for (const fixture of cases) {
      const invalid = structuredClone(testPlanV2(repo, [1])) as any;
      fixture.mutate(invalid);
      assert.throws(() => validatePlan(invalid), fixture.pattern);
    }
  } finally { repo.cleanup(); }
});

test("plan dependency order and config binding remain fail closed", () => {
  const repo = createTestRepo();
  try {
    const plan = testPlan(repo);
    plan.issues[0]!.dependsOn = [2];
    assert.throws(() => validatePlan(plan), /does not precede|depends on/);

    const config = testConfig(repo);
    const bound = testPlanV2(repo, [1]);
    assert.doesNotThrow(() => assertPlanCompatibleWithConfig(bound, config));
    assert.throws(
      () => assertPlanCompatibleWithConfig({ ...bound, source: { ...bound.source, repo: "other/project" } }, config),
      (error: any) => error?.code === "plan_source_repo_mismatch",
    );
    const missingOracleCommand = structuredClone(config);
    missingOracleCommand.validation.release = missingOracleCommand.validation.release
      .filter(({ command }) => command !== bound.issues[0]!.oracleBindings[0]!.execution.command);
    assert.throws(
      () => assertPlanCompatibleWithConfig(bound, missingOracleCommand),
      (error: any) => error?.code === "oracle_validation_command_missing",
    );
  } finally { repo.cleanup(); }
});

test("canonical JSON and exact UTF-8 limits remain deterministic", () => {
  const value = { pullRequest: { mergedAt: "a", mergeSha: "b" }, controller: { sourceRevision: "r", sourceManifestDigest: "m" } };
  assert.equal(stableStringify(value), '{"controller":{"sourceManifestDigest":"m","sourceRevision":"r"},"pullRequest":{"mergeSha":"b","mergedAt":"a"}}');
  assert.equal(boundedExactText("界".repeat(166), "title", 500), "界".repeat(166));
  assert.throws(() => boundedExactText("界".repeat(167), "title", 500), /exceeds 500 bytes/);
});
