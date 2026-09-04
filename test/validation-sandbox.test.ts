import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { CodexSandboxProvider } from "../src/validation-sandbox.js";
import type { SandboxProvider } from "../src/validation-sandbox.js";
import { GitClient } from "../src/git.js";
import { createTestRepo, git, testConfig, testSandboxBin } from "./support.js";
import { highRiskPlan, writeInputs } from "./support.js";
import { JobStore } from "../src/state.js";
import { assertValidationReceipt, Validator } from "../src/validator.js";
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
    const config = testConfig(repo);
    const unavailableSandbox = join(repo.root, "unavailable-sandbox");
    writeFileSync(unavailableSandbox, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo sandbox-test; exit 0; fi\nexit 1\n", "utf8");
    chmodSync(unavailableSandbox, 0o700);
    config.validation.sandbox!.bin = unavailableSandbox;
    const plan = highRiskPlan(repo, [1]);
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
    job.baseSha = plan.baseSha;
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

test("doctor seeds a host sentinel so environment inheritance cannot pass unnoticed", async () => {
  const repo = createTestRepo();
  const originalSentinel = process.env.CONTROLLER_SANDBOX_SENTINEL;
  try {
    delete process.env.CONTROLLER_SANDBOX_SENTINEL;
    const leakyProvider: SandboxProvider = {
      contained: true,
      policyDigest: "a".repeat(64),
      async run(input) {
        const stdoutTail = `${JSON.stringify({
          env: process.env.CONTROLLER_SANDBOX_SENTINEL ?? null,
          outsideWrite: false,
          network: false,
        })}\n`;
        return {
          command: input.command,
          args: [],
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 1,
          stdoutPath: input.stdoutPath,
          stderrPath: input.stderrPath,
          stdoutTail,
          stderrTail: "",
          stdoutBytes: Buffer.byteLength(stdoutTail),
          stderrBytes: 0,
          stdoutSha256: `sha256:${"1".repeat(64)}`,
          stderrSha256: `sha256:${"2".repeat(64)}`,
          outputLimitExceeded: false,
          terminationReason: "exit",
        };
      },
    };
    const executor = new ValidationExecutor(new GitClient(testConfig(repo)), leakyProvider, repo.sandbox);
    await assert.rejects(executor.doctor(), /environmentCleared|capability verification failed/u);
  } finally {
    if (originalSentinel === undefined) delete process.env.CONTROLLER_SANDBOX_SENTINEL;
    else process.env.CONTROLLER_SANDBOX_SENTINEL = originalSentinel;
    repo.cleanup();
  }
});

test("doctor rejects a sandbox whose writable temp root is inside the candidate projection", async () => {
  const repo = createTestRepo();
  try {
    const unsafeTempProvider: SandboxProvider = {
      contained: true,
      policyDigest: "b".repeat(64),
      async run(input) {
        const stdoutTail = `${JSON.stringify({
          env: null,
          outsideWrite: false,
          network: false,
          temporary: input.workspace,
          temporaryWrite: true,
        })}\n`;
        return {
          command: input.command,
          args: [],
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 1,
          stdoutPath: input.stdoutPath,
          stderrPath: input.stderrPath,
          stdoutTail,
          stderrTail: "",
          stdoutBytes: Buffer.byteLength(stdoutTail),
          stderrBytes: 0,
          stdoutSha256: `sha256:${"1".repeat(64)}`,
          stderrSha256: `sha256:${"2".repeat(64)}`,
          outputLimitExceeded: false,
          terminationReason: "exit",
        };
      },
    };
    const executor = new ValidationExecutor(new GitClient(testConfig(repo)), unsafeTempProvider, repo.sandbox);
    await assert.rejects(executor.doctor(), /temporaryOutsideCandidate|capability verification failed/u);
  } finally {
    repo.cleanup();
  }
});

test("validation output flooding is bounded and recorded as a failed termination", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    config.validation.maxStdoutBytes = 4_096;
    config.validation.maxStderrBytes = 4_096;
    config.validation.maxAggregateBytes = 6_144;
    const plan = highRiskPlan(repo, [1]);
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
    job.baseSha = plan.baseSha;
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
    const config = testConfig(repo);
    const plan = highRiskPlan(repo, [1]);
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
    job.baseSha = plan.baseSha;
    const gitClient = new GitClient(config);
    const receipt = (await new Validator(config, gitClient).run({
      job,
      scope: "release",
      issueNumber: null,
      commands: [{ command: "node -e \"require('node:fs').writeFileSync('README.md','substitute')\"" }],
      validationsRoot: store.validationsRoot(job.id),
      sourceHeadSha: await gitClient.head(repo.source),
      sourceWorktreeDigest: await gitClient.worktreeDigest(repo.source),
    })).receipt;
    assert.equal(receipt.passed, false);
    assert.equal(receipt.commands[0]?.exitCode, 0);
    assert.deepEqual(receipt.integrityChecks, [{ commandIndex: 0, afterBootstrap: true, afterValidation: false }]);
    assert.doesNotThrow(() => assertValidationReceipt(receipt));
    assert.equal(readFileSync(join(repo.source, "README.md"), "utf8"), "# Fixture\n");
  } finally {
    repo.cleanup();
  }
});

test("validation commands cannot pass state to later commands", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = highRiskPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.worktreePath = repo.source;
    job.baseSha = plan.baseSha;
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

test("each validation command receives a private writable temp root outside its candidate projection", async () => {
  const repo = createTestRepo();
  try {
    writeFileSync(join(repo.source, "temp-boundary-probe.mjs"), `
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, sep } from "node:path";
const workspace = realpathSync(".");
const temporary = realpathSync(process.env.TMPDIR ?? "");
const relation = relative(workspace, temporary);
if (relation === "" || (!relation.startsWith(\`..\${sep}\`) && relation !== "..")) {
  throw new Error("validation temp root is inside the candidate projection");
}
const marker = join(temporary, "projection-marker");
if (process.argv[2] === "write") {
  writeFileSync(marker, "first-command", "utf8");
  const nested = spawnSync(process.execPath, [
    "--permission",
    \`--allow-fs-read=\${workspace}\`,
    "-e",
    "const fs=require('node:fs');const p=process.argv[1];if(process.permission.has('fs.read',p))process.exit(3);try{fs.readFileSync(p);process.exit(4)}catch(error){if(error?.code!=='ERR_ACCESS_DENIED')throw error}",
    marker,
  ], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", TMPDIR: temporary, LANG: "C.UTF-8" },
  });
  if (nested.status !== 0) throw new Error(\`nested candidate-root capability probe failed: \${nested.stderr}\`);
} else if (existsSync(marker)) throw new Error("validation temp state crossed command projections");
console.log(JSON.stringify({ workspace, temporary }));
`, "utf8");
    git(repo.source, ["add", "temp-boundary-probe.mjs"]);
    git(repo.source, ["commit", "-m", "add temp boundary probe"]);
    git(repo.source, ["push", "origin", "main"]);

    const config = testConfig(repo);
    const plan = highRiskPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.worktreePath = repo.source;
    job.baseSha = plan.baseSha;
    const gitClient = new GitClient(config);
    const receipt = (await new Validator(config, gitClient).run({
      job,
      scope: "release",
      issueNumber: null,
      commands: [
        { command: "node temp-boundary-probe.mjs write" },
        { command: "node temp-boundary-probe.mjs assert-clean" },
      ],
      validationsRoot: store.validationsRoot(job.id),
      sourceHeadSha: await gitClient.head(repo.source),
      sourceWorktreeDigest: await gitClient.worktreeDigest(repo.source),
    })).receipt;

    assert.equal(receipt.passed, true, receipt.commands[0]?.stderrTail);
    assert.equal(receipt.commands.length, 2);
    const reports = receipt.commands.map((command) => JSON.parse(command.stdoutTail.trim().split("\n").at(-1)!));
    assert.notEqual(reports[0].workspace, reports[0].temporary);
    assert.notEqual(reports[1].workspace, reports[1].temporary);
    assert.notEqual(reports[0].temporary, reports[1].temporary);
    assert.deepEqual(readdirSync(join(repo.sandbox, job.id)), []);
  } finally {
    repo.cleanup();
  }
});

test("separate repository jobs sharing one sandbox root receive disjoint temporary state", async () => {
  const first = createTestRepo();
  const second = createTestRepo();
  try {
    for (const [repo, owner] of [[first, "first"], [second, "second"]] as const) {
      writeFileSync(join(repo.source, "project-temp-probe.mjs"), `
import { realpathSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
const workspace = realpathSync(".");
const temporary = realpathSync(process.env.TMPDIR ?? "");
const relation = relative(workspace, temporary);
if (relation === "" || (!relation.startsWith(\`..\${sep}\`) && relation !== "..")) process.exit(2);
writeFileSync(join(temporary, "owner"), ${JSON.stringify(owner)}, "utf8");
console.log(JSON.stringify({ owner: ${JSON.stringify(owner)}, workspace, temporary }));
`, "utf8");
      git(repo.source, ["add", "project-temp-probe.mjs"]);
      git(repo.source, ["commit", "-m", `add ${owner} project temp probe`]);
      git(repo.source, ["push", "origin", "main"]);
    }

    const run = async (repo: typeof first) => {
      const config = testConfig(repo);
      config.validation.sandbox!.root = first.sandbox;
      const plan = highRiskPlan(repo, [1]);
      const { configPath, planPath } = writeInputs(repo, config, plan);
      const store = new JobStore(config);
      const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
      job.worktreePath = repo.source;
      job.baseSha = plan.baseSha;
      const gitClient = new GitClient(config);
      return (await new Validator(config, gitClient).run({
        job,
        scope: "release",
        issueNumber: null,
        commands: [{ command: "node project-temp-probe.mjs" }],
        validationsRoot: store.validationsRoot(job.id),
        sourceHeadSha: await gitClient.head(repo.source),
        sourceWorktreeDigest: await gitClient.worktreeDigest(repo.source),
      })).receipt;
    };

    const [firstReceipt, secondReceipt] = await Promise.all([run(first), run(second)]);
    assert.equal(firstReceipt.passed, true, firstReceipt.commands[0]?.stderrTail);
    assert.equal(secondReceipt.passed, true, secondReceipt.commands[0]?.stderrTail);
    const firstReport = JSON.parse(firstReceipt.commands[0]!.stdoutTail.trim().split("\n").at(-1)!);
    const secondReport = JSON.parse(secondReceipt.commands[0]!.stdoutTail.trim().split("\n").at(-1)!);
    assert.equal(firstReport.owner, "first");
    assert.equal(secondReport.owner, "second");
    assert.notEqual(firstReport.workspace, secondReport.workspace);
    assert.notEqual(firstReport.temporary, secondReport.temporary);
    assert.deepEqual(readdirSync(join(first.sandbox, `job-${digestJson(highRiskPlan(first, [1]))}`)), []);
  } finally {
    second.cleanup();
    first.cleanup();
  }
});

test("a bare Oracle command uses dependencies bootstrapped inside its disposable projection", async () => {
  const repo = createTestRepo();
  try {
    writeFileSync(join(repo.source, ".gitignore"), "node_modules/\n", "utf8");
    const packageJson = JSON.parse(readFileSync(join(repo.source, "package.json"), "utf8"));
    packageJson.scripts["verify:oracle:o01"] = "local-tool";
    writeFileSync(join(repo.source, "package.json"), `${JSON.stringify(packageJson)}\n`, "utf8");
    git(repo.source, ["add", ".gitignore", "package.json"]);
    git(repo.source, ["commit", "-m", "require a project-local Oracle tool"]);
    git(repo.source, ["push", "origin", "main"]);

    const config = testConfig(repo, {
      validation: {
        bootstrap: {
          command: "mkdir -p node_modules/.bin && printf '#!/bin/sh\\nprintf bootstrap-ok\\n' > node_modules/.bin/local-tool && chmod +x node_modules/.bin/local-tool",
          timeoutMs: 10_000,
          networkAccess: false,
        },
        release: [{ command: "npm run verify:oracle:o01" }],
      } as any,
    });
    const plan = highRiskPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.worktreePath = repo.source;
    job.baseSha = plan.baseSha;
    const gitClient = new GitClient(config);

    const receipt = (await new Validator(config, gitClient).run({
      job,
      scope: "release",
      issueNumber: null,
      commands: config.validation.release,
      validationsRoot: store.validationsRoot(job.id),
      sourceHeadSha: await gitClient.head(repo.source),
      sourceWorktreeDigest: await gitClient.worktreeDigest(repo.source),
    })).receipt;

    assert.equal(receipt.passed, true, receipt.commands[0]?.stderrTail);
    assert.match(receipt.commands[0]!.stdoutTail, /bootstrap-ok/u);
    assert.equal(receipt.version, 4);
    assert.equal(receipt.bootstrap?.command, config.validation.bootstrap?.command);
    assert.equal(receipt.bootstrap?.runs[0]?.sourceIntegrityVerified, true);
    assert.deepEqual(receipt.integrityChecks, [{ commandIndex: 0, afterBootstrap: true, afterValidation: true }]);
    assert.doesNotThrow(() => assertValidationReceipt(receipt));

    const tampered = structuredClone(receipt);
    tampered.bootstrap!.runs[0]!.command = "tampered-bootstrap";
    const { digest: _digest, ...identity } = tampered;
    tampered.digest = digestJson(identity);
    assert.throws(() => assertValidationReceipt(tampered), /bootstrap evidence is invalid/u);
  } finally {
    repo.cleanup();
  }
});

test("bootstrap reruns for every isolated validation command projection", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: {
        bootstrap: {
          command: "mkdir -p node_modules/.bin && printf '#!/bin/sh\\nprintf local-tool-ok\\n' > node_modules/.bin/local-tool && chmod +x node_modules/.bin/local-tool && printf bootstrap-run",
          timeoutMs: 10_000,
          networkAccess: false,
        },
      } as any,
    });
    const plan = highRiskPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.worktreePath = repo.source;
    job.baseSha = plan.baseSha;
    const gitClient = new GitClient(config);
    const receipt = (await new Validator(config, gitClient).run({
      job,
      scope: "release",
      issueNumber: null,
      commands: [
        { command: "PATH=node_modules/.bin:$PATH local-tool && touch command-one-state" },
        { command: "PATH=node_modules/.bin:$PATH local-tool && test ! -e command-one-state" },
      ],
      validationsRoot: store.validationsRoot(job.id),
      sourceHeadSha: await gitClient.head(repo.source),
      sourceWorktreeDigest: await gitClient.worktreeDigest(repo.source),
    })).receipt;

    assert.equal(receipt.passed, true);
    assert.equal(receipt.bootstrap?.runs.length, 2);
    assert.equal(receipt.bootstrap?.runs.every((run) => run.stdoutTail === "bootstrap-run"), true);
    assert.equal(receipt.commands.every((command) => /local-tool-ok/u.test(command.stdoutTail)), true);
    assert.equal(receipt.integrityChecks?.every((entry) => entry.afterBootstrap && entry.afterValidation), true);
  } finally {
    repo.cleanup();
  }
});

test("bootstrap source mutation fails closed before the semantic command", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: {
        bootstrap: {
          command: "printf 'mutated\\n' > README.md",
          timeoutMs: 10_000,
          networkAccess: false,
        },
      } as any,
    });
    const plan = highRiskPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.worktreePath = repo.source;
    job.baseSha = plan.baseSha;
    const gitClient = new GitClient(config);
    const receipt = (await new Validator(config, gitClient).run({
      job,
      scope: "release",
      issueNumber: null,
      commands: [{ command: "node -e 'process.exit(99)'" }],
      validationsRoot: store.validationsRoot(job.id),
      sourceHeadSha: await gitClient.head(repo.source),
      sourceWorktreeDigest: await gitClient.worktreeDigest(repo.source),
    })).receipt;

    assert.equal(receipt.passed, false);
    assert.equal(receipt.bootstrap?.runs[0]?.exitCode, 0);
    assert.equal(receipt.bootstrap?.runs[0]?.sourceIntegrityVerified, false);
    assert.equal(receipt.commands.length, 0);
    assert.deepEqual(receipt.integrityChecks, [{ commandIndex: 0, afterBootstrap: false, afterValidation: null }]);
    assert.doesNotThrow(() => assertValidationReceipt(receipt));
    assert.equal(readFileSync(join(repo.source, "README.md"), "utf8"), "# Fixture\n");
  } finally {
    repo.cleanup();
  }
});

test("bootstrap exit, output-limit, and timeout failures are bounded and skip semantic validation", async (context: any) => {
  const scenarios = [
    { name: "exit", command: "printf bootstrap-failed >&2; exit 7", timeoutMs: 10_000, reason: "exit" },
    {
      name: "output-limit",
      command: "node -e \"process.on('SIGTERM',()=>process.exit(0));const c='x'.repeat(1024);setInterval(()=>{process.stdout.write(c);process.stderr.write(c)},0)\"",
      timeoutMs: 10_000,
      reason: "output_limit",
    },
    { name: "timeout", command: "node -e \"setInterval(()=>{},1000)\"", timeoutMs: 1_000, reason: "timeout" },
  ];
  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const repo = createTestRepo();
      try {
        const config = testConfig(repo, {
          validation: {
            bootstrap: {
              command: scenario.command,
              timeoutMs: scenario.timeoutMs,
              networkAccess: false,
            },
            maxStdoutBytes: 4_096,
            maxStderrBytes: 4_096,
            maxAggregateBytes: 6_144,
          } as any,
        });
        const plan = highRiskPlan(repo, [1]);
        const { configPath, planPath } = writeInputs(repo, config, plan);
        const store = new JobStore(config);
        const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
        job.worktreePath = repo.source;
        job.baseSha = plan.baseSha;
        const gitClient = new GitClient(config);
        const receipt = (await new Validator(config, gitClient).run({
          job,
          scope: "release",
          issueNumber: null,
          commands: [{ command: "node -e 'process.exit(99)'" }],
          validationsRoot: store.validationsRoot(job.id),
          sourceHeadSha: await gitClient.head(repo.source),
          sourceWorktreeDigest: await gitClient.worktreeDigest(repo.source),
        })).receipt;

        const bootstrap = receipt.bootstrap!.runs[0]!;
        assert.equal(receipt.passed, false);
        assert.equal(receipt.commands.length, 0);
        assert.equal(bootstrap.terminationReason, scenario.reason);
        assert.ok(statSync(bootstrap.stdoutPath).size <= 4_096);
        assert.ok(statSync(bootstrap.stderrPath).size <= 4_096);
        assert.doesNotThrow(() => assertValidationReceipt(receipt));
      } finally {
        repo.cleanup();
      }
    });
  }
});

test("bootstrap signal termination is bound into receipt evidence", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      validation: {
        bootstrap: { command: "signal-bootstrap", timeoutMs: 10_000, networkAccess: false },
      } as any,
    });
    const result = (input: any, signal: string | null, stdoutTail: string) => ({
      command: input.command,
      args: [],
      exitCode: signal ? null : 0,
      signal,
      timedOut: false,
      durationMs: 1,
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
      stdoutTail,
      stderrTail: "",
      stdoutBytes: Buffer.byteLength(stdoutTail),
      stderrBytes: 0,
      stdoutSha256: `sha256:${"3".repeat(64)}`,
      stderrSha256: `sha256:${"4".repeat(64)}`,
      outputLimitExceeded: false,
      terminationReason: signal ? "signal" as const : "exit" as const,
    });
    const doctorResult = (input: any) => {
      const temporary = join(input.runRoot, "fake-doctor-temp");
      mkdirSync(temporary, { recursive: true, mode: 0o700 });
      return result(input, null, `${JSON.stringify({
        env: null,
        outsideWrite: false,
        network: false,
        temporary,
        temporaryWrite: true,
      })}\n`);
    };
    const validationProvider: SandboxProvider = {
      contained: true,
      policyDigest: "a".repeat(64),
      async run(input) {
        return doctorResult(input);
      },
    };
    const bootstrapProvider: SandboxProvider = {
      contained: true,
      policyDigest: "b".repeat(64),
      async run(input) {
        return input.command === "node probe.mjs"
          ? doctorResult(input)
          : result(input, "SIGTERM", "");
      },
    };
    const plan = highRiskPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.worktreePath = repo.source;
    job.baseSha = plan.baseSha;
    const gitClient = new GitClient(config);
    const executor = new ValidationExecutor(gitClient, validationProvider, repo.sandbox, {
      config: config.validation.bootstrap!,
      provider: bootstrapProvider,
    });
    const receipt = (await new Validator(config, gitClient, executor).run({
      job,
      scope: "release",
      issueNumber: null,
      commands: [{ command: "semantic-command-must-not-run" }],
      validationsRoot: store.validationsRoot(job.id),
      sourceHeadSha: await gitClient.head(repo.source),
      sourceWorktreeDigest: await gitClient.worktreeDigest(repo.source),
    })).receipt;

    assert.equal(receipt.commands.length, 0);
    assert.equal(receipt.bootstrap?.runs[0]?.signal, "SIGTERM");
    assert.equal(receipt.bootstrap?.runs[0]?.terminationReason, "signal");
    assert.doesNotThrow(() => assertValidationReceipt(receipt));
  } finally {
    repo.cleanup();
  }
});

test("bootstrap may use configured network while semantic validation remains credential-free and offline", async () => {
  const repo = createTestRepo();
  const server = createServer((socket: any) => {
    socket.on("error", () => {});
    socket.end("reachable");
  });
  const originalSentinel = process.env.CONTROLLER_SENTINEL;
  const originalToken = process.env.NPM_TOKEN;
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test listener address is unavailable");
    const stateSecret = join(repo.state, "controller-secret");
    writeFileSync(stateSecret, "private", "utf8");
    writeFileSync(join(repo.source, "sandbox-policy-probe.mjs"), `
import fs from "node:fs";
import net from "node:net";
const expectedNetwork = process.argv[3] === "true";
const network = await new Promise((resolve) => {
  const socket = net.connect(Number(process.argv[2]), "127.0.0.1");
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
  setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
});
let stateReadable = false;
try { fs.readFileSync(${JSON.stringify(stateSecret)}); stateReadable = true; } catch {}
const report = {
  network,
  hostSentinel: process.env.CONTROLLER_SENTINEL ?? null,
  npmToken: process.env.NPM_TOKEN ?? null,
  npmUserConfig: process.env.NPM_CONFIG_USERCONFIG ?? null,
  userNpmrc: fs.existsSync(process.env.HOME + "/.npmrc"),
  stateReadable,
};
console.log(JSON.stringify(report));
if (network !== expectedNetwork || report.hostSentinel !== null || report.npmToken !== null
  || report.npmUserConfig !== "/dev/null" || report.userNpmrc || stateReadable) process.exit(1);
if (expectedNetwork) {
  fs.mkdirSync("node_modules/.bin", { recursive: true });
  fs.writeFileSync("node_modules/.bin/local-tool", "#!/bin/sh\\nprintf policy-ok\\n", { mode: 0o700 });
}
`, "utf8");
    git(repo.source, ["add", "sandbox-policy-probe.mjs"]);
    git(repo.source, ["commit", "-m", "add sandbox policy probe"]);
    git(repo.source, ["push", "origin", "main"]);
    process.env.CONTROLLER_SENTINEL = "must-not-cross";
    process.env.NPM_TOKEN = "must-not-cross";

    const config = testConfig(repo, {
      validation: {
        bootstrap: {
          command: `node sandbox-policy-probe.mjs ${address.port} true`,
          timeoutMs: 10_000,
          networkAccess: true,
        },
      } as any,
    });
    const plan = highRiskPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.worktreePath = repo.source;
    job.baseSha = plan.baseSha;
    const gitClient = new GitClient(config);
    const validator = new Validator(config, gitClient);
    const doctor = await validator.preflight();
    assert.equal(doctor.verified, true);
    assert.match(doctor.validationPolicyDigest, /^[a-f0-9]{64}$/u);
    assert.match(doctor.bootstrapPolicyDigest ?? "", /^[a-f0-9]{64}$/u);
    assert.notEqual(doctor.validationPolicyDigest, doctor.bootstrapPolicyDigest);

    const receipt = (await validator.run({
      job,
      scope: "release",
      issueNumber: null,
      commands: [{ command: `node sandbox-policy-probe.mjs ${address.port} false && PATH=node_modules/.bin:$PATH local-tool` }],
      validationsRoot: store.validationsRoot(job.id),
      sourceHeadSha: await gitClient.head(repo.source),
      sourceWorktreeDigest: await gitClient.worktreeDigest(repo.source),
    })).receipt;

    assert.equal(receipt.passed, true, receipt.commands[0]?.stderrTail);
    assert.equal(JSON.parse(receipt.bootstrap!.runs[0]!.stdoutTail).network, true);
    assert.equal(JSON.parse(receipt.commands[0]!.stdoutTail.split("\n")[0]!).network, false);
    assert.match(receipt.commands[0]!.stdoutTail, /policy-ok/u);
  } finally {
    if (originalSentinel === undefined) delete process.env.CONTROLLER_SENTINEL;
    else process.env.CONTROLLER_SENTINEL = originalSentinel;
    if (originalToken === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = originalToken;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
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
    const config = testConfig(repo);
    const plan = highRiskPlan(repo, [1]);
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
    job.baseSha = plan.baseSha;
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
    assert.equal(receipt.version, 4);
    assert.equal(receipt.bootstrap, null);
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
    const config = testConfig(repo, { stateDir: externalState });
    const plan = highRiskPlan(repo, [1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.worktreePath = repo.source;
    job.baseSha = plan.baseSha;
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
process.stdout.write("sandbox-stdout\\n");
process.stderr.write("sandbox-stderr\\n");
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
    assert.match(result.stdoutTail, /sandbox-stdout/u);
    assert.match(result.stderrTail, /sandbox-stderr/u);
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

test("sandbox allows Node realpath inside a nested worktree without exposing HOME", async () => {
  const repo = createTestRepo();
  const worktreeRoot = realpathSync(mkdtempSync(join("/var/tmp", "herdr-nested-worktree-")));
  try {
    const workspace = join(worktreeRoot, "job-nested");
    const sibling = join(worktreeRoot, "job-sibling");
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    mkdirSync(sibling, { recursive: true, mode: 0o700 });
    writeFileSync(join(sibling, "secret.txt"), "sibling-secret\n", "utf8");
    writeFileSync(join(workspace, "probe.mjs"), `
import fs from "node:fs";
const self = process.argv[1];
const resolved = fs.realpathSync(self);
let homeReadable = false;
try { fs.readdirSync(${JSON.stringify(process.env.HOME)}).length; homeReadable = true; } catch {}
let siblingReadable = false;
try { fs.readFileSync(${JSON.stringify(join(sibling, "secret.txt"))}, "utf8"); siblingReadable = true; } catch {}
console.log(JSON.stringify({ resolved, homeReadable, siblingReadable }));
`);
    const provider = new CodexSandboxProvider({
      codexBin: testSandboxBin,
      shell: "/bin/bash",
      environmentPath: [dirname(realpathSync(process.argv[0]!)), "/usr/bin", "/bin"],
      deniedReadPaths: [repo.source, repo.state, worktreeRoot],
      terminationGraceMs: 2_000,
    });
    const runRoot = join(repo.sandbox, "realpath-run");
    mkdirSync(runRoot, { recursive: true, mode: 0o700 });
    const result = await provider.run({
      runRoot,
      workspace,
      command: "node probe.mjs",
      environment: { HERDR_RELEASE_ID: "sandbox-test" },
      timeoutMs: 10_000,
      stdoutPath: join(runRoot, "stdout.log"),
      stderrPath: join(runRoot, "stderr.log"),
      stdoutByteLimit: 16_384,
      stderrByteLimit: 16_384,
      aggregateByteLimit: 24_576,
    });
    assert.equal(result.exitCode, 0, result.stderrTail || result.stdoutTail);
    const report = JSON.parse(result.stdoutTail.trim().split("\n").at(-1)!);
    assert.equal(report.resolved, realpathSync(join(workspace, "probe.mjs")));
    assert.equal(report.homeReadable, false);
    assert.equal(report.siblingReadable, false);
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    repo.cleanup();
  }
});
