import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ControllerConfig, JobState, RepositoryFileSnapshot, ValidationProjectionEntry } from "./types.js";
import type { GitRemoteIdentity } from "./types.js";
import { runCommand, requireCommandSuccess } from "./command.js";
import { ensurePrivateDir } from "./fs-atomic.js";
import { digestJson, newId, pathWithin, sha256 } from "./util.js";
import { configuredRemoteIdentity, inspectGitRemoteIdentity } from "./remote-identity.js";

const GIT_TIMEOUT_MS = 120_000;
const GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const ORACLE_MAX_BYTES = 64 * 1024 * 1024;
const PROJECTION_MAX_FILE_BYTES = 64 * 1024 * 1024;
const PROJECTION_MAX_BYTES = 512 * 1024 * 1024;
const PROJECTION_MAX_FILES = 100_000;
type DiffEntry = { path: string; changedLines: number; binary: boolean };
type BoundedDiff = { files: number; changedLines: number; paths: string[]; entries: DiffEntry[] };

export class GitClient {
  constructor(private readonly config: ControllerConfig) {}

  async preflight(): Promise<void> {
    requireCommandSuccess(await runCommand({
      command: "git", args: ["--version"], cwd: this.config.localPath, timeoutMs: 30_000, maxTailBytes: 16_384,
      stdoutByteLimit: 16_384, stderrByteLimit: 16_384, aggregateByteLimit: 32_768,
    }), "git preflight");
    const root = await this.text(this.config.localPath, ["rev-parse", "--show-toplevel"]);
    if (realpathSync(root) !== realpathSync(this.config.localPath)) {
      throw new Error(`config.localPath is not the Git root: ${root}`);
    }
    await this.verifiedRemoteIdentity();
  }

  async remoteIdentity(): Promise<GitRemoteIdentity | null> {
    return this.verifiedRemoteIdentity();
  }

  async fetchBase(): Promise<string> {
    const identity = await this.verifiedRemoteIdentity();
    const targetRef = `refs/remotes/${this.config.remote}/${this.config.baseRef}`;
    await this.success(this.config.localPath, identity
      ? ["fetch", "--prune", "--no-tags", identity.fetchUrl, `+refs/heads/${this.config.baseRef}:${targetRef}`]
      : ["fetch", "--prune", this.config.remote, this.config.baseRef], "git fetch base");
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

  async verifyIssueCommit(input: {
    jobId: string;
    planDigest: string;
    issueNumber: number;
    sha: string;
    candidateSha: string;
  }): Promise<boolean> {
    assertSha(input.sha);
    assertSha(input.candidateSha);
    const ancestor = await this.run(this.config.localPath, ["merge-base", "--is-ancestor", input.sha, input.candidateSha]);
    if (ancestor.exitCode === 1) return false;
    if (ancestor.exitCode !== 0) throw new Error(`cannot verify Issue commit ancestry: ${ancestor.stderrTail || ancestor.stdoutTail}`);
    const message = await this.textRaw(this.config.localPath, ["show", "-s", "--format=%B", input.sha]);
    return hasExactTrailers(message, [
      ["Herdr-Release-Id", input.jobId],
      ["Herdr-Issue", String(input.issueNumber)],
      ["Herdr-Plan-Digest", input.planDigest],
    ]);
  }

  async ensureWorktree(job: JobState): Promise<void> {
    await this.verifiedRemoteIdentity();
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

  async createValidationProjection(cwd: string, destination: string): Promise<{
    treeSha: string;
    manifestDigest: string;
    manifest: ValidationProjectionEntry[];
    fileCount: number;
    byteCount: number;
    changedPaths: string[];
  }> {
    const sourceRoot = realpathSync(cwd);
    const requestedTarget = resolve(destination);
    const targetParent = realpathSync(dirname(requestedTarget));
    const target = join(targetParent, basename(requestedTarget));
    if (existsSync(target) || pathWithin(sourceRoot, target) || pathWithin(target, sourceRoot)) {
      throw new Error("validation projection destination is unsafe");
    }
    if (!pathWithin(targetParent, target)) throw new Error("validation projection destination escapes its parent");
    const changedPaths = await this.changedPaths(sourceRoot);
    await this.assertNoUnignoredSpecialFiles(sourceRoot, new Set(changedPaths));
    const indexPath = join(targetParent, `${newId("validation-index")}.index`);
    const objectDirectory = join(targetParent, newId("validation-objects"));
    const commonDirectory = realpathSync(resolve(sourceRoot, await this.text(sourceRoot, ["rev-parse", "--git-common-dir"])));
    const sourceObjects = realpathSync(join(commonDirectory, "objects"));
    if (sourceObjects.includes(":")) throw new Error("validation projection source object path is unsupported");
    mkdirSync(objectDirectory, { mode: 0o700 });
    const indexEnvironment = {
      GIT_INDEX_FILE: indexPath,
      GIT_OBJECT_DIRECTORY: objectDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: sourceObjects,
      GIT_CONFIG_COUNT: "0",
    };
    mkdirSync(target, { mode: 0o700 });
    try {
      await this.indexSuccess(sourceRoot, indexEnvironment, ["read-tree", "HEAD"], "git prepare validation index");
      for (const path of changedPaths) {
        assertSafeRepoPath(path);
        const file = candidateFile(sourceRoot, path);
        if (file === null) {
          await this.indexSuccess(sourceRoot, indexEnvironment, ["update-index", "--remove", "--", path], "git remove deleted validation path");
          continue;
        }
        const object = (await this.indexText(sourceRoot, indexEnvironment, ["hash-object", "-w", "--no-filters", "--", path])).trim();
        if (!/^[a-f0-9]{40}$/u.test(object)) throw new Error("validation projection object identity is invalid");
        await this.indexSuccess(sourceRoot, indexEnvironment, [
          "update-index", "--add", "--cacheinfo", `${file.mode},${object},${path}`,
        ], "git update validation index");
      }
      const treeSha = (await this.indexText(sourceRoot, indexEnvironment, ["write-tree"])).trim();
      assertSha(treeSha);
      const raw = await this.indexText(sourceRoot, indexEnvironment, ["ls-files", "--stage", "-z"], 32 * 1024 * 1024);
      const entries = raw.split("\0").filter(Boolean);
      if (entries.length > PROJECTION_MAX_FILES) throw new Error("validation projection contains too many files");
      let byteCount = 0;
      const manifest: ValidationProjectionEntry[] = [];
      for (const entry of entries) {
        const match = entry.match(/^(100644|100755|120000) ([a-f0-9]{40}) 0\t([\s\S]+)$/u);
        if (!match) throw new Error("validation projection contains a symlink, submodule, or special entry");
        const mode = match[1]! as "100644" | "100755" | "120000";
        const object = match[2]!;
        const path = match[3]!;
        assertSafeRepoPath(path);
        const bytes = gitBytes(
          sourceRoot,
          ["cat-file", "blob", object],
          PROJECTION_MAX_FILE_BYTES,
          indexEnvironment,
          safeGitArguments(this.config),
        );
        byteCount += bytes.byteLength;
        if (byteCount > PROJECTION_MAX_BYTES) throw new Error("validation projection exceeds its byte bound");
        const output = resolve(target, path);
        if (!pathWithin(target, output)) throw new Error("validation projection path escapes its root");
        mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
        if (mode === "120000") {
          if (changedPaths.includes(path)) throw new Error(`validation candidate contains a changed symlink: ${path}`);
          const linkTarget = Buffer.from(bytes).toString("utf8");
          if (!linkTarget || Buffer.byteLength(linkTarget, "utf8") !== bytes.byteLength
            || linkTarget.startsWith("/") || /[\0\r\n]/u.test(linkTarget)
            || !pathWithin(target, resolve(dirname(output), linkTarget))) {
            throw new Error(`validation candidate contains an unsafe tracked symlink: ${path}`);
          }
          symlinkSync(linkTarget, output);
          manifest.push({ path, mode, byteCount: bytes.byteLength, sha256: `sha256:${sha256(bytes)}`, linkTarget });
          continue;
        }
        writeFileSync(output, bytes, { flag: "wx", mode: mode === "100755" ? 0o700 : 0o600 });
        const stat = lstatSync(output);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
          throw new Error("validation projection output is not a safe regular file");
        }
        manifest.push({ path, mode, byteCount: bytes.byteLength, sha256: `sha256:${sha256(bytes)}` });
      }
      return { treeSha, manifestDigest: digestJson(manifest), manifest, fileCount: entries.length, byteCount, changedPaths };
    } catch (error) {
      rmSync(target, { recursive: true, force: true });
      throw error;
    } finally {
      if (existsSync(indexPath)) unlinkSync(indexPath);
      rmSync(objectDirectory, { recursive: true, force: true });
    }
  }

  async verifyValidationProjection(
    destination: string,
    manifest: ValidationProjectionEntry[],
  ): Promise<void> {
    const root = realpathSync(destination);
    for (const expected of manifest) {
      assertSafeRepoPath(expected.path);
      const output = resolve(root, expected.path);
      if (expected.mode === "120000") {
        const stat = lstatSync(output);
        const linkTarget = readlinkSync(output);
        if (!stat.isSymbolicLink() || linkTarget !== expected.linkTarget
          || !pathWithin(root, resolve(dirname(output), linkTarget))
          || `sha256:${sha256(linkTarget)}` !== expected.sha256) {
          throw new Error(`validation candidate projection changed after materialization: ${expected.path}`);
        }
        continue;
      }
      let current = root;
      for (const segment of expected.path.split("/")) {
        current = join(current, segment);
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) throw new Error("validation candidate projection changed through a symlink");
      }
      const stat = lstatSync(current);
      const mode = (stat.mode & 0o111) === 0 ? "100644" : "100755";
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected.byteCount || mode !== expected.mode
        || `sha256:${sha256(readFileSync(current))}` !== expected.sha256) {
        throw new Error(`validation candidate projection changed after materialization: ${expected.path}`);
      }
    }
  }

  async fileAtRevision(revision: string, path: string): Promise<RepositoryFileSnapshot> {
    assertSha(revision);
    assertSafeRepoPath(path);
    const tree = await this.textRawBounded(this.config.localPath, ["ls-tree", "-z", revision, "--", path], 8_192);
    const match = tree.replace(/\0$/u, "").match(/^(100644|100755) blob [a-f0-9]+\t([^\u0000]+)$/u);
    if (!match || match[2] !== path) throw new Error("Oracle artifact is not a reviewed-base regular file");
    return fileBinding(gitBytes(
      this.config.localPath,
      ["show", `${revision}:${path}`],
      ORACLE_MAX_BYTES,
      { GIT_CONFIG_COUNT: "0" },
      safeGitArguments(this.config),
    ));
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
      await this.success(job.worktreePath, ["commit", "--no-verify", "--allow-empty", "-m", subject, "-m", body], "git commit no-op issue");
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
    await this.success(job.worktreePath, ["commit", "--no-verify", "-m", subject, "-m", body], "git commit issue");
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
    return hasExactTrailers(bodyLines.join("\n"), [
      ["Herdr-Release-Id", job.id],
      ["Herdr-Issue", String(issueNumber)],
      ["Herdr-Plan-Digest", job.planDigest],
    ]) ? sha : null;
  }

  async salvageHardeningCommitAtHead(job: JobState, round: number): Promise<string | null> {
    if (!(await this.isClean(job.worktreePath))) return null;
    const message = await this.textRaw(job.worktreePath, ["log", "-1", "--format=%H%n%B"]);
    const [sha, ...bodyLines] = message.split(/\r?\n/);
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) return null;
    return hasExactTrailers(bodyLines.join("\n"), [
      ["Herdr-Release-Id", job.id],
      ["Herdr-Hardening-Round", String(round)],
      ["Herdr-Plan-Digest", job.planDigest],
    ]) ? sha : null;
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
    await this.success(job.worktreePath, ["commit", "--no-verify", "-m", `fix: harden ${job.plan.title}`, "-m", body], "git commit hardening");
    return { sha: await this.head(job.worktreePath), created: true };
  }

  async diffStats(job: JobState): Promise<BoundedDiff & { summary: string }> {
    if (!job.baseSha) throw new Error("job base SHA is missing");
    const stats = await this.statsBetween(job.worktreePath, job.baseSha, "HEAD");
    const summary = await this.textRaw(job.worktreePath, ["diff", "--stat", `${job.baseSha}...HEAD`]);
    return { ...stats, summary };
  }

  async reportDiffStats(job: JobState): Promise<(BoundedDiff & { summary: string }) | null> {
    if (!job.baseSha) return null;
    const cwd = existsSync(job.worktreePath) ? job.worktreePath : this.config.localPath;
    const target = job.candidateSha ?? "HEAD";
    const stats = await this.statsBetween(cwd, job.baseSha, target);
    const summary = await this.textRawBounded(cwd, [
      "diff", "--stat", "--no-renames", `${job.baseSha}...${target}`, "--",
    ], GIT_OUTPUT_BYTES);
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
    const identity = await this.verifiedRemoteIdentity();
    await this.success(job.worktreePath, identity
      ? ["push", "--no-verify", identity.pushUrl, `HEAD:refs/heads/${job.branch}`]
      : ["push", "--no-verify", "--set-upstream", job.remote, job.branch], "git push release branch", 15 * 60_000);
  }

  async quarantineRemoteBranch(job: JobState, candidateSha: string): Promise<void> {
    assertSha(candidateSha);
    const identity = await this.verifiedRemoteIdentity();
    if (!identity) throw new Error("production branch quarantine requires an exact remote identity");
    const ref = `refs/heads/${job.branch}`;
    const read = async () => (await this.textRawBounded(this.config.localPath, ["ls-remote", "--heads", identity.pushUrl, ref], 16 * 1024)).trim();
    const before = await read();
    if (!before) return;
    const [sha, observedRef, ...extra] = before.split(/\s+/u);
    if (extra.length > 0 || sha !== candidateSha || observedRef !== ref) {
      throw new Error("remote quarantine branch identity mismatch");
    }
    await this.success(this.config.localPath, [
      "push", "--no-verify", `--force-with-lease=${ref}:${candidateSha}`, identity.pushUrl, `:${ref}`,
    ], "git quarantine exact release branch", 15 * 60_000);
    if (await read()) throw new Error("remote release branch quarantine was not read back");
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

  private async indexText(
    cwd: string,
    environment: Record<string, string>,
    args: string[],
    maximumBytes = GIT_OUTPUT_BYTES,
  ): Promise<string> {
    const result = await runCommand({
      command: "git",
      args: [...safeGitArguments(this.config), "-C", cwd, ...args],
      cwd,
      env: environment,
      timeoutMs: GIT_TIMEOUT_MS,
      maxTailBytes: maximumBytes,
      stdoutByteLimit: maximumBytes,
      stderrByteLimit: GIT_OUTPUT_BYTES,
      aggregateByteLimit: maximumBytes + GIT_OUTPUT_BYTES,
    });
    requireCommandSuccess(result, `git ${args[0] ?? "command"}`);
    if (result.stdoutBytes >= maximumBytes) throw new Error(`git ${args[0] ?? "command"} output reached its byte bound`);
    return result.stdoutTail;
  }

  private async indexSuccess(cwd: string, environment: Record<string, string>, args: string[], label: string): Promise<void> {
    const result = await runCommand({
      command: "git",
      args: [...safeGitArguments(this.config), "-C", cwd, ...args],
      cwd,
      env: environment,
      timeoutMs: GIT_TIMEOUT_MS,
      maxTailBytes: GIT_OUTPUT_BYTES,
      stdoutByteLimit: GIT_OUTPUT_BYTES,
      stderrByteLimit: GIT_OUTPUT_BYTES,
      aggregateByteLimit: GIT_OUTPUT_BYTES,
    });
    requireCommandSuccess(result, label);
  }

  private async assertNoUnignoredSpecialFiles(cwd: string, changedPaths: Set<string>): Promise<void> {
    const pending = [cwd];
    let visited = 0;
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        const path = relative(cwd, absolute).split("\\").join("/");
        if (path === ".git" || path.startsWith(".git/")) continue;
        visited += 1;
        if (visited > 200_000) throw new Error("validation candidate filesystem scan exceeds its entry bound");
        if (entry.isDirectory()) {
          if (!(await this.isIgnored(cwd, path))) pending.push(absolute);
          continue;
        }
        if (entry.isFile()) continue;
        if (entry.isSymbolicLink() && !changedPaths.has(path) && await this.isTracked(cwd, path)) continue;
        if (!(await this.isIgnored(cwd, path))) {
          throw new Error(`validation candidate contains an unignored symlink, device, FIFO, or socket: ${path}`);
        }
      }
    }
  }

  private async isTracked(cwd: string, path: string): Promise<boolean> {
    const result = await this.run(cwd, ["ls-files", "--error-unmatch", "--", path], 8_192);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(`cannot classify tracked validation path: ${result.stderrTail || result.stdoutTail}`);
  }

  private async isIgnored(cwd: string, path: string): Promise<boolean> {
    const result = await this.run(cwd, ["check-ignore", "--quiet", "--", path], 8_192);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(`cannot classify ignored validation path: ${result.stderrTail || result.stdoutTail}`);
  }

  private run(cwd: string, args: string[], maxTailBytes = GIT_OUTPUT_BYTES, timeoutMs = GIT_TIMEOUT_MS) {
    const remoteIdentity = this.config.remoteIdentity ? configuredRemoteIdentity(this.config) : null;
    return runCommand({
      command: "git",
      args: [...safeGitArguments(this.config), "-C", cwd, ...args],
      cwd,
      env: {
        GIT_CONFIG_COUNT: "0",
        GIT_EXTERNAL_DIFF: undefined,
        GIT_TERMINAL_PROMPT: "0",
        ...(remoteIdentity?.fetchTransport === "ssh" || remoteIdentity?.pushTransport === "ssh"
          ? { GIT_SSH_COMMAND: "/usr/bin/ssh -F /dev/null -o ClearAllForwardings=yes -o PermitLocalCommand=no -o ProxyCommand=none -o CanonicalizeHostname=no" }
          : {}),
      },
      timeoutMs,
      maxTailBytes,
      stdoutByteLimit: maxTailBytes,
      stderrByteLimit: maxTailBytes,
      aggregateByteLimit: Math.min(Number.MAX_SAFE_INTEGER, maxTailBytes * 2),
    });
  }

  protected async verifiedRemoteIdentity(): Promise<GitRemoteIdentity | null> {
    return this.config.executionMode === "release-plan-v2-direct" && this.config.remoteIdentity
      ? inspectGitRemoteIdentity(this.config)
      : null;
  }
}

function safeGitArguments(config: ControllerConfig): string[] {
  return [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "credential.interactive=never",
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "protocol.ssh.allow=always",
    "-c", `protocol.file.allow=${config.executionMode === "release-plan-v2-direct" ? "never" : "always"}`,
    "-c", "protocol.ext.allow=never",
  ];
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

function gitBytes(
  cwd: string,
  args: string[],
  maximumBytes = ORACLE_MAX_BYTES,
  environment: Record<string, string> = {},
  prefix: string[] = [],
): Uint8Array {
  const run = spawnSync("git", [...prefix, "-C", cwd, ...args], {
    encoding: null,
    maxBuffer: maximumBytes + 1,
    env: { ...process.env, GIT_CONFIG_COUNT: "0", GIT_EXTERNAL_DIFF: undefined, ...environment },
  });
  if (run.error || run.signal || run.status !== 0 || !(run.stdout instanceof Uint8Array)) {
    throw new Error("cannot read Oracle artifact bytes from Git");
  }
  return run.stdout;
}

function candidateFile(root: string, path: string): { mode: "100644" | "100755" } | null {
  let current = root;
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    if (!existsSync(current)) return null;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`validation candidate contains a changed symlink: ${path}`);
    if (index < segments.length - 1) {
      if (!stat.isDirectory()) throw new Error(`validation candidate path has a non-directory parent: ${path}`);
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`validation candidate contains a hardlink, device, FIFO, or socket: ${path}`);
    }
    return { mode: (stat.mode & 0o111) === 0 ? "100644" : "100755" };
  }
  return null;
}

function normalizeSubject(value: string, fallback: string): string {
  const firstLine = value.replace(/[\r\n]+/g, " ").trim();
  const subject = firstLine || fallback;
  return subject.length <= 72 ? subject : `${subject.slice(0, 69)}...`;
}

function hasExactTrailers(message: string, trailers: Array<[string, string]>): boolean {
  const lines = message.split(/\r?\n/);
  return trailers.every(([name, value]) => {
    const prefix = `${name}: `;
    return lines.filter((line) => line.startsWith(prefix)).length === 1 && lines.includes(`${prefix}${value}`);
  });
}
