import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ControllerConfig, DispatcherConfig } from "./types.js";
import { expectExactKeys, expectObject } from "./config.js";
import { boundedStringArray, boundedText, parsePositiveInteger } from "./util.js";

export function loadDispatcherConfig(path: string): DispatcherConfig {
  const absolute = resolve(path);
  return validateDispatcherConfig(JSON.parse(readFileSync(absolute, "utf8")) as unknown);
}

export function validateDispatcherConfig(value: unknown): DispatcherConfig {
  const root = expectObject(value, "dispatcher");
  expectExactKeys(root, [
    "parentIssue", "postMerge", "readyLabel", "releaseAcceptanceCriteria", "reviewFocus", "version",
  ], "dispatcher");
  if (root.version !== 1) throw new Error("dispatcher.version must be 1");
  const postMerge = expectObject(root.postMerge, "dispatcher.postMerge");
  expectExactKeys(postMerge, ["pollIntervalMs", "requiredWorkflows", "timeoutMs"], "dispatcher.postMerge");
  const requiredWorkflows = boundedStringArray(
    postMerge.requiredWorkflows,
    "dispatcher.postMerge.requiredWorkflows",
    20,
    500,
  );
  if (requiredWorkflows.length === 0) {
    throw new Error("dispatcher.postMerge.requiredWorkflows must not be empty");
  }
  const releaseAcceptanceCriteria = boundedStringArray(
    root.releaseAcceptanceCriteria,
    "dispatcher.releaseAcceptanceCriteria",
    50,
    2_000,
  );
  if (releaseAcceptanceCriteria.length === 0) {
    throw new Error("dispatcher.releaseAcceptanceCriteria must not be empty");
  }
  const reviewFocus = boundedStringArray(root.reviewFocus, "dispatcher.reviewFocus", 50, 2_000);
  if (reviewFocus.length === 0) throw new Error("dispatcher.reviewFocus must not be empty");
  const readyLabel = boundedText(root.readyLabel, "dispatcher.readyLabel", 200);
  if (readyLabel !== "ready-for-agent") {
    throw new Error('dispatcher.readyLabel must be exactly "ready-for-agent"');
  }
  return {
    version: 1,
    parentIssue: parsePositiveInteger(root.parentIssue, "dispatcher.parentIssue", 1, Number.MAX_SAFE_INTEGER),
    readyLabel,
    releaseAcceptanceCriteria,
    reviewFocus,
    postMerge: {
      requiredWorkflows,
      pollIntervalMs: parsePositiveInteger(
        postMerge.pollIntervalMs,
        "dispatcher.postMerge.pollIntervalMs",
        1_000,
        10 * 60_000,
      ),
      timeoutMs: parsePositiveInteger(
        postMerge.timeoutMs,
        "dispatcher.postMerge.timeoutMs",
        60_000,
        24 * 60 * 60_000,
      ),
    },
  };
}

export function assertDispatcherCompatible(
  dispatcher: DispatcherConfig,
  controller: ControllerConfig,
): void {
  if (!controller.delivery.createPullRequest) throw new Error("dispatcher requires delivery.createPullRequest=true");
  if (!controller.delivery.autoMerge) throw new Error("dispatcher requires delivery.autoMerge=true");
  if (controller.delivery.allowNoChecks) throw new Error("dispatcher requires delivery.allowNoChecks=false");
  if (controller.delivery.mergeMethod !== "squash") throw new Error("dispatcher requires squash merge delivery");
  if (!controller.review.enabled) throw new Error("dispatcher requires aggregate release review");
  for (const severity of ["critical", "major"] as const) {
    if (!controller.review.blockingSeverities.includes(severity)) {
      throw new Error(`dispatcher requires ${severity} release-review findings to block delivery`);
    }
  }
  if (dispatcher.readyLabel !== "ready-for-agent") {
    throw new Error('dispatcher.readyLabel must be exactly "ready-for-agent"');
  }
}
