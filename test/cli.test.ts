import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { digestJson } from "../src/util.js";
import { configInput, createTestRepo, git, testConfig, testPlan, writeInputs } from "./support.js";
import { blockJob, JobStore } from "../src/state.js";
import { publicStatus } from "../src/public-status.js";

test("CLI validates the semantic Plan and starts with one approved digest", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlan(repo, [1]);
    const env = installPreflightFakes(repo, config);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    writeFileSync(configPath, `${JSON.stringify(configInput(config), null, 2)}\n`, "utf8");
    const cli = resolve("dist/src/cli.js");
    const validated = spawnSync("node", [cli, "plan", "validate", "--config", configPath, "--plan", planPath, "--json"], { cwd: resolve("."), encoding: "utf8" });
    assert.equal(validated.status, 0, validated.stderr);
    const output = JSON.parse(String(validated.stdout));
    assert.equal(output.plan.controllerContractVersion, 1);
    assert.equal(output.planDigest, digestJson(plan));
    assert.equal("provenance" in output, false);

    const start = spawnSync("node", [cli, "start", "--config", configPath, "--plan", planPath, "--approve-plan", output.planDigest, "--json"], {
      cwd: resolve("."), env, encoding: "utf8",
    });
    assert.equal(start.status, 0, start.stderr);
    const job = JSON.parse(String(start.stdout));
    assert.equal(job.id, plan.id);
    assert.equal(job.planDigest, output.planDigest);
    assert.equal("provenance" in job, false);
  } finally { repo.cleanup(); }
});

test("CLI rejects invalid and legacy start approvals before Job creation", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const cli = resolve("dist/src/cli.js");
    const base = [cli, "start", "--config", configPath, "--plan", planPath];
    const cases = [
      { args: [], code: "approved_plan_digest_required" },
      { args: ["--approve-plan", "bad"], code: "approved_plan_digest_invalid" },
      { args: ["--approve-plan", "f".repeat(64)], code: "approved_plan_digest_mismatch" },
      { args: ["--approve-plan", digestJson(plan), "--approve-plan", digestJson(plan)], code: "approved_plan_digest_invalid" },
      { args: ["--approve-plan", digestJson(plan), "--expected-controller-revision", "a".repeat(40)], code: "unknown option" },
    ];
    for (const fixture of cases) {
      const result = spawnSync("node", [...base, ...fixture.args], { cwd: resolve("."), encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(String(result.stderr), new RegExp(fixture.code));
      assert.equal(existsSync(join(config.stateDir, "jobs", plan.id, "job.json")), false);
    }
  } finally { repo.cleanup(); }
});

test("CLI rejects unsupported contract majors and removed commands", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = { ...testPlan(repo, [1]), controllerContractVersion: 2 };
    const { configPath, planPath } = writeInputs(repo, config, plan as any);
    const cli = resolve("dist/src/cli.js");
    const invalid = spawnSync("node", [cli, "plan", "validate", "--config", configPath, "--plan", planPath], { cwd: resolve("."), encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    assert.match(String(invalid.stderr), /unsupported_controller_contract_version/);
    for (const command of [["completion", "export"], ["dispatch"]]) {
      const removed = spawnSync("node", [cli, ...command, "--config", configPath], { cwd: resolve("."), encoding: "utf8" });
      assert.notEqual(removed.status, 0);
      assert.match(String(removed.stderr), /unknown command/);
    }
  } finally { repo.cleanup(); }
});

test("public status is bounded, redacted, mode-exclusive, and legacy read-only", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    created.baseSha = plan.baseSha;
    store.save(created);
    const cli = resolve("dist/src/cli.js");
    const run = (...args: string[]) => spawnSync("node", [cli, ...args], { cwd: resolve("."), encoding: "utf8" });

    const running = run("status", "--config", configPath, "--job", created.id, "--public", "--json");
    assert.equal(running.status, 0, running.stderr);
    const runningStatus = JSON.parse(String(running.stdout));
    assert.deepEqual(Object.keys(runningStatus), [
      "id", "status", "phase", "repo", "planDigest", "baseSha", "currentIssueNumber", "issues",
      "candidateSha", "blocked", "result", "updatedAt", "legacy",
    ]);
    assert.equal(runningStatus.status, "running");
    assert.equal(runningStatus.legacy, false);
    assert.deepEqual(runningStatus.issues, [{ number: 1, status: "pending" }]);
    const defaultStatus = JSON.parse(String(run("status", "--config", configPath, "--job", created.id, "--json").stdout));
    const operator = JSON.parse(String(run("status", "--config", configPath, "--job", created.id, "--operator", "--json").stdout));
    assert.equal(defaultStatus.worktreePath, created.worktreePath);
    assert.equal(operator.activeRun, null);
    assert.match(operator.nextAction, /Run step or run/u);

    for (const [code, kind] of [
      ["development_setup_failed", "recoverable"],
      ["repair_scope_unattributed", "manual"],
      ["plan_base_drift", "replan_required"],
    ] as const) {
      const view = publicStatus(config, blockJob(structuredClone(created), code, "bounded message"));
      assert.equal(view.blocked?.code, code);
      assert.equal(view.blocked?.kind, kind);
    }

    const completed = structuredClone(created);
    completed.status = "completed";
    completed.phase = "complete";
    completed.candidateSha = "a".repeat(40);
    completed.result = {
      schema: "herdr-codex-controller:release-result:v1",
      releaseId: completed.id,
      planDigest: completed.planDigest,
      status: "merged",
      baseSha: plan.baseSha,
      candidateSha: completed.candidateSha,
      pullRequest: { number: 7, url: "https://github.com/example/project/pull/7" },
      requiredChecks: { names: ["verify"], status: "passed" },
      mergeSha: "b".repeat(40),
      completedAt: "2026-09-02T00:00:00.000Z",
    };
    assert.deepEqual(publicStatus(config, completed).result, {
      status: "merged",
      mergeSha: "b".repeat(40),
      completedAt: "2026-09-02T00:00:00.000Z",
    });

    let blocked = blockJob(
      created,
      "repair_scope_unattributed",
      `${config.stateDir}/private TOKEN=top-secret password=hunter2 detailsPath=/Users/example/private`,
      join(store.root(created.id), "private-details.json"),
    );
    store.save(blocked);
    const redacted = run("status", "--config", configPath, "--job", created.id, "--public", "--json");
    assert.equal(redacted.status, 0, redacted.stderr);
    const redactedText = String(redacted.stdout);
    assert.doesNotMatch(redactedText, /configPath|planPath|stateDir|worktreePath|promptPath|stderrPath|detailsPath|token|password|secret|\/Users\/|\/private\//iu);
    assert.equal(JSON.parse(redactedText).blocked.kind, "manual");

    blocked = store.load(created.id);
    blocked.blocked = { ...blocked.blocked!, code: "replan_required" };
    delete blocked.blocked.kind;
    writeFileSync(store.path(created.id), `${JSON.stringify(blocked, null, 2)}\n`, "utf8");
    const legacyBytes = readFileSync(store.path(created.id), "utf8");
    const legacy = run("status", "--config", configPath, "--job", created.id, "--public", "--json");
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.equal(readFileSync(store.path(created.id), "utf8"), legacyBytes);
    assert.equal(JSON.parse(String(legacy.stdout)).legacy, true);
    assert.equal(JSON.parse(String(legacy.stdout)).blocked.kind, "replan_required");
    const legacyRetry = run("retry", "--config", configPath, "--job", created.id, "--reason", "retry", "--evidence", planPath, "--json");
    assert.notEqual(legacyRetry.status, 0);
    assert.match(String(legacyRetry.stderr), /replan_required/u);
    assert.equal(readFileSync(store.path(created.id), "utf8"), legacyBytes);

    const conflict = run("status", "--config", configPath, "--job", created.id, "--public", "--operator", "--json");
    assert.notEqual(conflict.status, 0);
    assert.match(String(conflict.stderr), /status_mode_conflict/u);
    const missing = run("status", "--config", configPath, "--job", "not-started", "--public", "--json");
    assert.notEqual(missing.status, 0);
    assert.match(String(missing.stderr), /job_not_found/u);

    const corrupt = JSON.parse(legacyBytes);
    corrupt.id = "/Users/private/TOKEN=top-secret";
    writeFileSync(store.path(created.id), `${JSON.stringify(corrupt, null, 2)}\n`, "utf8");
    const rejected = run("status", "--config", configPath, "--job", created.id, "--public", "--json");
    assert.notEqual(rejected.status, 0);
    assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, /top-secret|\/Users\/private/iu);
    assert.match(String(rejected.stderr), /job state identity does not match/u);
  } finally { repo.cleanup(); }
});

function installPreflightFakes(repo: ReturnType<typeof createTestRepo>, config: ReturnType<typeof testConfig>) {
  const bin = join(repo.root, "preflight-bin");
  mkdirSync(bin, { mode: 0o700 });
  const codex = join(bin, "codex");
  writeFileSync(codex, `#!/usr/bin/env node
const a=process.argv.slice(2);
if(a[0]==="--version"){console.log("codex-test");process.exit(0)}
if(a[0]==="exec"&&a[1]==="--help"){console.log("--ignore-user-config --ignore-rules --output-schema --output-last-message");process.exit(0)}
if(a[0]==="login"&&a[1]==="status"){console.log("logged in");process.exit(0)}
process.exit(2);
`, "utf8");
  chmodSync(codex, 0o700);
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!/usr/bin/env node
const a=process.argv.slice(2);
if(a[0]==="auth"&&a[1]==="status")process.exit(0);
if(a[0]==="repo"&&a[1]==="view"){console.log(JSON.stringify({nameWithOwner:"example/project"}));process.exit(0)}
if(a[0]==="api"&&a[1]?.includes("/rules/branches/")){console.log(JSON.stringify([{type:"pull_request",parameters:{}},{type:"required_status_checks",parameters:{strict_required_status_checks_policy:true,required_status_checks:[{context:"verify",integration_id:15368}]}}]));process.exit(0)}
if(a[0]==="api"&&a[1]?.includes("/protection")){console.log("{}");process.exit(0)}
process.exit(2);
`, "utf8");
  chmodSync(gh, 0o700);
  config.codex.bin = codex;
  git(repo.source, ["remote", "set-url", "origin", config.remoteIdentity.fetchUrl]);
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
}
