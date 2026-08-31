import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CodexSandboxProvider } from "../src/validation-sandbox.js";
import { GitClient } from "../src/git.js";
import { createTestRepo, git, testConfig, testSandboxBin } from "./support.js";
import { testPlanV2, writeInputs } from "./support.js";
import { JobStore } from "../src/state.js";
import { Validator } from "../src/validator.js";
import { digestJson } from "../src/util.js";
import { nowIso } from "../src/util.js";
import { ValidationExecutor } from "../src/validation-executor.js";
import { HostSandboxProvider } from "../src/validation-sandbox.js";

test("interrupted sandbox cleanup is recovered idempotently after restart", () => {
  const repo = createTestRepo();
  try {
    const validationsRoot = join(repo.state, "validations");
    const evidenceRoot = join(validationsRoot, "interrupted-validation");
    const sandboxRunRoot = join(repo.sandbox, "release-fixture", "interrupted-validation");
    const workspace = join(sandboxRunRoot, "workspace");
    mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    writeFileSync(join(workspace, "leftover.txt"), "interrupted\n", "utf8");
    const provider = new HostSandboxProvider("/bin/sh", 500);
    const identity = {
      version: 1 as const,
      sandboxRunRoot,
      workspace,
      policyDigest: provider.policyDigest,
      state: "pending" as const,
      createdAt: nowIso(),
      cleanedAt: null,
    };
    writeFileSync(join(evidenceRoot, "sandbox.json"), `${JSON.stringify({ ...identity, digest: digestJson(identity) }, null, 2)}\n`, "utf8");
    const executor = new ValidationExecutor(new GitClient(testConfig(repo)), provider, repo.sandbox);

    executor.recover(validationsRoot);
    executor.recover(validationsRoot);

    assert.equal(existsSync(sandboxRunRoot), false);
    assert.equal(JSON.parse(readFileSync(join(evidenceRoot, "sandbox.json"), "utf8")).state, "clean");
  } finally {
    repo.cleanup();
  }
});

test("missing sandbox capability blocks before candidate validation", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    const unavailableSandbox = join(repo.root, "unavailable-sandbox");
    writeFileSync(unavailableSandbox, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo sandbox-test; exit 0; fi\nexit 1\n", "utf8");
    chmodSync(unavailableSandbox, 0o700);
    config.validation.sandbox!.bin = unavailableSandbox;
    const plan = testPlanV2(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });
    job.worktreePath = repo.source;
    job.baseSha = plan.source.baseSha;
    const gitClient = new GitClient(config);
    await assert.rejects(new Validator(config, gitClient).run({
      job,
      scope: "release",
      issueNumber: null,
      commands: [{ command: "candidate-command-must-not-run" }],
      validationsRoot: store.validationsRoot(job.id),
      sourceHeadSha: await gitClient.head(repo.source),
      sourceWorktreeDigest: await gitClient.worktreeDigest(repo.source),
    }), /sandbox capability/u);
  } finally {
    repo.cleanup();
  }
});

test("validation sandbox executable drift blocks before capability or candidate execution", async () => {
  const repo = createTestRepo();
  try {
    const wrapper = join(repo.root, "sandbox-codex");
    const realSandbox = resolve("node_modules/.bin/codex");
    const source = `#!/bin/sh\nexec ${JSON.stringify(realSandbox)} "$@"\n`;
    writeFileSync(wrapper, source, "utf8");
    chmodSync(wrapper, 0o700);
    const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    config.validation.sandbox!.bin = wrapper;
    const plan = testPlanV2(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });
    job.worktreePath = repo.source;
    job.baseSha = plan.source.baseSha;
    writeFileSync(wrapper, `${source}# drifted\n`, "utf8");
    const gitClient = new GitClient(config);
    await assert.rejects(new Validator(config, gitClient).run({
      job,
      scope: "release",
      issueNumber: null,
      commands: [{ command: "candidate-command-must-not-run" }],
      validationsRoot: store.validationsRoot(job.id),
      sourceHeadSha: await gitClient.head(repo.source),
      sourceWorktreeDigest: await gitClient.worktreeDigest(repo.source),
    }), (error: any) => error?.code === "validation_sandbox_drift");
  } finally {
    repo.cleanup();
  }
});

test("validation output flooding is bounded and recorded as a failed termination", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    config.validation.maxStdoutBytes = 4_096;
    config.validation.maxStderrBytes = 4_096;
    config.validation.maxAggregateBytes = 6_144;
    const plan = testPlanV2(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });
    job.worktreePath = repo.source;
    job.baseSha = plan.source.baseSha;
    const gitClient = new GitClient(config);
    const receipt = (await new Validator(config, gitClient).run({
      job,
      scope: "release",
      issueNumber: null,
      commands: [
        { command: "node -e \"process.stdout.write('a'.repeat(4096))\"" },
        {
          command: "node -e \"process.on('SIGTERM',()=>process.exit(0));const c='x'.repeat(1024);setInterval(()=>{process.stdout.write(c);process.stderr.write(c)},0)\"",
        },
      ],
      validationsRoot: store.validationsRoot(job.id),
      sourceHeadSha: await gitClient.head(repo.source),
      sourceWorktreeDigest: await gitClient.worktreeDigest(repo.source),
    })).receipt;
    const command = receipt.commands[1]!;
    assert.equal(receipt.passed, false);
    assert.equal(command.outputLimitExceeded, true);
    assert.equal(command.terminationReason, "output_limit");
    assert.ok(statSync(command.stdoutPath).size <= 4_096);
    assert.ok(statSync(command.stderrPath).size <= 4_096);
    assert.ok(receipt.commands.reduce((total, entry) => (
      total + statSync(entry.stdoutPath).size + statSync(entry.stderrPath).size
    ), 0) <= 6_144);
  } finally {
    repo.cleanup();
  }
});

test("validation command cannot validate a modified disposable substitute for the candidate", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    const plan = testPlanV2(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });
    job.worktreePath = repo.source;
    job.baseSha = plan.source.baseSha;
    const gitClient = new GitClient(config);
    await assert.rejects(new Validator(config, gitClient).run({
      job,
      scope: "release",
      issueNumber: null,
      commands: [{ command: "node -e \"require('node:fs').writeFileSync('README.md','substitute')\"" }],
      validationsRoot: store.validationsRoot(job.id),
      sourceHeadSha: await gitClient.head(repo.source),
      sourceWorktreeDigest: await gitClient.worktreeDigest(repo.source),
    }), /projection.*changed|candidate.*mutated/iu);
    assert.equal(readFileSync(join(repo.source, "README.md"), "utf8"), "# Fixture\n");
  } finally {
    repo.cleanup();
  }
});

test("validation commands cannot pass state to later commands", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    const plan = testPlanV2(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.worktreePath = repo.source;
    job.baseSha = plan.source.baseSha;
    const gitClient = new GitClient(config);
    const receipt = (await new Validator(config, gitClient).run({
      job,
      scope: "release",
      issueNumber: null,
      commands: [
        { command: "node -e \"require('node:fs').writeFileSync('injected','pass')\"" },
        { command: "test -f injected" },
      ],
      validationsRoot: store.validationsRoot(job.id),
      sourceHeadSha: await gitClient.head(repo.source),
      sourceWorktreeDigest: await gitClient.worktreeDigest(repo.source),
    })).receipt;
    assert.equal(receipt.passed, false);
    assert.equal(receipt.commands[0]!.exitCode, 0);
    assert.notEqual(receipt.commands[1]!.exitCode, 0);
  } finally {
    repo.cleanup();
  }
});

test("Validator binds and executes the clean projection through the verified sandbox", async () => {
  const repo = createTestRepo();
  const server = createServer((socket: any) => socket.end("reachable"));
  const originalSentinel = process.env.CONTROLLER_SENTINEL;
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test listener address is unavailable");
    writeFileSync(join(repo.source, ".gitignore"), ".env\n", "utf8");
    git(repo.source, ["add", ".gitignore"]);
    git(repo.source, ["commit", "-m", "track validation ignore policy"]);
    git(repo.source, ["push", "origin", "main"]);
    writeFileSync(join(repo.source, ".env"), "SENTINEL=ignored-worker-state\n", "utf8");
    const outsidePath = join(tmpdir(), `herdr-validation-outside-${Date.now()}`);
    writeFileSync(join(repo.source, "validation-probe.mjs"), `
import fs from "node:fs";
import net from "node:net";
const report = {
  env: process.env.CONTROLLER_SENTINEL ?? null,
  ignoredStatePresent: fs.existsSync(".env"),
  outsideWrite: false,
  network: false,
};
try { fs.writeFileSync(${JSON.stringify(outsidePath)}, "unsafe"); report.outsideWrite = true; } catch {}
report.network = await new Promise((resolve) => {
  const socket = net.connect(${address.port}, "127.0.0.1");
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
  setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
});

console.log(JSON.stringify(report));
`, "utf8");
    process.env.CONTROLLER_SENTINEL = "must-not-cross";
    const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    const plan = testPlanV2(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({
      configPath,
      planPath,
      plan,
      configDigest: digestJson(config),
      planDigest: digestJson(plan),
    });
    job.worktreePath = repo.source;
    job.baseSha = plan.source.baseSha;
    const gitClient = new GitClient(config);
    const receipt = (await new Validator(config, gitClient).run({
      job,
      scope: "release",
      issueNumber: null,
      commands: [{ command: "node validation-probe.mjs" }],
      validationsRoot: store.validationsRoot(job.id),
      sourceHeadSha: await gitClient.head(repo.source),
      sourceWorktreeDigest: await gitClient.worktreeDigest(repo.source),
    })).receipt;

    const report = JSON.parse(receipt.commands[0]!.stdoutTail.trim().split("\n").at(-1)!);
    assert.deepEqual(report, { env: null, ignoredStatePresent: false, outsideWrite: false, network: false });
    assert.equal(existsSync(outsidePath), false);
    assert.equal(receipt.version, 3);
    assert.equal(receipt.passed, true);
    assert.equal(receipt.cleanupCompleted, true);
    assert.match(receipt.candidateTreeSha ?? "", /^[a-f0-9]{40}$/u);
    assert.match(receipt.sandboxPolicyDigest ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(receipt.commands[0]!.outputLimitExceeded, false);
    assert.equal(receipt.commands[0]!.terminationReason, "exit");
  } finally {
    if (originalSentinel === undefined) delete process.env.CONTROLLER_SENTINEL;
    else process.env.CONTROLLER_SENTINEL = originalSentinel;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    repo.cleanup();
  }
});

test("validation sandbox denies Controller state outside HOME and system temp", async () => {
  const repo = createTestRepo();
  const externalState = realpathSync(mkdtempSync(join("/var/tmp", "herdr-controller-private-state-")));
  try {
    const secret = join(externalState, "controller-secret");
    writeFileSync(secret, "private", "utf8");
    const config = testConfig(repo, { executionMode: "release-plan-v2-direct", stateDir: externalState });
    const plan = testPlanV2(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.worktreePath = repo.source;
    job.baseSha = plan.source.baseSha;
    writeFileSync(join(repo.source, "state-probe.mjs"), `
import fs from "node:fs";
let readable = false;
try { fs.readFileSync(${JSON.stringify(secret)}); readable = true; } catch {}
console.log(readable);
`, "utf8");
    const gitClient = new GitClient(config);
    const receipt = (await new Validator(config, gitClient).run({
      job,
      scope: "release",
      issueNumber: null,
      commands: [{ command: "node state-probe.mjs" }],
      validationsRoot: store.validationsRoot(job.id),
      sourceHeadSha: await gitClient.head(repo.source),
      sourceWorktreeDigest: await gitClient.worktreeDigest(repo.source),
    })).receipt;
    assert.equal(receipt.passed, true);
    assert.equal(receipt.commands[0]!.stdoutTail.trim(), "false");
  } finally {
    rmSync(externalState, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("validation projection includes admitted changes and excludes ignored Worker state", async () => {
  const repo = createTestRepo();
  const root = mkdtempSync(join("/var/tmp", "herdr-validation-projection-"));
  try {
    writeFileSync(join(repo.source, ".gitignore"), ".env\n.npmrc\nignored-cache/\n", "utf8");
    git(repo.source, ["add", ".gitignore"]);
    git(repo.source, ["commit", "-m", "track validation ignore policy"]);
    writeFileSync(join(repo.source, "tracked.txt"), "tracked candidate\n", "utf8");
    writeFileSync(join(repo.source, "admitted.txt"), "admitted untracked change\n", "utf8");
    writeFileSync(join(repo.source, ".env"), "SENTINEL=unsafe\n", "utf8");
    writeFileSync(join(repo.source, ".npmrc"), "//registry.example/:_authToken=unsafe\n", "utf8");
    mkdirSync(join(repo.source, "ignored-cache"), { mode: 0o700 });
    writeFileSync(join(repo.source, "ignored-cache", "module.js"), "throw new Error('ignored')\n", "utf8");

    const destination = join(root, "workspace");
    const projection = await new GitClient(testConfig(repo)).createValidationProjection(repo.source, destination);
    assert.match(projection.treeSha, /^[a-f0-9]{40}$/u);
    assert.equal(readFileSync(join(destination, "tracked.txt"), "utf8"), "tracked candidate\n");
    assert.equal(readFileSync(join(destination, "admitted.txt"), "utf8"), "admitted untracked change\n");
    assert.equal(existsSync(join(destination, ".env")), false);
    assert.equal(existsSync(join(destination, ".npmrc")), false);
    assert.equal(existsSync(join(destination, "ignored-cache")), false);
  } finally {
    repo.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("validation projection never writes candidate blobs into the source object database", async () => {
  const repo = createTestRepo();
  const root = mkdtempSync(join("/var/tmp", "herdr-validation-object-store-"));
  try {
    writeFileSync(join(repo.source, "private-candidate.txt"), `candidate-${Date.now()}\n`, "utf8");
    const object = git(repo.source, ["hash-object", "--no-filters", "--", "private-candidate.txt"]);
    assert.notEqual(spawnSync("git", ["-C", repo.source, "cat-file", "-e", object]).status, 0);
    await new GitClient(testConfig(repo)).createValidationProjection(repo.source, join(root, "workspace"));
    assert.notEqual(spawnSync("git", ["-C", repo.source, "cat-file", "-e", object]).status, 0);
  } finally {
    repo.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("validation projection preserves an unchanged tracked symlink that stays inside the candidate root", async () => {
  const repo = createTestRepo();
  const root = mkdtempSync(join("/var/tmp", "herdr-validation-tracked-symlink-"));
  try {
    symlinkSync("README.md", join(repo.source, "README.link"));
    git(repo.source, ["add", "README.link"]);
    git(repo.source, ["commit", "-m", "track safe symlink"]);
    const destination = join(root, "workspace");
    await new GitClient(testConfig(repo)).createValidationProjection(repo.source, destination);
    assert.equal(readFileSync(join(destination, "README.link"), "utf8"), "# Fixture\n");
  } finally {
    repo.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("validation projection rejects changed links, FIFOs, and sockets", async (context: any) => {
  for (const kind of ["symlink", "hardlink", "fifo", "socket"] as const) {
    await context.test(kind, async () => {
      const repo = createTestRepo();
      const root = mkdtempSync(join("/var/tmp", `herdr-validation-${kind}-`));
      const candidate = join(repo.source, `candidate-${kind}`);
      let socketServer: ReturnType<typeof createServer> | null = null;
      try {
        if (kind === "symlink") symlinkSync("README.md", candidate);
        else if (kind === "hardlink") linkSync(join(repo.source, "README.md"), candidate);
        else if (kind === "fifo") {
          const created = spawnSync("mkfifo", [candidate]);
          if (created.status !== 0) throw new Error("mkfifo is unavailable");
        } else {
          socketServer = createServer();
          await new Promise<void>((resolvePromise, rejectPromise) => {
            socketServer!.once("error", rejectPromise);
            socketServer!.listen(candidate, resolvePromise);
          });
        }
        await assert.rejects(
          new GitClient(testConfig(repo)).createValidationProjection(repo.source, join(root, "workspace")),
          /symlink|hardlink|device|FIFO|socket|special/u,
        );
      } finally {
        if (socketServer) await new Promise<void>((resolvePromise) => socketServer!.close(() => resolvePromise()));
        repo.cleanup();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("validation sandbox denies Controller env, network, and reads or writes outside its root", async () => {
  const root = mkdtempSync(join("/var/tmp", "herdr-validation-sandbox-"));
  const secretRoot = mkdtempSync(join(tmpdir(), "herdr-validation-secret-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const server = createServer((socket: any) => socket.end("reachable"));
  const originalSentinel = process.env.CONTROLLER_SENTINEL;
  try {
    mkdirSync(workspace, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test listener address is unavailable");
    const script = join(workspace, "probe.mjs");
    writeFileSync(join(secretRoot, "secret.txt"), "controller-secret", "utf8");
    writeFileSync(script, `
import fs from "node:fs";
import net from "node:net";
const report = { env: process.env.CONTROLLER_SENTINEL ?? null, readOutside: false, writeOutside: false, network: false };
try { fs.readFileSync(${JSON.stringify(join(secretRoot, "secret.txt"))}); report.readOutside = true; } catch {}
try { fs.writeFileSync(${JSON.stringify(join(outside, "written.txt"))}, "unsafe"); report.writeOutside = true; } catch {}
report.network = await new Promise((resolve) => {
  const socket = net.connect(${address.port}, "127.0.0.1");
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
  setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
});
fs.writeFileSync("report.json", JSON.stringify(report));
`, "utf8");
    chmodSync(script, 0o700);
    process.env.CONTROLLER_SENTINEL = "must-not-cross";
    const provider = new CodexSandboxProvider({
      codexBin: testSandboxBin,
      shell: "/bin/sh",
      environmentPath: [dirname(realpathSync(process.argv[0]!)), "/usr/bin", "/bin"],
      terminationGraceMs: 500,
    });
    const result = await provider.run({
      runRoot: root,
      workspace,
      command: "node probe.mjs",
      environment: { HERDR_RELEASE_ID: "sandbox-test" },
      timeoutMs: 10_000,
      stdoutPath: join(root, "stdout.log"),
      stderrPath: join(root, "stderr.log"),
      stdoutByteLimit: 16_384,
      stderrByteLimit: 16_384,
      aggregateByteLimit: 24_576,
    });

    assert.equal(result.exitCode, 0, result.stderrTail || result.stdoutTail);
    assert.deepEqual(JSON.parse(readFileSync(join(workspace, "report.json"), "utf8")), {
      env: null,
      readOutside: false,
      writeOutside: false,
      network: false,
    });
  } finally {
    if (originalSentinel === undefined) delete process.env.CONTROLLER_SENTINEL;
    else process.env.CONTROLLER_SENTINEL = originalSentinel;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    rmSync(root, { recursive: true, force: true });
    rmSync(secretRoot, { recursive: true, force: true });
  }
});
