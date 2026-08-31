import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import type { GitPort } from "./ports.js";
import type { JobState, ValidationCommandConfig } from "./types.js";
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
  ) {
    this.sandboxRoot = ensurePrivateDir(sandboxRoot);
  }

  get policyDigest(): string {
    return this.provider.policyDigest;
  }

  async doctor(): Promise<{ verified: boolean; policyDigest: string }> {
    if (!this.provider.contained) return { verified: false, policyDigest: this.provider.policyDigest };
    const runRoot = ensurePrivateDir(join(this.sandboxRoot, newId("doctor")));
    const workspace = ensurePrivateDir(join(runRoot, "workspace"));
    const outside = ensurePrivateDir(join(runRoot, "outside"));
    const server = createServer((socket: any) => socket.end("reachable"));
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
const report = { env: process.env.CONTROLLER_SANDBOX_SENTINEL ?? null, outsideWrite: false, network: false };
try { fs.writeFileSync(${JSON.stringify(join(outside, "unsafe.txt"))}, "unsafe"); report.outsideWrite = true; } catch {}
report.network = await new Promise((resolve) => {
  const socket = net.connect(${address.port}, "127.0.0.1");
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
  setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
});
console.log(JSON.stringify(report));
`);
      const result = await this.provider.run({
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
      const line = result.stdoutTail.trim().split("\n").at(-1);
      const report = line ? JSON.parse(line) as Record<string, unknown> : null;
      if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.outputLimitExceeded
        || !report || report.env !== null || report.outsideWrite !== false || report.network !== false) {
        const diagnostic = JSON.stringify({
          exited: result.exitCode === 0 && result.signal === null,
          timedOut: result.timedOut,
          outputBounded: !result.outputLimitExceeded,
          reportPresent: report !== null,
          environmentCleared: report?.env === null,
          outsideWriteDenied: report?.outsideWrite === false,
          networkDenied: report?.network === false,
        });
        throw new Error(`${result.stderrTail || "sandbox capability probe did not enforce its policy"}; ${diagnostic}`);
      }
      return { verified: true, policyDigest: this.provider.policyDigest };
    } catch (error) {
      throw new ControllerError(
        "validation_sandbox_capability_unavailable",
        `Validation sandbox capability verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (listening) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      rmSync(runRoot, { recursive: true, force: true });
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
      let oracleFailed = false;
      let aggregateOutputBytes = 0;
      for (let index = 0; index < input.commands.length; index += 1) {
        const command = input.commands[index]!;
        const oracles = command.oracles ?? [];
        const timeoutMs = command.timeoutMs ?? 30 * 60_000;
        if (oracleFailed && oracles.length === 0) break;
        const commandWorkspace = join(sandboxRunRoot, `workspace-${String(index + 1).padStart(2, "0")}`);
        const commandProjection = await this.git.createValidationProjection(input.job.worktreePath, commandWorkspace);
        if (projection === null) projection = commandProjection;
        else if (projection.treeSha !== commandProjection.treeSha
          || projection.manifestDigest !== commandProjection.manifestDigest) {
          throw new Error("validation candidate projection changed between commands");
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
        await this.git.verifyValidationProjection(commandWorkspace, commandProjection.manifest);
        rmSync(commandWorkspace, { recursive: true, force: true });
        if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.outputLimitExceeded) {
          if (oracles.length === 0) break;
          oracleFailed = true;
        }
      }
      if (projection === null) {
        const emptyWorkspace = join(sandboxRunRoot, "workspace-empty");
        projection = await this.git.createValidationProjection(input.job.worktreePath, emptyWorkspace);
        await this.git.verifyValidationProjection(emptyWorkspace, projection.manifest);
        rmSync(emptyWorkspace, { recursive: true, force: true });
      }
      return { projection, results, sandboxPolicyDigest: this.provider.policyDigest };
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

  recover(validationsRoot: string): void {
    if (!existsSync(validationsRoot)) return;
    const root = realpathSync(validationsRoot);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const markerPath = join(root, entry.name, "sandbox.json");
      if (!existsSync(markerPath)) continue;
      const marker = readMarker(markerPath);
      if (marker.state === "clean") continue;
      if (!pathWithin(this.sandboxRoot, marker.sandboxRunRoot)
        || !pathWithin(marker.sandboxRunRoot, marker.workspace)) {
        throw new Error("validation sandbox cleanup marker escapes its configured root");
      }
      if (existsSync(marker.sandboxRunRoot)) {
        const stat = lstatSync(marker.sandboxRunRoot);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("validation sandbox cleanup target is unsafe");
        rmSync(marker.sandboxRunRoot, { recursive: true, force: true });
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
