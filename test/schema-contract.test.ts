import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { validateConfig } from "../src/config.js";
import { validatePlan } from "../src/plan.js";
import { assertReleaseResult } from "../src/release-result.js";
import { configInput, createTestRepo, testConfig, testPlan } from "./support.js";

const schema = (name: string) => JSON.parse(readFileSync(resolve("schemas", name), "utf8"));

test("canonical Planner Plan fixture agrees across schema and runtime", () => {
  const repo = createTestRepo();
  try {
    const plan = testPlan(repo, [1]);
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema("release-plan.schema.json"));
    assert.equal(validate(plan), true, JSON.stringify(validate.errors));
    assert.deepEqual(validatePlan(plan), plan);
    const invalid = { ...plan, controllerContractVersion: 2 };
    assert.equal(validate(invalid), false);
    assert.throws(() => validatePlan(invalid), (error: any) => error?.code === "unsupported_controller_contract_version");
  } finally { repo.cleanup(); }
});

test("current config fixture agrees across schema and runtime", () => {
  const repo = createTestRepo();
  try {
    const config = configInput(testConfig(repo));
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema("controller-config.schema.json"));
    assert.equal(validate(config), true, JSON.stringify(validate.errors));
    assert.doesNotThrow(() => validateConfig(config));
    const invalid = structuredClone(config) as any;
    invalid.executionMode = "release-plan-v2-direct";
    assert.equal(validate(invalid), false);
    assert.throws(() => validateConfig(invalid), /unknown keys/);
  } finally { repo.cleanup(); }
});

test("Release Result v1 fixture agrees across schema and runtime", () => {
  const result = {
    schema: "herdr-codex-controller:release-result:v1" as const,
    releaseId: "release-1",
    planDigest: "1".repeat(64),
    status: "merged" as const,
    baseSha: "2".repeat(40),
    candidateSha: "3".repeat(40),
    pullRequest: { number: 7, url: "https://github.com/example/project/pull/7" },
    requiredChecks: { names: ["verify"], status: "passed" as const },
    mergeSha: "4".repeat(40),
    completedAt: "2026-09-01T00:00:00.000Z",
  };
  const validate = new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(schema("release-result-v1.schema.json"));
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  assert.doesNotThrow(() => assertReleaseResult(result));
  for (const mutate of [
    (value: any) => { value.status = "completed"; },
    (value: any) => { value.requiredChecks.status = "pending"; },
    (value: any) => { value.pullRequest.privatePath = "/secret"; },
    (value: any) => { value.privatePath = "/secret"; },
  ]) {
    const invalid = structuredClone(result) as any;
    mutate(invalid);
    assert.equal(validate(invalid), false);
    assert.throws(() => assertReleaseResult(invalid), /Release Result is invalid/);
  }
});
