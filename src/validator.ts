import { join } from "node:path";
import type {
  CommandConfig,
  ControllerConfig,
  JobState,
  ValidationCommandResult,
  ValidationReceipt,
} from "./types.js";
import { runCommand } from "./command.js";
import { ensurePrivateDir, writeJsonAtomic } from "./fs-atomic.js";
import { digestJson, newId, nowIso } from "./util.js";

export class Validator {
  constructor(private readonly config: ControllerConfig) {}

  async run(input: {
    job: JobState;
    scope: "setup" | "issue" | "release";
    issueNumber: number | null;
    commands: CommandConfig[];
    validationsRoot: string;
    sourceHeadSha: string;
    sourceWorktreeDigest: string;
  }): Promise<{ receipt: ValidationReceipt; path: string }> {
    const id = newId(`${input.scope}-validation`);
    const root = ensurePrivateDir(join(input.validationsRoot, id));
    const results: ValidationCommandResult[] = [];
    for (let index = 0; index < input.commands.length; index += 1) {
      const command = input.commands[index]!;
      const stdoutPath = join(root, `${String(index + 1).padStart(2, "0")}.stdout.log`);
      const stderrPath = join(root, `${String(index + 1).padStart(2, "0")}.stderr.log`);
      const result = await runCommand({
        command: this.config.shell,
        args: ["-lc", command.command],
        cwd: input.job.worktreePath,
        timeoutMs: command.timeoutMs ?? 30 * 60_000,
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
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdoutPath,
        stderrPath,
        stdoutTail: result.stdoutTail,
        stderrTail: result.stderrTail,
      });
      if (result.exitCode !== 0 || result.signal !== null || result.timedOut) break;
    }
    const identity = {
      version: 1 as const,
      id,
      scope: input.scope,
      issueNumber: input.issueNumber,
      candidateSha: input.sourceHeadSha,
      sourceWorktreeDigest: input.sourceWorktreeDigest,
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
