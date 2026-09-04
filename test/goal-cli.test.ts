import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { writeJsonAtomic } from "../src/fs-atomic.js";
import { digestJson } from "../src/util.js";
import { createTestRepo, testConfig, testPlan, writeInputs } from "./support.js";

test("Goal CLI starts only an exactly approved handoff and exposes read-only bounded status", (t: any) => {
  const repo = createTestRepo();
  t.after(() => repo.cleanup());
  const config = testConfig(repo);
  const plan = testPlan(repo, [1]);
  const { configPath, planPath } = writeInputs(repo, config, plan);
  const handoff = {
    schema: "pi-ticket-planning:goal-handoff:v1",
    releaseId: plan.id,
    repo: plan.repo,
    baseSha: plan.baseSha,
    planDigest: digestJson(plan),
    channel: "GOAL_LOCAL",
    runnerRef: "local",
    runnerDigest: `sha256:${digestJson({ ref: "local" })}`,
    runnerHost: hostname(),
    releasePlan: plan,
  };
  const handoffPath = join(repo.root, "goal-handoff.json");
  writeJsonAtomic(handoffPath, handoff);
  const goalCli = resolve("dist/src/goal-cli.js");
  const controllerCli = resolve("dist/src/cli.js");
  const runGoal = (...args: string[]) => spawnSync("node", [goalCli, ...args], { encoding: "utf8" });

  const wrong = runGoal("start", "--config", configPath, "--handoff", handoffPath, "--approve-handoff", `sha256:${"0".repeat(64)}`, "--runner-ref", "local", "--json");
  assert.notEqual(wrong.status, 0);
  assert.match(String(wrong.stderr), /approved_goal_handoff_mismatch/u);
  const approved = `sha256:${digestJson(handoff)}`;
  const started = runGoal("start", "--config", configPath, "--handoff", handoffPath, "--approve-handoff", approved, "--runner-ref", "local", "--json");
  assert.equal(started.status, 0, String(started.stderr));
  const startState = JSON.parse(String(started.stdout));
  assert.equal(startState.status, "running");
  assert.equal(startState.phase, "prepare");

  const status = runGoal("status", "--config", configPath, "--run-id", plan.id, "--json");
  assert.equal(status.status, 0, String(status.stderr));
  const publicState = JSON.parse(String(status.stdout));
  assert.equal(publicState.planDigest, digestJson(plan));
  assert.equal("worktreePath" in publicState, false);
  assert.equal("currentThreadId" in publicState, false);
  assert.equal(String(status.stdout).includes(repo.root), false);

  const controller = spawnSync("node", [controllerCli, "start", "--config", configPath, "--plan", planPath, "--approve-plan", digestJson(plan), "--json"], { encoding: "utf8" });
  assert.notEqual(controller.status, 0);
  assert.match(String(controller.stderr), /active Goal run/u);
});

test("GOAL_REMOTE accepts the exact handoff over stdin on the approved runner", (t: any) => {
  const repo = createTestRepo();
  t.after(() => repo.cleanup());
  const config = testConfig(repo);
  const plan = testPlan(repo, [1]);
  const { configPath } = writeInputs(repo, config, plan);
  const handoff = {
    schema: "pi-ticket-planning:goal-handoff:v1",
    releaseId: plan.id,
    repo: plan.repo,
    baseSha: plan.baseSha,
    planDigest: digestJson(plan),
    channel: "GOAL_REMOTE",
    runnerRef: "mac-mini",
    runnerDigest: `sha256:${digestJson({ ref: "mac-mini" })}`,
    runnerHost: hostname(),
    releasePlan: plan,
  };
  const wrongHost = { ...handoff, runnerHost: "definitely-not-this-host.invalid" };
  const rejected = spawnSync("node", [
    resolve("dist/src/goal-cli.js"), "start", "--config", configPath, "--handoff", "-",
    "--approve-handoff", `sha256:${digestJson(wrongHost)}`, "--runner-ref", "mac-mini", "--json",
  ], { encoding: "utf8", input: JSON.stringify(wrongHost) });
  assert.notEqual(rejected.status, 0);
  assert.match(String(rejected.stderr), /goal_runner_host_mismatch/u);
  const result = spawnSync("node", [
    resolve("dist/src/goal-cli.js"), "start", "--config", configPath, "--handoff", "-",
    "--approve-handoff", `sha256:${digestJson(handoff)}`, "--runner-ref", "mac-mini", "--json",
  ], { encoding: "utf8", input: JSON.stringify(handoff) });
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(JSON.parse(String(result.stdout)).channel, "GOAL_REMOTE");
});
