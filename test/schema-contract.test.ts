import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Ajv2020 } from "ajv/dist/2020.js";
import { validatePlan } from "../src/plan.js";
import { validateDispatcherConfig } from "../src/dispatcher-config.js";
import { validateConfig } from "../src/config.js";
import { assertReleaseCompletion } from "../src/completion-export.js";
import { digestJson, sha256 } from "../src/util.js";
import { createTestRepo, testConfig, testPlan, testPlanV2, writeInputs } from "./support.js";
import { createControllerProvenance, readControllerIdentity } from "../src/provenance.js";

test("release completion v3 binds lifecycle, runtime, sandbox, and remote identities without local paths", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    const plan = testPlanV2(repo, [1]);
    const planDigest = digestJson(plan);
    const provenance = createControllerProvenance(readControllerIdentity(), config, digestJson(config), plan);
    const body = {
      schema: "herdr-codex-controller:release-completion:v3" as const,
      releaseId: "release-v2",
      repo: "example/project",
      baseRef: "main",
      planDigest,
      sourceBaseSha: "1".repeat(40),
      candidateSha: "2".repeat(40),
      issueCommits: [{ issueNumber: 1, sha: "3".repeat(40) }],
      releaseValidationDigest: "4".repeat(64),
      reviewResultDigest: "5".repeat(64),
      pullRequest: { number: 2, headRef: "agent/release-v2", headSha: "2".repeat(40), baseRef: "main", mergeSha: "6".repeat(40), mergedAt: "2026-08-30T00:00:00.000Z" },
      requiredChecks: ["verify"],
      mergedMainSha: "6".repeat(40),
      dependencyHandoffDigests: [],
      controllerProvenance: provenance,
      completedAt: "2026-08-30T00:01:00.000Z",
      digestAlgorithm: "utf16-code-unit-canonical-json-v1+sha256-hex" as const,
      schemaSha256: `sha256:${sha256(readFileSync(resolve("schemas", "release-completion-v3.schema.json")))}`,
      requiredCheckContractDigest: provenance.requiredCheckContractDigest!,
    };
    const completion = { ...body, digest: `sha256:${digestJson(body)}` };
    const validate = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
      .compile(readSchema("release-completion-v3.schema.json"));
    assert.equal(validate(completion), true, JSON.stringify(validate.errors));
    assert.doesNotThrow(() => assertReleaseCompletion(completion));
    const rendered = JSON.stringify(completion);
    for (const privatePath of [repo.root, config.codex.bin, config.validation.sandbox!.bin, config.validation.sandbox!.root]) {
      assert.equal(rendered.includes(privatePath), false);
    }
  } finally { repo.cleanup(); }
});

function readSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve("schemas", name), "utf8")) as Record<string, unknown>;
}

function releasePlanSchemaValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(readSchema("controller-config.schema.json"), "controller-config.schema.json");
  ajv.addSchema(readSchema("release-plan-v1.schema.json"), "release-plan-v1.schema.json");
  ajv.addSchema(readSchema("release-plan-v2.schema.json"), "release-plan-v2.schema.json");
  ajv.addSchema(readSchema("release-plan.schema.json"), "release-plan.schema.json");
  const validate = ajv.getSchema("release-plan.schema.json");
  if (!validate) throw new Error("release-plan.schema.json did not compile");
  return validate;
}

test("aggregate JSON Schema preserves Release Plan v1 and closes unknown keys", () => {
  const validateSchema = releasePlanSchemaValidator();
  const v1 = testPlan([1]);
  assert.equal(validateSchema(v1), true, JSON.stringify(validateSchema.errors));
  assert.doesNotThrow(() => validatePlan(v1));
  const invalid = { ...v1, unexpected: true };
  assert.equal(validateSchema(invalid), false);
  assert.throws(() => validatePlan(invalid), /unknown keys/);
});

test("v2 fixed fixtures agree across JSON Schema, validatePlan, and CLI plan validate", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const positive = testPlanV2(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, positive);
    const validateSchema = releasePlanSchemaValidator();
    const cli = resolve("dist/src/cli.js");
    const fixtures: Array<{ name: string; valid: boolean; mutate(plan: any): void }> = [
      { name: "positive", valid: true, mutate: () => {} },
      { name: "extra top-level key", valid: false, mutate: (plan) => { plan.extra = true; } },
      { name: "missing parentIssue", valid: false, mutate: (plan) => { delete plan.parentIssue; } },
      { name: "extra source key", valid: false, mutate: (plan) => { plan.source.extra = true; } },
      { name: "extra Issue key", valid: false, mutate: (plan) => { plan.issues[0].extra = true; } },
      { name: "wrong hash", valid: false, mutate: (plan) => { plan.issues[0].expectedBodyHash = "sha256:not-a-hash"; } },
      { name: "legacy v2 without runtime contract", valid: false, mutate: (plan) => { delete plan.issues[0].oracleBindings; } },
      { name: "missing verifier manifest", valid: false, mutate: (plan) => { delete plan.issues[0].oracleBindings[0].verifier; } },
      { name: "open verifier manifest", valid: false, mutate: (plan) => { plan.issues[0].oracleBindings[0].verifier.extra = true; } },
      { name: "open verifier file", valid: false, mutate: (plan) => { plan.issues[0].oracleBindings[0].verifier.files[0].extra = true; } },
    ];

    for (const fixture of fixtures) {
      const plan = structuredClone(positive) as any;
      fixture.mutate(plan);
      assert.equal(validateSchema(plan), fixture.valid, `${fixture.name}: ${JSON.stringify(validateSchema.errors)}`);
      if (fixture.valid) assert.doesNotThrow(() => validatePlan(plan), fixture.name);
      else assert.throws(() => validatePlan(plan), undefined, fixture.name);

      writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
      const result = spawnSync("node", [
        cli, "plan", "validate", "--config", configPath, "--plan", planPath, "--json",
      ], { cwd: resolve("."), encoding: "utf8" });
      assert.equal(result.status === 0, fixture.valid, `${fixture.name}: ${result.stderr}`);
      if (fixture.valid) {
        const output = JSON.parse(String(result.stdout));
        assert.equal(output.plan.version, 2);
        assert.match(output.planDigest, /^[a-f0-9]{64}$/);
      }
    }
  } finally { repo.cleanup(); }
});

test("dispatcher JSON Schema and runtime validator agree on the closed policy", () => {
  const schema = readSchema("dispatcher-config.schema.json");
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validateSchema = ajv.compile(schema);
  const positive = JSON.parse(readFileSync(resolve("examples", "dispatcher.config.example.json"), "utf8"));
  const fixtures: Array<{ valid: boolean; mutate(value: any): void }> = [
    { valid: true, mutate: () => {} },
    { valid: false, mutate: (value) => { value.extra = true; } },
    { valid: false, mutate: (value) => { value.readyLabel = "agent:claimed"; } },
    { valid: false, mutate: (value) => { value.postMerge.requiredWorkflows = []; } },
  ];
  for (const fixture of fixtures) {
    const value = structuredClone(positive);
    fixture.mutate(value);
    assert.equal(validateSchema(value), fixture.valid, JSON.stringify(validateSchema.errors));
    if (fixture.valid) assert.doesNotThrow(() => validateDispatcherConfig(value));
    else assert.throws(() => validateDispatcherConfig(value));
  }
});

test("Controller config schema exposes only the explicit execution modes", () => {
  const schema = readSchema("controller-config.schema.json");
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validateSchema = ajv.compile(schema);
  const positive = JSON.parse(readFileSync(resolve("examples", "controller.config.example.json"), "utf8"));
  const fixtures: Array<{ valid: boolean; mutate(value: any): void }> = [
    { valid: true, mutate: () => {} },
    { valid: true, mutate: (value) => { delete value.executionMode; } },
    { valid: false, mutate: (value) => { value.executionMode = "dispatcher-qualified"; } },
    { valid: false, mutate: (value) => { value.delivery.createPullRequest = false; } },
    { valid: false, mutate: (value) => { value.delivery.autoMerge = false; } },
    { valid: false, mutate: (value) => { value.delivery.allowNoChecks = true; } },
    { valid: false, mutate: (value) => { value.delivery.requiredChecks.checks = []; } },
    { valid: false, mutate: (value) => { value.delivery.mergeAuthority.quarantine = "leave-open"; } },
  ];
  for (const fixture of fixtures) {
    const value = structuredClone(positive);
    fixture.mutate(value);
    assert.equal(validateSchema(value), fixture.valid, JSON.stringify(validateSchema.errors));
    if (fixture.valid) assert.doesNotThrow(() => validateConfig(value));
    else assert.throws(() => validateConfig(value));
  }
});

test("config v1 remains readable only in explicit non-production modes", () => {
  const repo = createTestRepo();
  try {
    const legacy = structuredClone(testConfig(repo)) as any;
    legacy.version = 1;
    legacy.executionMode = "release-plan-v1-compatibility";
    delete legacy.remoteIdentity;
    for (const key of ["maxEventBytes", "maxStderrBytes", "maxResultBytes", "maxAggregateBytes"]) delete legacy.codex[key];
    for (const key of ["sandbox", "maxStdoutBytes", "maxStderrBytes", "maxAggregateBytes"]) delete legacy.validation[key];
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(readSchema("controller-config.schema.json"));
    assert.equal(validate(legacy), true, JSON.stringify(validate.errors));
    assert.doesNotThrow(() => validateConfig(legacy));
    legacy.executionMode = "release-plan-v2-direct";
    assert.equal(validate(legacy), false);
    assert.throws(
      () => validateConfig(legacy),
      (error: any) => error?.code === "production_config_migration_required",
    );
  } finally { repo.cleanup(); }
});

test("release completion schema and runtime validator are closed and self-digested", () => {
  const schema = readSchema("release-completion-v1.schema.json");
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  const validateSchema = ajv.compile(schema);
  const planDigest = "1".repeat(64);
  const controllerBody = {
    version: 1 as const,
    sourceRevision: "2".repeat(40),
    sourceManifestDigest: "3".repeat(64),
    buildDigest: "4".repeat(64),
  };
  const controller = { ...controllerBody, digest: digestJson(controllerBody) };
  const provenanceBody = {
    version: 1 as const,
    controller,
    executionMode: "release-plan-v2-direct" as const,
    configDigest: "5".repeat(64),
    releasePlan: { version: 2 as const, digest: planDigest },
  };
  const body = {
    schema: "herdr-codex-controller:release-completion:v1" as const,
    releaseId: "release-1",
    repo: "example/project",
    baseRef: "main",
    planDigest,
    sourceBaseSha: "6".repeat(40),
    candidateSha: "7".repeat(40),
    issueCommits: [{ issueNumber: 1, sha: "8".repeat(40) }],
    releaseValidationDigest: "9".repeat(64),
    reviewResultDigest: "a".repeat(64),
    pullRequest: { number: 1, headRef: "agent/release-1", headSha: "7".repeat(40), baseRef: "main", mergeSha: "b".repeat(40), mergedAt: "2026-08-30T00:00:00.000Z" },
    requiredChecks: ["verify"],
    mergedMainSha: "b".repeat(40),
    dependencyHandoffDigests: [],
    controllerProvenance: { ...provenanceBody, digest: digestJson(provenanceBody) },
    completedAt: "2026-08-30T00:01:00.000Z",
  };
  const completion = { ...body, digest: `sha256:${digestJson(body)}` };
  assert.equal(validateSchema(completion), true, JSON.stringify(validateSchema.errors));
  assert.doesNotThrow(() => assertReleaseCompletion(completion));
  assert.throws(() => assertReleaseCompletion({ ...completion, digest: `sha256:${"0".repeat(64)}` }));

  const invalids: Array<{ name: string; mutate(value: any): void }> = [
    { name: "unknown top-level key", mutate: (value) => { value.privatePath = "/secret"; } },
    { name: "non-canonical release id", mutate: (value) => { value.releaseId = "NOT schema conforming"; } },
    { name: "oversized base ref", mutate: (value) => { value.baseRef = "b".repeat(301); value.pullRequest.baseRef = value.baseRef; } },
    { name: "oversized head ref", mutate: (value) => { value.pullRequest.headRef = "h".repeat(301); } },
    { name: "too many Issue commits", mutate: (value) => { value.issueCommits = Array.from({ length: 51 }, (_, index) => ({ issueNumber: index + 1, sha: index.toString(16).padStart(40, "0") })); } },
    { name: "open Issue commit", mutate: (value) => { value.issueCommits[0].extra = true; } },
    { name: "too many required checks", mutate: (value) => { value.requiredChecks = Array.from({ length: 101 }, (_, index) => `check-${index}`); } },
    { name: "too many handoffs", mutate: (value) => { value.dependencyHandoffDigests = Array.from({ length: 101 }, (_, index) => `sha256:${index.toString(16).padStart(64, "0")}`); } },
    { name: "compatibility provenance", mutate: (value) => { value.controllerProvenance.executionMode = "release-plan-v1-compatibility"; } },
    { name: "Plan v1 provenance", mutate: (value) => { value.controllerProvenance.releasePlan.version = 1; } },
    { name: "open provenance", mutate: (value) => { value.controllerProvenance.extra = true; } },
    { name: "open Controller identity", mutate: (value) => { value.controllerProvenance.controller.extra = true; } },
    { name: "open Plan provenance", mutate: (value) => { value.controllerProvenance.releasePlan.extra = true; } },
  ];
  for (const fixture of invalids) {
    const invalid = structuredClone(completion) as any;
    fixture.mutate(invalid);
    const { digest: _controllerDigest, ...controllerIdentity } = invalid.controllerProvenance.controller;
    invalid.controllerProvenance.controller.digest = digestJson(controllerIdentity);
    const { digest: _provenanceDigest, ...provenanceIdentity } = invalid.controllerProvenance;
    invalid.controllerProvenance.digest = digestJson(provenanceIdentity);
    const { digest: _artifactDigest, ...artifactIdentity } = invalid;
    invalid.digest = `sha256:${digestJson(artifactIdentity)}`;
    assert.equal(validateSchema(invalid), false, fixture.name);
    assert.throws(
      () => assertReleaseCompletion(invalid),
      (error: any) => error?.code === "completion_export_artifact_invalid",
      fixture.name,
    );
  }
});
