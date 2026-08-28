import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import type {
  DispatcherConfig,
  JobState,
  PullRequestState,
  QueueIssue,
  StepResult,
  WorkflowGateSummary,
} from "../src/types.js";
import { assertDispatcherCompatible, validateDispatcherConfig } from "../src/dispatcher-config.js";
import { buildDispatchPlan, IssueDispatcher, selectEligibleIssue } from "../src/dispatcher.js";
import { GitClient } from "../src/git.js";
import { JobStore } from "../src/state.js";
import { digestJson, nowIso } from "../src/util.js";
import { writeJsonAtomic } from "../src/fs-atomic.js";
import { createTestRepo, FakeGitHub, git, testConfig } from "./support.js";

const dispatcherConfig: DispatcherConfig = {
  version: 1,
  parentIssue: 100,
  readyLabel: "ready-for-agent",
  releaseAcceptanceCriteria: [
    "The Issue acceptance criteria pass.",
    "The exact candidate passes aggregate review and required CI.",
  ],
  reviewFocus: ["Specification, standards, security, and regression coverage."],
  postMerge: {
    requiredWorkflows: ["Test Backend", "Playwright Tests"],
    pollIntervalMs: 1_000,
    timeoutMs: 60_000,
  },
};

test("dispatcher config requires fail-closed reviewed squash auto-merge", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      executionMode: "dispatcher-experimental",
      delivery: {
        createPullRequest: true,
        draft: false,
        autoMerge: true,
        mergeMethod: "squash",
        allowNoChecks: false,
        pollIntervalMs: 1_000,
      },
    } as any);
    const validated = validateDispatcherConfig(dispatcherConfig);
    assert.doesNotThrow(() => assertDispatcherCompatible(validated, config));
    assert.throws(
      () => assertDispatcherCompatible(validated, { ...config, delivery: { ...config.delivery, autoMerge: false } }),
      /autoMerge=true/,
    );
    assert.throws(
      () => validateDispatcherConfig({ ...dispatcherConfig, readyLabel: "agent:claimed" }),
      /readyLabel must be exactly/,
    );
  } finally { repo.cleanup(); }
});

test("eligible selection preserves parent order and rejects labels, assignees, or blockers", () => {
  const issues = [
    queueIssue(1, { labels: [], openBlockers: 0, assignees: [] }),
    queueIssue(2, { labels: ["ready-for-agent"], openBlockers: 1, assignees: [] }),
    queueIssue(3, { labels: ["ready-for-agent"], openBlockers: 0, assignees: ["someone"] }),
    queueIssue(4, { labels: ["ready-for-agent"], openBlockers: 0, assignees: [] }),
    queueIssue(5, { labels: ["ready-for-agent"], openBlockers: 0, assignees: [] }),
  ];
  assert.equal(selectEligibleIssue(issues, "ready-for-agent")?.number, 4);
  assert.equal(selectEligibleIssue(issues.slice(0, 3), "ready-for-agent"), null);
});

test("dispatcher derives one bounded release plan from the claimed Issue", () => {
  const issue = queueIssue(143);
  const plan = buildDispatchPlan(issue, dispatcherConfig, "2026-08-27T10:00:00.000Z");
  assert.equal(plan.parentIssue, 100);
  assert.equal(plan.issues.length, 1);
  assert.equal(plan.issues[0]?.number, 143);
  assert.deepEqual(plan.issues[0]?.acceptanceCriteria, ["First criterion.", "Second criterion."]);
  assert.match(plan.objective, /Deliver Issue #143: Implement the bounded behavior\./);
});

test("dispatcher gates the next claim on post-merge evidence, then claims it without operator intervention", async () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo, {
      executionMode: "dispatcher-experimental",
      validation: { setup: [], issue: [], release: [], maxOutputBytes: 64 * 1024 },
      delivery: {
        createPullRequest: true,
        draft: false,
        autoMerge: true,
        mergeMethod: "squash",
        allowNoChecks: false,
        pollIntervalMs: 1_000,
      },
    } as any);
    const configPath = join(repo.root, "controller.json");
    const dispatcherPath = join(repo.root, "dispatcher.json");
    writeJsonAtomic(configPath, config);
    writeJsonAtomic(dispatcherPath, dispatcherConfig);
    const store = new JobStore(config);
    const github = new QueueGitHub([queueIssue(143), queueIssue(144)]);
    const mergeSha = git(repo.source, ["rev-parse", "origin/main"]);

    const fakeController = {
      async step(jobId: string): Promise<StepResult> {
        const job = store.load(jobId);
        if (job.phase === "prepare") {
          job.baseSha = mergeSha;
          job.phase = "implement";
          job.issues[0]!.snapshot = snapshotFromQueue(github.issue(job.issues[0]!.number));
          store.save(job);
          return controllerResult("release_prepared", false);
        }
        job.candidateSha = mergeSha;
        job.pullRequest = pullRequestFor(job, mergeSha);
        job.status = "completed";
        job.phase = "complete";
        store.save(job);
        github.lastJob = job;
        github.issue(job.issues[0]!.number).state = "CLOSED";
        return controllerResult("release_merged", true);
      },
    };
    const dispatcher = new IssueDispatcher({
      store,
      controller: fakeController,
      git: new GitClient(config),
      github,
      controllerConfig: config,
      controllerConfigPath: configPath,
      controllerConfigDigest: digestJson(config),
      dispatcherConfig,
      dispatcherConfigPath: dispatcherPath,
      dispatcherConfigDigest: digestJson(dispatcherConfig),
    });

    const actions: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const result = await dispatcher.step();
      actions.push(result.action);
      if (result.action === "issue_claimed" && result.issueNumber === 144) break;
      if (result.terminal) break;
    }
    assert.deepEqual(actions, [
      "issue_selected",
      "issue_claimed",
      "plan_prepared",
      "job_started",
      "controller_release_prepared",
      "pre_worker_source_verified",
      "post_merge_verification_started",
      "issue_completed_verified",
      "issue_selected",
      "issue_claimed",
    ]);
    assert.equal(github.claims, 2);
    assert.equal(dispatcher.status().current?.issueNumber, 144);
    assert.equal(dispatcher.status().current?.phase, "claimed");
    assert.equal(dispatcher.status().history[0]?.issueNumber, 143);
    assert.equal(dispatcher.status().history[0]?.mergeSha, mergeSha);
    assert.deepEqual(dispatcher.status().history[0]?.workflowGate.successes.map((entry) => entry.name), [
      "Test Backend",
      "Playwright Tests",
    ]);
  } finally { repo.cleanup(); }
});

class QueueGitHub extends FakeGitHub {
  claims = 0;
  constructor(readonly issues: QueueIssue[]) { super(); }
  issue(number: number): QueueIssue {
    const issue = this.issues.find((entry) => entry.number === number);
    if (!issue) throw new Error(`fixture Issue #${number} missing`);
    return issue;
  }
  override async currentLogin(): Promise<string> { return "test-user"; }
  override async listSubIssues(_parentIssue: number): Promise<QueueIssue[]> {
    return this.issues.map((issue) => ({ ...issue, labels: [...issue.labels], assignees: [...issue.assignees] }));
  }
  override async fetchQueueIssue(number: number): Promise<QueueIssue> {
    const issue = this.issue(number);
    return { ...issue, labels: [...issue.labels], assignees: [...issue.assignees] };
  }
  override async claimIssue(number: number, login: string): Promise<void> {
    this.claims += 1;
    this.issue(number).assignees = [login];
  }
  override async inspectPullRequest(_number: number) {
    const job = this.lastJob;
    if (!job?.pullRequest) throw new Error("fixture PR missing");
    return { pullRequest: job.pullRequest, checks: { state: "success" as const, failures: [], pending: [] }, mergedAt: nowIso() };
  }
  override async inspectWorkflowGate(sha: string, requiredWorkflows: string[]): Promise<WorkflowGateSummary> {
    return {
      state: "success",
      sha,
      missing: [],
      pending: [],
      failures: [],
      successes: requiredWorkflows.map((name) => ({ name, url: `https://example.invalid/${encodeURIComponent(name)}` })),
      observedAt: nowIso(),
    };
  }
  lastJob: JobState | null = null;
}

function queueIssue(number: number, overrides: Partial<QueueIssue> = {}): QueueIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: [
      "## What to build",
      "",
      "Implement the bounded behavior.",
      "",
      "## Acceptance criteria",
      "",
      "- [ ] First criterion.",
      "- [ ] Second criterion.",
    ].join("\n"),
    state: "OPEN",
    labels: ["ready-for-agent"],
    assignees: [],
    url: `https://github.com/example/project/issues/${number}`,
    openBlockers: 0,
    ...overrides,
  };
}

function snapshotFromQueue(issue: QueueIssue) {
  const identity = {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    assignees: issue.assignees,
    url: issue.url,
    fetchedAt: nowIso(),
  };
  return { ...identity, digest: digestJson(identity) };
}

function pullRequestFor(job: JobState, mergeSha: string): PullRequestState {
  const pullRequest = {
    number: 149,
    url: "https://github.com/example/project/pull/149",
    state: "MERGED" as const,
    headRef: job.branch,
    baseRef: job.baseRef,
    headSha: job.candidateSha!,
    mergeSha,
  };
  return pullRequest;
}

function controllerResult(action: string, terminal: boolean): StepResult {
  return { action, progressed: true, terminal, retryAfterMs: null, message: action };
}
