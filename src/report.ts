import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateReviewResult, validateWorkerResult } from "./codex.js";
import { validateConfig } from "./config.js";
import { ControllerError } from "./errors.js";
import { readJsonFile, writePublicTextAtomic } from "./fs-atomic.js";
import type { GitPort } from "./ports.js";
import type { JobStore } from "./state.js";
import { REPLAN_REQUIRED_CODE } from "./state.js";
import type {
  ControllerConfig,
  GhCheckSummary,
  JobState,
  ReviewResult,
  ValidationReceipt,
  WorkerResult,
} from "./types.js";
import { digestJson, pathWithin, sha256 } from "./util.js";
import { assertValidationReceipt } from "./validator.js";
import { assertReviewDemoResult } from "./demo.js";
import type { ReviewDemoResult } from "./types.js";

const MAX_REPORT_BYTES = 512 * 1024;
const MAX_CHANGED_PATHS = 100;
const MAX_DIFF_STAT_BYTES = 12 * 1024;
const MAX_CHECKS = 80;
const MAX_EXCERPT_BYTES = 1_024;
const MAX_AGENT_RUNS = 30;
const MAX_CRITERIA = 200;

export type ReleaseReportModel = {
  result: {
    status: "RUNNING" | "BLOCKED" | "COMPLETED" | "FAILED";
    phase: string;
    releaseId: string;
    baseSha: string | null;
    candidateSha: string | null;
    mergeSha: string | null;
    pullRequest: { number: number; url: string; state: string } | null;
  };
  goal: {
    title: string;
    objective: string;
    issues: Array<{
      number: number;
      objective: string;
      acceptanceCriteria: string[];
    }>;
    omittedCriteria: number;
    releaseAcceptanceCriteria: string[];
    reviewFocus: string[];
  };
  change: {
    available: boolean;
    files: number;
    changedLines: number;
    diffStat: string;
    changedPaths: string[];
    omittedPaths: number;
  };
  checks: Array<{
    stage: string;
    command: string;
    status: "PASS" | "FAIL" | "PENDING" | "MISSING";
    durationMs: number | null;
    stdoutExcerpt: string;
    stderrExcerpt: string;
    url: string | null;
  }>;
  omittedChecks: number;
  agentSelfReview: Array<{
    kind: string;
    issueNumber: number | null;
    status: "completed" | "blocked" | "unavailable";
    summary: string;
    performed: boolean | null;
    findingsFixed: string[];
    remainingConcerns: string[];
    residualRisks: string[];
  }>;
  omittedAgentRuns: number;
  aggregateReview: {
    status: "PASS" | "CHANGES" | "BLOCKED" | "NOT RUN" | "UNAVAILABLE";
    summary: string;
    findings: Array<{
      severity: string;
      path: string | null;
      line: number | null;
      summary: string;
      rationale: string;
      recommendation: string;
    }>;
  };
  demonstration: {
    status: "PASS" | "WARN" | "NOT RUN";
    command: string | null;
    required: boolean | null;
    networkAccess: boolean | null;
    exitCode: number | null;
    durationMs: number | null;
    stdoutExcerpt: string;
    stderrExcerpt: string;
    artifacts: Array<{ path: string; mediaType: string; bytes: number }>;
    error: string | null;
  };
  remainingConcerns: {
    items: string[];
    blockedReason: string | null;
    recovery: string | null;
  };
  howToReview: {
    pullRequestDiffUrl: string | null;
    releaseCommands: string[];
    ciLinks: string[];
  };
  technical: {
    planDigest: string;
    baseSha: string | null;
    candidateSha: string | null;
    mergeSha: string | null;
    validationDigests: string[];
    reviewDigest: string | null;
  };
};

export async function buildReleaseReportModel(input: {
  job: JobState;
  config: ControllerConfig;
  jobRoot: string;
  git: GitPort;
}): Promise<ReleaseReportModel> {
  const clean = cleaner(input.config, input.job);
  const diff = await input.git.reportDiffStats(input.job);
  const validationChecks: ReleaseReportModel["checks"] = [];
  const validationDigests: string[] = [];
  for (const binding of input.job.validations) {
    const receipt = readPrivateJson<ValidationReceipt>(input.jobRoot, binding.path);
    try { assertValidationReceipt(receipt); }
    catch { throw new ControllerError("report_validation_invalid", `Validation receipt ${binding.id} is invalid.`); }
    if (receipt.id !== binding.id || receipt.scope !== binding.scope || receipt.issueNumber !== binding.issueNumber
      || receipt.passed !== binding.passed || receipt.digest !== binding.digest) {
      throw new ControllerError("report_validation_invalid", `Validation receipt ${binding.id} differs from its Job binding.`);
    }
    validationDigests.push(receipt.digest);
    for (const command of receipt.commands) {
      validationChecks.push({
        stage: receipt.scope === "setup" ? "Baseline" : receipt.scope === "issue" ? `Issue #${receipt.issueNumber}` : "Release",
        command: clean(command.command, 1_000),
        status: command.exitCode === 0 && command.signal === null && !command.timedOut && command.outputLimitExceeded !== true
          ? "PASS"
          : "FAIL",
        durationMs: command.durationMs,
        stdoutExcerpt: clean(command.stdoutTail, MAX_EXCERPT_BYTES, true),
        stderrExcerpt: clean(command.stderrTail, MAX_EXCERPT_BYTES, true),
        url: null,
      });
    }
  }

  const ciChecks = renderCiChecks(input.job.ciGate?.lastObservation ?? null, input.job, clean);
  const allChecks = [...validationChecks, ...ciChecks];
  const checks = allChecks.slice(0, MAX_CHECKS);
  const agentRuns: ReleaseReportModel["agentSelfReview"] = [];
  for (const run of input.job.runs.filter(({ kind }) => kind !== "review")) {
    const result = readOptionalWorkerResult(input.jobRoot, run.resultPath, run.resultDigest);
    agentRuns.push(result ? {
      kind: run.kind,
      issueNumber: run.issueNumber,
      status: result.status,
      summary: clean(result.summary, 1_000),
      performed: result.selfReview.performed,
      findingsFixed: result.selfReview.findingsFixed.slice(0, 5).map((item) => clean(item, 300)),
      remainingConcerns: result.selfReview.remainingConcerns.slice(0, 5).map((item) => clean(item, 300)),
      residualRisks: result.residualRisks.slice(0, 5).map((item) => clean(item, 300)),
    } : {
      kind: run.kind,
      issueNumber: run.issueNumber,
      status: "unavailable",
      summary: "No valid structured Worker result is available for this run.",
      performed: null,
      findingsFixed: [],
      remainingConcerns: [],
      residualRisks: [],
    });
  }

  const review = readAggregateReview(input.jobRoot, input.job);
  const concerns = unique(agentRuns.flatMap((run) => [...run.remainingConcerns, ...run.residualRisks])).slice(0, 50);
  const criteria = input.job.plan.issues.flatMap((issue) => issue.acceptanceCriteria);
  let remainingCriteria = MAX_CRITERIA;
  const issues = input.job.plan.issues.map((issue) => {
    const acceptanceCriteria = issue.acceptanceCriteria.slice(0, remainingCriteria).map((item) => clean(item, 500));
    remainingCriteria -= acceptanceCriteria.length;
    return {
      number: issue.number,
      objective: clean(issue.objective ?? "No separate Issue objective was declared.", 1_000),
      acceptanceCriteria,
    };
  });
  const pullRequestUrl = safeUrl(input.job.pullRequest?.url ?? null);
  const ciLinks = unique(ciChecks.flatMap(({ url }) => url ? [url] : [])).slice(0, 100);
  const reviewRecord = [...input.job.runs].reverse().find(({ kind, resultPath }) => (
    kind === "review" && resultPath === input.job.lastReviewPath
  ));
  const demo = readReviewDemo(input.jobRoot, input.job);

  return {
    result: {
      status: reportStatus(input.job),
      phase: input.job.phase,
      releaseId: clean(input.job.id, 120),
      baseSha: input.job.baseSha,
      candidateSha: input.job.candidateSha,
      mergeSha: input.job.pullRequest?.mergeSha ?? null,
      pullRequest: input.job.pullRequest ? {
        number: input.job.pullRequest.number,
        url: pullRequestUrl ?? "",
        state: input.job.pullRequest.state,
      } : null,
    },
    goal: {
      title: clean(input.job.plan.title, 500),
      objective: clean(input.job.plan.objective, 4_000),
      issues,
      omittedCriteria: Math.max(0, criteria.length - (MAX_CRITERIA - remainingCriteria)),
      releaseAcceptanceCriteria: input.job.plan.releaseAcceptanceCriteria.slice(0, 50).map((item) => clean(item, 500)),
      reviewFocus: input.job.plan.reviewFocus.slice(0, 20).map((item) => clean(item, 500)),
    },
    change: diff ? {
      available: true,
      files: diff.files,
      changedLines: diff.changedLines,
      diffStat: clean(diff.summary, MAX_DIFF_STAT_BYTES, true),
      changedPaths: diff.paths.slice(0, MAX_CHANGED_PATHS).map((path) => clean(path, 1_000)),
      omittedPaths: Math.max(0, diff.paths.length - MAX_CHANGED_PATHS),
    } : {
      available: false,
      files: 0,
      changedLines: 0,
      diffStat: "",
      changedPaths: [],
      omittedPaths: 0,
    },
    checks,
    omittedChecks: Math.max(0, allChecks.length - checks.length),
    agentSelfReview: agentRuns.slice(0, MAX_AGENT_RUNS),
    omittedAgentRuns: Math.max(0, agentRuns.length - MAX_AGENT_RUNS),
    aggregateReview: review ? {
      status: review.status.toUpperCase() as "PASS" | "CHANGES" | "BLOCKED",
      summary: clean(review.summary, 1_000),
      findings: review.findings.map((finding) => ({
        severity: finding.severity,
        path: finding.path === null ? null : clean(finding.path, 500),
        line: finding.line,
        summary: clean(finding.summary, 500),
        rationale: clean(finding.rationale, 500),
        recommendation: clean(finding.recommendation, 500),
      })),
    } : {
      status: input.job.lastReviewPath ? "UNAVAILABLE" : "NOT RUN",
      summary: input.job.lastReviewPath
        ? "The Job references an aggregate review, but no valid structured result is available."
        : "Aggregate review has not run.",
      findings: [],
    },
    demonstration: demo ? {
      status: demo.passed ? "PASS" : "WARN",
      command: clean(demo.command, 1_000),
      required: demo.required,
      networkAccess: demo.networkAccess,
      exitCode: demo.exitCode,
      durationMs: demo.durationMs,
      stdoutExcerpt: clean(demo.stdoutTail, MAX_EXCERPT_BYTES, true),
      stderrExcerpt: clean(demo.stderrTail, MAX_EXCERPT_BYTES, true),
      artifacts: demo.artifacts.map((artifact) => ({ ...artifact, path: clean(artifact.path, 1_000) })),
      error: demo.error === null ? null : clean(demo.error, 1_000),
    } : {
      status: "NOT RUN",
      command: null,
      required: input.config.reviewDemo?.required ?? null,
      networkAccess: input.config.reviewDemo?.networkAccess ?? null,
      exitCode: null,
      durationMs: null,
      stdoutExcerpt: "",
      stderrExcerpt: "",
      artifacts: [],
      error: null,
    },
    remainingConcerns: {
      items: concerns,
      blockedReason: input.job.blocked ? clean(`${input.job.blocked.code}: ${input.job.blocked.message}`, 2_000) : null,
      recovery: input.job.blocked
        ? input.job.blocked.code === REPLAN_REQUIRED_CODE
          ? "Abort this Job, return to Planner for a new approved Plan, and start a new Job."
          : "Resolve the blocker and provide fresh recovery evidence before retrying this Job."
        : null,
    },
    howToReview: {
      pullRequestDiffUrl: pullRequestUrl ? `${pullRequestUrl.replace(/\/$/u, "")}/files` : null,
      releaseCommands: input.config.validation.release.slice(0, 20).map(({ command }) => clean(command, 1_000)),
      ciLinks,
    },
    technical: {
      planDigest: input.job.planDigest,
      baseSha: input.job.baseSha,
      candidateSha: input.job.candidateSha,
      mergeSha: input.job.pullRequest?.mergeSha ?? null,
      validationDigests,
      reviewDigest: reviewRecord?.resultDigest ?? null,
    },
  };
}

export function renderReleaseReport(model: ReleaseReportModel): string {
  const result = model.result;
  const lines = [
    "# Release Review",
    "",
    "## Result",
    "",
    `- Status: **${result.status}**`,
    `- Phase: \`${code(result.phase)}\``,
    `- Release: \`${code(result.releaseId)}\``,
    `- Base: ${shortIdentity(result.baseSha)}`,
    `- Candidate: ${shortIdentity(result.candidateSha)}`,
    `- Merge: ${shortIdentity(result.mergeSha)}`,
    `- Pull request: ${result.pullRequest ? `[${result.pullRequest.number}](${result.pullRequest.url}) (${result.pullRequest.state})` : "Not created"}`,
    "",
    "## Goal and scope",
    "",
    `### ${inline(model.goal.title)}`,
    "",
    inline(model.goal.objective),
    "",
    "### Included Issues",
    "",
  ];
  for (const issue of model.goal.issues) {
    lines.push(`#### Issue #${issue.number}`, "", inline(issue.objective), "");
    lines.push(...bullets(issue.acceptanceCriteria, "No acceptance criteria were recorded in the report bound."), "");
  }
  if (model.goal.omittedCriteria > 0) lines.push(`- ${model.goal.omittedCriteria} additional criteria omitted by the report size bound.`, "");
  lines.push("### Release acceptance criteria", "", ...bullets(model.goal.releaseAcceptanceCriteria), "");
  lines.push("### Review focus", "", ...bullets(model.goal.reviewFocus), "");
  lines.push("## Change summary", "");
  if (!model.change.available) {
    lines.push("- No base-bound committed diff is available yet.", "");
  } else {
    lines.push(`- Files: ${model.change.files}`, `- Changed lines: ${model.change.changedLines}`, "", "### Diff stat", "");
    lines.push(...indented(model.change.diffStat || "No diff."), "", "### Changed paths", "");
    lines.push(...bullets(model.change.changedPaths.map((path) => `\`${code(path)}\``), "None."));
    if (model.change.omittedPaths > 0) lines.push(`- ${model.change.omittedPaths} additional paths omitted by the report bound.`);
    lines.push("");
  }
  lines.push("## Checks actually executed", "");
  if (model.checks.length === 0) lines.push("No Controller validation or CI result has been recorded.", "");
  else {
    lines.push("| Stage | Command/check | Result | Duration |", "| --- | --- | --- | ---: |");
    for (const check of model.checks) {
      const command = check.url ? `[${inline(check.command)}](${check.url})` : `\`${code(check.command)}\``;
      lines.push(`| ${inline(check.stage)} | ${command} | ${check.status} | ${check.durationMs === null ? "—" : formatDuration(check.durationMs)} |`);
    }
    lines.push("");
    const excerpts = model.checks.filter(({ stdoutExcerpt, stderrExcerpt }) => stdoutExcerpt || stderrExcerpt);
    if (excerpts.length > 0) {
      lines.push("<details>", "<summary>Bounded output excerpts</summary>", "");
      for (const check of excerpts) {
        lines.push(`### ${inline(check.stage)} — ${inline(check.command)}`, "");
        if (check.stdoutExcerpt) lines.push("stdout:", "", ...indented(check.stdoutExcerpt), "");
        if (check.stderrExcerpt) lines.push("stderr:", "", ...indented(check.stderrExcerpt), "");
      }
      lines.push("</details>", "");
    }
  }
  if (model.omittedChecks > 0) lines.push(`${model.omittedChecks} additional checks omitted by the report size bound.`, "");
  lines.push("## Agent self-review", "", "_Agent-reported; this is not Controller proof._", "");
  if (model.agentSelfReview.length === 0) lines.push("No structured Worker result has been recorded.", "");
  for (const run of model.agentSelfReview) {
    lines.push(`### ${inline(run.kind)}${run.issueNumber === null ? "" : ` — Issue #${run.issueNumber}`}`, "");
    lines.push(`- Status: ${run.status}`, `- Summary: ${inline(run.summary)}`, `- Self-review performed: ${run.performed === null ? "unknown" : run.performed ? "yes" : "no"}`);
    lines.push(`- Findings fixed: ${run.findingsFixed.length ? run.findingsFixed.map(inline).join("; ") : "None reported"}`);
    lines.push(`- Remaining concerns: ${run.remainingConcerns.length ? run.remainingConcerns.map(inline).join("; ") : "None reported"}`);
    lines.push(`- Residual risks: ${run.residualRisks.length ? run.residualRisks.map(inline).join("; ") : "None reported"}`, "");
  }
  if (model.omittedAgentRuns > 0) lines.push(`${model.omittedAgentRuns} additional Agent runs omitted by the report size bound.`, "");
  lines.push("## Aggregate review", "", "_Reviewer judgment; this is not deterministic proof._", "");
  lines.push(`- Status: **${model.aggregateReview.status}**`, `- Summary: ${inline(model.aggregateReview.summary)}`, "");
  if (model.aggregateReview.findings.length === 0) lines.push("No findings recorded.", "");
  else for (const [index, finding] of model.aggregateReview.findings.entries()) {
    const location = finding.path ? ` — \`${code(finding.path)}${finding.line ? `:${finding.line}` : ""}\`` : "";
    lines.push(`### Finding ${index + 1}: ${inline(finding.severity)}${location}`, "");
    lines.push(`- Summary: ${inline(finding.summary)}`, `- Rationale: ${inline(finding.rationale)}`, `- Recommendation: ${inline(finding.recommendation)}`, "");
  }
  lines.push("## Demonstration", "");
  lines.push(`- Status: **${model.demonstration.status}**`);
  if (model.demonstration.command) {
    lines.push(`- Command: \`${code(model.demonstration.command)}\``);
    lines.push(`- Required: ${model.demonstration.required ? "yes" : "no"}`);
    lines.push(`- Network: ${model.demonstration.networkAccess ? "network-enabled demonstration" : "disabled"}`);
    lines.push(`- Exit: ${model.demonstration.exitCode ?? "not available"}`);
    lines.push(`- Duration: ${model.demonstration.durationMs === null ? "not available" : formatDuration(model.demonstration.durationMs)}`);
    if (model.demonstration.error) lines.push(`- Error: ${inline(model.demonstration.error)}`);
    lines.push("- Artifacts:");
    lines.push(...model.demonstration.artifacts.map((artifact) => `  - \`${code(artifact.path)}\` — ${artifact.mediaType}, ${artifact.bytes} bytes`));
    if (model.demonstration.artifacts.length === 0) lines.push("  - None.");
    if (model.demonstration.stdoutExcerpt) lines.push("", "stdout:", "", ...indented(model.demonstration.stdoutExcerpt));
    if (model.demonstration.stderrExcerpt) lines.push("", "stderr:", "", ...indented(model.demonstration.stderrExcerpt));
  } else lines.push("- No Review Demo is recorded for the current candidate.");
  lines.push("");
  lines.push("## Remaining concerns", "");
  lines.push(...bullets(model.remainingConcerns.items, "None observed."));
  if (model.remainingConcerns.blockedReason) lines.push(`- Blocked reason: ${inline(model.remainingConcerns.blockedReason)}`);
  if (model.remainingConcerns.recovery) lines.push(`- Required recovery: ${inline(model.remainingConcerns.recovery)}`);
  lines.push("", "## How to review", "");
  lines.push(`- PR diff: ${model.howToReview.pullRequestDiffUrl ? `[open diff](${model.howToReview.pullRequestDiffUrl})` : "Not available"}`);
  lines.push("- Minimum configured release checks:");
  lines.push(...model.howToReview.releaseCommands.map((command) => `  - \`${code(command)}\``));
  if (model.howToReview.releaseCommands.length === 0) lines.push("  - None configured.");
  lines.push("- CI links:");
  lines.push(...model.howToReview.ciLinks.map((url) => `  - [${url}](${url})`));
  if (model.howToReview.ciLinks.length === 0) lines.push("  - None recorded.");
  lines.push("", "<details>", "<summary>Technical details</summary>", "");
  lines.push(`- Plan digest: \`${model.technical.planDigest}\``);
  lines.push(`- Base SHA: ${fullIdentity(model.technical.baseSha)}`);
  lines.push(`- Candidate SHA: ${fullIdentity(model.technical.candidateSha)}`);
  lines.push(`- Merge SHA: ${fullIdentity(model.technical.mergeSha)}`);
  lines.push(`- Validation digests: ${model.technical.validationDigests.length ? model.technical.validationDigests.map((value) => `\`${value}\``).join(", ") : "None"}`);
  lines.push(`- Review digest: ${model.technical.reviewDigest ? `\`${model.technical.reviewDigest}\`` : "None"}`);
  lines.push("", "</details>", "");
  const report = `${lines.join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
  if (Buffer.byteLength(report, "utf8") > MAX_REPORT_BYTES) {
    throw new ControllerError("report_output_too_large", `Release report exceeds ${MAX_REPORT_BYTES} bytes after bounded rendering.`);
  }
  return report;
}

export function renderPullRequestBody(model: ReleaseReportModel): string {
  const issues = model.goal.issues.map((issue) => `- Issue #${issue.number}`).join("\n") || "- None";
  const checks = model.checks.slice(-12).map((check) => `- ${inline(check.stage)}: ${inline(check.command)} — ${check.status}`).join("\n") || "- No checks recorded";
  const risks = model.remainingConcerns.items.map((item) => `- ${inline(item)}`).join("\n") || "- None observed";
  const diff = model.change.available ? `${model.change.files} files, ${model.change.changedLines} changed lines` : "Not available yet";
  return `## Goal\n\n${inline(model.goal.objective)}\n\n## Issues\n\n${issues}\n\n## Change summary\n\n- ${diff}\n\n## Checks\n\n${checks}\n\n## Aggregate review\n\n- ${model.aggregateReview.status}: ${inline(model.aggregateReview.summary)}\n\n## Demonstration\n\n- ${model.demonstration.status}${model.demonstration.networkAccess ? " (network-enabled)" : ""}\n\n## Residual risks\n\n${risks}\n\n## Candidate\n\n${fullIdentity(model.result.candidateSha)}\n`;
}

export async function exportReleaseReport(input: {
  store: JobStore;
  git: GitPort;
  jobId: string;
  outputPath: string;
}): Promise<{
  model: ReleaseReportModel;
  markdown: string;
  outputPath: string;
  bytes: number;
  sha256: string;
  writeStatus: "created" | "unchanged";
}> {
  const job = input.store.load(input.jobId);
  const config = historicalJobConfig(input.store.root(job.id), job);
  const model = await buildReleaseReportModel({
    job,
    config,
    jobRoot: input.store.root(job.id),
    git: input.git,
  });
  const markdown = renderReleaseReport(model);
  const outputPath = resolve(input.outputPath);
  if (pathWithin(input.store.config.stateDir, outputPath)) {
    throw new ControllerError("report_export_output_private_path", "Report export must be outside Controller private state.");
  }
  let writeStatus: "created" | "unchanged";
  try { writeStatus = writePublicTextAtomic(outputPath, markdown); }
  catch (error) {
    throw new ControllerError(
      error instanceof Error && error.message.includes("conflicts")
        ? "report_export_output_conflict"
        : "report_export_output_invalid",
      "Report export output is unsafe or conflicts with existing bytes.",
    );
  }
  return {
    model,
    markdown,
    outputPath,
    bytes: Buffer.byteLength(markdown, "utf8"),
    sha256: `sha256:${sha256(markdown)}`,
    writeStatus,
  };
}

function historicalJobConfig(jobRoot: string, job: JobState): ControllerConfig {
  let config: ControllerConfig;
  try {
    config = validateConfig(
      readPrivateJson<unknown>(jobRoot, join(jobRoot, "config.snapshot.json")),
      "historical config snapshot",
      { allowHistoricalDirectV2: true },
    );
  } catch {
    throw new ControllerError("report_config_snapshot_invalid", "The Job config snapshot is missing or invalid.");
  }
  if (digestJson(config) !== job.configDigest) {
    throw new ControllerError("report_config_snapshot_invalid", "The Job config snapshot differs from its bound digest.");
  }
  return config;
}

function renderCiChecks(
  checks: GhCheckSummary | null,
  job: JobState,
  clean: ReturnType<typeof cleaner>,
): ReleaseReportModel["checks"] {
  if (!checks) {
    return job.status === "completed" && job.completion
      ? job.completion.requiredChecks.map((name) => ({
        stage: "CI",
        command: clean(name, 500),
        status: "PASS" as const,
        durationMs: null,
        stdoutExcerpt: "",
        stderrExcerpt: "",
        url: null,
      }))
      : [];
  }
  return [
    ...(checks.successes ?? []).map((check) => ciCheck(check.name, "PASS", check.link, clean)),
    ...checks.failures.map((check) => ciCheck(check.name, "FAIL", check.link, clean)),
    ...checks.pending.map((check) => ciCheck(check.name, "PENDING", check.link, clean)),
    ...checks.missing.map((name) => ciCheck(name, "MISSING", null, clean)),
  ];
}

function ciCheck(
  name: string,
  status: "PASS" | "FAIL" | "PENDING" | "MISSING",
  url: string | null,
  clean: ReturnType<typeof cleaner>,
): ReleaseReportModel["checks"][number] {
  return {
    stage: "CI",
    command: clean(name, 500),
    status,
    durationMs: null,
    stdoutExcerpt: "",
    stderrExcerpt: "",
    url: safeUrl(url),
  };
}

function readAggregateReview(jobRoot: string, job: JobState): ReviewResult | null {
  if (!job.lastReviewPath) return null;
  const record = [...job.runs].reverse().find(({ kind, resultPath }) => kind === "review" && resultPath === job.lastReviewPath);
  if (!record || !record.resultDigest) return null;
  try {
    const result = readPrivateJson<unknown>(jobRoot, job.lastReviewPath);
    const review = validateReviewResult(result);
    return digestJson(review) === record.resultDigest ? review : null;
  } catch {
    return null;
  }
}

function readReviewDemo(jobRoot: string, job: JobState): ReviewDemoResult | null {
  if (!job.reviewDemo || job.reviewDemo.candidateSha !== job.candidateSha) return null;
  try {
    const result = readPrivateJson<ReviewDemoResult>(jobRoot, job.reviewDemo.path);
    assertReviewDemoResult(result);
    return result.digest === job.reviewDemo.digest ? result : null;
  } catch {
    return null;
  }
}

function readOptionalWorkerResult(jobRoot: string, path: string, expectedDigest: string | null): WorkerResult | null {
  if (!expectedDigest || !safePrivateFile(jobRoot, path)) return null;
  try {
    const result = validateWorkerResult(readJsonFile<unknown>(resolve(path)));
    return digestJson(result) === expectedDigest ? result : null;
  } catch {
    return null;
  }
}

function readPrivateJson<T>(root: string, path: string): T {
  if (!safePrivateFile(root, path)) throw new ControllerError("report_private_evidence_invalid", "Report evidence is outside the Job private root or unsafe.");
  return readJsonFile<T>(resolve(path));
}

function safePrivateFile(root: string, path: string): boolean {
  const absolute = resolve(path);
  if (!pathWithin(root, absolute) || !existsSync(absolute)) return false;
  const stat = lstatSync(absolute);
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && realpathSync(absolute) === absolute;
}

function cleaner(config: ControllerConfig, job: JobState) {
  const privatePaths = [
    config.localPath,
    config.stateDir,
    config.worktreeRoot,
    config.codex.bin,
    config.validation.sandbox?.bin ?? "",
    config.validation.sandbox?.root ?? "",
    job.worktreePath,
    job.configPath,
    job.planPath,
  ].filter(Boolean).sort((left, right) => right.length - left.length);
  return (value: string, maximumBytes: number, multiline = false): string => {
    let text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
    for (const path of privatePaths) text = text.replaceAll(path, "<redacted-path>");
    text = text
      .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+\b/gu, "<redacted-token>")
      .replace(/\bBearer\s+[^\s]+/giu, "Bearer <redacted-token>")
      .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|AUTH|COOKIE)[A-Z0-9_]*)=([^\s]+)/giu, "$1=<redacted>")
      .replace(/(?<![A-Za-z0-9._:/-])\/[^\s"'<>()[\]{}]*/gu, "<redacted-path>")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    if (!multiline) text = text.replace(/\s+/gu, " ").trim();
    else text = text.split(/\r?\n/u).slice(-12).join("\n").trim();
    return truncateUtf8(text, maximumBytes);
  };
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let end = Math.min(value.length, maximumBytes);
  while (end > 0 && Buffer.byteLength(`${value.slice(0, end)}…`, "utf8") > maximumBytes) end -= 1;
  return `${value.slice(0, end)}…`;
}

function reportStatus(job: JobState): ReleaseReportModel["result"]["status"] {
  if (job.status === "completed") return "COMPLETED";
  if (job.status === "failed") return "FAILED";
  if (job.status === "blocked") return "BLOCKED";
  return "RUNNING";
}

function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function inline(value: string): string {
  return value.replace(/\r?\n/gu, " ").replaceAll("|", "\\|").trim();
}

function code(value: string): string {
  return inline(value).replaceAll("`", "'");
}

function bullets(values: string[], fallback = "None declared."): string[] {
  return values.length ? values.map((value) => `- ${inline(value)}`) : [`- ${fallback}`];
}

function indented(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => `    ${line || " "}`);
}

function shortIdentity(value: string | null): string {
  return value ? `\`${value.slice(0, 12)}\`` : "Not recorded";
}

function fullIdentity(value: string | null): string {
  return value ? `\`${value}\`` : "Not recorded";
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} s`;
}
