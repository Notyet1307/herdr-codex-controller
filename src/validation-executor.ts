import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import type { GitPort } from "./ports.js";
import type { JobState, ValidationBootstrapConfig, ValidationCommandConfig } from "./types.js";
import type { SandboxProvider } from "./validation-sandbox.js";
import { ensurePrivateDir, readJsonFile, writeJsonAtomic, writeTextAtomic } from "./fs-atomic.js";
import { digestJson, newId, nowIso, pathWithin, safeToken } from "./util.js";
import { ControllerError } from "./errors.js";

type CleanupMarker = {
  version: 1;
  sandboxRunRoot: string;
  workspace: string;
  policyDigest: string;
  state: "pending" | "clean";
  createdAt: string;
  cleanedAt: string | null;
  digest: string;
};

export class ValidationExecutor {
  private readonly sandboxRoot: string;

  constructor(
    private readonly git: GitPort,
    private readonly provider: SandboxProvider,
    sandboxRoot: string,
    private readonly bootstrap: { config: ValidationBootstrapConfig; provider: SandboxProvider } | null = null,
  ) {
    this.sandboxRoot = ensurePrivateDir(sandboxRoot);
  }

  get policyDigest(): string {
    return this.provider.policyDigest;
  }

  get bootstrapPolicyDigest(): string | null {
    return this.bootstrap?.provider.policyDigest ?? null;
  }

  async doctor(): Promise<{
    verified: boolean;
    policyDigest: string;
    validationPolicyDigest: string;
    bootstrapPolicyDigest: string | null;
  }> {
    const validationVerified = await this.probeProvider(this.provider, false, "validation");
    const bootstrapVerified = this.bootstrap
      ? await this.probeProvider(this.bootstrap.provider, this.bootstrap.config.networkAccess, "bootstrap")
      : true;
    return {
      verified: validationVerified && bootstrapVerified,
      policyDigest: this.provider.policyDigest,
      validationPolicyDigest: this.provider.policyDigest,
      bootstrapPolicyDigest: this.bootstrapPolicyDigest,
    };
  }

  private async probeProvider(provider: SandboxProvider, expectedNetwork: boolean, label: string): Promise<boolean> {
    if (!provider.contained) return false;
    const runRoot = ensurePrivateDir(join(this.sandboxRoot, newId(`${label}-doctor`)));
    const workspace = ensurePrivateDir(join(runRoot, "workspace"));
    const outside = ensurePrivateDir(join(runRoot, "outside"));
    const server = createServer((socket: any) => {
      socket.on("error", () => {});
      socket.end("reachable");
    });
    let listening = false;
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(0, "127.0.0.1", () => { listening = true; resolvePromise(); });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("sandbox doctor listener identity is unavailable");
      writeTextAtomic(join(workspace, "probe.mjs"), `
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
const temporary = fs.realpathSync(process.env.TMPDIR ?? "");
const report = {
  env: process.env.CONTROLLER_SANDBOX_SENTINEL ?? null,
  outsideWrite: false,
  network: false,
  temporary,
  temporaryWrite: false,
};
try { fs.writeFileSync(${JSON.stringify(join(outside, "unsafe.txt"))}, "unsafe"); report.outsideWrite = true; } catch {}
try { fs.writeFileSync(path.join(temporary, "doctor-write-canary"), "safe"); report.temporaryWrite = true; } catch {}
report.network = await new Promise((resolve) => {
  const socket = net.connect(${address.port}, "127.0.0.1");
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
  setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
});
fs.writeSync(1, JSON.stringify(report) + "\\n");
`);
      const previousSentinel = process.env.CONTROLLER_SANDBOX_SENTINEL;
      process.env.CONTROLLER_SANDBOX_SENTINEL = "must-not-cross";
      let result: Awaited<ReturnType<SandboxProvider["run"]>>;
      try {
        result = await provider.run({
          runRoot,
          workspace,
          command: "node probe.mjs",
          environment: { HERDR_RELEASE_ID: "sandbox-doctor" },
          timeoutMs: 10_000,
          stdoutPath: join(runRoot, "doctor.stdout.log"),
          stderrPath: join(runRoot, "doctor.stderr.log"),
          stdoutByteLimit: 64 * 1024,
          stderrByteLimit: 64 * 1024,
          aggregateByteLimit: 96 * 1024,
        });
      } finally {
        if (previousSentinel === undefined) delete process.env.CONTROLLER_SANDBOX_SENTINEL;
        else process.env.CONTROLLER_SANDBOX_SENTINEL = previousSentinel;
      }
      const line = result.stdoutTail.trim().split("\n").at(-1);
      const report = line ? JSON.parse(line) as Record<string, unknown> : null;
      const temporary = typeof report?.temporary === "string" && existsSync(report.temporary)
        ? realpathSync(report.temporary)
        : null;
      const temporaryOutsideCandidate = temporary !== null
        && pathWithin(runRoot, temporary)
        && !pathWithin(workspace, temporary);
      if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.outputLimitExceeded
        || !report || report.env !== null || report.outsideWrite !== false || report.network !== expectedNetwork
        || report.temporaryWrite !== true || !temporaryOutsideCandidate) {
        const diagnostic = JSON.stringify({
          exited: result.exitCode === 0 && result.signal === null,
          timedOut: result.timedOut,
          outputBounded: !result.outputLimitExceeded,
          reportPresent: report !== null,
          environmentCleared: report?.env === null,
          outsideWriteDenied: report?.outsideWrite === false,
          temporaryWriteAllowed: report?.temporaryWrite === true,
          temporaryOutsideCandidate,
          networkMatchesPolicy: report?.network === expectedNetwork,
        });
        throw new Error(`${result.stderrTail || "sandbox capability probe did not enforce its policy"}; ${diagnostic}`);
      }
      return true;
    } catch (error) {
      throw new ControllerError(
        `${label}_sandbox_capability_unavailable`,
        `${label[0]!.toUpperCase()}${label.slice(1)} sandbox capability verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (listening) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      rmSync(runRoot, { recursive: true, force: true });
    }
  }

  async executeDevelopmentGate(input: {
    job: JobState;
    validationId: string;
    commands: ValidationCommandConfig[];
    evidenceRoot: string;
    sourceHeadSha: string;
    stdoutByteLimit: number;
    stderrByteLimit: number;
    aggregateByteLimit: number;
  }) {
    this.recover(resolve(input.evidenceRoot, ".."));
    const jobRoot = ensurePrivateDir(join(this.sandboxRoot, safeToken(input.job.id)));
    const sandboxRunRoot = resolve(jobRoot, safeToken(input.validationId));
    if (existsSync(sandboxRunRoot) || !pathWithin(jobRoot, sandboxRunRoot)) {
      throw new Error("development sandbox run identity is unsafe or already exists");
    }
    ensurePrivateDir(sandboxRunRoot);
    const markerPath = join(input.evidenceRoot, "sandbox.json");
    writeJsonAtomic(markerPath, cleanupMarker({
      sandboxRunRoot,
      workspace: input.job.worktreePath,
      policyDigest: this.provider.policyDigest,
      state: "pending",
      createdAt: nowIso(),
      cleanedAt: null,
    }));
    const results: Array<{
      stage: "bootstrap" | "setup";
      command: ValidationCommandConfig | ValidationBootstrapConfig;
      stdoutPath: string;
      stderrPath: string;
      result: Awaited<ReturnType<SandboxProvider["run"]>> | null;
      error: string | null;
    }> = [];
    let aggregateOutputBytes = 0;
    let integrityFailure: "bootstrap" | "setup" | null = null;
    let executionError: unknown = null;
    try {
      if (!(await this.developmentSourceIsIntact(input.job, input.sourceHeadSha))) {
        integrityFailure = "setup";
      }
      const commands: Array<{
        stage: "bootstrap" | "setup";
        config: ValidationCommandConfig | ValidationBootstrapConfig;
        provider: SandboxProvider;
      }> = [
        ...(this.bootstrap ? [{ stage: "bootstrap" as const, config: this.bootstrap.config, provider: this.bootstrap.provider }] : []),
        ...input.commands.map((config) => ({ stage: "setup" as const, config, provider: this.provider })),
      ];
      for (let index = 0; integrityFailure === null && index < commands.length; index += 1) {
        const entry = commands[index]!;
        if (!(await this.developmentSourceIsIntact(input.job, input.sourceHeadSha))) {
          integrityFailure = entry.stage;
          break;
        }
        const prefix = `${String(index + 1).padStart(2, "0")}.${entry.stage}`;
        const stdoutPath = join(input.evidenceRoot, `${prefix}.stdout.log`);
        const stderrPath = join(input.evidenceRoot, `${prefix}.stderr.log`);
        let result: Awaited<ReturnType<SandboxProvider["run"]>> | null = null;
        let error: string | null = null;
        try {
          result = await entry.provider.run({
            runRoot: sandboxRunRoot,
            workspace: input.job.worktreePath,
            command: entry.config.command,
            environment: {
              HERDR_RELEASE_ID: input.job.id,
              HERDR_ISSUE_NUMBER: "",
              HERDR_CANDIDATE_SHA: input.sourceHeadSha,
            },
            timeoutMs: entry.config.timeoutMs ?? 30 * 60_000,
            stdoutPath,
            stderrPath,
            stdoutByteLimit: input.stdoutByteLimit,
            stderrByteLimit: input.stderrByteLimit,
            aggregateByteLimit: Math.max(0, input.aggregateByteLimit - aggregateOutputBytes),
          });
          aggregateOutputBytes += result.stdoutBytes + result.stderrBytes;
        } catch (caught) {
          error = (caught instanceof Error ? caught.message : String(caught)).slice(0, 4_000);
        }
        results.push({ stage: entry.stage, command: entry.config, stdoutPath, stderrPath, result, error });
        if (!(await this.developmentSourceIsIntact(input.job, input.sourceHeadSha))) {
          integrityFailure = entry.stage;
          break;
        }
        if (result === null || !commandPassed(result)) break;
      }
      return {
        results,
        integrityFailure,
        sandboxPolicyDigest: this.provider.policyDigest,
        bootstrapPolicyDigest: this.bootstrapPolicyDigest,
      };
    } catch (error) {
      executionError = error;
      throw error;
    } finally {
      try {
        rmSync(sandboxRunRoot, { recursive: true, force: true });
        writeJsonAtomic(markerPath, cleanupMarker({
          sandboxRunRoot,
          workspace: input.job.worktreePath,
          policyDigest: this.provider.policyDigest,
          state: "clean",
          createdAt: readMarker(markerPath).createdAt,
          cleanedAt: nowIso(),
        }));
      } catch (cleanupError) {
        if (executionError === null) throw cleanupError;
      }
    }
  }

  private async developmentSourceIsIntact(job: JobState, expectedHead: string): Promise<boolean> {
    try {
      await this.git.remoteIdentity();
      await this.git.verifyWorktree(job);
      return await this.git.head(job.worktreePath) === expectedHead
        && await this.git.branch(job.worktreePath) === job.branch
        && await this.git.isClean(job.worktreePath);
    } catch {
      return false;
    }
  }

  async execute(input: {
    job: JobState;
    validationId: string;
    commands: ValidationCommandConfig[];
    evidenceRoot: string;
    issueNumber: number | null;
    sourceHeadSha: string;
    stdoutByteLimit: number;
    stderrByteLimit: number;
    aggregateByteLimit: number;
  }) {
    this.recover(input.evidenceRoot);
    const jobRoot = ensurePrivateDir(join(this.sandboxRoot, safeToken(input.job.id)));
    const sandboxRunRoot = resolve(jobRoot, safeToken(input.validationId));
    if (existsSync(sandboxRunRoot) || !pathWithin(jobRoot, sandboxRunRoot)) {
      throw new Error("validation sandbox run identity is unsafe or already exists");
    }
    ensurePrivateDir(sandboxRunRoot);
    const workspace = sandboxRunRoot;
    const markerPath = join(input.evidenceRoot, "sandbox.json");
    writeJsonAtomic(markerPath, cleanupMarker({
      sandboxRunRoot,
      workspace,
      policyDigest: this.provider.policyDigest,
      state: "pending",
      createdAt: nowIso(),
      cleanedAt: null,
    }));
    let executionError: unknown = null;
    try {
      let projection: Awaited<ReturnType<GitPort["createValidationProjection"]>> | null = null;
      const results: Array<{
        command: ValidationCommandConfig;
        timeoutMs: number;
        stdoutPath: string;
        stderrPath: string;
        result: Awaited<ReturnType<SandboxProvider["run"]>>;
      }> = [];
      const bootstrapResults: Array<{
        commandIndex: number;
        command: ValidationBootstrapConfig;
        stdoutPath: string;
        stderrPath: string;
        result: Awaited<ReturnType<SandboxProvider["run"]>>;
        sourceIntegrityVerified: boolean;
      }> = [];
      const integrityChecks: Array<{
        commandIndex: number;
        afterBootstrap: boolean;
        afterValidation: boolean | null;
      }> = [];
      let aggregateOutputBytes = 0;
      for (let index = 0; index < input.commands.length; index += 1) {
        const command = input.commands[index]!;
        const timeoutMs = command.timeoutMs ?? 30 * 60_000;
        const commandWorkspace = join(sandboxRunRoot, `workspace-${String(index + 1).padStart(2, "0")}`);
        const commandProjection = await this.git.createValidationProjection(input.job.worktreePath, commandWorkspace);
        if (projection === null) projection = commandProjection;
        else if (projection.treeSha !== commandProjection.treeSha
          || projection.manifestDigest !== commandProjection.manifestDigest) {
          throw new Error("validation candidate projection changed between commands");
        }
        let afterBootstrap = true;
        if (this.bootstrap) {
          const bootstrapStdoutPath = join(input.evidenceRoot, `${String(index + 1).padStart(2, "0")}.bootstrap.stdout.log`);
          const bootstrapStderrPath = join(input.evidenceRoot, `${String(index + 1).padStart(2, "0")}.bootstrap.stderr.log`);
          const bootstrapResult = await this.bootstrap.provider.run({
            runRoot: sandboxRunRoot,
            workspace: commandWorkspace,
            command: this.bootstrap.config.command,
            environment: {
              HERDR_RELEASE_ID: input.job.id,
              HERDR_ISSUE_NUMBER: input.issueNumber === null ? "" : String(input.issueNumber),
              HERDR_CANDIDATE_SHA: input.sourceHeadSha,
            },
            timeoutMs: this.bootstrap.config.timeoutMs,
            stdoutPath: bootstrapStdoutPath,
            stderrPath: bootstrapStderrPath,
            stdoutByteLimit: input.stdoutByteLimit,
            stderrByteLimit: input.stderrByteLimit,
            aggregateByteLimit: Math.max(0, input.aggregateByteLimit - aggregateOutputBytes),
          });
          aggregateOutputBytes += bootstrapResult.stdoutBytes + bootstrapResult.stderrBytes;
          afterBootstrap = await this.projectionIsIntact(commandWorkspace, commandProjection.manifest);
          bootstrapResults.push({
            commandIndex: index,
            command: this.bootstrap.config,
            stdoutPath: bootstrapStdoutPath,
            stderrPath: bootstrapStderrPath,
            result: bootstrapResult,
            sourceIntegrityVerified: afterBootstrap,
          });
          if (!commandPassed(bootstrapResult) || !afterBootstrap) {
            integrityChecks.push({ commandIndex: index, afterBootstrap, afterValidation: null });
            rmSync(commandWorkspace, { recursive: true, force: true });
            break;
          }
        } else {
          afterBootstrap = await this.projectionIsIntact(commandWorkspace, commandProjection.manifest);
        }
        const stdoutPath = join(input.evidenceRoot, `${String(index + 1).padStart(2, "0")}.stdout.log`);
        const stderrPath = join(input.evidenceRoot, `${String(index + 1).padStart(2, "0")}.stderr.log`);
        const result = await this.provider.run({
          runRoot: sandboxRunRoot,
          workspace: commandWorkspace,
          command: command.command,
          environment: {
            HERDR_RELEASE_ID: input.job.id,
            HERDR_ISSUE_NUMBER: input.issueNumber === null ? "" : String(input.issueNumber),
            HERDR_CANDIDATE_SHA: input.sourceHeadSha,
          },
          timeoutMs,
          stdoutPath,
          stderrPath,
          stdoutByteLimit: input.stdoutByteLimit,
          stderrByteLimit: input.stderrByteLimit,
          aggregateByteLimit: Math.max(0, input.aggregateByteLimit - aggregateOutputBytes),
        });
        aggregateOutputBytes += result.stdoutBytes + result.stderrBytes;
        results.push({ command, timeoutMs, stdoutPath, stderrPath, result });
        const afterValidation = await this.projectionIsIntact(commandWorkspace, commandProjection.manifest);
        integrityChecks.push({ commandIndex: index, afterBootstrap, afterValidation });
        rmSync(commandWorkspace, { recursive: true, force: true });
        if (!commandPassed(result) || !afterValidation) {
          break;
        }
      }
      if (projection === null) {
        const emptyWorkspace = join(sandboxRunRoot, "workspace-empty");
        projection = await this.git.createValidationProjection(input.job.worktreePath, emptyWorkspace);
        await this.git.verifyValidationProjection(emptyWorkspace, projection.manifest);
        rmSync(emptyWorkspace, { recursive: true, force: true });
      }
      return {
        projection,
        results,
        bootstrapResults,
        integrityChecks,
        sandboxPolicyDigest: this.provider.policyDigest,
        bootstrapPolicyDigest: this.bootstrapPolicyDigest,
      };
    } catch (error) {
      executionError = error;
      throw error;
    } finally {
      try {
        rmSync(sandboxRunRoot, { recursive: true, force: true });
        writeJsonAtomic(markerPath, cleanupMarker({
          sandboxRunRoot,
          workspace,
          policyDigest: this.provider.policyDigest,
          state: "clean",
          createdAt: readMarker(markerPath).createdAt,
          cleanedAt: nowIso(),
        }));
      } catch (cleanupError) {
        if (executionError === null) throw cleanupError;
      }
    }
  }

  private async projectionIsIntact(destination: string, manifest: Parameters<GitPort["verifyValidationProjection"]>[1]): Promise<boolean> {
    try {
      await this.git.verifyValidationProjection(destination, manifest);
      return true;
    } catch {
      return false;
    }
  }

  recover(validationsRoot: string): void {
    if (!existsSync(validationsRoot)) return;
    const root = realpathSync(validationsRoot);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const markerPath = join(root, entry.name, "sandbox.json");
      if (!existsSync(markerPath)) continue;
      const marker = readMarker(markerPath);
      if (marker.state === "clean") continue;
      const sandboxRunRoot = resolve(marker.sandboxRunRoot);
      if (dirname(dirname(sandboxRunRoot)) !== this.sandboxRoot
        || basename(sandboxRunRoot) !== safeToken(entry.name)) {
        throw new Error("validation sandbox cleanup marker escapes its configured root");
      }
      if (existsSync(sandboxRunRoot)) {
        const stat = lstatSync(sandboxRunRoot);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("validation sandbox cleanup target is unsafe");
        rmSync(sandboxRunRoot, { recursive: true, force: true });
      }
      writeJsonAtomic(markerPath, cleanupMarker({
        sandboxRunRoot: marker.sandboxRunRoot,
        workspace: marker.workspace,
        policyDigest: marker.policyDigest,
        state: "clean",
        createdAt: marker.createdAt,
        cleanedAt: nowIso(),
      }));
    }
  }
}

function commandPassed(result: Awaited<ReturnType<SandboxProvider["run"]>>): boolean {
  return result.exitCode === 0 && result.signal === null && !result.timedOut && !result.outputLimitExceeded;
}

function cleanupMarker(body: Omit<CleanupMarker, "version" | "digest">): CleanupMarker {
  const identity = { version: 1 as const, ...body };
  return { ...identity, digest: digestJson(identity) };
}

function readMarker(path: string): CleanupMarker {
  const marker = readJsonFile<CleanupMarker>(path);
  const { digest, ...identity } = marker;
  if (marker.version !== 1
    || !["pending", "clean"].includes(marker.state)
    || typeof marker.sandboxRunRoot !== "string"
    || typeof marker.workspace !== "string"
    || typeof marker.policyDigest !== "string"
    || digest !== digestJson(identity)) {
    throw new Error("validation sandbox cleanup marker is invalid");
  }
  return marker;
}
