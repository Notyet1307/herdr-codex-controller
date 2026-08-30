import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReleaseController } from "../src/controller.js";
import { GitClient } from "../src/git.js";
import { JobStore } from "../src/state.js";
import { Validator } from "../src/validator.js";
import type { JobState, OracleVerifierManifestV1, ValidationReceipt } from "../src/types.js";
import { digestJson, sha256, sha256PrefixedUtf8 } from "../src/util.js";
import {
  FakeCodex,
  FakeGitHub,
  completedWorker,
  createTestRepo,
  git,
  testConfig,
  testPlanV2,
  writeInputs,
} from "./support.js";

test("each Issue Oracle runs before commit and release validation runs every Oracle again", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    const plan = testPlanV2(repo, [1, 2]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new GitClient(config);
    const controller = new ReleaseController({
      store,
      git: gitClient,
      github: new FakeGitHub(),
      codex: new FakeCodex(gitClient),
      validator: new Validator(config),
    });
    const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    await stepUntil(controller, store, created.id, (result) => result.action === "release_validated");
    const job = store.load(created.id);

    for (const issue of job.issues) {
      const receipt = validationReceipt(job, issue.lastValidationId!);
      const binding = plan.issues.find(({ number }) => number === issue.number)!.oracleBindings[0]!;
      const result = receipt.commands.find(({ oracles }) => (
        oracles.some(({ issueNumber, oracleId }) => issueNumber === issue.number && oracleId === binding.id)
      ));
      if (!result) throw new Error(`Issue #${issue.number} Oracle result is missing`);
      assert.equal(receipt.version, 2);
      assert.equal(receipt.scope, "issue");
      assert.equal(receipt.issueNumber, issue.number);
      assert.equal(receipt.passed, true);
      assert.equal(receipt.candidateSha, await gitClient.commitParent(job, issue.commitSha!));
      assert.match(receipt.sourceWorktreeDigest, /^[a-f0-9]{64}$/);
      assert.equal(result.command, binding.execution.command);
      assert.equal(result.timeoutMs, issue.number === 1 ? 45_000 : 60_000);
      assert.equal(result.exitCode, 0);
      assert.equal(result.signal, null);
      assert.equal(result.timedOut, false);
      assert.equal(result.stdoutSha256, `sha256:${sha256(readFileSync(result.stdoutPath))}`);
      assert.equal(result.stderrSha256, `sha256:${sha256(readFileSync(result.stderrPath))}`);
      assert.ok(Number.isFinite(Date.parse(result.verifiedAt)));
    }

    const release = [...job.validations].reverse().find(({ scope }) => scope === "release")!;
    const releaseReceipt = validationReceipt(job, release.id);
    assert.equal(releaseReceipt.passed, true);
    assert.deepEqual(
      releaseReceipt.commands.flatMap(({ oracles }) => oracles.map(({ issueNumber, oracleId }) => `${issueNumber}:${oracleId}`)),
      ["1:O01", "2:O02"],
    );
  } finally { repo.cleanup(); }
});

test("Issue Oracle failure schedules repair and only PASS can commit", async () => {
  const repo = createTestRepo();
  try {
    const packagePath = join(repo.source, "package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    packageJson.scripts["verify:oracle:o01"] = "test -f oracle-ready";
    writeFileSync(packagePath, `${JSON.stringify(packageJson)}\n`, "utf8");
    git(repo.source, ["add", "package.json"]);
    git(repo.source, ["commit", "-m", "make Oracle repairable"]);
    git(repo.source, ["push", "origin", "main"]);

    const base = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    const config = testConfig(repo, {
      executionMode: "release-plan-v2-direct",
      validation: { ...base.validation, issue: [], release: [] },
    } as any);
    const fixturePlan = testPlanV2(repo, [1, 2]);
    fixturePlan.issues[0]!.oracleBindings.push(fixturePlan.issues[1]!.oracleBindings[0]!);
    fixturePlan.issues = [fixturePlan.issues[0]!];
    const plan = fixturePlan;
    const verifier = plan.issues[0]!.oracleBindings[0]!.verifier;
    verifier.packageScript.definitionSha256 = sha256PrefixedUtf8("test -f oracle-ready");
    redigest(verifier);
    plan.issues[0]!.expectedPaths = ["issue-1.txt", "oracle-ready"];
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new GitClient(config);
    const codex = new FakeCodex(gitClient, async ({ job, kind }) => {
      if (kind === "worker") writeFileSync(join(job.worktreePath, "issue-1.txt"), "first\n", "utf8");
      if (kind === "issue-repair") writeFileSync(join(job.worktreePath, "oracle-ready"), "ready\n", "utf8");
      return kind === "review"
        ? { review: { status: "pass", summary: "pass", findings: [] } }
        : { worker: completedWorker(kind, ["FIXTURE_BEHAVIOR"]) };
    });
    const controller = new ReleaseController({ store, git: gitClient, github: new FakeGitHub(), codex, validator: new Validator(config) });
    const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    await stepUntil(controller, store, created.id, () => store.load(created.id).issues[0]?.status === "committed");
    const job = store.load(created.id);
    const receipts = job.validations.filter(({ scope, issueNumber }) => scope === "issue" && issueNumber === 1)
      .map(({ id }) => validationReceipt(job, id));
    assert.deepEqual(receipts.map(({ passed }) => passed), [false, true]);
    assert.deepEqual(
      receipts[0]!.commands.flatMap(({ oracles }) => oracles.map(({ oracleId }) => oracleId)),
      ["O01", "O02"],
    );
    assert.equal(job.issues[0]?.repairRounds, 1);
    assert.ok(job.issues[0]?.commitSha);
    assert.equal(receipts[0]!.commands[0]!.exitCode, 1);
    assert.equal(receipts[1]!.candidateSha, await gitClient.commitParent(job, job.issues[0]!.commitSha!));
  } finally { repo.cleanup(); }
});

test("Issue Oracle de-duplicates ordinary validation and keeps the release timeout", async () => {
  const repo = createTestRepo();
  try {
    const base = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    const config = testConfig(repo, {
      executionMode: "release-plan-v2-direct",
      validation: {
        ...base.validation,
        issue: [{ command: "npm run verify:oracle:o01", timeoutMs: 1_000 }],
      },
    } as any);
    const plan = testPlanV2(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new GitClient(config);
    const controller = new ReleaseController({ store, git: gitClient, github: new FakeGitHub(), codex: new FakeCodex(gitClient), validator: new Validator(config) });
    const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    await stepUntil(controller, store, created.id, () => store.load(created.id).issues[0]?.status === "committed");
    const job = store.load(created.id);
    const receipt = validationReceipt(job, job.issues[0]!.lastValidationId!);
    const matching = receipt.commands.filter(({ command }) => command === "npm run verify:oracle:o01");
    assert.equal(matching.length, 1);
    assert.equal(matching[0]!.timeoutMs, 45_000);
    assert.deepEqual(matching[0]!.oracles, [{ issueNumber: 1, oracleId: "O01" }]);
  } finally { repo.cleanup(); }
});

test("missing Issue Oracle execution is durable REPLAN_REQUIRED before commit", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    const plan = testPlanV2(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const gitClient = new GitClient(config);
    class OmittingValidator extends Validator {
      override async run(input: Parameters<Validator["run"]>[0]) {
        const validation = await super.run(input);
        if (input.scope === "issue") {
          for (const command of validation.receipt.commands) command.oracles = [];
          const { digest: _digest, ...identity } = validation.receipt;
          validation.receipt.digest = digestJson(identity);
          writeFileSync(validation.path, `${JSON.stringify(validation.receipt, null, 2)}\n`, "utf8");
        }
        return validation;
      }
    }
    const controller = new ReleaseController({
      store,
      git: gitClient,
      github: new FakeGitHub(),
      codex: new FakeCodex(gitClient),
      validator: new OmittingValidator(config),
    });
    const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    assert.equal((await controller.step(created.id)).action, "release_prepared");
    assert.equal((await controller.step(created.id)).action, "worker_completed");
    assert.equal((await controller.step(created.id)).action, "blocked");
    const blocked = store.load(created.id);
    assert.equal(blocked.blocked?.code, "replan_required");
    assert.match(blocked.blocked?.message ?? "", /issue_oracle_validation_missing/);
    assert.equal(blocked.issues[0]?.commitSha, null);
    assert.equal(blocked.validations.filter(({ scope }) => scope === "issue").length, 1);
  } finally { repo.cleanup(); }
});

test("every Worker globally protects other Tickets' verifier files and package scripts", async () => {
  for (const target of ["scripts/lib/o02-helper.mjs", "package.json"]) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
      const plan = testPlanV2(repo, [1, 2]);
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const gitClient = new GitClient(config);
      const codex = new FakeCodex(gitClient, async ({ job, kind }) => {
        if (kind !== "worker") return {};
        writeFileSync(join(job.worktreePath, "issue-1.txt"), "candidate\n", "utf8");
        if (target === "package.json") {
          const value = JSON.parse(readFileSync(join(job.worktreePath, target), "utf8"));
          value.scripts["verify:oracle:o02"] = "exit 1";
          writeFileSync(join(job.worktreePath, target), `${JSON.stringify(value)}\n`, "utf8");
        } else writeFileSync(join(job.worktreePath, target), "export const oracleId = \"changed\";\n", "utf8");
        return { worker: completedWorker("changed verifier", ["FIXTURE_BEHAVIOR"]) };
      });
      const controller = new ReleaseController({ store, git: gitClient, github: new FakeGitHub(), codex, validator: new Validator(config) });
      const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
      assert.equal((await controller.step(created.id)).action, "release_prepared");
      assert.equal((await controller.step(created.id)).action, "blocked", target);
      const blocked = store.load(created.id);
      assert.equal(blocked.blocked?.code, "replan_required", target);
      assert.match(blocked.blocked?.message ?? "", /oracle_verifier_drift/, target);
      assert.equal(blocked.validations.filter(({ scope }) => scope === "issue").length, 0, target);
      assert.equal(blocked.issues[0]?.commitSha, null, target);
    } finally { repo.cleanup(); }
  }
});

test("verifier manifest byte drift and hardening drift are REPLAN_REQUIRED", async () => {
  for (const phase of ["prepare", "harden"] as const) {
    const repo = createTestRepo();
    try {
      const base = testConfig(repo, { executionMode: "release-plan-v2-direct" });
      const config = testConfig(repo, {
        executionMode: "release-plan-v2-direct",
        validation: { ...base.validation, release: [{ command: "test -f issue-1.txt" }] },
      } as any);
      const plan = testPlanV2(repo, [1]);
      if (phase === "prepare") {
        plan.issues[0]!.oracleBindings[0]!.verifier.files[0]!.sha256 = `sha256:${"0".repeat(64)}`;
        redigest(plan.issues[0]!.oracleBindings[0]!.verifier);
      }
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const gitClient = new GitClient(config);
      const codex = new FakeCodex(gitClient, async ({ job, kind }) => {
        if (kind === "review") {
          return { review: { status: "changes", summary: "harden", findings: [{ severity: "major", path: "issue-1.txt", line: 1, summary: "fix", rationale: "fixture", recommendation: "fix", relatedIssues: [1] }] } };
        }
        if (kind === "release-harden") {
          writeFileSync(join(job.worktreePath, "scripts/lib/o01-helper.mjs"), "export const oracleId = \"changed\";\n", "utf8");
          return { worker: completedWorker("changed verifier", ["FIXTURE_BEHAVIOR"]) };
        }
        return {};
      });
      const controller = new ReleaseController({ store, git: gitClient, github: new FakeGitHub(), codex, validator: new Validator(config) });
      const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
      const blocked = await settleBlocked(controller, store, created.id);
      assert.equal(blocked.blocked?.code, "replan_required", phase);
      assert.match(blocked.blocked?.message ?? "", /oracle_verifier_drift/, phase);
    } finally { repo.cleanup(); }
  }
});

test("crash salvage requires a passed Oracle receipt bound to the commit parent", async () => {
  for (const mode of ["missing-receipt", "valid", "verifier-drift"] as const) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
      const plan = testPlanV2(repo, [1]);
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const gitClient = new GitClient(config);
      const controller = new ReleaseController({ store, git: gitClient, github: new FakeGitHub(), codex: new FakeCodex(gitClient), validator: new Validator(config) });
      const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
      assert.equal((await controller.step(created.id)).action, "release_prepared");
      const job = store.load(created.id);
      job.phase = "issue_validate";
      job.currentIssueNumber = 1;
      job.issues[0]!.status = "running";
      writeFileSync(join(job.worktreePath, "issue-1.txt"), "candidate\n", "utf8");
      if (mode !== "missing-receipt") {
        await checkpointOracleReceipt(store, gitClient, config, job, plan.issues[0]!.oracleBindings[0]!.id);
      }
      else store.save(job);
      if (mode === "verifier-drift") {
        writeFileSync(join(job.worktreePath, "scripts/lib/o01-helper.mjs"), "export const oracleId = \"changed\";\n", "utf8");
      }
      await gitClient.commitIssue(job, 1, "Issue 1", false);

      const result = await controller.step(job.id);
      const observed = store.load(job.id);
      if (mode === "valid") {
        assert.equal(result.action, "issue_commit_salvaged");
        assert.equal(observed.issues[0]?.status, "committed");
      } else {
        assert.equal(result.action, "blocked");
        assert.equal(observed.blocked?.code, "replan_required");
        assert.match(
          observed.blocked?.message ?? "",
          mode === "missing-receipt" ? /issue_oracle_validation_missing/ : /oracle_verifier_drift/,
        );
      }
    } finally { repo.cleanup(); }
  }
});

async function checkpointOracleReceipt(
  store: JobStore,
  gitClient: GitClient,
  config: ReturnType<typeof testConfig>,
  job: JobState,
  oracleId: string,
): Promise<void> {
  const command = config.validation.release.find(({ command }) => command === "npm run verify:oracle:o01")!;
  const validation = await new Validator(config).run({
    job,
    scope: "issue",
    issueNumber: 1,
    commands: [{ ...command, oracles: [{ issueNumber: 1, oracleId }] }],
    validationsRoot: store.validationsRoot(job.id),
    sourceHeadSha: await gitClient.head(job.worktreePath),
    sourceWorktreeDigest: await gitClient.worktreeDigest(job.worktreePath),
  });
  job.validations.push({
    id: validation.receipt.id,
    scope: "issue",
    issueNumber: 1,
    path: validation.path,
    passed: validation.receipt.passed,
    digest: validation.receipt.digest,
  });
  job.issues[0]!.lastValidationId = validation.receipt.id;
  store.save(job);
}

function validationReceipt(job: JobState, id: string): ValidationReceipt {
  const binding = job.validations.find((entry) => entry.id === id);
  if (!binding) throw new Error(`missing validation ${id}`);
  return JSON.parse(readFileSync(binding.path, "utf8")) as ValidationReceipt;
}

function redigest(verifier: OracleVerifierManifestV1): void {
  const { digest: _digest, ...identity } = verifier;
  verifier.digest = `sha256:${digestJson(identity)}`;
}

async function stepUntil(
  controller: ReleaseController,
  store: JobStore,
  id: string,
  done: (result: Awaited<ReturnType<ReleaseController["step"]>>) => boolean,
): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    const result = await controller.step(id);
    if (done(result)) return;
    const job = store.load(id);
    if (job.status === "blocked") throw new Error(job.blocked?.message);
  }
  throw new Error("Controller did not reach the expected state");
}

async function settleBlocked(controller: ReleaseController, store: JobStore, id: string): Promise<JobState> {
  for (let index = 0; index < 30; index += 1) {
    await controller.step(id);
    const job = store.load(id);
    if (job.status === "blocked") return job;
  }
  throw new Error("Controller did not block");
}
