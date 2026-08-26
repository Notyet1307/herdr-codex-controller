import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(value: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function digestJson(value: unknown): string {
  return sha256(stableStringify(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

export function newId(prefix: string): string {
  return `${safeToken(prefix)}-${randomUUID().replaceAll("-", "")}`;
}

export function safeToken(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("value cannot be converted to a safe token");
  return normalized.slice(0, 80);
}

export function assertAbsolutePath(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  return resolve(path);
}

export function pathWithin(root: string, value: string): boolean {
  const rel = relative(resolve(root), resolve(value));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function boundedText(value: unknown, label: string, maximumBytes: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const text = value.trim();
  if (!allowEmpty && !text) throw new Error(`${label} cannot be empty`);
  if (Buffer.byteLength(text, "utf8") > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  return text;
}

export function boundedStringArray(value: unknown, label: string, maximumItems: number, maximumItemBytes: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${label} must be an array with at most ${maximumItems} entries`);
  const result = value.map((entry, index) => boundedText(entry, `${label}[${index}]`, maximumItemBytes));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate entries`);
  return result;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function parsePositiveInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
