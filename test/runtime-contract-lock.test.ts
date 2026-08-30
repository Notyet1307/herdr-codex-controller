import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { RISK_CLASS_REGISTRY, assertCanonicalRiskClasses, assertRiskClassRegistryLock, unknownRiskClasses } from "../src/risk-classes.js";
import { digestJson, sha256 } from "../src/util.js";

test("runtime contract lock reads back exact schemas and Planner risk registry bytes", () => {
  const lock = JSON.parse(readFileSync(resolve("contracts", "runtime-contract-lock.json"), "utf8"));
  assert.deepEqual(Object.keys(lock).sort(), ["artifacts", "digest", "plannerRiskRegistry", "schema"]);
  assert.equal(lock.schema, "herdr-codex-controller:runtime-contract-lock:v1");
  assert.match(lock.plannerRiskRegistry.commit, /^[a-f0-9]{40}$/);
  assert.equal(lock.plannerRiskRegistry.path, "contracts/risk-class-registry.json");
  assert.equal(lock.plannerRiskRegistry.artifactDigest, RISK_CLASS_REGISTRY.digest);
  assert.deepEqual(lock.artifacts.map(({ path }: { path: string }) => path), [...lock.artifacts.map(({ path }: { path: string }) => path)].sort());
  for (const artifact of lock.artifacts) {
    const path = resolve(artifact.path);
    const stat = lstatSync(path);
    assert.equal(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, true, artifact.path);
    assert.equal(sha256(readFileSync(path)), artifact.sha256, artifact.path);
  }
  assert.equal(lock.plannerRiskRegistry.byteSha256, lock.artifacts[0].sha256);
  const registryBytes = readFileSync(resolve("contracts", "risk-class-registry.json"));
  const driftedLock = structuredClone(lock);
  driftedLock.plannerRiskRegistry.byteSha256 = "0".repeat(64);
  const { digest: _driftedDigest, ...driftedBody } = driftedLock;
  driftedLock.digest = `sha256:${digestJson(driftedBody)}`;
  assert.throws(() => assertRiskClassRegistryLock(driftedLock, RISK_CLASS_REGISTRY, registryBytes), /risk_class_registry_lock_mismatch/);
  const { digest, ...body } = lock;
  assert.equal(digest, `sha256:${digestJson(body)}`);
  assert.deepEqual(unknownRiskClasses(["AUTHORITY_BOUNDARY", "BOUNDED_CHANGE"]), ["BOUNDED_CHANGE"]);
  assert.doesNotThrow(() => assertCanonicalRiskClasses(["AUTHORITY_BOUNDARY"], "test"));
  assert.throws(() => assertCanonicalRiskClasses(["BOUNDED_CHANGE"], "test"), /unknown_risk_class/);

  const workflow = readFileSync(resolve(".github", "workflows", "ci.yml"), "utf8");
  for (const token of ["actions/checkout@v7", "fetch-depth: 0", "actions/setup-node@v7", "node-version: 22.16.0", "npm ci --ignore-scripts --no-audit --no-fund", "github.event.pull_request.base.sha", "git diff --check HEAD^..HEAD", "npm run verify"]) {
    assert.equal(workflow.includes(token), true, token);
  }
  assert.equal(workflow.includes("pull_request_target") || workflow.includes("secrets."), false);
});
