import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CodexRunner, validateReviewResult, validateWorkerResult } from "../src/codex.js";
import { GitClient } from "../src/git.js";
import { JobStore } from "../src/state.js";
import { digestJson } from "../src/util.js";
import { createTestRepo, TestGitClient, testConfig, testPlan, writeInputs } from "./support.js";
import { codexRuntimeControlArgs } from "../src/runtime-identity.js";

test("canonical review status is derived from blocking findings", () => {
  const finding = {
    severity: "minor",
    path: null,
    line: null,
    summary: "minor",
    rationale: "audit only",
    recommendation: "consider later",
    relatedIssues: [],
  };
  assert.doesNotThrow(() => validateReviewResult({ status: "pass", summary: "pass", findings: [finding] }));
  assert.throws(() => validateReviewResult({ status: "changes", summary: "wrong", findings: [] }), /changes.*blocking/iu);
  assert.throws(() => validateReviewResult({ status: "changes", summary: "wrong", findings: [finding] }), /changes.*blocking/iu);
  assert.throws(() => validateReviewResult({
    status: "pass",
    summary: "wrong",
    findings: [{ ...finding, severity: "major" }],
  }), /pass.*blocking/iu);
  assert.throws(() => validateReviewResult({ status: "pass", summary: "duplicate", findings: [finding, finding] }), /duplicate/iu);
});

test("fixed Codex config parses and excludes repository AGENTS from model input", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "herdr-codex-config-probe-"));
  try {
    const repo = createTestRepo();
    try {
      writeFileSync(join(repo.source, "AGENTS.md"), "HERDR_UNTRUSTED_AGENTS_SENTINEL\n", "utf8");
      const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
      const controls = codexRuntimeControlArgs(config, repo.source);
      const args: string[] = [];
      for (let index = 0; index < controls.length; index += 1) {
        if (controls[index] === "--config") args.push("-c", controls[++index]!);
      }
      args.push("debug", "prompt-input", "probe");
      const result = spawnSync(resolve("node_modules/.bin/codex"), args, {
        cwd: repo.source,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CODEX_HOME: codexHome },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(String(result.stdout).includes("HERDR_UNTRUSTED_AGENTS_SENTINEL"), false);
    } finally { repo.cleanup(); }
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("CodexRunner uses fresh structured non-interactive execution with least-privilege sandbox flags", async () => {
  const repo = createTestRepo();
  const originalArgsPath = process.env.FAKE_CODEX_ARGS_PATH;
  try {
    const fake = join(repo.root, "fake-codex.mjs");
    const argsPath = join(repo.root, "codex-args.json");
    process.env.FAKE_CODEX_ARGS_PATH = argsPath;
    writeFileSync(fake, `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nif(args[0]==='--version'){console.log('codex-test');process.exit(0)}\nif(args[0]==='exec'&&args[1]==='--help'){console.log('--ignore-user-config --ignore-rules --output-schema --output-last-message');process.exit(0)}\nif(args[0]==='login'&&args[1]==='status'){console.log('logged in');process.exit(0)}\nfs.writeFileSync(process.env.FAKE_CODEX_ARGS_PATH, JSON.stringify(args));\nlet input='';for await (const chunk of process.stdin) input+=chunk;\nconst output=args[args.indexOf('--output-last-message')+1];\nconst review=args.includes('read-only');\nconst result=review?{status:'pass',summary:'pass',findings:[]}:{status:'completed',summary:'done',selfReview:{performed:true,findingsFixed:[],remainingConcerns:[]},testsRun:[],residualRisks:[],observedRiskClasses:[],blockedReason:null,blockedKind:null};\nfs.writeFileSync(output, JSON.stringify(result));\nconsole.log(JSON.stringify({type:'turn.completed'}));\n`, "utf8");
    chmodSync(fake, 0o700);
    const config = testConfig(repo, { codex: { ...testConfig(repo).codex, bin: fake } } as any);
    const plan = testPlan([1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.baseSha = await new TestGitClient(config).fetchBase();
    job.worktreePath = repo.source;
    const runner = new CodexRunner(config, new TestGitClient(config));
    await runner.preflight();
    const execution = await runner.run({ job, kind: "worker", issueNumber: 1, prompt: "Implement the fixture.", runsRoot: store.runsRoot(job.id) });
    assert.equal(execution.workerResult?.status, "completed");
    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    assert.deepEqual(args.slice(0, 3), ["--ask-for-approval", "never", "exec"]);
    assert.ok(args.includes("--ephemeral"));
    assert.ok(args.includes("--ignore-user-config"));
    assert.ok(args.includes("--ignore-rules"));
    assert.ok(args.includes("--json"));
    assert.ok(args.includes("--strict-config"));
    assert.ok(args.includes("workspace-write"));
    assert.ok(args.includes("sandbox_workspace_write.network_access=false"));
    assert.ok(args.includes("sandbox_workspace_write.writable_roots=[]"));
    assert.ok(args.includes("sandbox_workspace_write.exclude_slash_tmp=true"));
    assert.ok(args.includes("sandbox_workspace_write.exclude_tmpdir_env_var=true"));
    assert.ok(args.includes("mcp_servers={}"));
    assert.ok(args.includes("hooks={}"));
    assert.ok(args.includes("plugins={}"));
    assert.ok(args.includes("project_doc_max_bytes=0"));
    assert.ok(args.includes("project_doc_fallback_filenames=[]"));
    assert.ok(args.some((entry) => entry.startsWith("projects.") && entry.endsWith('.trust_level="untrusted"')));
    assert.ok(!args.includes("--profile"));
    assert.ok(args.includes("shell_environment_policy.ignore_default_excludes=false"));
    assert.equal(optionValue(args, "--model"), "gpt-5.6-terra");
    assert.ok(args.includes('model_reasoning_effort="high"'));
    assert.ok(!args.includes("gpt-5.6-sol"));
    assert.equal(args.at(-1), "-");

    for (const [kind, issueNumber] of [
      ["issue-repair", 1],
      ["release-harden", null],
    ] as const) {
      await runner.run({
        job,
        kind,
        issueNumber,
        prompt: `Run ${kind}.`,
        runsRoot: store.runsRoot(job.id),
      });
      const writingArgs = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
      assert.equal(optionValue(writingArgs, "--model"), "gpt-5.6-terra");
      assert.ok(writingArgs.includes('model_reasoning_effort="high"'));
      assert.ok(!writingArgs.includes("gpt-5.6-sol"));
    }

    const review = await runner.run({
      job,
      kind: "review",
      issueNumber: null,
      prompt: "Review the aggregate candidate.",
      runsRoot: store.runsRoot(job.id),
    });
    assert.equal(review.reviewResult?.status, "pass");
    const reviewArgs = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    assert.ok(reviewArgs.includes("read-only"));
    assert.equal(optionValue(reviewArgs, "--model"), "gpt-5.6-sol");
    assert.ok(reviewArgs.includes('model_reasoning_effort="max"'));
    assert.ok(!reviewArgs.includes("gpt-5.6-terra"));
  } finally {
    if (originalArgsPath === undefined) delete process.env.FAKE_CODEX_ARGS_PATH;
    else process.env.FAKE_CODEX_ARGS_PATH = originalArgsPath;
    repo.cleanup();
  }
});

test("worker blockedKind is required and closed", () => {
  const blocked = {
    status: "blocked",
    summary: "Cannot continue safely.",
    selfReview: { performed: true, findingsFixed: [], remainingConcerns: [] },
    testsRun: [],
    residualRisks: [],
    observedRiskClasses: [],
    blockedReason: "The accepted ADR must change.",
    blockedKind: "replan_required",
  };
  assert.equal(validateWorkerResult(blocked).blockedKind, "replan_required");
  assert.throws(() => validateWorkerResult({ ...blocked, blockedKind: "guess" }), /blockedKind is invalid/);
  assert.throws(() => validateWorkerResult({ ...blocked, observedRiskClasses: ["not-valid"] }), /observedRiskClasses is invalid/);
  assert.throws(() => validateWorkerResult({ ...blocked, observedRiskClasses: ["AUTHORITY_BOUNDARY", "AUTHORITY_BOUNDARY"] }), /observedRiskClasses is invalid/);
  assert.throws(() => validateWorkerResult({ ...blocked, blockedKind: null }), /requires blockedReason and blockedKind/);
  assert.throws(() => validateWorkerResult({ ...blocked, status: "completed" }), /cannot include blockedReason or blockedKind/);
});

test("Codex executable byte drift blocks before model execution", async () => {
  const repo = createTestRepo();
  try {
    const fake = join(repo.root, "runtime-bound-codex.mjs");
    const marker = join(repo.root, "model-executed");
    const source = `#!/usr/bin/env node
import fs from "node:fs";
const args=process.argv.slice(2);
if(args[0]==="--version"){console.log("codex-runtime-test");process.exit(0)}
if(args[0]==="login"&&args[1]==="status"){console.log("logged in");process.exit(0)}
fs.writeFileSync(${JSON.stringify(marker)}, "executed");
`;
    writeFileSync(fake, source, "utf8");
    chmodSync(fake, 0o700);
    const config = testConfig(repo, { codex: { ...testConfig(repo).codex, bin: fake } } as any);
    const plan = testPlan([1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.baseSha = await new TestGitClient(config).fetchBase();
    job.worktreePath = repo.source;
    writeFileSync(fake, `${source}\n// changed after Job creation\n`, "utf8");

    await assert.rejects(
      new CodexRunner(config, new TestGitClient(config)).run({
        job,
        kind: "worker",
        issueNumber: 1,
        prompt: "Do not run.",
        runsRoot: store.runsRoot(job.id),
      }),
      (error: any) => error?.code === "execution_runtime_drift",
    );
    assert.equal(existsSync(marker), false);
  } finally {
    repo.cleanup();
  }
});

test("oversized Codex final result is rejected before unbounded parsing", async () => {
  const repo = createTestRepo();
  try {
    const fake = join(repo.root, "oversized-result-codex.mjs");
    writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args=process.argv.slice(2);
if(args[0]==="--version"){console.log("codex-runtime-test");process.exit(0)}
if(args[0]==="login"&&args[1]==="status"){console.log("logged in");process.exit(0)}
fs.writeFileSync(args[args.indexOf("--output-last-message")+1], "x".repeat(8192));
`, "utf8");
    chmodSync(fake, 0o700);
    const config = testConfig(repo, { codex: { ...testConfig(repo).codex, bin: fake } } as any);
    config.codex.maxResultBytes = 4_096;
    const plan = testPlan([1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.baseSha = await new TestGitClient(config).fetchBase();
    job.worktreePath = repo.source;
    const execution = await new CodexRunner(config, new TestGitClient(config)).run({
      job,
      kind: "worker",
      issueNumber: 1,
      prompt: "Return bounded output.",
      runsRoot: store.runsRoot(job.id),
    });
    assert.equal(execution.record.outputLimitExceeded, true);
    assert.equal(execution.record.terminationReason, "output_limit");
    assert.equal(execution.record.resultBytes, 8192);
    assert.equal(execution.record.resultDigest, null);
    assert.equal(execution.workerResult, null);
    assert.equal(existsSync(execution.record.resultPath), false);
  } finally {
    repo.cleanup();
  }
});

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index < 0 ? undefined : args[index + 1];
}
