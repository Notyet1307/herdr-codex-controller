import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CommandResult, ControllerConfig, ExecutableIdentity, ValidationSandboxIdentity } from "./types.js";
import { runCommand } from "./command.js";
import { ensurePrivateDir, writeTextAtomic } from "./fs-atomic.js";
import { digestJson, pathWithin } from "./util.js";
import { readExecutableIdentity } from "./executable-identity.js";

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
  terminationGraceMs: number;
};

export class CodexSandboxProvider implements SandboxProvider {
  readonly contained = true;
  readonly policyDigest: string;
  readonly binaryIdentity: ExecutableIdentity;
  private readonly deniedRoots: string[];

  constructor(private readonly config: CodexSandboxConfig) {
    if (!config.codexBin || !isAbsolute(config.codexBin)) throw new Error("validation sandbox codexBin must be absolute");
    if (!config.shell || !isAbsolute(config.shell)) throw new Error("validation sandbox shell must be absolute");
    if (config.environmentPath.length === 0 || config.environmentPath.some((entry) => !entry.startsWith("/"))) {
      throw new Error("validation sandbox environmentPath must contain absolute directories");
    }
    this.deniedRoots = sensitiveRoots(config.deniedReadPaths ?? []);
    this.binaryIdentity = readExecutableIdentity(config.codexBin, "/", "Validation sandbox executable");
    this.policyDigest = digestJson({
      version: 1,
      provider: "codex-permission-profile",
      binary: this.binaryIdentity,
      profile: profileTemplate(this.deniedRoots),
      environmentPath: config.environmentPath,
      shell: config.shell,
      terminationGraceMs: config.terminationGraceMs,
    });
  }

  async run(input: SandboxRunInput): Promise<CommandResult> {
    const runRoot = realpathSync(input.runRoot);
    const workspace = realpathSync(input.workspace);
    if (!pathWithin(runRoot, workspace)) throw new Error("validation workspace escapes its private run root");
    const profileRoot = ensurePrivateDir(join(runRoot, "sandbox-profile"));
    const isolatedHome = ensurePrivateDir(join(workspace, ".herdr-home"));
    const isolatedTmp = ensurePrivateDir(join(workspace, ".herdr-tmp"));
    const cacheRoot = ensurePrivateDir(join(workspace, ".herdr-cache"));
    writeTextAtomic(join(profileRoot, "config.toml"), profileTemplate(this.deniedRoots));
    const environment = sandboxEnvironment({
      configured: input.environment,
      profileRoot,
      isolatedHome,
      isolatedTmp,
      cacheRoot,
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

export function readValidationSandboxIdentity(config: ControllerConfig): ValidationSandboxIdentity {
  const sandbox = config.validation.sandbox;
  if (!sandbox) throw new Error("validation sandbox identity requires config version 2");
  const provider = new CodexSandboxProvider({
    codexBin: sandbox.bin,
    shell: config.shell,
    environmentPath: sandbox.environmentPath,
    deniedReadPaths: [config.localPath, config.stateDir, config.worktreeRoot],
    terminationGraceMs: config.codex.terminationGraceMs,
  });
  const identity = {
    version: 1 as const,
    provider: "codex-permission-profile" as const,
    binary: provider.binaryIdentity,
    policyDigest: provider.policyDigest,
  };
  return { ...identity, digest: digestJson(identity) };
}

export function assertValidationSandboxIdentity(value: ValidationSandboxIdentity): void {
  if (!value || value.version !== 1 || value.provider !== "codex-permission-profile"
    || Object.keys(value as unknown as Record<string, unknown>).sort().join(",") !== "binary,digest,policyDigest,provider,version"
    || !value.binary || !/^sha256:[a-f0-9]{64}$/u.test(value.binary.sha256)
    || Object.keys(value.binary as unknown as Record<string, unknown>).sort().join(",") !== "byteCount,configuredPathDigest,realPathDigest,sha256,versionOutput"
    || !/^[a-f0-9]{64}$/u.test(value.policyDigest)) {
    throw new Error("validation sandbox identity is invalid");
  }
  const { digest, ...identity } = value;
  if (!/^[a-f0-9]{64}$/u.test(digest) || digest !== digestJson(identity)) {
    throw new Error("validation sandbox identity digest is invalid");
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
    ...input.configured,
  };
}

function sensitiveRoots(additional: string[]): string[] {
  const candidates = [process.env.HOME, tmpdir(), "/tmp", "/private/tmp", "/run", "/var/run", ...additional];
  const canonical = [...new Set(candidates
    .filter((entry): entry is string => typeof entry === "string" && entry.startsWith("/") && existsSync(entry))
    .map((entry) => realpathSync(entry)))]
    .sort((left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0));
  return canonical.filter((entry, index) => !canonical.slice(0, index).some((parent) => pathWithin(parent, entry)));
}

function profileTemplate(deniedRoots: string[]): string {
  const denied = deniedRoots.map((entry) => `${tomlString(entry)} = "deny"`).join("\n");
  return `default_permissions = "validation"

[permissions.validation]
extends = ":read-only"

[permissions.validation.filesystem]
${denied}

[permissions.validation.filesystem.":workspace_roots"]
"." = "write"

[permissions.validation.network]
enabled = false
`;
}

function tomlString(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) throw new Error("unsafe sandbox policy path");
  return JSON.stringify(value);
}
