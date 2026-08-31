import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digestJson, sha256 } from "../dist/src/util.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = resolve(root, "contracts/runtime-contract-lock.json");
const previous = JSON.parse(readFileSync(lockPath, "utf8"));
const artifactPaths = [
  "contracts/controller-identity-history.json",
  "contracts/risk-class-registry.json",
  "schemas/controller-config.schema.json",
  "schemas/controller-identity-history-v1.schema.json",
  "schemas/release-completion-v3.schema.json",
  "schemas/release-plan-v2.schema.json",
];
const artifacts = artifactPaths.map((path) => ({ path, sha256: sha256(readFileSync(resolve(root, path))) }));
const riskRegistry = JSON.parse(readFileSync(resolve(root, "contracts/risk-class-registry.json"), "utf8"));
const body = {
  schema: "herdr-codex-controller:runtime-contract-lock:v1",
  plannerRiskRegistry: {
    repository: previous.plannerRiskRegistry.repository,
    commit: previous.plannerRiskRegistry.commit,
    path: "contracts/risk-class-registry.json",
    byteSha256: artifacts.find(({ path }) => path === "contracts/risk-class-registry.json").sha256,
    artifactDigest: riskRegistry.digest,
  },
  artifacts,
};
const lock = { ...body, digest: `sha256:${digestJson(body)}` };
const expected = `${JSON.stringify(lock, null, 2)}\n`;
if (process.argv.slice(2).includes("--write")) writeFileSync(lockPath, expected, "utf8");
else if (readFileSync(lockPath, "utf8") !== expected) {
  process.stderr.write("runtime contract lock is stale; run npm run contract:generate\n");
  process.exitCode = 1;
}
