import type {
  ControllerConfig,
  CommandResult,
  JobState,
  ValidationBootstrapResult,
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
  private verified: Awaited<ReturnType<ValidationExecutor["doctor"]>> | null = null;

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
    const bootstrap = config.validation.bootstrap
      ? {
          config: config.validation.bootstrap,
          provider: new CodexSandboxProvider({
            codexBin: sandbox.bin,
            shell: config.shell,
            environmentPath: sandbox.environmentPath,
            deniedReadPaths: [config.localPath, config.stateDir, config.worktreeRoot],
            networkAccess: config.validation.bootstrap.networkAccess,
            terminationGraceMs: config.codex.terminationGraceMs,
          }),
        }
      : null;
    this.executor = new ValidationExecutor(
      git,
      provider,
      sandbox.root,
      bootstrap,
    );
  }

  async preflight(): Promise<Awaited<ReturnType<ValidationExecutor["doctor"]>>> {
    if (this.verified) {
      return this.verified;
    }
    const result = await this.executor.doctor();
    if (!result.verified) {
      throw new ControllerError(
        "validation_sandbox_capability_unavailable",
        "Production delivery requires a verified validation sandbox capability.",
      );
    }
    this.verified = result;
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
    const results: ValidationCommandResult[] = execution.results.map((entry, index) => commandEvidence({
      command: entry.command.command,
      timeoutMs: entry.timeoutMs,
      stdoutPath: entry.stdoutPath,
      stderrPath: entry.stderrPath,
      result: entry.result,
      identity: { index, command: entry.command.command, timeoutMs: entry.timeoutMs },
    }));
    const configuredCommands = input.commands.map((command) => ({
      command: command.command,
      timeoutMs: command.timeoutMs ?? 30 * 60_000,
    }));
    const bootstrapConfig = this.config.validation.bootstrap ?? null;
    const bootstrapRuns: ValidationBootstrapResult[] = execution.bootstrapResults.map((entry) => ({
      ...commandEvidence({
        command: entry.command.command,
        timeoutMs: entry.command.timeoutMs,
        stdoutPath: entry.stdoutPath,
        stderrPath: entry.stderrPath,
        result: entry.result,
        identity: {
          commandIndex: entry.commandIndex,
          command: entry.command.command,
          timeoutMs: entry.command.timeoutMs,
          networkAccess: entry.command.networkAccess,
          policyDigest: execution.bootstrapPolicyDigest,
        },
      }),
      commandIndex: entry.commandIndex,
      sourceIntegrityVerified: entry.sourceIntegrityVerified,
    }));
    const bootstrap = bootstrapConfig === null ? null : {
      ...bootstrapConfig,
      identityDigest: digestJson(bootstrapConfig),
      policyDigest: execution.bootstrapPolicyDigest ?? "",
      runs: bootstrapRuns,
    };
    const integrityPassed = execution.integrityChecks.length === input.commands.length
      && execution.integrityChecks.every((entry) => entry.afterBootstrap && entry.afterValidation === true);
    const bootstrapPassed = bootstrap === null || (bootstrap.runs.length === input.commands.length
      && bootstrap.runs.every((entry) => commandPassed(entry) && entry.sourceIntegrityVerified));
    const identity = {
      version: 4 as const,
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
      bootstrap,
      integrityChecks: execution.integrityChecks,
      commandCount: input.commands.length,
      passed: results.length === input.commands.length && results.every((entry) => (
        entry.exitCode === 0 && entry.signal === null && !entry.timedOut && !entry.outputLimitExceeded
      )) && integrityPassed && bootstrapPassed,
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
  if (!receipt || ![2, 3, 4].includes(receipt.version)
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
    if ((receipt.version === 3 || receipt.version === 4) && (
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
  if (receipt.version === 3 || receipt.version === 4) {
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
  const commandsPassed = receipt.commands.length === receipt.commandCount && receipt.commands.every(commandPassed);
  let v4Passed = true;
  if (receipt.version === 4) v4Passed = assertV4Evidence(receipt);
  if (receipt.passed !== (commandsPassed && v4Passed)) {
    throw new ControllerError("validation_receipt_invalid", `Validation receipt ${receipt.id} pass state is invalid.`);
  }
  const { digest, ...identity } = receipt;
  if (digest !== digestJson(identity)) throw new ControllerError("validation_receipt_invalid", `Validation receipt ${receipt.id} failed its self-digest.`);
}

function commandEvidence(input: {
  command: string;
  timeoutMs: number;
  stdoutPath: string;
  stderrPath: string;
  result: CommandResult;
  identity: unknown;
}): ValidationCommandResult {
  return {
    command: input.command,
    timeoutMs: input.timeoutMs,
    exitCode: input.result.exitCode,
    signal: input.result.signal,
    timedOut: input.result.timedOut,
    durationMs: input.result.durationMs,
    stdoutPath: input.stdoutPath,
    stderrPath: input.stderrPath,
    stdoutSha256: input.result.stdoutSha256,
    stderrSha256: input.result.stderrSha256,
    stdoutTail: input.result.stdoutTail,
    stderrTail: input.result.stderrTail,
    stdoutBytes: input.result.stdoutBytes,
    stderrBytes: input.result.stderrBytes,
    outputLimitExceeded: input.result.outputLimitExceeded,
    terminationReason: input.result.terminationReason,
    commandIdentityDigest: digestJson(input.identity),
    verifiedAt: nowIso(),
  };
}

function commandPassed(command: Pick<ValidationCommandResult, "exitCode" | "signal" | "timedOut" | "outputLimitExceeded">): boolean {
  return command.exitCode === 0 && command.signal === null && !command.timedOut && command.outputLimitExceeded !== true;
}

function assertV4Evidence(receipt: ValidationReceipt): boolean {
  const integrity = receipt.integrityChecks;
  if (!("bootstrap" in receipt) || !Array.isArray(integrity) || integrity.length > receipt.commandCount
    || integrity.some((entry, index) => entry.commandIndex !== index
      || typeof entry.afterBootstrap !== "boolean"
      || (entry.afterValidation !== null && typeof entry.afterValidation !== "boolean")
      || (!entry.afterBootstrap && entry.afterValidation !== null))
    || integrity.filter((entry) => entry.afterValidation !== null).length !== receipt.commands.length) {
    throw new ControllerError("validation_receipt_invalid", `Validation receipt ${receipt.id} integrity evidence is invalid.`);
  }
  const bootstrap = receipt.bootstrap;
  if (bootstrap !== null) {
    if (!bootstrap || !bootstrap.command || !Number.isSafeInteger(bootstrap.timeoutMs) || bootstrap.timeoutMs < 1_000
      || typeof bootstrap.networkAccess !== "boolean"
      || bootstrap.identityDigest !== digestJson({
        command: bootstrap.command,
        timeoutMs: bootstrap.timeoutMs,
        networkAccess: bootstrap.networkAccess,
      })
      || !/^[a-f0-9]{64}$/u.test(bootstrap.policyDigest)
      || !Array.isArray(bootstrap.runs) || bootstrap.runs.length !== integrity.length) {
      throw new ControllerError("validation_receipt_invalid", `Validation receipt ${receipt.id} bootstrap binding is invalid.`);
    }
    for (let index = 0; index < bootstrap.runs.length; index += 1) {
      const run = bootstrap.runs[index]!;
      if (run.commandIndex !== index || run.command !== bootstrap.command || run.timeoutMs !== bootstrap.timeoutMs
        || typeof run.sourceIntegrityVerified !== "boolean"
        || run.sourceIntegrityVerified !== integrity[index]!.afterBootstrap
        || !Number.isSafeInteger(run.durationMs) || run.durationMs < 0
        || (run.exitCode !== null && !Number.isSafeInteger(run.exitCode))
        || (run.signal !== null && typeof run.signal !== "string")
        || typeof run.timedOut !== "boolean"
        || typeof run.stdoutTail !== "string" || typeof run.stderrTail !== "string"
        || !Number.isSafeInteger(run.stdoutBytes) || Number(run.stdoutBytes) < 0
        || !Number.isSafeInteger(run.stderrBytes) || Number(run.stderrBytes) < 0
        || typeof run.outputLimitExceeded !== "boolean"
        || !["exit", "signal", "timeout", "output_limit"].includes(String(run.terminationReason))
        || !/^sha256:[a-f0-9]{64}$/u.test(run.stdoutSha256)
        || !/^sha256:[a-f0-9]{64}$/u.test(run.stderrSha256)
        || !run.stdoutPath || !run.stderrPath
        || !Number.isFinite(Date.parse(run.verifiedAt))
        || run.commandIdentityDigest !== digestJson({
          commandIndex: index,
          command: bootstrap.command,
          timeoutMs: bootstrap.timeoutMs,
          networkAccess: bootstrap.networkAccess,
          policyDigest: bootstrap.policyDigest,
        })) {
        throw new ControllerError("validation_receipt_invalid", `Validation receipt ${receipt.id} bootstrap evidence is invalid.`);
      }
    }
  }
  return integrity.length === receipt.commandCount
    && integrity.every((entry) => entry.afterBootstrap && entry.afterValidation === true)
    && (bootstrap === null || (bootstrap.runs.length === receipt.commandCount
      && bootstrap.runs.every((entry) => commandPassed(entry) && entry.sourceIntegrityVerified)));
}
import { join } from "node:path";
