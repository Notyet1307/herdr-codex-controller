import assert from "node:assert/strict";
import test from "node:test";
import { configuredRemoteIdentity, inspectGitRemoteIdentity } from "../src/remote-identity.js";
import { createTestRepo, git, testConfig } from "./support.js";
import { TestGitClient, testPlan, writeInputs } from "./support.js";
import { GitClient } from "../src/git.js";
import { JobStore } from "../src/state.js";
import { digestJson } from "../src/util.js";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("SSH and HTTPS endpoints canonicalize to the approved GitHub repository", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    for (const endpoint of [
      "https://github.com/example/project.git",
      "git@github.com:example/project.git",
      "ssh://git@github.com/example/project.git",
    ]) {
      config.remoteIdentity = { version: 1, fetchUrl: endpoint, pushUrl: endpoint };
      assert.equal(configuredRemoteIdentity(config).repo, "example/project");
    }
  } finally { repo.cleanup(); }
});

test("remote inspection rejects push redirection, URL rewrites, and local endpoints", async () => {
  for (const kind of ["pushurl", "rewrite", "local"] as const) {
    const repo = createTestRepo();
    try {
      const config = testConfig(repo);
      config.remoteIdentity = {
        version: 1,
        fetchUrl: "https://github.com/example/project.git",
        pushUrl: "https://github.com/example/project.git",
      };
      if (kind === "pushurl") {
        git(repo.source, ["remote", "set-url", "origin", "https://github.com/example/project.git"]);
        git(repo.source, ["remote", "set-url", "--push", "origin", "https://github.com/attacker/elsewhere.git"]);
      } else if (kind === "rewrite") {
        git(repo.source, ["remote", "set-url", "origin", "https://github.com/example/project.git"]);
        git(repo.source, ["config", "url.https://github.com/attacker/.insteadOf", "https://github.com/"]);
      }
      await assert.rejects(
        inspectGitRemoteIdentity(config),
        kind === "local" ? /local|file|unsupported/u : /push|rewrite|identity|endpoint/u,
      );
    } finally { repo.cleanup(); }
  }
});

test("remote inspection accepts the exact configured endpoint", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    git(repo.source, ["remote", "set-url", "origin", config.remoteIdentity!.fetchUrl]);
    assert.equal((await inspectGitRemoteIdentity(config)).digest, configuredRemoteIdentity(config).digest);
  } finally { repo.cleanup(); }
});

test("remote drift after Job creation is rejected on the next Git preflight", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    git(repo.source, ["remote", "set-url", "origin", config.remoteIdentity!.fetchUrl]);
    const client = new GitClient(config);
    await client.preflight();
    git(repo.source, ["remote", "set-url", "origin", "git@github.com:attacker/elsewhere.git"]);
    await assert.rejects(client.preflight(), /identity|endpoint/u);
  } finally { repo.cleanup(); }
});

test("remote mismatch is rejected before any push mutation", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, { executionMode: "release-plan-v2-direct" });
    const remoteBefore = git(repo.remote, ["rev-parse", "refs/heads/main"]);
    writeFileSync(join(repo.source, "unpushed.txt"), "must stay local\n", "utf8");
    git(repo.source, ["add", "unpushed.txt"]);
    git(repo.source, ["commit", "-m", "local only"]);
    await assert.rejects(
      new GitClient(config).push({ worktreePath: repo.source, branch: "main", remote: "origin" } as any),
      /identity|endpoint|local|file/u,
    );
    assert.equal(git(repo.remote, ["rev-parse", "refs/heads/main"]), remoteBefore);
  } finally { repo.cleanup(); }
});

test("Controller commits and pushes cannot execute repository-configured hooks", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const plan = testPlan([1]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const store = new JobStore(config);
    const job = store.create({ configPath, planPath, plan, configDigest: digestJson(config), planDigest: digestJson(plan) });
    job.worktreePath = repo.source;
    job.baseSha = git(repo.source, ["rev-parse", "HEAD"]);
    job.branch = "main";
    const hooks = join(repo.source, "tracked-hooks");
    const sentinel = join(repo.root, "hook-ran");
    mkdirSync(hooks, { mode: 0o700 });
    for (const name of ["pre-commit", "pre-push"]) {
      const hook = join(hooks, name);
      writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\n`, "utf8");
      chmodSync(hook, 0o700);
    }
    git(repo.source, ["config", "core.hooksPath", "tracked-hooks"]);
    writeFileSync(join(repo.source, "candidate.txt"), "candidate\n", "utf8");
    const client = new TestGitClient(config);
    await client.commitIssue(job, 1, "Hook-safe commit", false);
    await client.push(job);
    assert.equal(existsSync(sentinel), false);
  } finally { repo.cleanup(); }
});
