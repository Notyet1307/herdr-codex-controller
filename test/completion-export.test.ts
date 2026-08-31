import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { exportReleaseCompletion } from "../src/completion-export.js";
import { ReleaseController } from "../src/controller.js";
import { GitClient } from "../src/git.js";
import { readControllerIdentity } from "../src/provenance.js";
import { JobStore } from "../src/state.js";
import { Validator } from "../src/validator.js";
import { digestJson } from "../src/util.js";
import {
  FakeCodex,
  FakeGitHub,
  TestGitClient,
  createTestRepo,
  git,
  testConfig,
  testPlan,
  testPlanV2,
  writeInputs,
} from "./support.js";

test("completion export CLI is public, restart-safe, and byte-idempotent", async () => {
  const fixture = await completedFixture();
  try {
    const publicRoot = join(fixture.repo.root, "public");
    mkdirSync(publicRoot, { mode: 0o700 });
    const output = join(publicRoot, "completion.json");
    const fakeBin = join(fixture.repo.root, "bin");
    mkdirSync(fakeBin, { mode: 0o700 });
    const gh = join(fakeBin, "gh");
    writeFileSync(gh, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(fixture.githubResponse()))});\n`, "utf8");
    chmodSync(gh, 0o700);
    git(fixture.repo.source, ["remote", "set-url", "origin", fixture.config.remoteIdentity!.fetchUrl]);
    const realGit = String(spawnSync("which", ["git"], { encoding: "utf8" }).stdout).trim();
    const fakeGit = join(fakeBin, "git");
    writeFileSync(fakeGit, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2).map((value) => value === ${JSON.stringify(fixture.config.remoteIdentity!.fetchUrl)}
  ? ${JSON.stringify(fixture.repo.remote)}
  : value === "protocol.file.allow=never" ? "protocol.file.allow=always" : value);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`, "utf8");
    chmodSync(fakeGit, 0o700);
    const cli = resolve("dist/src/cli.js");
    const first = spawnSync("node", [
      cli, "completion", "export", "--config", fixture.configPath,
      "--job", fixture.jobId, "--out", output, "--json",
    ], { cwd: resolve("."), env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` }, encoding: "utf8" });
    git(fixture.repo.source, ["remote", "set-url", "origin", fixture.repo.remote]);
    assert.equal(first.status, 0, first.stderr);
    const artifact = JSON.parse(first.stdout);
    const firstBytes = readFileSync(output);
    assert.equal(artifact.schema, "herdr-codex-controller:release-completion:v2");
    assert.equal(artifact.candidateSha, fixture.candidateSha);
    assert.equal(artifact.pullRequest.mergeSha, fixture.mergeSha);
    assert.equal(artifact.pullRequest.mergedAt, "2026-08-30T01:00:00.000Z");
    assert.equal(artifact.mergedMainSha, fixture.mergeSha);
    assert.notEqual(artifact.mergedMainSha, fixture.observedBaseSha);
    assert.deepEqual(artifact.requiredChecks, ["verify"]);
    assert.equal(statSync(output).mode & 0o777, 0o644);
    const rendered = firstBytes.toString("utf8");
    for (const privateValue of [
      fixture.repo.root,
      fixture.config.stateDir,
      fixture.completed.worktreePath,
      fixture.config.codex.bin,
      fixture.config.validation.sandbox!.bin,
      fixture.config.validation.sandbox!.root,
    ]) {
      assert.equal(rendered.includes(privateValue), false);
    }

    writeFileSync(join(fixture.repo.source, "later.txt"), "later main\n", "utf8");
    git(fixture.repo.source, ["add", "later.txt"]);
    git(fixture.repo.source, ["commit", "-m", "advance main after completion"]);
    git(fixture.repo.source, ["push", "origin", "main"]);
    const restarted = new JobStore(fixture.config);
    const second = await exportReleaseCompletion({
      store: restarted,
      git: new TestGitClient(fixture.config),
      github: fixture.github,
      jobId: fixture.jobId,
      outputPath: output,
    });
    assert.equal(second.digest, artifact.digest);
    assert.deepEqual(readFileSync(output), firstBytes);
  } finally { fixture.repo.cleanup(); }
});

test("locale-bound completion checkpoints fail closed after the canonical cutover", async () => {
  const fixture = await completedFixture();
  try {
    const job = fixture.store.load(fixture.jobId);
    const { digest: currentDigest, ...body } = job.completion!;
    const legacyDigest = legacyLocaleDigest(body);
    assert.notEqual(legacyDigest, currentDigest);
    job.completion!.digest = legacyDigest;
    writeFileSync(fixture.store.path(fixture.jobId), `${JSON.stringify(job, null, 2)}\n`, "utf8");
    assert.throws(() => fixture.store.load(fixture.jobId), /job completion evidence is invalid/);
    const output = join(fixture.repo.root, "legacy-completion.json");
    await assert.rejects(exportReleaseCompletion({
      store: fixture.store,
      git: new TestGitClient(fixture.config),
      github: fixture.github,
      jobId: fixture.jobId,
      outputPath: output,
    }), /job completion evidence is invalid/);
    assert.equal(existsSync(output), false);
  } finally { fixture.repo.cleanup(); }
});

test("completion export rejects incomplete, drifted, private, and forged evidence", async () => {
  const fixture = await completedFixture();
  try {
    const publicRoot = join(fixture.repo.root, "public");
    mkdirSync(publicRoot, { mode: 0o700 });
    const run = (outputPath: string, store = fixture.store) => exportReleaseCompletion({
      store,
      git: new TestGitClient(fixture.config),
      github: fixture.github,
      jobId: fixture.jobId,
      outputPath,
    });

    fixture.github.pr.headSha = "f".repeat(40);
    await rejectsCode(run(join(publicRoot, "wrong-head.json")), "completion_export_pr_identity_invalid");
    fixture.github.pr.headSha = fixture.candidateSha;

    const mergedAt = fixture.github.mergedAt;
    fixture.github.mergedAt = null;
    await rejectsCode(run(join(publicRoot, "unmerged.json")), "completion_export_pr_identity_invalid");
    fixture.github.mergedAt = mergedAt;
    for (const [name, value] of ([
      ["different-time", "2026-08-30T01:00:01Z"],
      ["missing-zone", "2026-08-30T01:00:00"],
      ["invalid-date", "2026-02-30T00:00:00Z"],
      ["invalid-time", "not-a-time"],
    ] as const)) {
      fixture.github.mergedAt = value;
      await rejectsCode(run(join(publicRoot, `${name}.json`)), "completion_export_pr_identity_invalid");
    }
    fixture.github.mergedAt = mergedAt;

    const mergeSha = fixture.github.mergeSha;
    fixture.github.mergeSha = "e".repeat(40);
    await rejectsCode(run(join(publicRoot, "wrong-merge.json")), "completion_export_pr_identity_invalid");
    fixture.github.mergeSha = mergeSha;

    fixture.github.checks = { state: "pending", missing: ["verify"], failures: [], pending: [] };
    await rejectsCode(run(join(publicRoot, "missing-check.json")), "completion_export_required_checks_unverified");
    fixture.github.checks = { state: "pending", missing: [], failures: [], pending: [{ name: "verify", state: "IN_PROGRESS", link: null }] };
    await rejectsCode(run(join(publicRoot, "pending-check.json")), "completion_export_required_checks_unverified");
    fixture.github.checks = { state: "failure", missing: [], failures: [{ name: "verify", state: "FAILURE", link: null }], pending: [] };
    await rejectsCode(run(join(publicRoot, "failed-check.json")), "completion_export_required_checks_unverified");
    fixture.github.checks = { state: "success", missing: [], failures: [], pending: [] };

    const identity = readControllerIdentity();
    const changedBody = { ...identity, sourceRevision: identity.sourceRevision === "f".repeat(40) ? "e".repeat(40) : "f".repeat(40) };
    const { digest: _digest, ...changedIdentity } = changedBody;
    const driftStore = new JobStore(fixture.config, () => ({ ...changedIdentity, digest: digestJson(changedIdentity) }));
    await rejectsCode(run(join(publicRoot, "provenance.json"), driftStore), "completion_export_provenance_drift");

    const job = fixture.store.load(fixture.jobId);
    const release = [...job.validations].reverse().find(({ scope }) => scope === "release")!;
    const receiptBytes = readFileSync(release.path);
    writeFileSync(release.path, "{}\n", "utf8");
    await rejectsCode(run(join(publicRoot, "receipt.json")), "completion_export_release_validation_missing");
    writeFileSync(release.path, receiptBytes);

    const reviewBytes = readFileSync(job.lastReviewPath!);
    writeFileSync(job.lastReviewPath!, JSON.stringify({ status: "changes", summary: "changed", findings: [] }), "utf8");
    await rejectsCode(run(join(publicRoot, "review.json")), "completion_export_review_missing");
    writeFileSync(job.lastReviewPath!, reviewBytes);

    await rejectsCode(run(join(fixture.config.stateDir, "private.json")), "completion_export_output_private_path");
    const conflict = join(publicRoot, "conflict.json");
    writeFileSync(conflict, "different\n", { mode: 0o644 });
    await rejectsCode(run(conflict), "completion_export_output_conflict");

    const compatibility = testConfig(fixture.repo);
    const plan = testPlan([2]);
    const input = writeInputs(fixture.repo, compatibility, plan);
    const legacyStore = new JobStore(compatibility);
    const legacy = legacyStore.create({
      ...input,
      plan,
      configDigest: digestJson(compatibility),
      planDigest: digestJson(plan),
    });
    legacy.baseSha = git(fixture.repo.source, ["rev-parse", "origin/main"]);
    legacy.candidateSha = legacy.baseSha;
    legacy.phase = "complete";
    legacy.status = "completed";
    legacyStore.save(legacy);
    await rejectsCode(exportReleaseCompletion({
      store: legacyStore,
      git: new TestGitClient(compatibility),
      github: new FakeGitHub(),
      jobId: legacy.id,
      outputPath: join(publicRoot, "local-only.json"),
    }), "completion_export_not_completed");

    const forged = fixture.store.load(fixture.jobId);
    const forgedSha = forged.baseSha!;
    forged.issues[0]!.commitSha = forgedSha;
    forged.completion!.issueCommits = [{ issueNumber: 1, sha: forgedSha }];
    const { digest: _completionDigest, ...completionBody } = forged.completion!;
    forged.completion!.digest = digestJson(completionBody);
    fixture.store.save(forged);
    await rejectsCode(run(join(publicRoot, "forged-issue-commit.json")), "completion_export_issue_commit_invalid");
  } finally { fixture.repo.cleanup(); }
});

async function completedFixture() {
  const repo = createTestRepo();
  const config = testConfig(repo, {
    executionMode: "release-plan-v2-direct",
    validation: {
      setup: [],
      issue: [{ command: "test -f issue-$HERDR_ISSUE_NUMBER.txt" }],
      release: [{ command: "test -f issue-1.txt" }],
      maxOutputBytes: 64 * 1024,
    },
    delivery: {
      createPullRequest: true,
      draft: false,
      autoMerge: false,
      mergeMethod: "merge",
      allowNoChecks: false,
      requiredChecks: ["verify"],
      pollIntervalMs: 1_000,
    },
  } as any);
  const plan = testPlanV2(repo, [1]);
  const { configPath, planPath } = writeInputs(repo, config, plan);
  const store = new JobStore(config);
  const gitClient = new TestGitClient(config);
  class CompletionGitHub extends FakeGitHub {
    pr: any = null;
    mergeSha: string | null = null;
    mergedAt: string | null = null;
    checks: any = { state: "success", missing: [], failures: [], pending: [] };
    override async createPullRequest(job: any) {
      this.pr = { number: 41, url: "https://github.com/example/project/pull/41", state: "OPEN", headRef: job.branch, baseRef: job.baseRef, headSha: job.candidateSha, mergeSha: null };
      return this.pr;
    }
    override async inspectPullRequest() {
      return { pullRequest: { ...this.pr, state: this.mergedAt ? "MERGED" as const : "OPEN" as const, mergeSha: this.mergeSha }, checks: this.checks, mergedAt: this.mergedAt };
    }
    githubResponse() {
      return {
        number: this.pr.number,
        url: this.pr.url,
        state: "MERGED",
        headRefName: this.pr.headRef,
        baseRefName: this.pr.baseRef,
        headRefOid: this.pr.headSha,
        mergedAt: this.mergedAt,
        mergeCommit: { oid: this.mergeSha },
        statusCheckRollup: [{ name: "verify", status: "COMPLETED", conclusion: "SUCCESS" }],
      };
    }
  }
  const github = new CompletionGitHub();
  const controller = new ReleaseController({ store, git: gitClient, github, codex: new FakeCodex(gitClient), validator: new Validator(config) });
  const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
  let job = store.load(created.id);
  for (let index = 0; index < 100 && job.status !== "ready_to_merge"; index += 1) {
    await controller.step(job.id);
    job = store.load(job.id);
    if (job.status === "blocked") throw new Error(job.blocked?.message);
  }
  const candidateSha = job.candidateSha!;
  git(repo.source, ["merge", "--no-ff", candidateSha, "-m", "merge completion candidate"]);
  git(repo.source, ["push", "origin", "main"]);
  github.mergeSha = git(repo.source, ["rev-parse", "HEAD"]);
  github.mergedAt = "2026-08-30T01:00:00Z";
  writeFileSync(join(repo.source, "after-merge.txt"), "advance main before completion observation\n", "utf8");
  git(repo.source, ["add", "after-merge.txt"]);
  git(repo.source, ["commit", "-m", "advance main before completion observation"]);
  git(repo.source, ["push", "origin", "main"]);
  const observedBaseSha = git(repo.source, ["rev-parse", "HEAD"]);
  const result = await controller.step(job.id);
  if (result.action !== "release_merged") throw new Error(result.message);
  const completed = store.load(job.id);
  if (!completed.completion) throw new Error("completion checkpoint is missing");
  return {
    repo,
    config,
    configPath,
    store,
    github,
    jobId: job.id,
    completed,
    candidateSha,
    mergeSha: github.mergeSha,
    observedBaseSha,
    githubResponse: () => github.githubResponse(),
  };
}

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: any) => error?.code === code);
}

function legacyLocaleDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .sort(([left], [right]) => {
        const foldedLeft = left.toLowerCase();
        const foldedRight = right.toLowerCase();
        return foldedLeft < foldedRight ? -1 : foldedLeft > foldedRight ? 1 : left < right ? -1 : left > right ? 1 : 0;
      })
      .map(([key, child]) => [key, canonical(child)]));
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
