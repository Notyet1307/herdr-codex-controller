import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ControllerConfig,
  JobState,
  ValidationCommandConfig,
  ValidationCommandResult,
  ValidationReceipt,
} from "./types.js";
import { runCommand } from "./command.js";
import { ensurePrivateDir, writeJsonAtomic } from "./fs-atomic.js";
import { digestJson, newId, nowIso, sha256 } from "./util.js";

export class Validator {
  constructor(private readonly config: ControllerConfig) {}

  async run(input: {
    job: JobState;
    scope: "setup" | "issue" | "release";
    issueNumber: number | null;
    commands: ValidationCommandConfig[];
    validationsRoot: string;
    sourceHeadSha: string;
    sourceWorktreeDigest: string;
  }): Promise<{ receipt: ValidationReceipt; path: string }> {
    const id = newId(`${input.scope}-validation`);
    const root = ensurePrivateDir(join(input.validationsRoot, id));
    const results: ValidationCommandResult[] = [];
    let oracleFailed = false;
    for (let index = 0; index < input.commands.length; index += 1) {
      const command = input.commands[index]!;
      const oracles = command.oracles ?? [];
      const timeoutMs = command.timeoutMs ?? 30 * 60_000;
      if (oracleFailed && oracles.length === 0) break;
      const stdoutPath = join(root, `${String(index + 1).padStart(2, "0")}.stdout.log`);
      const stderrPath = join(root, `${String(index + 1).padStart(2, "0")}.stderr.log`);
      const result = await runCommand({
        command: this.config.shell,
        args: ["-lc", command.command],
        cwd: input.job.worktreePath,
        timeoutMs,
        terminationGraceMs: this.config.codex.terminationGraceMs,
        stdoutPath,
        stderrPath,
        maxTailBytes: this.config.validation.maxOutputBytes,
        env: {
          HERDR_RELEASE_ID: input.job.id,
          HERDR_ISSUE_NUMBER: input.issueNumber === null ? "" : String(input.issueNumber),
          HERDR_CANDIDATE_SHA: input.sourceHeadSha,
        },
      });
      results.push({
        command: command.command,
        oracles,
        timeoutMs,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdoutPath,
        stderrPath,
        stdoutSha256: `sha256:${sha256(readFileSync(stdoutPath))}`,
        stderrSha256: `sha256:${sha256(readFileSync(stderrPath))}`,
        stdoutTail: result.stdoutTail,
        stderrTail: result.stderrTail,
        verifiedAt: nowIso(),
      });
      if (result.exitCode !== 0 || result.signal !== null || result.timedOut) {
        if (oracles.length === 0) break;
        oracleFailed = true;
      }
    }
    const identity = {
      version: 2 as const,
      id,
      scope: input.scope,
      issueNumber: input.issueNumber,
      candidateSha: input.sourceHeadSha,
      sourceWorktreeDigest: input.sourceWorktreeDigest,
      commandCount: input.commands.length,
      passed: results.length === input.commands.length && results.every((entry) => (
        entry.exitCode === 0 && entry.signal === null && !entry.timedOut
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
