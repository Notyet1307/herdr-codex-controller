import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { digestJson, pathWithin, sha256 } from "../src/util.js";
import { blockJob, JobStore } from "../src/state.js";
import { ReleaseController } from "../src/controller.js";
import { GitClient } from "../src/git.js";
import { Validator } from "../src/validator.js";
import { createTestRepo, FakeCodex, FakeGitHub, testConfig, testPlan, testPlanV2, writeInputs } from "./support.js";

test("CLI starts and completes a local no-PR release with fake gh and Codex executables", () => {
  const repo = createTestRepo();
  const bin = join(repo.root, "bin");
  mkdirSync(bin, { mode: 0o700 });
  try {
    const fakeGh = join(bin, "gh");
    writeFileSync(fakeGh, `#!/usr/bin/env node\nconst a=process.argv.slice(2);\nif(a[0]==='auth'&&a[1]==='status') process.exit(0);\nif(a[0]==='repo'&&a[1]==='view'){console.log(JSON.stringify({nameWithOwner:'example/project'}));process.exit(0)}\nif(a[0]==='issue'&&a[1]==='view'){const n=Number(a[2]);console.log(JSON.stringify({number:n,title:'Issue '+n,body:'Create issue-'+n+'.txt.',state:'OPEN',labels:[{name:'ready'}],assignees:[],url:'https://github.com/example/project/issues/'+n}));process.exit(0)}\nconsole.error('unsupported gh '+a.join(' '));process.exit(2);\n`, "utf8");
    chmodSync(fakeGh, 0o700);
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/usr/bin/env node\nimport fs from 'node:fs';import path from 'node:path';\nconst a=process.argv.slice(2);\nif(a[0]==='--version'){console.log('codex-test');process.exit(0)}\nif(a[0]==='login'&&a[1]==='status'){console.log('logged in');process.exit(0)}\nlet prompt='';for await(const c of process.stdin)prompt+=c;\nconst out=a[a.indexOf('--output-last-message')+1];const review=a.includes('read-only');\nif(!review){const m=prompt.match(/Issue #(\\d+)/);if(m)fs.writeFileSync(path.join(process.cwd(),'issue-'+m[1]+'.txt'),'implemented\\n')}\nconst result=review?{status:'pass',summary:'pass',findings:[]}:{status:'completed',summary:'done',selfReview:{performed:true,findingsFixed:[],remainingConcerns:[]},testsRun:[],residualRisks:[],blockedReason:null,blockedKind:null};\nfs.writeFileSync(out,JSON.stringify(result));console.log(JSON.stringify({type:'turn.completed'}));\n`, "utf8");
    chmodSync(fakeCodex, 0o700);
    const config = testConfig(repo, { codex: { ...testConfig(repo).codex, bin: fakeCodex } } as any);
    const plan = testPlan([1, 2]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
    const cli = resolve("dist/src/cli.js");
    const start = spawnSync("node", [cli, "start", "--config", configPath, "--plan", planPath, "--json"], { cwd: resolve("."), env, encoding: "utf8" });
    assert.equal(start.status, 0, start.stderr);
    const jobId = JSON.parse(String(start.stdout)).id as string;
    const run = spawnSync("node", [cli, "run", "--config", configPath, "--job", jobId, "--max-steps", "100", "--json"], { cwd: resolve("."), env, encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    const status = spawnSync("node", [cli, "status", "--config", configPath, "--job", jobId, "--json"], { cwd: resolve("."), env, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    const job = JSON.parse(String(status.stdout));
    assert.equal(job.status, "completed");
    assert.deepEqual(job.issues.map((issue: any) => issue.status), ["committed", "committed"]);
  } finally { repo.cleanup(); }
});

test("CLI enforces one active release per repository state root", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const configPath = join(repo.root, "config-single-writer.json");
    const firstPlanPath = join(repo.root, "plan-first.json");
    const secondPlanPath = join(repo.root, "plan-second.json");
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    writeFileSync(firstPlanPath, `${JSON.stringify({ ...testPlan([1]), id: "release-first" }, null, 2)}\n`, "utf8");
    writeFileSync(secondPlanPath, `${JSON.stringify({ ...testPlan([2]), id: "release-second" }, null, 2)}\n`, "utf8");
    const cli = resolve("dist/src/cli.js");

    const first = spawnSync("node", [cli, "start", "--config", configPath, "--plan", firstPlanPath, "--json"], {
      cwd: resolve("."), encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr);

    const second = spawnSync("node", [cli, "start", "--config", configPath, "--plan", secondPlanPath, "--json"], {
      cwd: resolve("."), encoding: "utf8",
    });
    assert.notEqual(second.status, 0);
    assert.match(String(second.stderr), /active release job/);
  } finally { repo.cleanup(); }
});

test("CLI plan validate accepts v2 and rejects config source mismatches", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlanV2(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const cli = resolve("dist/src/cli.js");
    const valid = spawnSync("node", [cli, "plan", "validate", "--config", configPath, "--plan", planPath, "--json"], {
      cwd: resolve("."), encoding: "utf8",
    });
    assert.equal(valid.status, 0, valid.stderr);
    const output = JSON.parse(String(valid.stdout));
    assert.equal(output.ok, true);
    assert.equal(output.plan.version, 2);
    assert.match(output.planDigest, /^[a-f0-9]{64}$/);

    writeFileSync(planPath, `${JSON.stringify({ ...plan, source: { ...plan.source, repo: "other/project" } })}\n`, "utf8");
    const repoMismatch = spawnSync("node", [cli, "plan", "validate", "--config", configPath, "--plan", planPath], {
      cwd: resolve("."), encoding: "utf8",
    });
    assert.notEqual(repoMismatch.status, 0);
    assert.match(String(repoMismatch.stderr), /plan_source_repo_mismatch/);

    writeFileSync(planPath, `${JSON.stringify({ ...plan, source: { ...plan.source, baseRef: "develop" } })}\n`, "utf8");
    const refMismatch = spawnSync("node", [cli, "plan", "validate", "--config", configPath, "--plan", planPath], {
      cwd: resolve("."), encoding: "utf8",
    });
    assert.notEqual(refMismatch.status, 0);
    assert.match(String(refMismatch.stderr), /plan_source_base_ref_mismatch/);
  } finally { repo.cleanup(); }
});

test("CLI v2 start requires the exact approved config digest before Job creation", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlanV2(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const cli = resolve("dist/src/cli.js");
    const baseArgs = [cli, "start", "--config", configPath, "--plan", planPath, "--json"];
    const jobPath = join(config.stateDir, "jobs", plan.id, "job.json");

    const missing = spawnSync("node", baseArgs, { cwd: resolve("."), encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    assert.match(String(missing.stderr), /expected_config_digest_required/);
    assert.equal(existsSync(jobPath), false);

    const wrong = spawnSync("node", [...baseArgs, "--expected-config-digest", "0".repeat(64)], {
      cwd: resolve("."), encoding: "utf8",
    });
    assert.notEqual(wrong.status, 0);
    assert.match(String(wrong.stderr), /expected_config_digest_mismatch/);
    assert.equal(existsSync(jobPath), false);

    for (const invalidDigest of [`sha256:${"0".repeat(64)}`, "A".repeat(64), ""]) {
      const invalid = spawnSync("node", [...baseArgs, "--expected-config-digest", invalidDigest], {
        cwd: resolve("."), encoding: "utf8",
      });
      assert.notEqual(invalid.status, 0);
      assert.match(String(invalid.stderr), /expected_config_digest_invalid/);
      assert.equal(existsSync(jobPath), false);
    }

    const approvedDigest = digestJson(config);
    const duplicate = spawnSync("node", [
      ...baseArgs,
      "--expected-config-digest", approvedDigest,
      "--expected-config-digest", approvedDigest,
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.notEqual(duplicate.status, 0);
    assert.match(String(duplicate.stderr), /expected_config_digest_invalid/);
    assert.equal(existsSync(jobPath), false);

    const exact = spawnSync("node", [...baseArgs, "--expected-config-digest", approvedDigest], {
      cwd: resolve("."), encoding: "utf8",
    });
    assert.equal(exact.status, 0, exact.stderr);
    const started = JSON.parse(String(exact.stdout));
    assert.equal(started.id, plan.id);
    const persisted = JSON.parse(readFileSync(jobPath, "utf8"));
    assert.equal(persisted.plan.version, 2);
    assert.equal(persisted.configDigest, approvedDigest);
    assert.equal(persisted.planDigest, digestJson(plan));
    assert.equal(persisted.baseSha, null);
  } finally { repo.cleanup(); }
});

test("CLI snapshots recovery evidence and the next failure stays fail closed", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: {
        ...testConfig(repo).validation,
        setup: [{ command: "test -f dependency-ready.txt" }],
      },
    } as any);
    const plan = testPlan([1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    let job = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });
    job = blockJob(job, "setup_validation_failed", "transient registry outage", join(store.root(job.id), "setup-01.json"));
    store.save(job);
    const evidence = Buffer.from("{\"dependency\":\"ready\",\"checkedAt\":\"2026-08-28T10:00:00Z\"}\n", "utf8");
    const evidencePath = join(repo.root, "dependency-recovery.json");
    writeFileSync(evidencePath, evidence);
    const cli = resolve("dist/src/cli.js");
    const retryArgs = [
      cli, "retry", "--config", configPath, "--job", job.id,
      "--reason", "Local dependency is now available.",
      "--evidence", evidencePath,
      "--json",
    ];

    const first = spawnSync("node", retryArgs, { cwd: resolve("."), encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    job = store.load(job.id);
    assert.equal(job.status, "running");
    assert.equal(job.phase, "prepare");
    assert.equal(job.retryAuthorizations.length, 1);
    const authorization = job.retryAuthorizations[0]!;
    assert.equal(authorization.previousBlockedCode, "setup_validation_failed");
    assert.equal(authorization.previousBlockedPhase, "prepare");
    assert.equal(authorization.previousDetailsPath, join(store.root(job.id), "setup-01.json"));
    assert.equal(authorization.operatorReason, "Local dependency is now available.");
    assert.equal(authorization.evidenceDigest, sha256(evidence));
    assert.equal(pathWithin(store.root(job.id), authorization.recoveryEvidencePath), true);
    assert.deepEqual(readFileSync(authorization.recoveryEvidencePath), evidence);

    const gitClient = new GitClient(config);
    const controller = new ReleaseController({
      store,
      git: gitClient,
      github: new FakeGitHub(),
      codex: new FakeCodex(gitClient),
      validator: new Validator(config),
    });
    const failedRecovery = await controller.step(job.id);
    assert.equal(failedRecovery.action, "blocked");
    assert.equal(store.load(job.id).blocked?.code, "setup_validation_failed");

    const second = spawnSync("node", retryArgs, { cwd: resolve("."), encoding: "utf8" });
    assert.notEqual(second.status, 0);
    assert.match(String(second.stderr), /retry_without_new_evidence/);
    assert.equal(store.load(job.id).status, "blocked");
    assert.equal(store.load(job.id).retryAuthorizations.length, 1);

    writeFileSync(authorization.recoveryEvidencePath, "tampered\n", "utf8");
    assert.throws(() => store.load(job.id), /Retry evidence digest mismatch/);
  } finally { repo.cleanup(); }
});

test("abort followed by a new Release Plan v2 Job is the only replan recovery path", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlanV2(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    let job = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });
    job.phase = "review";
    job = blockJob(job, "release_hardening_exhausted", "hardening budget exhausted", join(store.root(job.id), "review.json"));
    store.save(job);
    const cli = resolve("dist/src/cli.js");
    const evidencePath = join(repo.root, "must-not-be-read.json");

    const status = spawnSync("node", [cli, "status", "--config", configPath, "--job", job.id, "--operator", "--json"], {
      cwd: resolve("."), encoding: "utf8",
    });
    assert.equal(status.status, 0, status.stderr);
    assert.match(JSON.parse(String(status.stdout)).nextAction, /abort.*Release Plan v2.*new Job/i);

    const nextPlan = { ...testPlanV2(repo, [1]), id: "release-replanned-v2", title: "Replanned source-bound release" };
    const nextPlanPath = join(repo.root, "release-plan-v2-new.json");
    writeFileSync(nextPlanPath, `${JSON.stringify(nextPlan, null, 2)}\n`, "utf8");
    const startArgs = [
      cli, "start", "--config", configPath, "--plan", nextPlanPath,
      "--expected-config-digest", digestJson(config), "--json",
    ];
    const beforeAbort = spawnSync("node", startArgs, { cwd: resolve("."), encoding: "utf8" });
    assert.notEqual(beforeAbort.status, 0);
    assert.match(String(beforeAbort.stderr), /active release job/);

    const retry = spawnSync("node", [
      cli, "retry", "--config", configPath, "--job", job.id,
      "--reason", "No new plan; retry anyway.", "--evidence", evidencePath,
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.notEqual(retry.status, 0);
    assert.match(String(retry.stderr), /replan_required/);

    const abort = spawnSync("node", [
      cli, "abort", "--config", configPath, "--job", job.id,
      "--reason", "Return to Planner for a new Release Plan v2.", "--json",
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.equal(abort.status, 0, abort.stderr);
    assert.equal(store.load(job.id).status, "failed");

    const started = spawnSync("node", startArgs, { cwd: resolve("."), encoding: "utf8" });
    assert.equal(started.status, 0, started.stderr);
    const newJob = store.load(nextPlan.id);
    assert.equal(newJob.status, "running");
    assert.equal(newJob.plan.version, 2);
    assert.equal(newJob.planDigest, digestJson(nextPlan));
  } finally { repo.cleanup(); }
});
