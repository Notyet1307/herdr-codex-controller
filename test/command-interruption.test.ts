import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { requireCommandSuccess, runCommand } from "../src/command.js";

test("stdout and stderr flooding is terminated at the configured byte limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-command-output-limit-"));
  try {
    const stdoutPath = join(root, "stdout.log");
    const stderrPath = join(root, "stderr.log");
    const result = await runCommand({
      command: "node",
      args: ["-e", "process.on('SIGTERM',()=>process.exit(0));const chunk='x'.repeat(1024);setInterval(()=>{process.stdout.write(chunk);process.stderr.write(chunk)},0)"],
      cwd: root,
      timeoutMs: 30_000,
      terminationGraceMs: 500,
      stdoutPath,
      stderrPath,
      stdoutByteLimit: 4_096,
      stderrByteLimit: 4_096,
      aggregateByteLimit: 6_144,
    });

    assert.equal(result.outputLimitExceeded, true);
    assert.equal(result.terminationReason, "output_limit");
    assert.equal(result.exitCode, 0);
    assert.throws(() => requireCommandSuccess(result, "flood"), /output limit/);
    assert.ok(statSync(stdoutPath).size <= 4_096);
    assert.ok(statSync(stderrPath).size <= 4_096);
    assert.ok(statSync(stdoutPath).size + statSync(stderrPath).size <= 6_144);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parent SIGTERM terminates the command group and preserves interruption as a fresh-recovery boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-command-interrupt-"));
  try {
    const readyPath = join(root, "ready");
    const resultPath = join(root, "result.json");
    const wrapperPath = join(root, "wrapper.mjs");
    const commandModule = pathToFileURL(resolve("dist/src/command.js")).href;
    writeFileSync(wrapperPath, `
import { writeFileSync } from "node:fs";
import { runCommand } from ${JSON.stringify(commandModule)};
const readyPath = ${JSON.stringify(readyPath)};
const resultPath = ${JSON.stringify(resultPath)};
const childSource = \`const fs=require("node:fs");setTimeout(()=>{fs.writeFileSync(${JSON.stringify(readyPath)},"ready");setInterval(()=>{},1000)},100)\`;
try {
  await runCommand({ command: "node", args: ["-e", childSource], cwd: ${JSON.stringify(root)}, timeoutMs: 60000, terminationGraceMs: 500 });
  writeFileSync(resultPath, JSON.stringify({ name: "unexpected" }));
} catch (error) {
  writeFileSync(resultPath, JSON.stringify({ name: error?.name, signal: error?.signal, message: error?.message }));
}
`, "utf8");

    const wrapper = spawn("node", [wrapperPath], { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] });
    await waitForFile(readyPath, 5_000);
    wrapper.kill("SIGTERM");
    const outcome = await new Promise<{ code: number | null; signal: string | null }>((resolvePromise, rejectPromise) => {
      wrapper.once("error", rejectPromise);
      wrapper.once("close", (code: number | null, signal: string | null) => resolvePromise({ code, signal }));
    });
    assert.deepEqual(outcome, { code: 0, signal: null });
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    assert.equal(result.name, "CommandInterruptedError");
    assert.equal(result.signal, "SIGTERM");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}
