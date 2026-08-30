import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digestJson, sha256 } from "./util.js";

type RiskClassRegistry = {
  schema: "pi-ticket-planning:risk-class-registry:v1";
  classes: string[];
  aliases: Record<string, never>;
  splitCombinations: string[][];
  digest: string;
};

const TOKEN = /^[A-Z][A-Z0-9_]{0,63}$/;

function contractPath(name: string, code: string): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  for (const root of [resolve(moduleDirectory, "../.."), resolve(moduleDirectory, "..")]) {
    const candidate = resolve(root, "contracts", name);
    try {
      const stat = lstatSync(candidate);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && realpathSync(candidate) === candidate) return candidate;
    } catch {}
  }
  throw new Error(code);
}

function sorted(values: string[]): boolean {
  return [...values].sort().join("\n") === values.join("\n");
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).sort().join("\n") === [...keys].sort().join("\n");
}

export function assertRiskClassRegistryLock(lock: unknown, registry: RiskClassRegistry, registryBytes: Uint8Array): void {
  if (!exactKeys(lock, ["artifacts", "digest", "plannerRiskRegistry", "schema"])) throw new Error("risk_class_registry_lock_mismatch");
  const source = lock.plannerRiskRegistry;
  const artifacts = lock.artifacts;
  if (lock.schema !== "herdr-codex-controller:runtime-contract-lock:v1"
    || !exactKeys(source, ["artifactDigest", "byteSha256", "commit", "path", "repository"])
    || source.repository !== "https://github.com/Notyet1307/pi-ticket-planning.git"
    || typeof source.commit !== "string" || !/^[a-f0-9]{40}$/.test(source.commit)
    || source.path !== "contracts/risk-class-registry.json"
    || !Array.isArray(artifacts)
    || artifacts.some((artifact) => !exactKeys(artifact, ["path", "sha256"])
      || typeof artifact.path !== "string" || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256))) {
    throw new Error("risk_class_registry_lock_mismatch");
  }
  const byteSha256 = sha256(registryBytes);
  const registryArtifact = artifacts.find((artifact) => artifact.path === "contracts/risk-class-registry.json");
  if (source.byteSha256 !== byteSha256 || source.artifactDigest !== registry.digest
    || registryArtifact?.sha256 !== byteSha256) throw new Error("risk_class_registry_lock_mismatch");
  const { digest, ...body } = lock;
  if (digest !== `sha256:${digestJson(body)}`) throw new Error("risk_class_registry_lock_mismatch");
}

function readRegistry(): RiskClassRegistry {
  const registryFile = contractPath("risk-class-registry.json", "risk_class_registry_unavailable");
  const registryBytes = readFileSync(registryFile);
  let value: RiskClassRegistry;
  try { value = JSON.parse(registryBytes.toString("utf8")) as RiskClassRegistry; }
  catch { throw new Error("risk_class_registry_invalid"); }
  const keys = ["aliases", "classes", "digest", "schema", "splitCombinations"];
  if (!value || Object.keys(value).sort().join("\n") !== keys.join("\n")
    || value.schema !== "pi-ticket-planning:risk-class-registry:v1"
    || !Array.isArray(value.classes) || value.classes.length === 0 || value.classes.length > 64
    || value.classes.some((entry) => typeof entry !== "string" || !TOKEN.test(entry))
    || new Set(value.classes).size !== value.classes.length || !sorted(value.classes)
    || !value.aliases || typeof value.aliases !== "object" || Array.isArray(value.aliases) || Object.keys(value.aliases).length !== 0
    || !Array.isArray(value.splitCombinations) || value.splitCombinations.length === 0 || value.splitCombinations.length > 32) {
    throw new Error("risk_class_registry_invalid");
  }
  const classes = new Set(value.classes);
  if (value.splitCombinations.some((combination) => !Array.isArray(combination)
    || combination.length < 2 || combination.length > 4
    || combination.some((entry) => !classes.has(entry))
    || new Set(combination).size !== combination.length || !sorted(combination))) {
    throw new Error("risk_class_registry_invalid");
  }
  const combinations = value.splitCombinations.map((combination) => combination.join("\n"));
  if (new Set(combinations).size !== combinations.length || !sorted(combinations)) throw new Error("risk_class_registry_invalid");
  const { digest, ...body } = value;
  if (digest !== `sha256:${digestJson(body)}`) throw new Error("risk_class_registry_digest_mismatch");
  let lock: unknown;
  try {
    lock = JSON.parse(readFileSync(contractPath("runtime-contract-lock.json", "risk_class_registry_lock_mismatch"), "utf8"));
  } catch {
    throw new Error("risk_class_registry_lock_mismatch");
  }
  assertRiskClassRegistryLock(lock, value, registryBytes);
  return value;
}

export const RISK_CLASS_REGISTRY = readRegistry();
const RISK_CLASSES = new Set(RISK_CLASS_REGISTRY.classes);

export function unknownRiskClasses(values: string[]): string[] {
  return [...new Set(values.filter((value) => !RISK_CLASSES.has(value)))];
}

export function assertCanonicalRiskClasses(values: string[], label: string): void {
  const unknown = unknownRiskClasses(values);
  if (unknown.length > 0) throw new Error(`unknown_risk_class:${label}:${unknown.join(",")}`);
}
