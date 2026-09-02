import type { ControllerConfig, JobState } from "./types.js";
import { createPublicTextCleaner } from "./report.js";
import { effectiveBlockedKind } from "./state.js";
import { ControllerError } from "./errors.js";
import { safeToken } from "./util.js";

export function publicStatus(config: ControllerConfig, job: JobState) {
  assertPublicStatusSource(config, job);
  const clean = createPublicTextCleaner(config, job);
  const blocked = job.blocked
    ? {
        code: job.blocked.code,
        kind: effectiveBlockedKind(job.blocked),
        message: clean(job.blocked.message, 1_024).replace(
          /\b(?:api[_-]?key|auth|configPath|cookie|detailsPath|password|planPath|promptPath|secret|stateDir|stderrPath|token|worktreePath)\b/giu,
          "redacted",
        ),
        fromPhase: job.blocked.fromPhase,
      }
    : null;
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    repo: job.repo,
    planDigest: job.planDigest,
    baseSha: job.baseSha,
    currentIssueNumber: job.currentIssueNumber,
    issues: job.issues.map((issue) => ({ number: issue.number, status: issue.status })),
    candidateSha: job.candidateSha,
    blocked,
    result: job.result ? {
      status: job.result.status,
      mergeSha: job.result.mergeSha,
      completedAt: job.result.completedAt,
    } : null,
    updatedAt: job.updatedAt,
    legacy: job.blocked !== null && job.blocked.kind === undefined,
  };
}

function assertPublicStatusSource(config: ControllerConfig, job: JobState): void {
  const sha = (value: string | null) => value === null || /^[a-f0-9]{40}$/u.test(value);
  let canonicalId = false;
  try { canonicalId = job.id === safeToken(job.id); } catch {}
  if (!canonicalId || job.repo !== config.repo
    || !["running", "blocked", "completed", "failed"].includes(job.status)
    || !["prepare", "implement", "verify", "review", "repair", "deliver", "complete"].includes(job.phase)
    || !/^[a-f0-9]{64}$/u.test(job.planDigest)
    || !sha(job.baseSha) || !sha(job.candidateSha)
    || !Number.isFinite(Date.parse(job.updatedAt))
    || (job.currentIssueNumber !== null && (!Number.isSafeInteger(job.currentIssueNumber) || job.currentIssueNumber < 1))
    || job.issues.some((issue) => !Number.isSafeInteger(issue.number) || issue.number < 1
      || !["pending", "running", "committed", "blocked"].includes(issue.status))
    || (job.blocked !== null && (!/^[a-z][a-z0-9_]{0,119}$/u.test(job.blocked.code)
      || !["prepare", "implement", "verify", "review", "repair", "deliver", "complete"].includes(job.blocked.fromPhase)))) {
    throw new ControllerError("public_status_source_invalid", "Controller Job state cannot be safely projected.");
  }
}
