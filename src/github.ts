import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ControllerConfig,
  CiFailureEvidence,
  GhCheckSummary,
  GhCheckObservation,
  IssueSnapshot,
  JobState,
  PullRequestState,
  RequiredCheckContractV1,
} from "./types.js";
import { runCommand, requireCommandSuccess } from "./command.js";
import { digestJson, nowIso, sha256 } from "./util.js";
import { writeTextAtomic } from "./fs-atomic.js";
import { requiredCheckContract, requiredCheckNames } from "./config.js";
import { ControllerError } from "./errors.js";

const GH_TIMEOUT_MS = 120_000;
const GH_OUTPUT_BYTES = 4 * 1024 * 1024;
const CI_EVIDENCE_BYTES = 256 * 1024;

export class GitHubClient {
  constructor(private readonly config: ControllerConfig) {}

  async preflight(): Promise<void> {
    requireCommandSuccess(await this.run(["auth", "status"], 60_000), "gh auth status");
    const result = requireCommandSuccess(await this.run([
      "repo", "view", this.config.repo, "--json", "nameWithOwner",
    ]), "gh repo view");
    const value = parseJson(result.stdoutTail, "gh repo view") as { nameWithOwner?: unknown };
    if (value.nameWithOwner !== this.config.repo) throw new Error("GitHub repository identity differs from config.repo");
    if (this.config.executionMode === "release-plan-v2-direct" && !(await this.baseAllowsUpToDateAutoMerge())) {
      throw new ControllerError("merge_policy_unverified", "Production Controller auto-merge requires strict latest-base pull-request and required-check server policy.");
    }
  }

  async fetchIssue(number: number, options: { allowClosed?: boolean } = {}): Promise<IssueSnapshot> {
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
      labels: expectNames(value.labels, "issue.labels", "name"),
      assignees: expectNames(value.assignees, "issue.assignees", "login"),
      url: expectString(value.url, "issue.url", false, 2_000),
      fetchedAt: nowIso(),
    };
    if (snapshotIdentity.number !== number) throw new Error(`GitHub returned issue #${snapshotIdentity.number} for requested #${number}`);
    if (snapshotIdentity.state !== "OPEN" && !options.allowClosed) throw new Error(`issue #${number} is not OPEN`);
    return { ...snapshotIdentity, digest: digestJson(snapshotIdentity) };
  }

  async findPullRequest(job: JobState): Promise<PullRequestState | null> {
    const result = await this.run([
      "pr", "view", job.branch, "--repo", this.config.repo,
      "--json", "number,url,state,headRefName,baseRefName,headRefOid,mergedAt,mergeCommit",
    ]);
    if (result.exitCode !== 0) {
      const text = `${result.stderrTail}\n${result.stdoutTail}`.toLowerCase();
      if (text.includes("no pull requests found") || text.includes("could not resolve")) return null;
      requireCommandSuccess(result, "gh pr view");
    }
    return parsePullRequest(result.stdoutTail);
  }

  async createPullRequest(job: JobState, deliveryRoot: string, body: string): Promise<PullRequestState> {
    const existing = await this.findPullRequest(job);
    if (existing && existing.state !== "CLOSED") return existing;
    const bodyPath = join(deliveryRoot, "pull-request-body.md");
    writeTextAtomic(bodyPath, body);
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
    autoMergeEnabled: boolean;
  }> {
    const result = requireCommandSuccess(await this.run([
      "pr", "view", String(number), "--repo", this.config.repo,
      "--json", "number,url,state,headRefName,baseRefName,headRefOid,mergedAt,mergeCommit,statusCheckRollup,autoMergeRequest",
    ]), "gh inspect pull request");
    const value = parseJson(result.stdoutTail, "pull request") as Record<string, unknown>;
    const pullRequest = parsePullRequestValue(value);
    const checkValues = await this.checkRunsForCandidate(pullRequest.headSha, value.statusCheckRollup);
    return {
      pullRequest,
      checks: summarizeChecks(checkValues, this.config.delivery.requiredChecks),
      mergedAt: value.mergedAt === null ? null : expectString(value.mergedAt, "pr.mergedAt"),
      autoMergeEnabled: value.autoMergeRequest !== null && value.autoMergeRequest !== undefined,
    };
  }

  async baseAllowsUpToDateAutoMerge(): Promise<boolean> {
    const branch = encodeURIComponent(this.config.baseRef);
    const rules = await this.readApi(`repos/${this.config.repo}/rules/branches/${branch}`);
    const protection = await this.readApi(`repos/${this.config.repo}/branches/${branch}/protection`);
    let pullRequestsRequired = false;
    const strictChecks = new Map<string, Set<number | null>>();

    if (Array.isArray(rules)) {
      for (const raw of rules) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const rule = raw as Record<string, unknown>;
        if (rule.type === "pull_request") pullRequestsRequired = true;
        if (rule.type !== "required_status_checks") continue;
        const parameters = objectOrNull(rule.parameters);
        if (parameters?.strict_required_status_checks_policy !== true) continue;
        addRequiredCheckContexts(strictChecks, parameters.required_status_checks);
      }
    }

    const classic = objectOrNull(protection);
    if (classic) {
      if (objectOrNull(classic.required_pull_request_reviews)) pullRequestsRequired = true;
      const statusChecks = objectOrNull(classic.required_status_checks);
      if (statusChecks?.strict === true) {
        addRequiredCheckContexts(strictChecks, statusChecks.contexts);
        addRequiredCheckContexts(strictChecks, statusChecks.checks);
      }
    }

    const contract = requiredCheckContract(this.config);
    const checksVerified = contract
      ? contract.checks.filter((check) => check.required).every((check) => (
        check.appId !== null && strictChecks.get(check.name)?.has(check.appId) === true
      ))
      : requiredCheckNames(this.config).every((name) => strictChecks.has(name));
    return pullRequestsRequired && checksVerified;
  }

  async enableAutoMerge(number: number, candidateSha: string): Promise<void> {
    requireCommandSuccess(await this.run(
      autoMergeArgs(number, this.config.repo, this.config.delivery.mergeMethod, candidateSha),
      5 * 60_000,
    ), "gh enable auto merge");
  }

  async disableAutoMerge(number: number, candidateSha: string): Promise<void> {
    const before = await this.assertCandidatePullRequest(number, candidateSha);
    if (!before.autoMergeEnabled) return;
    requireCommandSuccess(await this.run([
      "pr", "merge", String(number), "--repo", this.config.repo,
      "--disable-auto", "--match-head-commit", candidateSha,
    ], 5 * 60_000), "gh disable auto merge");
    const after = await this.assertCandidatePullRequest(number, candidateSha);
    if (after.autoMergeEnabled) throw new Error("GitHub auto-merge revocation was not observable");
  }

  async fetchCheckFailureEvidence(check: GhCheckObservation, candidateSha: string): Promise<CiFailureEvidence> {
    const runId = await this.assertWorkflowRunIdentity(check, candidateSha);
    const result = requireCommandSuccess(await this.run([
      "run", "view", String(runId), "--repo", this.config.repo, "--log-failed",
    ], GH_TIMEOUT_MS, CI_EVIDENCE_BYTES), "gh read failed check evidence");
    const log = sanitizeCheckLog(result.stdoutTail || result.stderrTail);
    if (!log.trim()) throw new Error("failed check evidence is empty");
    const body = {
      version: 1 as const,
      candidateSha,
      check,
      log,
      logBytes: Buffer.byteLength(log, "utf8"),
      logSha256: `sha256:${sha256(log)}`,
      observedAt: nowIso(),
    };
    return { ...body, digest: `sha256:${digestJson(body)}` };
  }

  async rerunCheck(check: GhCheckObservation, candidateSha: string): Promise<void> {
    const runId = await this.assertWorkflowRunIdentity(check, candidateSha);
    requireCommandSuccess(await this.run([
      "run", "rerun", String(runId), "--repo", this.config.repo, "--failed",
    ], 5 * 60_000), "gh rerun failed workflow");
  }

  private run(args: string[], timeoutMs = GH_TIMEOUT_MS, outputBytes = GH_OUTPUT_BYTES) {
    return runCommand({
      command: "gh",
      args,
      cwd: this.config.localPath,
      timeoutMs,
      maxTailBytes: outputBytes,
      stdoutByteLimit: outputBytes,
      stderrByteLimit: outputBytes,
      aggregateByteLimit: outputBytes * 2,
    });
  }

  private async readApi(endpoint: string): Promise<unknown | null> {
    const result = await this.run(["api", endpoint]);
    return result.exitCode === 0 ? parseJson(result.stdoutTail, endpoint) : null;
  }

  private async assertCandidatePullRequest(number: number, candidateSha: string, allowClosed = false) {
    if (!/^[0-9a-f]{40}$/iu.test(candidateSha)) throw new Error("pull request candidate SHA is invalid");
    const observed = await this.inspectPullRequest(number);
    if (observed.pullRequest.number !== number || observed.pullRequest.headSha !== candidateSha
      || observed.pullRequest.baseRef !== this.config.baseRef
      || (!allowClosed && observed.pullRequest.state !== "OPEN")) {
      throw new Error("pull request lifecycle identity mismatch");
    }
    return observed;
  }

  private async assertWorkflowRunIdentity(check: GhCheckObservation, candidateSha: string): Promise<number> {
    if (!check.runId || !Number.isSafeInteger(check.runId) || check.runId < 1) throw new Error("check run identity is unavailable");
    const result = requireCommandSuccess(await this.run([
      "run", "view", String(check.runId), "--repo", this.config.repo,
      "--json", "databaseId,headSha,name,workflowName,status,conclusion,url",
    ]), "gh inspect workflow run");
    const value = parseJson(result.stdoutTail, "workflow run") as Record<string, unknown>;
    if (expectInteger(value.databaseId, "workflow run databaseId") !== check.runId
      || expectString(value.headSha, "workflow run headSha") !== candidateSha
      || (check.workflowName !== null && expectString(value.workflowName ?? value.name, "workflow run name") !== check.workflowName)) {
      throw new Error("workflow run identity differs from the candidate-bound check");
    }
    return check.runId;
  }

  private async checkRunsForCandidate(candidateSha: string, rollupValue: unknown): Promise<unknown[]> {
    const rollup = Array.isArray(rollupValue) ? rollupValue : [];
    if (!requiredCheckContract(this.config)) return rollup;
    const raw = objectOrNull(await this.readApi(`repos/${this.config.repo}/commits/${candidateSha}/check-runs?filter=latest&per_page=100`));
    const checkRuns = Array.isArray(raw?.check_runs) ? raw.check_runs : null;
    if (!checkRuns || (Number.isSafeInteger(raw?.total_count) && Number(raw?.total_count) > 100)) return rollup;
    const normalized = checkRuns.flatMap((value) => {
      const run = objectOrNull(value);
      if (!run) return [];
      const name = typeof run.name === "string" ? run.name : "";
      const detailsUrl = typeof run.details_url === "string" ? run.details_url : null;
      const matching = rollup.find((entry) => {
        const check = objectOrNull(entry);
        return check?.name === name && (detailsUrl === null || check.detailsUrl === detailsUrl);
      });
      const match = objectOrNull(matching);
      return [{
        name,
        status: run.status,
        conclusion: run.conclusion,
        detailsUrl,
        app: run.app,
        workflowName: typeof match?.workflowName === "string" ? match.workflowName : null,
      }];
    });
    const normalizedNames = new Set(normalized.map((entry) => entry.name));
    const statuses = rollup.filter((entry) => {
      const check = objectOrNull(entry);
      return check?.__typename !== "CheckRun" && (typeof check?.name !== "string" || !normalizedNames.has(check.name));
    });
    return [...normalized, ...statuses];
  }

}

export function autoMergeArgs(
  number: number,
  repo: string,
  mergeMethod: ControllerConfig["delivery"]["mergeMethod"],
  candidateSha: string,
): string[] {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("pull request number is invalid");
  if (!/^[0-9a-f]{40}$/i.test(candidateSha)) throw new Error("auto-merge candidate SHA is invalid");
  return [
    "pr", "merge", String(number), "--repo", repo,
    `--${mergeMethod}`, "--auto", "--match-head-commit", candidateSha,
  ];
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
    mergeSha: parseMergeSha(value.mergeCommit),
  };
}

function parseMergeSha(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pr.mergeCommit is invalid");
  const sha = expectString((value as Record<string, unknown>).oid, "pr.mergeCommit.oid");
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error("pull request merge SHA is invalid");
  return sha;
}

export function summarizeChecks(value: unknown, requiredChecks: string[] | RequiredCheckContractV1 = []): GhCheckSummary {
  if (!Array.isArray(requiredChecks)) return summarizeContractChecks(value, requiredChecks);
  if (!Array.isArray(value) || value.length === 0) {
    return { state: "none", missing: [...requiredChecks], failures: [], pending: [] };
  }
  const failures: GhCheckSummary["failures"] = [];
  const pending: GhCheckSummary["pending"] = [];
  const observed = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const check = raw as Record<string, unknown>;
    const name = stringOr(check.name, stringOr(check.context, "unnamed check"));
    observed.add(name);
    const link = typeof check.detailsUrl === "string" ? check.detailsUrl
      : typeof check.targetUrl === "string" ? check.targetUrl
        : null;
    const conclusion = stringOr(check.conclusion, "").toUpperCase();
    const status = stringOr(check.status, stringOr(check.state, "UNKNOWN")).toUpperCase();
    const effective = conclusion || status;
    if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE", "NEUTRAL", "SKIPPED"].includes(effective)) {
      failures.push({ name, state: effective, link });
    } else if (effective !== "SUCCESS") {
      pending.push({ name, state: effective || "PENDING", link });
    }
  }
  const missing = requiredChecks.filter((name) => !observed.has(name));
  return failures.length > 0
    ? { state: "failure", missing, failures, pending }
    : pending.length > 0 || missing.length > 0
      ? { state: "pending", missing, failures, pending }
      : { state: "success", missing, failures, pending };
}

function summarizeContractChecks(value: unknown, contract: RequiredCheckContractV1): GhCheckSummary {
  const observations = Array.isArray(value)
    ? value.flatMap((entry) => {
      const parsed = parseCheckObservation(entry);
      return parsed ? [parsed] : [];
    })
    : [];
  const missing: string[] = [];
  const failures: GhCheckSummary["failures"] = [];
  const pending: GhCheckSummary["pending"] = [];
  const successes: NonNullable<GhCheckSummary["successes"]> = [];
  const ambiguous: string[] = [];
  for (const expected of contract.checks) {
    if (!expected.required) continue;
    const sameName = observations.filter(({ name }) => name === expected.name);
    if (sameName.length === 0) {
      if (expected.required) missing.push(expected.name);
      continue;
    }
    if (sameName.length !== 1) {
      ambiguous.push(expected.name);
      continue;
    }
    const observed = sameName[0]!;
    if ((expected.appId !== null && observed.appId !== expected.appId)
      || (expected.workflowName !== null && observed.workflowName !== expected.workflowName)) {
      ambiguous.push(expected.name);
      continue;
    }
    if (observed.status !== "COMPLETED" || !observed.conclusion) {
      pending.push({ name: expected.name, state: observed.status || "PENDING", link: observed.link });
    } else if (expected.acceptedConclusions.includes(observed.conclusion as "SUCCESS" | "NEUTRAL" | "SKIPPED")) {
      successes.push({ name: expected.name, state: observed.conclusion, link: observed.link });
    } else {
      failures.push({ name: expected.name, state: observed.conclusion, link: observed.link });
    }
  }
  return {
    state: ambiguous.length > 0 || failures.length > 0
      ? "failure"
      : missing.length > 0 || pending.length > 0
        ? "pending"
        : "success",
    missing,
    failures,
    pending,
    successes,
    ambiguous,
    observations,
    observedAt: nowIso(),
  };
}

function parseCheckObservation(value: unknown): GhCheckObservation | null {
  const check = objectOrNull(value);
  if (!check) return null;
  const name = stringOr(check.name, stringOr(check.context, ""));
  if (!name) return null;
  const app = objectOrNull(check.app);
  const rawAppId = app?.id ?? app?.databaseId ?? check.appId;
  const appId = Number.isSafeInteger(rawAppId) && Number(rawAppId) > 0 ? Number(rawAppId) : null;
  const link = typeof check.detailsUrl === "string" ? check.detailsUrl
    : typeof check.targetUrl === "string" ? check.targetUrl
      : null;
  const runMatch = link?.match(/\/actions\/runs\/(\d+)/u);
  return {
    name,
    status: stringOr(check.status, stringOr(check.state, "UNKNOWN")).toUpperCase(),
    conclusion: stringOr(check.conclusion, "").toUpperCase(),
    link,
    appId,
    workflowName: typeof check.workflowName === "string" && check.workflowName.trim() ? check.workflowName : null,
    runId: runMatch ? Number(runMatch[1]) : null,
  };
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sanitizeCheckLog(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}

function addRequiredCheckContexts(target: Map<string, Set<number | null>>, value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (typeof entry === "string") addRequiredCheckContext(target, entry, null);
    else {
      const object = objectOrNull(entry);
      if (typeof object?.context === "string") {
        const rawAppId = object.app_id ?? object.integration_id ?? object.appId;
        const appId = Number.isSafeInteger(rawAppId) && Number(rawAppId) > 0 ? Number(rawAppId) : null;
        addRequiredCheckContext(target, object.context, appId);
      }
    }
  }
}

function addRequiredCheckContext(target: Map<string, Set<number | null>>, name: string, appId: number | null): void {
  const identities = target.get(name) ?? new Set<number | null>();
  identities.add(appId);
  target.set(name, identities);
}

export { renderPullRequestBody } from "./report.js";

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

function expectNames(value: unknown, label: string, identityKey: "name" | "login"): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label} must be an array with at most 100 entries`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${label}[${index}] is invalid`);
    const identity = (entry as Record<string, unknown>)[identityKey];
    return expectString(identity, `${label}[${index}].${identityKey}`, false, 300);
  });
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
