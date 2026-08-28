#!/usr/bin/env node
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { assertPlanCompatibleWithConfig, isReleasePlanV2, loadPlan } from "./plan.js";
import { JobStore, REPLAN_REQUIRED_CODE, retryBlockedJob } from "./state.js";
import { GitClient } from "./git.js";
import { GitHubClient } from "./github.js";
import { CodexRunner } from "./codex.js";
import { Validator } from "./validator.js";
import { ReleaseController } from "./controller.js";
import { withControllerLock } from "./lock.js";
import { digestJson, newId, nowIso, sha256, sleep } from "./util.js";
import { writeBytesAtomic, writeJsonAtomic, writeTextAtomic } from "./fs-atomic.js";
import type { JobState, ReleasePlan, RetryAuthorization, StepResult } from "./types.js";
import { ControllerError } from "./errors.js";
import { assertDispatcherCompatible, loadDispatcherConfig } from "./dispatcher-config.js";
import { IssueDispatcher } from "./dispatcher.js";
import type { DispatcherStepResult } from "./types.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    printHelp();
    return;
  }
  const configPath = requiredOption(args, "config");
  const config = loadConfig(configPath);
  const configDigest = digestJson(config);

  if (args.command === "config-validate") {
    output(args, { ok: true, configDigest, config });
    return;
  }
  if (args.command === "plan-validate") {
    const planPath = requiredOption(args, "plan");
    const plan = loadPlan(planPath);
    assertPlanCompatibleWithConfig(plan, config);
    output(args, { ok: true, planDigest: digestJson(plan), plan });
    return;
  }

  if (args.command === "start") {
    const planPath = requiredOption(args, "plan");
    const plan = loadPlan(planPath);
    assertPlanCompatibleWithConfig(plan, config);
    assertExpectedConfigDigest(args, plan, configDigest);
    if (plan.issues.length > config.policy.maxIssues) {
      throw new Error(`plan has ${plan.issues.length} issues; configured maximum is ${config.policy.maxIssues}`);
    }
    const store = new JobStore(config);
    const job = await withControllerLock(store.repositoryLockPath(), async () => {
      const active = store.active();
      if (active.length > 0) {
        throw new Error(`repository already has an active release job: ${active.map((entry) => `${entry.id} (${entry.status}/${entry.phase})`).join(", ")}`);
      }
      return store.create({
        configPath: resolve(configPath),
        planPath: resolve(planPath),
        plan,
        configDigest,
        planDigest: digestJson(plan),
      });
    });
    output(args, summarizeJob(job));
    return;
  }

  const store = new JobStore(config);

  const git = new GitClient(config);
  const github = new GitHubClient(config);
  const codex = new CodexRunner(config, git);
  const validator = new Validator(config);
  const controller = new ReleaseController({ store, git, github, codex, validator });

  if (args.command === "doctor") {
    await git.preflight();
    await github.preflight();
    await codex.preflight();
    output(args, { ok: true, checkedAt: nowIso(), configDigest });
    return;
  }

  if (args.command === "dispatch" || args.command === "dispatch-status" || args.command === "dispatch-retry") {
    const dispatcherConfigPath = requiredOption(args, "dispatcher");
    const dispatcherConfig = loadDispatcherConfig(dispatcherConfigPath);
    assertDispatcherCompatible(dispatcherConfig, config);
    const dispatcher = new IssueDispatcher({
      store,
      controller,
      git,
      github,
      controllerConfig: config,
      controllerConfigPath: resolve(configPath),
      controllerConfigDigest: configDigest,
      dispatcherConfig,
      dispatcherConfigPath: resolve(dispatcherConfigPath),
      dispatcherConfigDigest: digestJson(dispatcherConfig),
    });
    if (args.command === "dispatch-status") {
      output(args, dispatcher.status());
      return;
    }
    await withControllerLock(store.repositoryLockPath(), async () => {
      if (args.command === "dispatch-retry") {
        output(args, dispatcher.retry(requiredOption(args, "reason")));
        return;
      }
      const maximum = optionalInteger(args, "max-steps", 1, 10_000) ?? 500;
      const history: DispatcherStepResult[] = [];
      for (let index = 0; index < maximum; index += 1) {
        const result = await dispatcher.step();
        history.push(result);
        if (!args.options.json) process.stdout.write(`${result.action}: ${result.message}\n`);
        if (result.terminal) break;
        if (result.retryAfterMs) await sleep(result.retryAfterMs);
      }
      if (args.options.json) output(args, { dispatcher: dispatcher.status(), steps: history });
    });
    return;
  }

  const jobId = requiredOption(args, "job");
  if (args.command === "status") {
    output(args, args.options.operator ? operatorStatus(store.load(jobId)) : summarizeJob(store.load(jobId)));
    return;
  }

  await withControllerLock(store.repositoryLockPath(), async () => {
    if (args.command !== "cleanup") {
      const conflicting = store.active(jobId);
      if (conflicting.length > 0) {
        throw new Error(`another release job is active for this repository: ${conflicting.map((entry) => `${entry.id} (${entry.status}/${entry.phase})`).join(", ")}`);
      }
    }
    if (args.command === "step") {
      output(args, await controller.step(jobId));
      return;
    }
    if (args.command === "run") {
      const maximum = optionalInteger(args, "max-steps", 1, 10_000) ?? 200;
      const history: StepResult[] = [];
      for (let index = 0; index < maximum; index += 1) {
        const result = await controller.step(jobId);
        history.push(result);
        if (!args.options.json) process.stdout.write(`${result.action}: ${result.message}\n`);
        const job = store.load(jobId);
        if (result.terminal || job.status === "blocked" || job.status === "completed" || job.status === "failed" || job.status === "ready_to_merge") break;
        if (result.retryAfterMs) await sleep(result.retryAfterMs);
      }
      if (args.options.json) output(args, { job: summarizeJob(store.load(jobId)), steps: history });
      return;
    }
    if (args.command === "retry") {
      const reason = requiredOption(args, "reason");
      let job = store.load(jobId);
      if (job.status !== "blocked" || !job.blocked) throw new Error("job is not blocked");
      if (job.blocked.code === REPLAN_REQUIRED_CODE) retryBlockedJob(job);
      const evidence = readRecoveryEvidence(requiredOption(args, "evidence"));
      const evidenceDigest = sha256(evidence);
      const authorizationId = newId("operator-retry");
      const evidencePath = join(store.root(job.id), `retry-evidence-${evidenceDigest}.bin`);
      const notePath = join(store.root(job.id), `${authorizationId}.json`);
      const authorization: RetryAuthorization = {
        previousBlockedCode: job.blocked.code,
        previousBlockedPhase: job.blocked.fromPhase,
        previousDetailsPath: job.blocked.detailsPath,
        operatorReason: reason.trim(),
        recoveryEvidencePath: evidencePath,
        evidenceDigest,
        authorizedAt: nowIso(),
      };
      const fromPhase = job.blocked.fromPhase;
      writeBytesAtomic(evidencePath, evidence);
      job = retryBlockedJob(job, authorization, store.root(job.id));
      const issue = job.currentIssueNumber === null ? null : job.issues.find((entry) => entry.number === job.currentIssueNumber) ?? null;
      if (issue && (fromPhase === "implement" || fromPhase === "issue_validate")) {
        issue.status = "running";
        issue.nextRunKind = "recovery";
        job.phase = "implement";
      }
      writeJsonAtomic(notePath, authorization);
      store.save(job);
      output(args, { action: "retry_authorized", notePath, evidencePath, evidenceDigest, job: summarizeJob(job) });
      return;
    }
    if (args.command === "abort") {
      const reason = requiredOption(args, "reason");
      const job = store.load(jobId);
      if (job.activeRun) throw new Error("cannot abort while an active Codex run is recorded; first reconcile it with step");
      const notePath = join(store.root(job.id), `operator-abort-${Date.now()}.md`);
      writeTextAtomic(notePath, `# Operator abort\n\nTime: ${nowIso()}\n\n${reason.trim()}\n`);
      job.status = "failed";
      job.blocked = null;
      store.save(job);
      output(args, { action: "job_aborted", notePath, job: summarizeJob(job) });
      return;
    }
    if (args.command === "cleanup") {
      const job = store.load(jobId);
      if (job.status !== "completed" && job.status !== "failed") throw new Error("cleanup requires a completed or failed job");
      if (job.activeRun) throw new Error("cleanup refuses an active run");
      await git.removeWorktree(job);
      output(args, { action: "worktree_removed", jobId: job.id, worktreePath: job.worktreePath });
      return;
    }
    throw new Error(`unsupported command: ${args.command}`);
  });
}

type ParsedArgs = {
  command: "help" | "config-validate" | "plan-validate" | "doctor" | "start" | "status" | "step" | "run" | "retry" | "abort" | "cleanup" | "dispatch" | "dispatch-status" | "dispatch-retry";
  options: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") return { command: "help", options: {} };
  let command: ParsedArgs["command"];
  let offset = 1;
  if (argv[0] === "config" && argv[1] === "validate") { command = "config-validate"; offset = 2; }
  else if (argv[0] === "plan" && argv[1] === "validate") { command = "plan-validate"; offset = 2; }
  else if (argv[0] === "dispatch" && argv[1] === "status") { command = "dispatch-status"; offset = 2; }
  else if (argv[0] === "dispatch" && argv[1] === "retry") { command = "dispatch-retry"; offset = 2; }
  else if (argv[0] === "dispatch") { command = "dispatch"; offset = 1; }
  else if (["doctor", "start", "status", "step", "run", "retry", "abort", "cleanup"].includes(argv[0]!)) command = argv[0] as ParsedArgs["command"];
  else throw new Error(`unknown command: ${argv[0]}`);
  const options: Record<string, string | boolean> = {};
  for (let index = offset; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new Error(`unexpected positional argument: ${token}`);
    const key = token.slice(2);
    if (key === "json" || key === "operator") {
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`option --${key} requires a value`);
    if (key in options) {
      if (key === "expected-config-digest") {
        throw new ControllerError("expected_config_digest_invalid", "--expected-config-digest may be supplied only once.");
      }
      throw new Error(`duplicate option --${key}`);
    }
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function assertExpectedConfigDigest(args: ParsedArgs, plan: ReleasePlan, configDigest: string): void {
  const expected = args.options["expected-config-digest"];
  if (expected === undefined) {
    if (isReleasePlanV2(plan)) {
      throw new ControllerError(
        "expected_config_digest_required",
        "Release Plan v2 start requires --expected-config-digest.",
      );
    }
    return;
  }
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new ControllerError(
      "expected_config_digest_invalid",
      "--expected-config-digest must be exactly 64 lowercase hexadecimal characters without a prefix.",
    );
  }
  if (expected !== configDigest) {
    throw new ControllerError(
      "expected_config_digest_mismatch",
      "--expected-config-digest does not match the current validated Controller config.",
    );
  }
}

function requiredOption(args: ParsedArgs, key: string): string {
  const value = args.options[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${key} is required`);
  return value;
}

function optionalInteger(args: ParsedArgs, key: string, minimum: number, maximum: number): number | null {
  const value = args.options[key];
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`--${key} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error(`--${key} must be between ${minimum} and ${maximum}`);
  return number;
}

function readRecoveryEvidence(path: string): Uint8Array {
  const absolute = resolve(path);
  let stat;
  try { stat = lstatSync(absolute); }
  catch { throw new ControllerError("recovery_evidence_invalid", "Recovery evidence does not exist."); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024 * 1024) {
    throw new ControllerError("recovery_evidence_invalid", "Recovery evidence must be a non-empty regular file no larger than 1 MiB.");
  }
  return readFileSync(absolute);
}

function output(args: ParsedArgs, value: unknown): void {
  if (args.options.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function summarizeJob(job: JobState) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    repo: job.repo,
    baseSha: job.baseSha,
    branch: job.branch,
    worktreePath: job.worktreePath,
    currentIssueNumber: job.currentIssueNumber,
    issues: job.issues.map((issue) => ({ number: issue.number, status: issue.status, commitSha: issue.commitSha, repairRounds: issue.repairRounds })),
    candidateSha: job.candidateSha,
    reviewRound: job.reviewRound,
    hardeningRounds: job.hardeningRounds,
    pullRequest: job.pullRequest,
    blocked: job.blocked,
    updatedAt: job.updatedAt,
  };
}

function operatorStatus(job: JobState) {
  return {
    ...summarizeJob(job),
    activeRun: job.activeRun,
    lastRun: job.runs.at(-1) ?? null,
    lastValidation: job.validations.at(-1) ?? null,
    hardeningReasonPath: job.hardeningReasonPath,
    lastReviewPath: job.lastReviewPath,
    nextAction: nextAction(job),
  };
}

function nextAction(job: JobState): string {
  if (job.status === "blocked" && job.blocked?.code === REPLAN_REQUIRED_CODE) {
    return "Run abort, return to Planner for a new Release Plan v2, then start a new Job.";
  }
  if (job.status === "blocked") return `Inspect blocked evidence and run retry --reason TEXT --evidence PATH after resolving ${job.blocked?.code ?? "the blocker"}.`;
  if (job.status === "ready_to_merge") return `Merge PR #${job.pullRequest?.number ?? "?"}, then run step to observe completion.`;
  if (job.status === "completed" || job.status === "failed") return "No workflow action remains; cleanup is optional.";
  return `Run step or run to continue phase ${job.phase}.`;
}

function printHelp(): void {
  process.stdout.write(`Herdr Codex Controller\n\nCommands:\n  config validate  --config PATH [--json]\n  plan validate    --config PATH --plan PATH [--json]\n  doctor           --config PATH [--json]\n  start            --config PATH --plan PATH [--expected-config-digest 64HEX] [--json]\n  status           --config PATH --job ID [--operator] [--json]\n  step             --config PATH --job ID [--json]\n  run              --config PATH --job ID [--max-steps N] [--json]\n  retry            --config PATH --job ID --reason TEXT --evidence PATH [--json]\n  abort            --config PATH --job ID --reason TEXT [--json]\n  cleanup          --config PATH --job ID [--json]\n  dispatch         --config PATH --dispatcher PATH [--max-steps N] [--json]\n  dispatch status  --config PATH --dispatcher PATH [--json]\n  dispatch retry   --config PATH --dispatcher PATH --reason TEXT [--json]\n`);
}

main().catch((error) => {
  const message = error instanceof ControllerError
    ? `${error.code}: ${error.message}`
    : error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
