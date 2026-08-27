import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexRunner } from "../src/codex.js";
import { GitClient } from "../src/git.js";
import { JobStore } from "../src/state.js";
import { digestJson } from "../src/util.js";
import { createTestRepo, testConfig, testPlan, writeInputs } from "./support.js";

test("CodexRunner uses fresh structured non-interactive execution with least-privilege sandbox flags", async () => {
  const repo = createTestRepo();
  const originalArgsPath = process.env.FAKE_CODEX_ARGS_PATH;
  try {
    const fake = join(repo.root, "fake-codex.mjs");
    const argsPath = join(repo.root, "codex-args.json");
    process.env.FAKE_CODEX_ARGS_PATH = argsPath;
    writeFileSync(fake, `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nif(args[0]==='--version'){console.log('codex-test');process.exit(0)}\nif(args[0]==='login'&&args[1]==='status'){console.log('logged in');process.exit(0)}\nfs.writeFileSync(process.env.FAKE_CODEX_ARGS_PATH, JSON.stringify(args));\nlet input='';for await (const chunk of process.stdin) input+=chunk;\nconst output=args[args.indexOf('--output-last-message')+1];\nconst review=args.includes('read-only');\nconst result=review?{status:'pass',summary:'pass',findings:[]}:{status:'completed',summary:'done',selfReview:{performed:true,findingsFixed:[],remainingConcerns:[]},testsRun:[],residualRisks:[],blockedReason:null};\nfs.writeFileSync(output, JSON.stringify(result));\nconsole.log(JSON.stringify({type:'turn.completed'}));\n`, "utf8");
    chmodSync(fake, 0o700);
    const config = testConfig(repo, { codex: { ...testConfig(repo).codex, bin: fake } } as any);
    const plan = testPlan([1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.baseSha = await new GitClient(config).fetchBase();
    job.worktreePath = repo.source;
    const runner = new CodexRunner(config, new GitClient(config));
    await runner.preflight();
    const execution = await runner.run({ job, kind: "worker", issueNumber: 1, prompt: "Implement the fixture.", runsRoot: store.runsRoot(job.id) });
    assert.equal(execution.workerResult?.status, "completed");
    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    assert.deepEqual(args.slice(0, 3), ["--ask-for-approval", "never", "exec"]);
    assert.ok(args.includes("--ephemeral"));
    assert.ok(args.includes("--json"));
    assert.ok(args.includes("--strict-config"));
    assert.ok(args.includes("workspace-write"));
    assert.ok(args.includes("sandbox_workspace_write.network_access=false"));
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

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index < 0 ? undefined : args[index + 1];
}
