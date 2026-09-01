import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { newId } from "./util.js";

export function ensurePrivateDir(path: string): string {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  chmodSync(absolute, 0o700);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || realpathSync(absolute) !== absolute) {
    throw new Error(`unsafe private directory: ${absolute}`);
  }
  return absolute;
}

export function readJsonFile<T>(path: string): T {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`unsafe JSON file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function writeTextAtomic(path: string, value: string, mode = 0o600): void {
  writeFileAtomic(path, value, mode);
}

export function writeBytesAtomic(path: string, value: Uint8Array, mode = 0o600): void {
  writeFileAtomic(path, value, mode);
}

export function writePublicJsonAtomic(path: string, value: unknown): "created" | "unchanged" {
  return writePublicTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writePublicTextAtomic(path: string, value: string): "created" | "unchanged" {
  const absolute = resolve(path);
  const parent = resolve(dirname(absolute));
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || realpathSync(parent) !== parent) {
    throw new Error("public output parent is unsafe");
  }
  const bytes = Buffer.from(value, "utf8");
  if (existsSync(absolute)) return assertExistingPublicOutput(absolute, bytes);

  const temporary = resolve(parent, `.${newId("public-output")}`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, 0o644);
  try {
    linkSync(temporary, absolute);
  } catch {
    if (existsSync(absolute) && assertExistingPublicOutput(absolute, bytes) === "unchanged") return "unchanged";
    throw new Error("public output conflicts with an existing file");
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  const dirFd = openSync(parent, "r");
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o644) {
    throw new Error("public output was not created safely");
  }
  return "created";
}

function writeFileAtomic(path: string, value: string | Uint8Array, mode: number): void {
  const absolute = resolve(path);
  const parent = ensurePrivateDir(dirname(absolute));
  const temporary = resolve(parent, `.${newId("tmp")}`);
  const fd = openSync(temporary, "wx", mode);
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, mode);
  renameSync(temporary, absolute);
  const dirFd = openSync(parent, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

function assertExistingPublicOutput(path: string, expected: Uint8Array): "unchanged" {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o644
    || !readFileSync(path).equals(Buffer.from(expected))) {
    throw new Error("public output conflicts with an existing file");
  }
  return "unchanged";
}

export function copyJsonSnapshot(sourcePath: string, destinationPath: string): void {
  const raw = readFileSync(sourcePath, "utf8");
  JSON.parse(raw);
  writeTextAtomic(destinationPath, raw.endsWith("\n") ? raw : `${raw}\n`);
}

export function removeIfExists(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}
