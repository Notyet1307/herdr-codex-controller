import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ControllerConfig, JobState, RepositoryFileSnapshot } from "./types.js";
import { runCommand, requireCommandSuccess } from "./command.js";
import { ensurePrivateDir } from "./fs-atomic.js";
import { digestJson, pathWithin, sha256 } from "./util.js";

const GIT_TIMEOUT_MS = 120_000;
const GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const ORACLE_MAX_BYTES = 64 * 1024 * 1024;
type DiffEntry = { path: string; changedLines: number; binary: boolean };
type BoundedDiff = { files: number; changedLines: number; paths: string[]; entries: DiffEntry[] };

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

  async isAncestorOfRemoteBase(sha: string): Promise<boolean> {
    assertSha(sha);
    const result = await this.run(this.config.localPath, [
      "merge-base", "--is-ancestor", sha, `${this.config.remote}/${this.config.baseRef}`,
    ]);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(`cannot verify merged commit ancestry: ${result.stderrTail || result.stdoutTail}`);
  }

  async verifyMergeResult(input: {
    mergeSha: string;
    candidateSha: string;
    baseSha: string;
    mergeMethod: "merge" | "squash" | "rebase";
  }): Promise<"verified" | "base_mismatch" | "candidate_mismatch"> {
    assertSha(input.mergeSha);
    assertSha(input.candidateSha);
    assertSha(input.baseSha);
    const parents = (await this.text(this.config.localPath, ["rev-list", "--parents", "-n", "1", input.mergeSha])).split(" ").slice(1);
    if (input.mergeMethod === "merge") {
      if (parents[0] !== input.baseSha) return "base_mismatch";
      if (parents.length !== 2 || parents[1] !== input.candidateSha) return "candidate_mismatch";
    } else if (input.mergeMethod === "squash") {
      if (parents[0] !== input.baseSha) return "base_mismatch";
      if (parents.length !== 1) return "candidate_mismatch";
    } else {
      const candidateCountText = await this.text(this.config.localPath, [
        "rev-list", "--count", "--first-parent", `${input.baseSha}..${input.candidateSha}`,
      ]);
      const candidateCount = Number(candidateCountText);
      if (!Number.isSafeInteger(candidateCount) || candidateCount < 1) return "candidate_mismatch";
      const rebasedBase = await this.text(this.config.localPath, ["rev-parse", `${input.mergeSha}~${candidateCount}`]);
      if (rebasedBase !== input.baseSha) return "base_mismatch";
    }

    const mergeTree = await this.text(this.config.localPath, ["rev-parse", `${input.mergeSha}^{tree}`]);
    const candidateTree = await this.text(this.config.localPath, ["rev-parse", `${input.candidateSha}^{tree}`]);
    return mergeTree === candidateTree ? "verified" : "candidate_mismatch";
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
    const tracked = await this.textRawBounded(cwd, ["diff", "--name-only", "-z", "--no-renames", "HEAD", "--"], GIT_OUTPUT_BYTES);
    const untracked = await this.textRawBounded(cwd, ["ls-files", "-z", "--others", "--exclude-standard"], GIT_OUTPUT_BYTES);
    return [...new Set(`${tracked}\0${untracked}`.split("\0").filter(Boolean))].sort();
  }

  async fileAtRevision(revision: string, path: string): Promise<RepositoryFileSnapshot> {
    assertSha(revision);
    assertSafeRepoPath(path);
    const tree = await this.textRawBounded(this.config.localPath, ["ls-tree", "-z", revision, "--", path], 8_192);
    const match = tree.replace(/\0$/u, "").match(/^(100644|100755) blob [a-f0-9]+\t([^\u0000]+)$/u);
    if (!match || match[2] !== path) throw new Error("Oracle artifact is not a reviewed-base regular file");
    return fileBinding(gitBytes(this.config.localPath, ["show", `${revision}:${path}`]));
  }

  async fileInWorktree(job: JobState, path: string): Promise<RepositoryFileSnapshot> {
    assertSafeRepoPath(path);
    const root = realpathSync(job.worktreePath);
    let current = root;
    for (const segment of path.split("/")) {
      current = join(current, segment);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error("Oracle artifact path contains a symlink");
    }
    const target = realpathSync(current);
    if (!pathWithin(root, target)) throw new Error("Oracle artifact escapes the release worktree");
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Oracle artifact is not a private regular file");
    return fileBinding(readFileSync(target));
  }

  async commitStats(job: JobState, sha: string): Promise<BoundedDiff> {
    assertSha(sha);
    return this.statsBetween(job.worktreePath, `${sha}^`, sha);
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

  async commitParent(job: JobState, sha: string): Promise<string> {
    assertSha(sha);
    const parent = await this.text(job.worktreePath, ["rev-parse", `${sha}^1`]);
    assertSha(parent);
    return parent;
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

  async diffStats(job: JobState): Promise<BoundedDiff & { summary: string }> {
    if (!job.baseSha) throw new Error("job base SHA is missing");
    const stats = await this.statsBetween(job.worktreePath, job.baseSha, "HEAD");
    const summary = await this.textRaw(job.worktreePath, ["diff", "--stat", `${job.baseSha}...HEAD`]);
    return { ...stats, summary };
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

  private async statsBetween(cwd: string, from: string, to: string): Promise<BoundedDiff> {
    const raw = await this.textRawBounded(cwd, [
      "diff", "--numstat", "-z", "--no-renames", from, to, "--",
    ], GIT_OUTPUT_BYTES);
    const entries = raw.split("\0").filter(Boolean).map((entry) => {
      const match = entry.match(/^([0-9]+|-)\t([0-9]+|-)\t([\s\S]+)$/u);
      if (!match) throw new Error("invalid Git numstat entry");
      const binary = match[1] === "-" || match[2] === "-";
      return { path: match[3]!, changedLines: binary ? 0 : Number(match[1]) + Number(match[2]), binary };
    });
    return {
      files: entries.length,
      changedLines: entries.reduce((total, entry) => total + entry.changedLines, 0),
      paths: entries.map(({ path }) => path).sort(),
      entries,
    };
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

function assertSafeRepoPath(value: string): void {
  const segments = value.split("/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || /[*?[\]{}\u0000\r\n]/u.test(value)) {
    throw new Error("unsafe repository path");
  }
}

function fileBinding(bytes: Uint8Array): RepositoryFileSnapshot {
  if (bytes.byteLength > ORACLE_MAX_BYTES) throw new Error("Oracle artifact exceeds the byte bound");
  return { sha256: `sha256:${sha256(bytes)}`, byteCount: bytes.byteLength, bytes };
}

function gitBytes(cwd: string, args: string[]): Uint8Array {
  const run = spawnSync("git", ["-C", cwd, ...args], { encoding: null, maxBuffer: ORACLE_MAX_BYTES + 1 });
  if (run.error || run.signal || run.status !== 0 || !(run.stdout instanceof Uint8Array)) {
    throw new Error("cannot read Oracle artifact bytes from Git");
  }
  return run.stdout;
}

function normalizeSubject(value: string, fallback: string): string {
  const firstLine = value.replace(/[\r\n]+/g, " ").trim();
  const subject = firstLine || fallback;
  return subject.length <= 72 ? subject : `${subject.slice(0, 69)}...`;
}
