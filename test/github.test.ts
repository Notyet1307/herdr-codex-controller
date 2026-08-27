import assert from "node:assert/strict";
import test from "node:test";
import { autoMergeArgs } from "../src/github.js";

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
