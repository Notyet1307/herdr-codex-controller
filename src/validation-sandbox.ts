import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { CommandResult, ControllerConfig } from "./types.js";
import { runCommand } from "./command.js";
import { ensurePrivateDir, writeTextAtomic } from "./fs-atomic.js";
import { digestJson, pathWithin, sha256PrefixedUtf8 } from "./util.js";

export type SandboxRunInput = {
  runRoot: string;
  workspace: string;
  command: string;
  environment: Record<string, string>;
  timeoutMs: number;
  stdoutPath: string;
  stderrPath: string;
  stdoutByteLimit: number;
  stderrByteLimit: number;
  aggregateByteLimit: number;
};

export interface SandboxProvider {
  readonly contained: boolean;
  readonly policyDigest: string;
  run(input: SandboxRunInput): Promise<CommandResult>;
}

type CodexSandboxConfig = {
  codexBin: string;
  shell: string;
  environmentPath: string[];
  deniedReadPaths?: string[];
  networkAccess?: boolean;
  terminationGraceMs: number;
};

const NODE_STDIO_SHIM = `"use strict";
const fs = require("node:fs");
for (const [stream, fd] of [[process.stdout, 1], [process.stderr, 2]]) {
  if (stream?.constructor?.name !== "Writable" || stream._handle !== undefined) continue;
  stream.write = function (chunk, encoding, callback) {
    if (typeof encoding === "function") { callback = encoding; encoding = undefined; }
    const bytes = typeof chunk === "string"
      ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
      : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (typeof callback === "function") queueMicrotask(callback);
    return true;
  };
}
`;

export class CodexSandboxProvider implements SandboxProvider {
  readonly contained = true;
  readonly policyDigest: string;
  private readonly deniedRoots: string[];

  constructor(private readonly config: CodexSandboxConfig) {
    if (!config.codexBin || !isAbsolute(config.codexBin)) throw new Error("validation sandbox codexBin must be absolute");
    if (!config.shell || !isAbsolute(config.shell)) throw new Error("validation sandbox shell must be absolute");
    if (config.environmentPath.length === 0 || config.environmentPath.some((entry) => !entry.startsWith("/"))) {
      throw new Error("validation sandbox environmentPath must contain absolute directories");
    }
    this.deniedRoots = sensitiveRoots(config.deniedReadPaths ?? []);
    this.policyDigest = digestJson({
      version: 1,
      provider: "codex-permission-profile",
      profile: profileTemplate(this.deniedRoots, config.networkAccess ?? false),
      isolatedTemporaryDirectory: {
        location: "validation-run-sibling",
        scope: "sandbox-invocation",
        access: "write",
        cleanup: "validation-run",
      },
      isolatedHomeAndCache: {
        location: "validation-run-sibling",
        cleanup: "validation-run",
      },
      workspaceGitMetadata: "deny-safe-file-when-present",
      nodeStdioShimSha256: sha256PrefixedUtf8(NODE_STDIO_SHIM),
      environmentPath: config.environmentPath,
      shell: config.shell,
      terminationGraceMs: config.terminationGraceMs,
    });
  }

  async run(input: SandboxRunInput): Promise<CommandResult> {
    const runRoot = realpathSync(input.runRoot);
    const workspace = realpathSync(input.workspace);
    if (pathWithin(workspace, runRoot)) throw new Error("validation runtime root must stay outside its workspace");
    const runtimeRoot = resolve(runRoot, "runtime", basename(workspace));
    if (!pathWithin(runRoot, runtimeRoot) || pathWithin(workspace, runtimeRoot) || pathWithin(runtimeRoot, workspace)) {
      throw new Error("validation runtime root is outside its private command scope");
    }
    const profileRoot = ensurePrivateDir(join(runtimeRoot, "sandbox-profile"));
    const isolatedHome = ensurePrivateDir(join(runtimeRoot, "home"));
    const isolatedTmp = ensurePrivateDir(join(runtimeRoot, "tmp"));
    const cacheRoot = ensurePrivateDir(join(runtimeRoot, "cache"));
    const gitMetadata = join(workspace, ".git");
    const deniedRoots = [
      ...deniedRootsForWorkspace(this.deniedRoots, workspace),
      ...siblingDenies(workspace, runRoot),
    ];
    if (existsSync(gitMetadata)) {
      const stat = lstatSync(gitMetadata);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error("validation workspace Git metadata pointer is unsafe");
      }
      deniedRoots.push(gitMetadata);
    }
    const nodeStdioShim = join(profileRoot, "node-stdio.cjs");
    writeTextAtomic(
      join(profileRoot, "config.toml"),
      profileTemplate(deniedRoots, this.config.networkAccess ?? false, runtimeRoot),
    );
    writeTextAtomic(nodeStdioShim, NODE_STDIO_SHIM);
    const environment = sandboxEnvironment({
      configured: input.environment,
      profileRoot,
      isolatedHome,
      isolatedTmp,
      cacheRoot,
      nodeStdioShim,
      environmentPath: this.config.environmentPath,
    });
    return runCommand({
      command: this.config.codexBin,
      args: [
        "sandbox",
        "--permission-profile", "validation",
        "--cd", workspace,
        "--",
        this.config.shell,
        "-c", input.command,
      ],
      cwd: workspace,
      env: environment,
      inheritEnv: false,
      timeoutMs: input.timeoutMs,
      terminationGraceMs: this.config.terminationGraceMs,
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
      maxTailBytes: Math.max(input.stdoutByteLimit, input.stderrByteLimit),
      stdoutByteLimit: input.stdoutByteLimit,
      stderrByteLimit: input.stderrByteLimit,
      aggregateByteLimit: input.aggregateByteLimit,
    });
  }
}

export class HostSandboxProvider implements SandboxProvider {
  readonly contained = false;
  readonly policyDigest: string;

  constructor(
    private readonly shell: string,
    private readonly terminationGraceMs: number,
  ) {
    this.policyDigest = digestJson({ version: 1, provider: "host-compatibility-only", shell });
  }

  run(input: SandboxRunInput): Promise<CommandResult> {
    return runCommand({
      command: this.shell,
      args: ["-c", input.command],
      cwd: input.workspace,
      env: input.environment,
      timeoutMs: input.timeoutMs,
      terminationGraceMs: this.terminationGraceMs,
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
      maxTailBytes: Math.max(input.stdoutByteLimit, input.stderrByteLimit),
      stdoutByteLimit: input.stdoutByteLimit,
      stderrByteLimit: input.stderrByteLimit,
      aggregateByteLimit: input.aggregateByteLimit,
    });
  }
}

function sandboxEnvironment(input: {
  configured: Record<string, string>;
  profileRoot: string;
  isolatedHome: string;
  isolatedTmp: string;
  cacheRoot: string;
  nodeStdioShim: string;
  environmentPath: string[];
}): Record<string, string> {
  for (const [name, value] of Object.entries(input.configured)) {
    if (!/^HERDR_[A-Z0-9_]{1,80}$/u.test(name) || Buffer.byteLength(value, "utf8") > 4_096) {
      throw new Error("validation sandbox environment is outside the closed HERDR allowlist");
    }
  }
  return {
    PATH: input.environmentPath.join(":"),
    HOME: input.isolatedHome,
    TMPDIR: input.isolatedTmp,
    TMP: input.isolatedTmp,
    TEMP: input.isolatedTmp,
    XDG_CACHE_HOME: input.cacheRoot,
    XDG_CONFIG_HOME: join(input.isolatedHome, ".config"),
    npm_config_cache: join(input.cacheRoot, "npm"),
    NPM_CONFIG_USERCONFIG: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    CI: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    CODEX_HOME: input.profileRoot,
    NODE_OPTIONS: `--require=${JSON.stringify(input.nodeStdioShim)}`,
    ...input.configured,
  };
}

function deniedRootsForWorkspace(deniedRoots: string[], workspace: string): string[] {
  return deniedRoots.filter((root) => root !== workspace && !pathWithin(root, workspace));
}

function siblingDenies(workspace: string, runRoot: string): string[] {
  const parent = dirname(workspace);
  if (!existsSync(parent) || parent === runRoot || pathWithin(runRoot, parent)) return [];
  const denied: string[] = [];
  for (const name of readdirSync(parent)) {
    const sibling = resolve(parent, name);
    let resolved: string;
    try { resolved = realpathSync(sibling); } catch { continue; }
    if (resolved === workspace) continue;
    denied.push(resolved);
  }
  return denied;
}

function sensitiveRoots(additional: string[]): string[] {
  const candidates = [process.env.HOME, tmpdir(), "/tmp", "/private/tmp", "/run", "/var/run", ...additional];
  const canonical = [...new Set(candidates
    .filter((entry): entry is string => typeof entry === "string" && entry.startsWith("/") && existsSync(entry))
    .map((entry) => realpathSync(entry)))]
    .sort((left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0));
  return canonical.filter((entry, index) => !canonical.slice(0, index).some((parent) => pathWithin(parent, entry)));
}

function profileTemplate(deniedRoots: string[], networkAccess: boolean, isolatedRuntimeRoot?: string): string {
  const denied = deniedRoots.map((entry) => `${tomlString(entry)} = "deny"`).join("\n");
  const runtime = isolatedRuntimeRoot ? `${tomlString(isolatedRuntimeRoot)} = "write"\n` : "";
  return `default_permissions = "validation"

[permissions.validation]
extends = ":read-only"

[permissions.validation.filesystem]
${denied}
${runtime}
[permissions.validation.filesystem.":workspace_roots"]
"." = "write"

[permissions.validation.network]
enabled = ${networkAccess}
`;
}

function tomlString(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) throw new Error("unsafe sandbox policy path");
  return JSON.stringify(value);
}
