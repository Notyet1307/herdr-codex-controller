import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ControllerConfig, JobState } from "./types.js";
import { runCommand, requireCommandSuccess } from "./command.js";
import { ensurePrivateDir } from "./fs-atomic.js";
import { digestJson, pathWithin, sha256 } from "./util.js";

const GIT_TIMEOUT_MS = 120_000;
const GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

export class GitClient {
  constructor(private readonly config: ControllerConfig) {}

  async preflight(): Promise<void> {
    requireCommandSuccess(await runCommand({
      command: "git", args: ["--version"], cwd: this.config.localPath, timeoutMs: 30_000, maxTailBytes: 16_384,
    }), "git preflight");
    const root = await this.text(this.config.localPath, ["rev-parse", "--show-toplevel"]);
    if (realpathSync(root) !== realpathSync(this.config.localPath)) {
      throw new Error(`config.localPath is not the Git root: ${root}`);
    }
  }

  async fetchBase(): Promise<string> {
    await this.success(this.config.localPath, ["fetch", "--prune", this.config.remote, this.config.baseRef], "git fetch base");
    const sha = await this.text(this.config.localPath, ["rev-parse", `${this.config.remote}/${this.config.baseRef}^{commit}`]);
    assertSha(sha);
    return sha;
  }

  async ensureWorktree(job: JobState): Promise<void> {
    if (!job.baseSha) throw new Error("job base SHA is missing");
    ensurePrivateDir(this.config.worktreeRoot);
    if (!pathWithin(this.config.worktreeRoot, job.worktreePath)) throw new Error("worktree path escapes worktreeRoot");
    if (existsSync(job.worktreePath)) {
      const stat = lstatSync(job.worktreePath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("existing worktree path is unsafe");
      await this.verifyWorktree(job);
      return;
    }
    mkdirSync(dirname(job.worktreePath), { recursive: true, mode: 0o700 });
    const branchExists = await this.run(this.config.localPath, ["show-ref", "--verify", "--quiet", `refs/heads/${job.branch}`]);
    if (branchExists.exitCode === 0) {
      throw new Error(`branch ${job.branch} already exists without its expected worktree`);
    }
    await this.success(this.config.localPath, ["worktree", "add", "-b", job.branch, job.worktreePath, job.baseSha], "git create worktree");
    await this.verifyWorktree(job);
  }

  async verifyWorktree(job: JobState): Promise<void> {
    if (!job.baseSha) throw new Error("job base SHA is missing");
    const branch = await this.branch(job.worktreePath);
    if (branch !== job.branch) throw new Error(`worktree branch ${branch || "detached"} != ${job.branch}`);
    const root = await this.text(job.worktreePath, ["rev-parse", "--show-toplevel"]);
    if (realpathSync(root) !== realpathSync(job.worktreePath)) throw new Error("worktree Git root is unexpected");
    const mergeBase = await this.text(job.worktreePath, ["merge-base", job.baseSha, "HEAD"]);
    if (mergeBase !== job.baseSha) throw new Error("worktree history does not descend from the bound base SHA");
  }

  async head(cwd: string): Promise<string> {
    const sha = await this.text(cwd, ["rev-parse", "HEAD^{commit}"]);
    assertSha(sha);
    return sha;
  }

  async branch(cwd: string): Promise<string> {
    return this.text(cwd, ["branch", "--show-current"]);
  }

  async statusPorcelain(cwd: string): Promise<string> {
    return this.textRaw(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  }

  async isClean(cwd: string): Promise<boolean> {
    return (await this.statusPorcelain(cwd)).length === 0;
  }

  async changedPaths(cwd: string): Promise<string[]> {
    const raw = await this.statusPorcelain(cwd);
    const entries = raw.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (const entry of entries) {
      if (entry.length < 4) throw new Error("invalid Git status entry");
      const path = entry.slice(3).split(" -> ").at(-1)!;
      paths.push(path);
    }
    return [...new Set(paths)].sort();
  }

  async worktreeDigest(cwd: string): Promise<string> {
    const headSha = await this.head(cwd);
    const status = await this.statusPorcelain(cwd);
    const diff = await this.textRawBounded(cwd, ["diff", "--binary", "HEAD"], 64 * 1024 * 1024);
    const untrackedRaw = await this.textRawBounded(cwd, ["ls-files", "-z", "--others", "--exclude-standard"], 8 * 1024 * 1024);
    const untracked = untrackedRaw.split("\0").filter(Boolean).sort();
    const untrackedDigests: Array<{ path: string; object: string }> = [];
    for (const path of untracked) {
      if (path.includes("\0") || path.startsWith("/") || path.split("/").includes("..")) {
        throw new Error("unsafe untracked path while fingerprinting worktree");
      }
      const object = await this.text(cwd, ["hash-object", "--no-filters", "--", path]);
      if (!/^[0-9a-f]{40}$/i.test(object)) throw new Error("invalid untracked object hash");
      untrackedDigests.push({ path, object });
    }
    return digestJson({ version: 1, headSha, status, diff, untrackedDigests });
  }

  async assertAgentDidNotCommit(job: JobState, expectedHead: string): Promise<void> {
    const head = await this.head(job.worktreePath);
    const branch = await this.branch(job.worktreePath);
    if (head !== expectedHead) throw new Error("Codex changed Git HEAD; commit authority belongs to the Controller");
    if (branch !== job.branch) throw new Error("Codex changed the release branch identity");
  }

  async commitIssue(job: JobState, issueNumber: number, title: string, allowNoop: boolean): Promise<{ sha: string; created: boolean }> {
    await this.success(job.worktreePath, ["add", "-A"], "git stage issue changes");
    const diff = await this.run(job.worktreePath, ["diff", "--cached", "--quiet"]);
    if (diff.exitCode === 0) {
      if (!allowNoop) throw new Error(`issue #${issueNumber} produced no changes`);
      const subject = normalizeSubject(title, `record no-op issue #${issueNumber}`);
      const body = [
        `Issue: #${issueNumber}`,
        "",
        `Herdr-Release-Id: ${job.id}`,
        `Herdr-Issue: ${issueNumber}`,
        `Herdr-Plan-Digest: ${job.planDigest}`,
        "Herdr-Noop: true",
      ].join("\n");
      await this.success(job.worktreePath, ["commit", "--allow-empty", "-m", subject, "-m", body], "git commit no-op issue");
      return { sha: await this.head(job.worktreePath), created: true };
    }
    if (diff.exitCode !== 1) throw new Error(`cannot inspect staged diff: ${diff.stderrTail || diff.stdoutTail}`);
    const subject = normalizeSubject(title, `implement issue #${issueNumber}`);
    const body = [
      `Issue: #${issueNumber}`,
      "",
      `Herdr-Release-Id: ${job.id}`,
      `Herdr-Issue: ${issueNumber}`,
      `Herdr-Plan-Digest: ${job.planDigest}`,
    ].join("\n");
    await this.success(job.worktreePath, ["commit", "-m", subject, "-m", body], "git commit issue");
    return { sha: await this.head(job.worktreePath), created: true };
  }

  async salvageIssueCommitAtHead(job: JobState, issueNumber: number): Promise<string | null> {
    if (!(await this.isClean(job.worktreePath))) return null;
    const message = await this.textRaw(job.worktreePath, ["log", "-1", "--format=%H%n%B"]);
    const [sha, ...bodyLines] = message.split(/\r?\n/);
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) return null;
    const body = bodyLines.join("\n");
    if (!body.includes(`Herdr-Release-Id: ${job.id}`)
      || !body.includes(`Herdr-Issue: ${issueNumber}`)
      || !body.includes(`Herdr-Plan-Digest: ${job.planDigest}`)) return null;
    return sha;
  }

  async salvageHardeningCommitAtHead(job: JobState, round: number): Promise<string | null> {
    if (!(await this.isClean(job.worktreePath))) return null;
    const message = await this.textRaw(job.worktreePath, ["log", "-1", "--format=%H%n%B"]);
    const [sha, ...bodyLines] = message.split(/\r?\n/);
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) return null;
    const body = bodyLines.join("\n");
    if (!body.includes(`Herdr-Release-Id: ${job.id}`)
      || !body.includes(`Herdr-Hardening-Round: ${round}`)
      || !body.includes(`Herdr-Plan-Digest: ${job.planDigest}`)) return null;
    return sha;
  }

  async commitHardening(job: JobState, reason: string): Promise<{ sha: string; created: boolean }> {
    await this.success(job.worktreePath, ["add", "-A"], "git stage hardening changes");
    const diff = await this.run(job.worktreePath, ["diff", "--cached", "--quiet"]);
    if (diff.exitCode === 0) return { sha: await this.head(job.worktreePath), created: false };
    if (diff.exitCode !== 1) throw new Error(`cannot inspect hardening diff: ${diff.stderrTail || diff.stdoutTail}`);
    const body = [
      "Hardening evidence is retained in the private Controller state directory.",
      "",
      `Herdr-Release-Id: ${job.id}`,
      `Herdr-Hardening-Round: ${job.hardeningRounds}`,
      `Herdr-Hardening-Evidence-Digest: ${sha256(reason)}`,
      `Herdr-Plan-Digest: ${job.planDigest}`,
    ].join("\n");
    await this.success(job.worktreePath, ["commit", "-m", `fix: harden ${job.plan.title}`, "-m", body], "git commit hardening");
    return { sha: await this.head(job.worktreePath), created: true };
  }

  async diffStats(job: JobState): Promise<{ files: number; changedLines: number; summary: string }> {
    if (!job.baseSha) throw new Error("job base SHA is missing");
    const output = await this.textRaw(job.worktreePath, ["diff", "--numstat", `${job.baseSha}...HEAD`]);
    let files = 0;
    let changedLines = 0;
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const [added, deleted] = line.split("\t", 3);
      files += 1;
      if (added !== "-" && deleted !== "-") changedLines += Number(added) + Number(deleted);
    }
    const summary = await this.textRaw(job.worktreePath, ["diff", "--stat", `${job.baseSha}...HEAD`]);
    return { files, changedLines, summary };
  }

  async diffText(job: JobState, maximumBytes: number): Promise<string> {
    if (!job.baseSha || !job.candidateSha) throw new Error("review candidate identity is incomplete");
    const result = await this.run(job.worktreePath, ["diff", "--no-ext-diff", "--unified=80", `${job.baseSha}...${job.candidateSha}`], maximumBytes);
    requireCommandSuccess(result, "git render release diff");
    if (Buffer.byteLength(result.stdoutTail, "utf8") >= maximumBytes) {
      throw new Error(`release diff exceeds the ${maximumBytes} byte review input bound`);
    }
    return result.stdoutTail;
  }

  async push(job: JobState): Promise<void> {
    await this.success(job.worktreePath, ["push", "--set-upstream", job.remote, job.branch], "git push release branch", 15 * 60_000);
  }

  async removeWorktree(job: JobState): Promise<void> {
    if (!existsSync(job.worktreePath)) return;
    if (!(await this.isClean(job.worktreePath))) throw new Error("refusing to remove a dirty worktree");
    await this.success(this.config.localPath, ["worktree", "remove", job.worktreePath], "git remove worktree");
    if (existsSync(job.worktreePath)) throw new Error("worktree removal was not confirmed");
  }

  private async verifyWorktreeIdentity(cwd: string): Promise<void> {
    const root = await this.text(cwd, ["rev-parse", "--show-toplevel"]);
    if (realpathSync(root) !== realpathSync(cwd)) throw new Error("unexpected Git worktree root");
  }

  private async text(cwd: string, args: string[]): Promise<string> {
    return (await this.textRaw(cwd, args)).trim();
  }

  private async textRaw(cwd: string, args: string[]): Promise<string> {
    const result = await this.run(cwd, args);
    requireCommandSuccess(result, `git ${args[0] ?? "command"}`);
    return result.stdoutTail;
  }

  private async textRawBounded(cwd: string, args: string[], maximumBytes: number): Promise<string> {
    const result = await this.run(cwd, args, maximumBytes);
    requireCommandSuccess(result, `git ${args[0] ?? "command"}`);
    if (Buffer.byteLength(result.stdoutTail, "utf8") >= maximumBytes) {
      throw new Error(`git ${args[0] ?? "command"} output reached its ${maximumBytes} byte bound`);
    }
    return result.stdoutTail;
  }

  private async success(cwd: string, args: string[], label: string, timeoutMs = GIT_TIMEOUT_MS): Promise<void> {
    requireCommandSuccess(await this.run(cwd, args, GIT_OUTPUT_BYTES, timeoutMs), label);
  }

  private run(cwd: string, args: string[], maxTailBytes = GIT_OUTPUT_BYTES, timeoutMs = GIT_TIMEOUT_MS) {
    return runCommand({ command: "git", args: ["-C", cwd, ...args], cwd, timeoutMs, maxTailBytes });
  }
}

function assertSha(value: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`invalid Git SHA: ${value}`);
}

function normalizeSubject(value: string, fallback: string): string {
  const firstLine = value.replace(/[\r\n]+/g, " ").trim();
  const subject = firstLine || fallback;
  return subject.length <= 72 ? subject : `${subject.slice(0, 69)}...`;
}
