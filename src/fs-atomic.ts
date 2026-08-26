import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
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

function writeFileAtomic(path: string, value: string, mode: number): void {
  const absolute = resolve(path);
  const parent = ensurePrivateDir(dirname(absolute));
  const temporary = resolve(parent, `.${newId("tmp")}`);
  const fd = openSync(temporary, "wx", mode);
  try {
    writeFileSync(fd, value, "utf8");
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

export function copyJsonSnapshot(sourcePath: string, destinationPath: string): void {
  const raw = readFileSync(sourcePath, "utf8");
  JSON.parse(raw);
  writeTextAtomic(destinationPath, raw.endsWith("\n") ? raw : `${raw}\n`);
}

export function removeIfExists(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}
