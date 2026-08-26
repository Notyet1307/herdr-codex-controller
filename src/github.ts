import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ControllerConfig,
  GhCheckSummary,
  IssueSnapshot,
  JobState,
  PullRequestState,
} from "./types.js";
import { runCommand, requireCommandSuccess } from "./command.js";
import { digestJson, nowIso } from "./util.js";
import { writeTextAtomic } from "./fs-atomic.js";

const GH_TIMEOUT_MS = 120_000;
const GH_OUTPUT_BYTES = 4 * 1024 * 1024;

export class GitHubClient {
  constructor(private readonly config: ControllerConfig) {}

  async preflight(): Promise<void> {
    requireCommandSuccess(await this.run(["auth", "status"], 60_000), "gh auth status");
    const result = requireCommandSuccess(await this.run([
      "repo", "view", this.config.repo, "--json", "nameWithOwner",
    ]), "gh repo view");
    const value = parseJson(result.stdoutTail, "gh repo view") as { nameWithOwner?: unknown };
    if (value.nameWithOwner !== this.config.repo) throw new Error("GitHub repository identity differs from config.repo");
  }

  async fetchIssue(number: number): Promise<IssueSnapshot> {
    const result = requireCommandSuccess(await this.run([
      "issue", "view", String(number), "--repo", this.config.repo,
      "--json", "number,title,body,state,labels,assignees,url",
    ]), `gh issue view #${number}`);
    const value = parseJson(result.stdoutTail, `issue #${number}`) as Record<string, unknown>;
    const snapshotIdentity = {
      number: expectInteger(value.number, "issue.number"),
      title: expectString(value.title, "issue.title", false, 500),
      body: expectString(value.body, "issue.body", true, 64 * 1024),
      state: expectState(value.state),
      labels: expectNames(value.labels, "issue.labels"),
      assignees: expectNames(value.assignees, "issue.assignees"),
      url: expectString(value.url, "issue.url", false, 2_000),
      fetchedAt: nowIso(),
    };
    if (snapshotIdentity.number !== number) throw new Error(`GitHub returned issue #${snapshotIdentity.number} for requested #${number}`);
    if (snapshotIdentity.state !== "OPEN") throw new Error(`issue #${number} is not OPEN`);
    return { ...snapshotIdentity, digest: digestJson(snapshotIdentity) };
  }

  async findPullRequest(job: JobState): Promise<PullRequestState | null> {
    const result = await this.run([
      "pr", "view", job.branch, "--repo", this.config.repo,
      "--json", "number,url,state,headRefName,baseRefName,headRefOid,mergedAt",
    ]);
    if (result.exitCode !== 0) {
      const text = `${result.stderrTail}\n${result.stdoutTail}`.toLowerCase();
      if (text.includes("no pull requests found") || text.includes("could not resolve")) return null;
      requireCommandSuccess(result, "gh pr view");
    }
    return parsePullRequest(result.stdoutTail);
  }

  async createPullRequest(job: JobState, deliveryRoot: string): Promise<PullRequestState> {
    const existing = await this.findPullRequest(job);
    if (existing) return existing;
    const bodyPath = join(deliveryRoot, "pull-request-body.md");
    writeTextAtomic(bodyPath, renderPullRequestBody(job));
    const args = [
      "pr", "create", "--repo", this.config.repo,
      "--head", job.branch,
      "--base", job.baseRef,
      "--title", job.plan.title,
      "--body-file", bodyPath,
    ];
    if (this.config.delivery.draft) args.push("--draft");
    requireCommandSuccess(await this.run(args, 5 * 60_000), "gh pr create");
    const created = await this.findPullRequest(job);
    if (!created) throw new Error("pull request creation was not observable");
    return created;
  }

  async inspectPullRequest(number: number): Promise<{
    pullRequest: PullRequestState;
    checks: GhCheckSummary;
    mergedAt: string | null;
  }> {
    const result = requireCommandSuccess(await this.run([
      "pr", "view", String(number), "--repo", this.config.repo,
      "--json", "number,url,state,headRefName,baseRefName,headRefOid,mergedAt,statusCheckRollup",
    ]), "gh inspect pull request");
    const value = parseJson(result.stdoutTail, "pull request") as Record<string, unknown>;
    const pullRequest = parsePullRequestValue(value);
    return {
      pullRequest,
      checks: summarizeChecks(value.statusCheckRollup),
      mergedAt: value.mergedAt === null ? null : expectString(value.mergedAt, "pr.mergedAt"),
    };
  }

  async enableAutoMerge(number: number): Promise<void> {
    const methodFlag = `--${this.config.delivery.mergeMethod}`;
    requireCommandSuccess(await this.run([
      "pr", "merge", String(number), "--repo", this.config.repo, methodFlag, "--auto",
    ], 5 * 60_000), "gh enable auto merge");
  }

  private run(args: string[], timeoutMs = GH_TIMEOUT_MS) {
    return runCommand({
      command: "gh",
      args,
      cwd: this.config.localPath,
      timeoutMs,
      maxTailBytes: GH_OUTPUT_BYTES,
    });
  }
}

function parsePullRequest(raw: string): PullRequestState {
  return parsePullRequestValue(parseJson(raw, "pull request") as Record<string, unknown>);
}

function parsePullRequestValue(value: Record<string, unknown>): PullRequestState {
  const merged = value.mergedAt !== null && value.mergedAt !== undefined;
  const rawState = expectString(value.state, "pr.state");
  const state: PullRequestState["state"] = merged ? "MERGED" : rawState === "OPEN" ? "OPEN" : "CLOSED";
  const headSha = expectString(value.headRefOid, "pr.headRefOid");
  if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error("pull request head SHA is invalid");
  return {
    number: expectInteger(value.number, "pr.number"),
    url: expectString(value.url, "pr.url"),
    state,
    headRef: expectString(value.headRefName, "pr.headRefName"),
    baseRef: expectString(value.baseRefName, "pr.baseRefName"),
    headSha,
  };
}

function summarizeChecks(value: unknown): GhCheckSummary {
  if (!Array.isArray(value) || value.length === 0) return { state: "none", failures: [], pending: [] };
  const failures: GhCheckSummary["failures"] = [];
  const pending: GhCheckSummary["pending"] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const check = raw as Record<string, unknown>;
    const name = stringOr(check.name, stringOr(check.context, "unnamed check"));
    const link = typeof check.detailsUrl === "string" ? check.detailsUrl
      : typeof check.targetUrl === "string" ? check.targetUrl
        : null;
    const conclusion = stringOr(check.conclusion, "").toUpperCase();
    const status = stringOr(check.status, stringOr(check.state, "UNKNOWN")).toUpperCase();
    const effective = conclusion || status;
    if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(effective)) {
      failures.push({ name, state: effective, link });
    } else if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(effective)) {
      pending.push({ name, state: effective || "PENDING", link });
    }
  }
  return failures.length > 0
    ? { state: "failure", failures, pending }
    : pending.length > 0
      ? { state: "pending", failures, pending }
      : { state: "success", failures, pending };
}

function renderPullRequestBody(job: JobState): string {
  const issues = job.issues.map((issue) => `- Closes #${issue.number}`).join("\n");
  const criteria = job.plan.releaseAcceptanceCriteria.length > 0
    ? job.plan.releaseAcceptanceCriteria.map((item) => `- ${item}`).join("\n")
    : "- No additional release-level acceptance criteria were declared.";
  const validations = job.validations
    .filter((entry) => entry.scope === "release")
    .map((entry) => `- ${entry.id}: ${entry.passed ? "passed" : "failed"}`)
    .join("\n") || "- No release validation receipt recorded.";
  return `# ${job.plan.title}\n\n${job.plan.objective}\n\n## Issues\n\n${issues}\n\n## Release acceptance\n\n${criteria}\n\n## Validation\n\n${validations}\n\n## Review\n\n- Candidate: ${job.candidateSha ?? "not recorded"}\n- Review round: ${job.reviewRound}\n- Plan digest: ${job.planDigest}\n`;
}

function parseJson(value: string, label: string): unknown {
  try { return JSON.parse(value); } catch { throw new Error(`${label} did not return valid JSON`); }
}

function expectString(value: unknown, label: string, allowEmpty = false, maximumBytes = 8_192): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) throw new Error(`${label} must be a string`);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  return value;
}

function expectInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function expectState(value: unknown): "OPEN" | "CLOSED" {
  if (value !== "OPEN" && value !== "CLOSED") throw new Error("issue.state must be OPEN or CLOSED");
  return value;
}

function expectNames(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label} must be an array with at most 100 entries`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${label}[${index}] is invalid`);
    const name = (entry as Record<string, unknown>).name ?? (entry as Record<string, unknown>).login;
    return expectString(name, `${label}[${index}].name`, false, 300);
  });
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
