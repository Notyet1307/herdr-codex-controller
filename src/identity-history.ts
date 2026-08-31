import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ControllerIdentity, ControllerIdentityHistory } from "./types.js";
import { ControllerError } from "./errors.js";
import { digestJson } from "./util.js";

const HISTORY_SCHEMA = "herdr-codex-controller:identity-history:v1";
const DIGEST_ALGORITHM = "utf16-code-unit-canonical-json-v1+sha256-hex";
const HASH = /^sha256:[a-f0-9]{64}$/u;

export function readControllerIdentityHistory(): ControllerIdentityHistory {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  return validateControllerIdentityHistory(JSON.parse(readFileSync(resolve(root, "contracts/controller-identity-history.json"), "utf8")));
}

export function validateControllerIdentityHistory(value: unknown): ControllerIdentityHistory {
  const history = record(value, "Controller identity history") as unknown as ControllerIdentityHistory;
  exactKeys(history as unknown as Record<string, unknown>, ["digest", "digestAlgorithm", "entries", "schema", "version"], "Controller identity history");
  if (history.schema !== HISTORY_SCHEMA || history.version !== 1 || history.digestAlgorithm !== DIGEST_ALGORITHM
    || !Array.isArray(history.entries) || history.entries.length > 100) {
    throw new Error("Controller identity history header is invalid");
  }
  for (const [index, entry] of history.entries.entries()) {
    exactKeys(record(entry, `identity history entry[${index}]`), ["activatedAt", "identity", "ownedSchemas", "qualificationStatus", "revocation"], `identity history entry[${index}]`);
    assertIdentity(entry.identity);
    if (entry.qualificationStatus !== "qualified" || !canonicalTime(entry.activatedAt)
      || !Array.isArray(entry.ownedSchemas) || entry.ownedSchemas.length === 0 || entry.ownedSchemas.length > 20) {
      throw new Error(`identity history entry[${index}] is invalid`);
    }
    const schemas = new Set<string>();
    for (const schema of entry.ownedSchemas) {
      exactKeys(record(schema, "owned schema"), ["schema", "sha256"], "owned schema");
      if (typeof schema.schema !== "string" || !schema.schema.trim() || !HASH.test(schema.sha256) || schemas.has(schema.schema)) {
        throw new Error(`identity history entry[${index}] owned schemas are invalid`);
      }
      schemas.add(schema.schema);
    }
    if (entry.revocation !== null) {
      exactKeys(record(entry.revocation, "identity revocation"), ["reason", "revokedAt"], "identity revocation");
      if (!canonicalTime(entry.revocation.revokedAt) || typeof entry.revocation.reason !== "string"
        || !entry.revocation.reason.trim() || Buffer.byteLength(entry.revocation.reason, "utf8") > 2_000) {
        throw new Error(`identity history entry[${index}] revocation is invalid`);
      }
    }
  }
  if (new Set(history.entries.map(({ identity }) => identity.digest)).size !== history.entries.length) {
    throw new Error("Controller identity history contains duplicate identities");
  }
  const { digest, ...body } = history;
  if (!HASH.test(digest) || digest !== `sha256:${digestJson(body)}`) throw new Error("Controller identity history digest is invalid");
  return history;
}

export function requireHistoricallyTrustedController(
  identity: ControllerIdentity,
  history = readControllerIdentityHistory(),
): ControllerIdentityHistory["entries"][number] {
  assertIdentity(identity);
  const entry = history.entries.find((candidate) => candidate.identity.digest === identity.digest);
  if (!entry || JSON.stringify(entry.identity) !== JSON.stringify(identity)) {
    throw new ControllerError("controller_identity_unknown", "The historical Controller identity is not qualified.");
  }
  if (entry.revocation !== null) {
    throw new ControllerError("controller_identity_revoked", `The historical Controller identity was revoked: ${entry.revocation.reason}`);
  }
  return entry;
}

export function appendQualifiedControllerIdentity(
  history: ControllerIdentityHistory,
  entry: ControllerIdentityHistory["entries"][number],
): ControllerIdentityHistory {
  validateControllerIdentityHistory(history);
  const existing = history.entries.find((candidate) => candidate.identity.digest === entry.identity.digest);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error("Controller identity history digest collision");
    return history;
  }
  const previous = history.entries.at(-1);
  if (previous && Date.parse(entry.activatedAt) < Date.parse(previous.activatedAt)) {
    throw new Error("Controller identity history activation order is not append-only");
  }
  const body = {
    schema: history.schema,
    version: history.version,
    digestAlgorithm: history.digestAlgorithm,
    entries: [...history.entries, entry],
  };
  return validateControllerIdentityHistory({ ...body, digest: `sha256:${digestJson(body)}` });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) throw new Error(`${label} keys are invalid`);
}

function canonicalTime(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function assertIdentity(value: ControllerIdentity): void {
  if (!value || value.version !== 1
    || Object.keys(value as unknown as Record<string, unknown>).sort().join(",") !== "buildDigest,digest,sourceManifestDigest,sourceRevision,version"
    || !/^[a-f0-9]{40}$/u.test(value.sourceRevision)
    || !/^[a-f0-9]{64}$/u.test(value.sourceManifestDigest)
    || !/^[a-f0-9]{64}$/u.test(value.buildDigest)) throw new Error("Controller identity is invalid");
  const { digest, ...body } = value;
  if (!/^[a-f0-9]{64}$/u.test(digest) || digest !== digestJson(body)) throw new Error("Controller identity digest is invalid");
}
