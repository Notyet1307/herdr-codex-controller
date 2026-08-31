import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ControllerIdentity,
  ControllerProvenance,
  ControllerConfig,
  ReleasePlan,
} from "./types.js";
import { ControllerError } from "./errors.js";
import { digestJson, pathWithin, sha256 } from "./util.js";
import { assertExecutionRuntimeIdentity, readExecutionRuntimeIdentity } from "./runtime-identity.js";
import { assertGitRemoteIdentity, configuredRemoteIdentity } from "./remote-identity.js";
import { assertValidationSandboxIdentity, readValidationSandboxIdentity } from "./validation-sandbox.js";

const HEX_40 = /^[a-f0-9]{40}$/;
const HEX_64 = /^[a-f0-9]{64}$/;

export function readControllerIdentity(): ControllerIdentity {
  try {
    const root = controllerRoot();
    const sourceRevision = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    if (!HEX_40.test(sourceRevision)) throw new Error("Controller Git revision is not a full lowercase commit SHA");

    const tracked = git(root, ["ls-files", "-z", "--"])
      .split("\0")
      .filter(Boolean)
      .sort();
    if (tracked.length === 0) throw new Error("Controller checkout has no tracked files");
    const sourceManifestDigest = digestJson(tracked.map((path) => fileIdentity(root, path)));

    const buildFiles = ["package.json", "package-lock.json", ...compiledJavaScript(root)];
    const buildDigest = digestJson(buildFiles.map((path) => fileIdentity(root, path)));
    const identity = { version: 1 as const, sourceRevision, sourceManifestDigest, buildDigest };
    return { ...identity, digest: digestJson(identity) };
  } catch (error) {
    if (error instanceof ControllerError) throw error;
    throw new ControllerError(
      "controller_provenance_unavailable",
      `Controller runtime provenance is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function createControllerProvenance(
  controller: ControllerIdentity,
  config: ControllerConfig,
  configDigest: string,
  plan: ReleasePlan,
): ControllerProvenance {
  assertControllerIdentity(controller);
  if (!HEX_64.test(configDigest)) throw new Error("Controller config digest is invalid");
  const releasePlan = { version: plan.version, digest: digestJson(plan) };
  const provenance = config.version === 2
    ? {
      version: 2 as const,
      controller,
      executionRuntime: readExecutionRuntimeIdentity(config),
      remoteIdentity: configuredRemoteIdentity(config),
      validationSandbox: readValidationSandboxIdentity(config),
      executionMode: config.executionMode,
      configDigest,
      releasePlan,
    }
    : { version: 1 as const, controller, executionMode: config.executionMode, configDigest, releasePlan };
  return { ...provenance, digest: digestJson(provenance) };
}

export function assertControllerProvenance(value: ControllerProvenance): void {
  if (!value || (value.version !== 1 && value.version !== 2)) throw new Error("job Controller provenance is invalid");
  const expectedKeys = value.version === 1
    ? ["configDigest", "controller", "digest", "executionMode", "releasePlan", "version"]
    : ["configDigest", "controller", "digest", "executionMode", "executionRuntime", "remoteIdentity", "releasePlan", "validationSandbox", "version"];
  if (Object.keys(value as unknown as Record<string, unknown>).sort().join("\n") !== expectedKeys.sort().join("\n")) {
    throw new Error("job Controller provenance keys are invalid");
  }
  assertControllerIdentity(value.controller);
  if (value.version === 2) {
    assertExecutionRuntimeIdentity(value.executionRuntime!);
    assertGitRemoteIdentity(value.remoteIdentity!);
    assertValidationSandboxIdentity(value.validationSandbox!);
  } else if (value.executionRuntime !== undefined || value.remoteIdentity !== undefined || value.validationSandbox !== undefined) {
    throw new Error("job Controller provenance is invalid");
  }
  if (!["release-plan-v2-direct", "release-plan-v1-compatibility", "dispatcher-experimental"].includes(value.executionMode)
    || !HEX_64.test(value.configDigest)
    || (value.releasePlan?.version !== 1 && value.releasePlan?.version !== 2)
    || !HEX_64.test(value.releasePlan?.digest ?? "")) {
    throw new Error("job Controller provenance is invalid");
  }
  const { digest, ...identity } = value;
  if (!HEX_64.test(digest) || digest !== digestJson(identity)) {
    throw new Error("job Controller provenance digest is invalid");
  }
}

function assertControllerIdentity(value: ControllerIdentity): void {
  if (!value
    || Object.keys(value as unknown as Record<string, unknown>).sort().join(",") !== "buildDigest,digest,sourceManifestDigest,sourceRevision,version"
    || value.version !== 1
    || !HEX_40.test(value.sourceRevision)
    || !HEX_64.test(value.sourceManifestDigest)
    || !HEX_64.test(value.buildDigest)) {
    throw new Error("Controller runtime identity is invalid");
  }
  const { digest, ...identity } = value;
  if (!HEX_64.test(digest) || digest !== digestJson(identity)) {
    throw new Error("Controller runtime identity digest is invalid");
  }
}

function controllerRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(moduleDirectory, "../.."), resolve(moduleDirectory, "..")]) {
    try {
      const root = realpathSync(candidate);
      const packagePath = resolve(root, "package.json");
      const stat = lstatSync(packagePath);
      if (stat.isFile() && !stat.isSymbolicLink()) return root;
    } catch {}
  }
  throw new Error("Controller package root cannot be resolved");
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${String(result.stderr || result.stdout || result.error || "unknown error").trim()}`);
  }
  return String(result.stdout);
}

function compiledJavaScript(root: string): string[] {
  const buildRoot = resolve(root, "dist", "src");
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Controller build contains a symbolic link: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        files.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  visit(buildRoot);
  if (files.length === 0) throw new Error("Controller build contains no executable JavaScript");
  return files.sort();
}

function fileIdentity(root: string, path: string) {
  const absolute = resolve(root, path);
  if (!pathWithin(root, absolute)) throw new Error(`Controller provenance path escapes the package root: ${path}`);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`Controller provenance input is not a safe regular file: ${path}`);
  }
  const bytes = readFileSync(absolute);
  return {
    path,
    mode: (stat.mode & 0o111) === 0 ? "100644" : "100755",
    bytes: bytes.length,
    digest: sha256(bytes),
  };
}
