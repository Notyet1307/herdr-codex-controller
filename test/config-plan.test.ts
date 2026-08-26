import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig } from "../src/config.js";
import { validatePlan } from "../src/plan.js";
import { createTestRepo, testConfig, testPlan } from "./support.js";

test("config and ordered plan validate with isolated paths", () => {
  const repo = createTestRepo();
  try {
    const config = validateConfig(testConfig(repo));
    const plan = validatePlan(testPlan());
    assert.equal(config.codex.networkAccess, false);
    assert.deepEqual(plan.issues.map((issue) => issue.number), [1, 2]);
  } finally { repo.cleanup(); }
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
