import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { autoMergeArgs, GitHubClient } from "../src/github.js";
import { createTestRepo, testConfig } from "./support.js";

test("auto-merge is bound to the exact reviewed candidate SHA", () => {
  const candidateSha = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(
    autoMergeArgs(149, "example/project", "squash", candidateSha),
    [
      "pr", "merge", "149", "--repo", "example/project",
      "--squash", "--auto", "--match-head-commit", candidateSha,
    ],
  );
});

test("auto-merge rejects an invalid candidate identity before invoking GitHub", () => {
  assert.throws(
    () => autoMergeArgs(149, "example/project", "squash", "not-a-sha"),
    /candidate SHA is invalid/,
  );
});

test("issue snapshots use assignee login when GitHub returns an empty display name", async () => {
  const repo = createTestRepo();
  const fakeBin = mkdtempSync(join(tmpdir(), "herdr-fake-gh-"));
  const ghPath = join(fakeBin, "gh");
  const originalPath = process.env["PATH"];
  const response = JSON.stringify({
    number: 12,
    title: "Implement the next release task",
    body: "## What to build\n\nImplement it.",
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
    assignees: [{ login: "Notyet1307", name: "" }],
    url: "https://github.com/Notyet1307/Accord/issues/12",
  });
  mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
  writeFileSync(ghPath, `#!/bin/sh\nprintf '%s\\n' '${response}'\n`, { mode: 0o700 });
  chmodSync(ghPath, 0o700);
  process.env["PATH"] = `${fakeBin}:${originalPath ?? ""}`;
  try {
    const issue = await new GitHubClient(testConfig(repo)).fetchIssue(12);
    assert.deepEqual(issue.assignees, ["Notyet1307"]);
  } finally {
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    rmSync(fakeBin, { recursive: true, force: true });
    repo.cleanup();
  }
});
