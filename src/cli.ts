#!/usr/bin/env node
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, requiredCheckContract } from "./config.js";
import { assertPlanCompatibleWithConfig, loadPlan } from "./plan.js";
import { JobStore, REPLAN_REQUIRED_CODE, retryBlockedJob } from "./state.js";
import { GitClient } from "./git.js";
import { GitHubClient } from "./github.js";
import { CodexRunner } from "./codex.js";
import { Validator } from "./validator.js";
import { ReleaseController } from "./controller.js";
import { withControllerLock } from "./lock.js";
import { digestJson, newId, nowIso, sha256, sleep } from "./util.js";
import { writeBytesAtomic, writeJsonAtomic, writeTextAtomic } from "./fs-atomic.js";
import type {
  ControllerConfig,
  ControllerProvenance,
  JobState,
  ReleasePlan,
  RetryAuthorization,
  StepResult,
} from "./types.js";
import { ControllerError } from "./errors.js";
import { createControllerProvenance, readControllerIdentity } from "./provenance.js";
import { exportReleaseCompletion } from "./completion-export.js";
import { readControllerIdentityHistory } from "./identity-history.js";
import { exportReleaseReport } from "./report.js";
import { DemoRunner } from "./demo.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    printHelp();
    return;
  }
  const configPath = requiredOption(args, "config");
  const config = loadConfig(configPath);
  const configDigest = digestJson(config);
  const controllerIdentity = readControllerIdentity();

  if (args.command === "config-validate") {
    output(args, { ok: true, configDigest, controller: controllerIdentity, config });
    return;
  }
  if (args.command === "plan-validate") {
    const planPath = requiredOption(args, "plan");
    const plan = loadPlan(planPath);
    assertPlanCompatibleWithConfig(plan, config);
    const provenance = createControllerProvenance(controllerIdentity, config, configDigest, plan);
    output(args, { ok: true, planDigest: digestJson(plan), provenance, plan });
    return;
  }

  if (args.command === "start") {
    const planPath = requiredOption(args, "plan");
    const plan = loadPlan(planPath);
    assertPlanCompatibleWithConfig(plan, config);
    const provenance = createControllerProvenance(controllerIdentity, config, configDigest, plan);
    assertExpectedConfigDigest(args, plan, configDigest);
    assertExpectedControllerProvenance(args, plan, provenance);
    if (plan.issues.length > config.policy.maxIssues) {
      throw new Error(`plan has ${plan.issues.length} issues; configured maximum is ${config.policy.maxIssues}`);
    }
    const store = new JobStore(config);
    const job = await withControllerLock(store.repositoryLockPath(), async () => {
      const active = store.active();
      if (active.length > 0) {
        throw new Error(`repository already has an active release job: ${active.map((entry) => `${entry.id} (${entry.status}/${entry.phase})`).join(", ")}`);
      }
      const startGit = new GitClient(config);
      const startGithub = new GitHubClient(config);
      const startCodex = new CodexRunner(config, startGit);
      const startValidator = new Validator(config, startGit);
      await startGit.preflight();
      await startGithub.preflight();
      await startCodex.preflight();
      await startValidator.preflight();
      return store.create({
        configPath: resolve(configPath),
        planPath: resolve(planPath),
        plan,
        configDigest,
        planDigest: digestJson(plan),
        expectedControllerProvenanceDigest: provenance.digest,
      });
    });
    output(args, summarizeJob(job, provenance));
    return;
  }

  const store = new JobStore(config);

  const git = new GitClient(config);
  const github = new GitHubClient(config);
  const codex = new CodexRunner(config, git);
  const validator = new Validator(config, git);
  const demo = new DemoRunner(config, git);
  const controller = new ReleaseController({ store, git, github, codex, validator, demo });

  if (args.command === "doctor") {
    await git.preflight();
    const remoteIdentity = await git.remoteIdentity();
    await github.preflight();
    await codex.preflight();
    const validationSandbox = await validator.preflight();
    output(args, {
      ok: true,
      checkedAt: nowIso(),
      configDigest,
      controller: controllerIdentity,
      executionMode: config.executionMode,
      remoteIdentity,
      validationSandbox,
      requiredCheckContractDigest: config.version === 3 ? digestJson(requiredCheckContract(config)) : null,
      mergeAuthorityDigest: config.version === 3 ? digestJson(config.delivery.mergeAuthority) : null,
      identityHistoryDigest: config.version === 3 ? readControllerIdentityHistory().digest : null,
      mergePolicyVerified: true,
    });
    return;
  }

  const jobId = requiredOption(args, "job");
  if (args.command === "status") {
    const job = store.load(jobId);
    const currentProvenance = store.currentProvenance(job.plan);
    output(args, args.options.operator
      ? operatorStatus(job, currentProvenance)
      : summarizeJob(job, currentProvenance));
    return;
  }
  if (args.command === "completion-export") {
    const artifact = await withControllerLock(store.repositoryLockPath(), () => exportReleaseCompletion({
      store,
      git,
      github,
      jobId,
      outputPath: requiredOption(args, "out"),
    }));
    output(args, artifact);
    return;
  }
  if (args.command === "report-export") {
    const report = await withControllerLock(store.repositoryLockPath(), () => exportReleaseReport({
      store,
      git,
      jobId,
      outputPath: requiredOption(args, "out"),
    }));
    output(args, {
      ok: true,
      jobId,
      outputPath: report.outputPath,
      bytes: report.bytes,
      sha256: report.sha256,
      writeStatus: report.writeStatus,
    });
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
        if (result.terminal || job.status === "blocked" || job.status === "completed" || job.status === "failed") break;
        if (result.retryAfterMs) await sleep(result.retryAfterMs);
      }
      if (args.options.json) {
        const job = store.load(jobId);
        output(args, { job: summarizeJob(job, store.currentProvenance(job.plan)), steps: history });
      }
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
      if (issue && (fromPhase === "implement" || fromPhase === "verify" || fromPhase === "repair")) {
        issue.status = "running";
        issue.nextRunKind = "recovery";
        job.phase = "repair";
      }
      if (fromPhase === "deliver" && job.reviewDemo && !job.reviewDemo.passed) job.reviewDemo = null;
      writeJsonAtomic(notePath, authorization);
      store.save(job);
      output(args, {
        action: "retry_authorized",
        notePath,
        evidencePath,
        evidenceDigest,
        job: summarizeJob(job, store.currentProvenance(job.plan)),
      });
      return;
    }
    if (args.command === "abort") {
      const reason = requiredOption(args, "reason");
      let job = store.load(jobId);
      if (job.activeRun) throw new Error("cannot abort while an active Codex run is recorded; first reconcile it with step");
      const notePath = join(store.root(job.id), `operator-abort-${Date.now()}.md`);
      writeTextAtomic(notePath, `# Operator abort\n\nTime: ${nowIso()}\n\n${reason.trim()}\n`);
      job = await controller.abort(jobId, reason);
      output(args, { action: "job_aborted", notePath, job: summarizeJob(job, store.currentProvenance(job.plan)) });
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
  command: "help" | "config-validate" | "plan-validate" | "completion-export" | "report-export" | "doctor" | "start" | "status" | "step" | "run" | "retry" | "abort" | "cleanup";
  options: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") return { command: "help", options: {} };
  let command: ParsedArgs["command"];
  let offset = 1;
  if (argv[0] === "config" && argv[1] === "validate") { command = "config-validate"; offset = 2; }
  else if (argv[0] === "plan" && argv[1] === "validate") { command = "plan-validate"; offset = 2; }
  else if (argv[0] === "completion" && argv[1] === "export") { command = "completion-export"; offset = 2; }
  else if (argv[0] === "report" && argv[1] === "export") { command = "report-export"; offset = 2; }
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
      if (["expected-controller-revision", "expected-controller-provenance-digest"].includes(key)) {
        throw new ControllerError(
          "expected_controller_provenance_invalid",
          `--${key} may be supplied only once.`,
        );
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
    throw new ControllerError(
      "expected_config_digest_required",
      "Release Plan v2 start requires --expected-config-digest.",
    );
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

function assertExpectedControllerProvenance(
  args: ParsedArgs,
  plan: ReleasePlan,
  provenance: ControllerProvenance,
): void {
  const expectedRevision = args.options["expected-controller-revision"];
  const expectedDigest = args.options["expected-controller-provenance-digest"];
  if (expectedRevision === undefined) {
    throw new ControllerError(
      "expected_controller_revision_required",
      "Release Plan v2 start requires --expected-controller-revision.",
    );
  }
  if (expectedDigest === undefined) {
    throw new ControllerError(
      "expected_controller_provenance_required",
      "Release Plan v2 start requires --expected-controller-provenance-digest.",
    );
  }
  if (expectedRevision !== undefined) {
    if (typeof expectedRevision !== "string" || !/^[a-f0-9]{40}$/.test(expectedRevision)) {
      throw new ControllerError(
        "expected_controller_revision_invalid",
        "--expected-controller-revision must be exactly 40 lowercase hexadecimal characters.",
      );
    }
    if (expectedRevision !== provenance.controller.sourceRevision) {
      throw new ControllerError(
        "expected_controller_revision_mismatch",
        "--expected-controller-revision does not match the running Controller source revision.",
      );
    }
  }
  if (expectedDigest !== undefined) {
    if (typeof expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
      throw new ControllerError(
        "expected_controller_provenance_invalid",
        "--expected-controller-provenance-digest must be exactly 64 lowercase hexadecimal characters.",
      );
    }
    if (expectedDigest !== provenance.digest) {
      throw new ControllerError(
        "expected_controller_provenance_mismatch",
        "--expected-controller-provenance-digest does not match the current Controller, config, and Release Plan.",
      );
    }
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

function summarizeJob(job: JobState, currentProvenance: ControllerProvenance) {
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
    codeRepairRounds: job.codeRepairRounds,
    infrastructureReruns: job.infrastructureReruns,
    pullRequest: job.pullRequest,
    ciGate: job.ciGate,
    deliveryAuthority: job.deliveryAuthority,
    blocked: job.blocked,
    provenance: job.provenance,
    currentProvenance,
    provenanceMatches: currentProvenance.digest === job.provenance.digest,
    updatedAt: job.updatedAt,
  };
}

function operatorStatus(job: JobState, currentProvenance: ControllerProvenance) {
  return {
    ...summarizeJob(job, currentProvenance),
    activeRun: job.activeRun,
    lastRun: job.runs.at(-1) ?? null,
    lastValidation: job.validations.at(-1) ?? null,
    repairReasonPath: job.repairReasonPath,
    lastReviewPath: job.lastReviewPath,
    nextAction: nextAction(job),
  };
}

function nextAction(job: JobState): string {
  if (job.status === "blocked" && job.blocked?.code === REPLAN_REQUIRED_CODE) {
    return "Run abort, return to Planner for a new Release Plan v2, then start a new Job.";
  }
  if (job.status === "blocked") return `Inspect blocked evidence and run retry --reason TEXT --evidence PATH after resolving ${job.blocked?.code ?? "the blocker"}.`;
  if (job.status === "completed" || job.status === "failed") return "No workflow action remains; cleanup is optional.";
  return `Run step or run to continue phase ${job.phase}.`;
}

function printHelp(): void {
  process.stdout.write(`Herdr Codex Controller\n\nCommands:\n  config validate    --config PATH [--json]\n  plan validate      --config PATH --plan PATH [--json]\n  completion export  --config PATH --job ID --out FILE [--json]\n  report export      --config PATH --job ID --out FILE [--json]\n  doctor             --config PATH [--json]\n  start              --config PATH --plan PATH [--json]\n                     v2 requires --expected-config-digest 64HEX --expected-controller-revision 40HEX --expected-controller-provenance-digest 64HEX\n  status             --config PATH --job ID [--operator] [--json]\n  step               --config PATH --job ID [--json]\n  run                --config PATH --job ID [--max-steps N] [--json]\n  retry              --config PATH --job ID --reason TEXT --evidence PATH [--json]\n  abort              --config PATH --job ID --reason TEXT [--json]\n  cleanup            --config PATH --job ID [--json]\n`);
}

main().catch((error) => {
  const message = error instanceof ControllerError
    ? `${error.code}: ${error.message}`
    : error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
