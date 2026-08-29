import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Ajv2020 } from "ajv/dist/2020.js";
import { validatePlan } from "../src/plan.js";
import { validateDispatcherConfig } from "../src/dispatcher-config.js";
import { validateConfig } from "../src/config.js";
import { createTestRepo, testConfig, testPlan, testPlanV2, writeInputs } from "./support.js";

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
  ];
  for (const fixture of fixtures) {
    const value = structuredClone(positive);
    fixture.mutate(value);
    assert.equal(validateSchema(value), fixture.valid, JSON.stringify(validateSchema.errors));
    if (fixture.valid) assert.doesNotThrow(() => validateConfig(value));
    else assert.throws(() => validateConfig(value));
  }
});
