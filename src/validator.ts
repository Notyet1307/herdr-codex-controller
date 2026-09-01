import type {
  ControllerConfig,
  JobState,
  ValidationCommandConfig,
  ValidationCommandResult,
  ValidationReceipt,
} from "./types.js";
import { ControllerError } from "./errors.js";
import { ensurePrivateDir, writeJsonAtomic } from "./fs-atomic.js";
import { digestJson, newId, nowIso } from "./util.js";
import { GitClient } from "./git.js";
import type { GitPort } from "./ports.js";
import { CodexSandboxProvider } from "./validation-sandbox.js";
import { ValidationExecutor } from "./validation-executor.js";

export class Validator {
  private readonly executor: ValidationExecutor;
  private verified = false;

  constructor(
    private readonly config: ControllerConfig,
    git: GitPort = new GitClient(config),
    executor?: ValidationExecutor,
  ) {
    if (executor) {
      this.executor = executor;
      return;
    }
    const sandbox = config.validation.sandbox;
    const provider = new CodexSandboxProvider({
      codexBin: sandbox.bin,
      shell: config.shell,
      environmentPath: sandbox.environmentPath,
      deniedReadPaths: [config.localPath, config.stateDir, config.worktreeRoot],
      terminationGraceMs: config.codex.terminationGraceMs,
    });
    this.executor = new ValidationExecutor(
      git,
      provider,
      sandbox.root,
    );
  }

  async preflight(): Promise<{ verified: boolean; policyDigest: string }> {
    if (this.verified) {
      return { verified: true, policyDigest: this.executor.policyDigest };
    }
    const result = await this.executor.doctor();
    if (!result.verified) {
      throw new ControllerError(
        "validation_sandbox_capability_unavailable",
        "Production delivery requires a verified validation sandbox capability.",
      );
    }
    this.verified = true;
    return result;
  }

  async run(input: {
    job: JobState;
    scope: "setup" | "issue" | "release";
    issueNumber: number | null;
    commands: ValidationCommandConfig[];
    validationsRoot: string;
    sourceHeadSha: string;
    sourceWorktreeDigest: string;
  }): Promise<{ receipt: ValidationReceipt; path: string }> {
    await this.preflight();
    const id = newId(`${input.scope}-validation`);
    const root = ensurePrivateDir(join(input.validationsRoot, id));
    const execution = await this.executor.execute({
      job: input.job,
      validationId: id,
      commands: input.commands,
      evidenceRoot: root,
      issueNumber: input.issueNumber,
      sourceHeadSha: input.sourceHeadSha,
      stdoutByteLimit: this.config.validation.maxStdoutBytes,
      stderrByteLimit: this.config.validation.maxStderrBytes,
      aggregateByteLimit: this.config.validation.maxAggregateBytes,
    });
    const results: ValidationCommandResult[] = execution.results.map((entry, index) => ({
      command: entry.command.command,
      timeoutMs: entry.timeoutMs,
      exitCode: entry.result.exitCode,
      signal: entry.result.signal,
      timedOut: entry.result.timedOut,
      durationMs: entry.result.durationMs,
      stdoutPath: entry.stdoutPath,
      stderrPath: entry.stderrPath,
      stdoutSha256: entry.result.stdoutSha256,
      stderrSha256: entry.result.stderrSha256,
      stdoutTail: entry.result.stdoutTail,
      stderrTail: entry.result.stderrTail,
      stdoutBytes: entry.result.stdoutBytes,
      stderrBytes: entry.result.stderrBytes,
      outputLimitExceeded: entry.result.outputLimitExceeded,
      terminationReason: entry.result.terminationReason,
      commandIdentityDigest: digestJson({
        index,
        command: entry.command.command,
        timeoutMs: entry.timeoutMs,
      }),
      verifiedAt: nowIso(),
    }));
    const configuredCommands = input.commands.map((command) => ({
      command: command.command,
      timeoutMs: command.timeoutMs ?? 30 * 60_000,
    }));
    const identity = {
      version: 3 as const,
      id,
      scope: input.scope,
      issueNumber: input.issueNumber,
      candidateSha: input.sourceHeadSha,
      sourceWorktreeDigest: input.sourceWorktreeDigest,
      candidateTreeSha: execution.projection.treeSha,
      candidateTreeDigest: execution.projection.manifestDigest,
      sandboxPolicyDigest: execution.sandboxPolicyDigest,
      commandSetDigest: digestJson(configuredCommands),
      configuredCommands,
      projectionFileCount: execution.projection.fileCount,
      projectionByteCount: execution.projection.byteCount,
      cleanupCompleted: true,
      commandCount: input.commands.length,
      passed: results.length === input.commands.length && results.every((entry) => (
        entry.exitCode === 0 && entry.signal === null && !entry.timedOut && !entry.outputLimitExceeded
      )),
      commands: results,
      createdAt: nowIso(),
    };
    const receipt: ValidationReceipt = { ...identity, digest: digestJson(identity) };
    const path = join(root, "receipt.json");
    writeJsonAtomic(path, receipt);
    return { receipt, path };
  }

}

export function assertValidationReceipt(receipt: ValidationReceipt): void {
  if (!receipt || (receipt.version !== 2 && receipt.version !== 3)
    || !receipt.id
    || !["setup", "issue", "release"].includes(receipt.scope)
    || (receipt.scope === "issue"
      ? !Number.isSafeInteger(receipt.issueNumber) || Number(receipt.issueNumber) < 1
      : receipt.issueNumber !== null)
    || !/^[a-f0-9]{40}$/.test(receipt.candidateSha)
    || !/^[a-f0-9]{64}$/.test(receipt.sourceWorktreeDigest)
    || !Number.isSafeInteger(receipt.commandCount)
    || receipt.commandCount < 0
    || !Array.isArray(receipt.commands)
    || !Number.isFinite(Date.parse(receipt.createdAt))) {
    throw new ControllerError("validation_receipt_invalid", "Validation receipt structure is invalid.");
  }
  for (let index = 0; index < receipt.commands.length; index += 1) {
    const command = receipt.commands[index]!;
    if (!command.command
      || !Number.isSafeInteger(command.timeoutMs)
      || command.timeoutMs < 1_000
      || !/^sha256:[a-f0-9]{64}$/.test(command.stdoutSha256)
      || !/^sha256:[a-f0-9]{64}$/.test(command.stderrSha256)
      || !command.stdoutPath
      || !command.stderrPath
      || !Number.isFinite(Date.parse(command.verifiedAt))) {
      throw new ControllerError("validation_receipt_invalid", `Validation receipt ${receipt.id} command evidence is invalid.`);
    }
    if (receipt.version === 3 && (
      !Number.isSafeInteger(command.stdoutBytes) || Number(command.stdoutBytes) < 0
      || !Number.isSafeInteger(command.stderrBytes) || Number(command.stderrBytes) < 0
      || typeof command.outputLimitExceeded !== "boolean"
      || !["exit", "signal", "timeout", "output_limit"].includes(String(command.terminationReason))
      || command.commandIdentityDigest !== digestJson({
        index,
        command: command.command,
        timeoutMs: command.timeoutMs,
      })
    )) {
      throw new ControllerError("validation_receipt_invalid", `Validation receipt ${receipt.id} bounded command evidence is invalid.`);
    }
  }
  const commandsPassed = receipt.commands.length === receipt.commandCount && receipt.commands.every((command) => (
    command.exitCode === 0 && command.signal === null && !command.timedOut && command.outputLimitExceeded !== true
  ));
  if (receipt.passed !== commandsPassed) {
    throw new ControllerError("validation_receipt_invalid", `Validation receipt ${receipt.id} pass state is invalid.`);
  }
  if (receipt.version === 3) {
    const commandSet = receipt.configuredCommands;
    if (!/^[a-f0-9]{40}$/u.test(receipt.candidateTreeSha ?? "")
      || !/^[a-f0-9]{64}$/u.test(receipt.candidateTreeDigest ?? "")
      || !/^[a-f0-9]{64}$/u.test(receipt.sandboxPolicyDigest ?? "")
      || !Array.isArray(commandSet) || commandSet.length !== receipt.commandCount
      || receipt.commandSetDigest !== digestJson(commandSet)
      || receipt.commands.some((command, index) => (
        JSON.stringify({ command: command.command, timeoutMs: command.timeoutMs })
          !== JSON.stringify(commandSet[index])
      ))
      || !Number.isSafeInteger(receipt.projectionFileCount) || Number(receipt.projectionFileCount) < 0
      || !Number.isSafeInteger(receipt.projectionByteCount) || Number(receipt.projectionByteCount) < 0
      || receipt.cleanupCompleted !== true) {
      throw new ControllerError("validation_receipt_invalid", `Validation receipt ${receipt.id} sandbox binding is invalid.`);
    }
  }
  const { digest, ...identity } = receipt;
  if (digest !== digestJson(identity)) throw new ControllerError("validation_receipt_invalid", `Validation receipt ${receipt.id} failed its self-digest.`);
}
import { join } from "node:path";
