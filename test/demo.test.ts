import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { DemoRunner } from "../src/demo.js";
import { ReleaseController } from "../src/controller.js";
import { ensurePrivateDir, writeJsonAtomic } from "../src/fs-atomic.js";
import { JobStore } from "../src/state.js";
import { Validator } from "../src/validator.js";
import { buildReleaseReportModel, renderReleaseReport } from "../src/report.js";
import type { DemoPort } from "../src/ports.js";
import type { ControllerConfig, JobState, ReviewDemoResult } from "../src/types.js";
import { digestJson, nowIso } from "../src/util.js";
import {
  FakeCodex,
  FakeGitHub,
  TestGitClient,
  createTestRepo,
  git,
  testConfig,
  testPlan,
  writeInputs,
} from "./support.js";

test("Review Demo uses an isolated exact-candidate projection and copies only safe outputs", async () => {
  const server = createServer((socket: any) => {
    socket.on("error", () => {});
    socket.end("reachable");
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test listener unavailable");
  const repo = createTestRepo();
  const previousSecret = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "SECRET_ENV_SENTINEL";
  try {
    const command = `node -e 'const fs=require("node:fs"),net=require("node:net");fs.mkdirSync(".herdr-review-output");fs.writeFileSync(".herdr-review-output/result.json",JSON.stringify({secret:process.env.GITHUB_TOKEN??null}));const s=net.connect(${address.port},"127.0.0.1");s.on("connect",()=>process.exit(7));s.on("error",()=>{console.log("network blocked");process.exit(0)});setTimeout(()=>process.exit(0),1000)'`;
    const config = demoConfig(repo, command, true, false);
    const { store, job, gitClient } = await candidateFixture(repo, config);
    const execution = await new DemoRunner(config, gitClient).run({ job, demoRoot: store.demoRoot(job.id) });
    assert.equal(execution.result.passed, true);
    assert.equal(execution.result.networkAccess, false);
    assert.match(execution.result.stdoutTail, /network blocked/);
    assert.deepEqual(execution.result.artifacts, [{
      path: ".herdr-review-output/result.json",
      mediaType: "application/json",
      bytes: Buffer.byteLength('{"secret":null}', "utf8"),
    }]);
    const copied = join(execution.path, "..", "artifacts", "result.json");
    assert.equal(existsSync(copied), true);
    assert.deepEqual(JSON.parse(readFileSync(copied, "utf8")), { secret: null });

    const enabledConfig = demoConfig(
      repo,
      `node -e 'const net=require("node:net");const s=net.connect(${address.port},"127.0.0.1");s.on("connect",()=>{console.log("network enabled");s.destroy();process.exit(0)});s.on("error",()=>process.exit(8))'`,
      true,
      true,
    );
    const enabled = await new DemoRunner(enabledConfig, gitClient).run({ job, demoRoot: store.demoRoot(job.id) });
    assert.equal(enabled.result.passed, true);
    assert.equal(enabled.result.networkAccess, true);
    assert.match(enabled.result.stdoutTail, /network enabled/);
  } finally {
    if (previousSecret === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousSecret;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    repo.cleanup();
  }
});

test("Review Demo rejects unsafe artifacts and bounded-output failures", async () => {
  for (const scenario of ["symlink", "hardlink", "fifo", "output-limit"] as const) {
    const repo = createTestRepo();
    try {
      const command = scenario === "symlink"
        ? "mkdir .herdr-review-output && ln -s /etc/passwd .herdr-review-output/unsafe"
        : scenario === "hardlink"
          ? "mkdir .herdr-review-output && printf x > source.txt && ln source.txt .herdr-review-output/unsafe"
          : scenario === "fifo"
            ? "mkdir .herdr-review-output && mkfifo .herdr-review-output/unsafe"
            : "node -e 'process.stdout.write(\"x\".repeat(20000))'";
      const config = demoConfig(repo, command, true, false, 4_096);
      const { store, job, gitClient } = await candidateFixture(repo, config);
      const execution = await new DemoRunner(config, gitClient).run({ job, demoRoot: store.demoRoot(job.id) });
      assert.equal(execution.result.passed, false, scenario);
      if (scenario === "symlink") assert.match(execution.result.error ?? "", /symlink/);
      else if (scenario !== "output-limit") assert.match(execution.result.error ?? "", /hardlink, device, FIFO, or socket/);
      else assert.equal(execution.result.outputLimitExceeded, true);
      assert.deepEqual(execution.result.artifacts, []);
    } finally { repo.cleanup(); }
  }
});

test("required Demo blocks PR, optional Demo warns, and stale candidate evidence reruns", async () => {
  for (const required of [true, false]) {
    const repo = createTestRepo();
    try {
      const config = demoConfig(repo, "exit 9", required, !required);
      const plan = testPlan(repo, [1]);
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const gitClient = new TestGitClient(config);
      const demo = new RecordingDemo(config, repo.root, false);
      class PullRequestGitHub extends FakeGitHub {
        creates = 0;
        override async createPullRequest(job: JobState) {
          this.creates += 1;
          return { number: 90, url: "https://github.com/example/project/pull/90", state: "OPEN" as const, headRef: job.branch, baseRef: job.baseRef, headSha: job.candidateSha!, mergeSha: null };
        }
      }
      const github = new PullRequestGitHub();
      const controller = new ReleaseController({
        store,
        git: gitClient,
        github,
        codex: new FakeCodex(gitClient),
        validator: new Validator(config),
        demo,
      });
      const created = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
      let job = store.load(created.id);
      for (let index = 0; index < 30 && job.phase !== "deliver"; index += 1) {
        await controller.step(job.id);
        job = store.load(job.id);
        if (job.status === "blocked") throw new Error(job.blocked?.message);
      }
      bindStaleDemo(store, job, config);

      const result = await controller.step(job.id);
      job = store.load(job.id);
      assert.equal(demo.calls, 1);
      assert.equal(job.reviewDemo?.candidateSha, job.candidateSha);
      assert.equal(github.creates, 0);
      if (required) {
        assert.equal(result.action, "blocked");
        assert.equal(job.blocked?.code, "review_demo_failed");
      } else {
        assert.equal(result.action, "review_demo_warn");
        assert.equal(job.status, "running");
        const delivery = await controller.step(job.id);
        assert.equal(delivery.action, "pull_request_ready");
        assert.equal(github.creates, 1);
      }

      const reportModel = await buildReleaseReportModel({ job: store.load(job.id), config, jobRoot: store.root(job.id), git: gitClient });
      const report = renderReleaseReport(reportModel);
      assert.match(report, /## Demonstration/);
      assert.match(report, /Status: \*\*WARN\*\*/);
      if (!required) assert.match(report, /network-enabled demonstration/);
      assert.equal(report.includes(repo.root), false);
    } finally { repo.cleanup(); }
  }
});

async function candidateFixture(repo: ReturnType<typeof createTestRepo>, config: ControllerConfig) {
  const plan = testPlan(repo, [1]);
  const { configPath, planPath } = writeInputs(repo, config, plan);
  const store = new JobStore(config);
  const gitClient = new TestGitClient(config);
  const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
  job.baseSha = git(repo.source, ["rev-parse", "origin/main"]);
  await gitClient.ensureWorktree(job);
  job.candidateSha = await gitClient.head(job.worktreePath);
  job.phase = "deliver";
  store.save(job);
  return { store, job: store.load(job.id), gitClient };
}

function demoConfig(
  repo: ReturnType<typeof createTestRepo>,
  command: string,
  required: boolean,
  networkAccess: boolean,
  maxOutputBytes = 64 * 1024,
): ControllerConfig {
  return testConfig(repo, {
    reviewDemo: { command, required, networkAccess, timeoutMs: 30_000, maxOutputBytes },
  });
}

class RecordingDemo implements DemoPort {
  calls = 0;
  constructor(
    private readonly config: ControllerConfig,
    private readonly privatePath: string,
    private readonly passed: boolean,
  ) {}

  async run(input: { job: JobState; demoRoot: string }) {
    this.calls += 1;
    return writeDemoResult(input.demoRoot, input.job.candidateSha!, this.config, this.passed, this.privatePath);
  }
}

function bindStaleDemo(store: JobStore, job: JobState, config: ControllerConfig): void {
  const stale = writeDemoResult(store.demoRoot(job.id), "f".repeat(40), config, true, null);
  job.reviewDemo = {
    candidateSha: stale.result.candidateSha,
    path: stale.path,
    digest: stale.result.digest,
    passed: stale.result.passed,
    required: stale.result.required,
  };
  store.save(job);
}

function writeDemoResult(
  demoRoot: string,
  candidateSha: string,
  config: ControllerConfig,
  passed: boolean,
  error: string | null,
) {
  const id = `demo-${candidateSha.slice(0, 8)}-${passed ? "pass" : "fail"}`;
  const root = ensurePrivateDir(join(demoRoot, id));
  const body = {
    version: 1 as const,
    id,
    candidateSha,
    command: config.reviewDemo!.command,
    required: config.reviewDemo!.required,
    networkAccess: config.reviewDemo!.networkAccess,
    sandboxPolicyDigest: "a".repeat(64),
    passed,
    exitCode: passed ? 0 : 9,
    signal: null,
    timedOut: false,
    outputLimitExceeded: false,
    durationMs: 1,
    stdoutTail: "demo output",
    stderrTail: error ?? "",
    artifacts: [],
    error,
    createdAt: nowIso(),
  };
  const result: ReviewDemoResult = { ...body, digest: digestJson(body) };
  const path = join(root, "result.json");
  writeJsonAtomic(path, result);
  return { result, path };
}
