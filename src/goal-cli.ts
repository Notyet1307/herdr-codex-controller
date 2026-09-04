#!/usr/bin/env node
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { GitClient } from "./git.js";
import { GitHubClient } from "./github.js";
import { Validator } from "./validator.js";
import { CodexRunner } from "./codex.js";
import { GoalAppServer } from "./goal-app-server.js";
import {
  GoalStore,
  assertGoalHandoffCompatible,
  blockGoalRun,
  goalHandoffFingerprint,
  loadGoalHandoff,
  publicGoalStatus,
  validateGoalHandoff,
} from "./goal-state.js";
import { GoalRunner, exportGoalReleaseResult } from "./goal-runner.js";
import { JobStore } from "./state.js";
import { withControllerLock } from "./lock.js";
import { ControllerError } from "./errors.js";
import type { StepResult } from "./types.js";

type Command = "help" | "doctor" | "start" | "status" | "step" | "run" | "resume" | "result-export";
type Parsed = { command: Command; options: Record<string, string | boolean> };

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (args.command === "help") return printHelp();
  const configPath = required(args, "config");
  const config = loadConfig(configPath);
  const store = new GoalStore(config);
  const git = new GitClient(config);
  const github = new GitHubClient(config);
  const validator = new Validator(config, git);
  const reviewer = new CodexRunner(config, git);
  const goal = new GoalAppServer(config);
  const runner = new GoalRunner({ config, store, git, github, validator, reviewer, goal });

  if (args.command === "doctor") {
    only(args, ["config", "json"]);
    await git.preflight();
    await goal.preflight(resolve(config.stateDir, "goal-doctor-codex-home"));
    const validation = await validator.preflight();
    output(args, { ok: true, goalProtocol: "app-server-v2", validation });
    return;
  }

  if (args.command === "start") {
    only(args, ["approve-handoff", "config", "handoff", "json", "runner-ref"]);
    const handoffOption = required(args, "handoff");
    const handoffPath = handoffOption === "-" ? null : resolve(handoffOption);
    const handoff = handoffPath === null
      ? validateGoalHandoff(JSON.parse(readFileSync(0, "utf8")) as unknown)
      : loadGoalHandoff(handoffPath);
    const fingerprint = goalHandoffFingerprint(handoff);
    const approved = required(args, "approve-handoff");
    if (!/^sha256:[a-f0-9]{64}$/u.test(approved) || approved !== fingerprint) {
      throw new ControllerError("approved_goal_handoff_mismatch", "--approve-handoff must exactly match the Goal handoff fingerprint.");
    }
    assertGoalHandoffCompatible(handoff, config, required(args, "runner-ref"));
    const state = await withControllerLock(store.repositoryLockPath(), async () => {
      const controllerJobs = new JobStore(config).active();
      if (controllerJobs.length) throw new ControllerError("controller_job_active", "A Controller Job is already active for this repository.");
      if (store.active().length) throw new ControllerError("goal_run_active", "A Goal run is already active for this repository.");
      return store.create({ configPath, handoffPath, handoff, handoffDigest: fingerprint });
    });
    output(args, operatorStatus(state));
    return;
  }

  const id = required(args, "run-id");
  if (args.command === "status") {
    only(args, ["config", "json", "operator", "run-id"]);
    const state = store.load(id);
    output(args, args.options.operator ? operatorStatus(state) : publicGoalStatus(state));
    return;
  }
  if (args.command === "resume") {
    only(args, ["config", "json", "run-id"]);
    const state = await withControllerLock(store.repositoryLockPath(), async () => runner.resume(store.load(id)));
    output(args, operatorStatus(state));
    return;
  }
  if (args.command === "result-export") {
    only(args, ["config", "json", "out", "pull-request", "run-id"]);
    const result = await withControllerLock(store.repositoryLockPath(), async () => exportGoalReleaseResult({
      config,
      store,
      git,
      github,
      state: store.load(id),
      pullRequestNumber: positiveInteger(required(args, "pull-request"), "pull-request", 1, Number.MAX_SAFE_INTEGER),
      outputPath: required(args, "out"),
    }));
    output(args, result);
    return;
  }
  if (args.command === "step") {
    only(args, ["config", "json", "run-id"]);
    output(args, await withControllerLock(store.repositoryLockPath(), async () => stepOnce(store, runner, id)));
    return;
  }
  if (args.command === "run") {
    only(args, ["config", "json", "max-steps", "run-id"]);
    const maximum = args.options["max-steps"] === undefined ? 100 : positiveInteger(required(args, "max-steps"), "max-steps", 1, 1_000);
    const steps: StepResult[] = [];
    await withControllerLock(store.repositoryLockPath(), async () => {
      for (let index = 0; index < maximum; index += 1) {
        const step = await stepOnce(store, runner, id);
        steps.push(step.step);
        if (step.step.terminal || !step.step.progressed || step.status !== "running") break;
      }
    });
    output(args, { steps, state: operatorStatus(store.load(id)) });
    return;
  }
  throw new Error(`unsupported command: ${args.command}`);
}

async function stepOnce(store: GoalStore, runner: GoalRunner, id: string) {
  let state = store.load(id);
  try {
    const step = await runner.step(state);
    state = store.load(id);
    return { step, ...publicGoalStatus(state) };
  } catch (error) {
    state = blockGoalRun(state, error);
    store.save(state);
    return {
      step: { action: "goal_blocked", progressed: false, terminal: true, retryAfterMs: null, message: state.blocked?.message ?? "Goal run blocked." },
      ...publicGoalStatus(state),
    };
  }
}

function parse(argv: string[]): Parsed {
  if (!argv.length || ["help", "--help", "-h"].includes(argv[0]!)) return { command: "help", options: {} };
  let command: Command;
  let offset = 1;
  if (argv[0] === "result" && argv[1] === "export") { command = "result-export"; offset = 2; }
  else if (["doctor", "start", "status", "step", "run", "resume"].includes(argv[0]!)) command = argv[0] as Command;
  else throw new Error(`unknown command: ${argv[0]}`);
  const options: Record<string, string | boolean> = {};
  for (let index = offset; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new Error(`unexpected positional argument: ${token}`);
    const key = token.slice(2);
    if (key === "json" || key === "operator") {
      if (key in options) throw new Error(`duplicate option --${key}`);
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || key in options) throw new Error(`invalid option --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function required(args: Parsed, key: string): string {
  const value = args.options[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${key} is required`);
  return value;
}

function only(args: Parsed, allowed: string[]): void {
  const unknown = Object.keys(args.options).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`unknown option --${unknown}`);
}

function positiveInteger(value: string, label: string, minimum: number, maximum: number): number {
  if (!/^\d+$/u.test(value)) throw new Error(`--${label} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error(`--${label} is out of range`);
  return number;
}

function operatorStatus(state: ReturnType<GoalStore["load"]>) {
  return {
    ...publicGoalStatus(state),
    runnerHost: state.runnerHost,
    branch: state.branch,
    worktreePath: state.worktreePath,
    currentThreadId: state.currentIssueNumber === null ? null : state.issues.find((issue) => issue.number === state.currentIssueNumber)?.threadId ?? null,
    currentTurnId: state.currentIssueNumber === null ? null : state.issues.find((issue) => issue.number === state.currentIssueNumber)?.activeTurnId ?? null,
    lastValidation: state.validations.at(-1) ?? null,
    review: state.review,
    nextAction: nextAction(state),
  };
}

function nextAction(state: ReturnType<GoalStore["load"]>): string {
  if (state.status === "blocked") return state.blocked?.kind === "replan_required"
    ? "Return to Planner for a new approved Goal handoff."
    : "Inspect the blocker, then explicitly run resume when the cause is resolved.";
  if (state.status === "review_ready") return "Human: push the exact candidate branch, open/review the PR, merge it, then export the Goal Release Result.";
  if (state.status === "completed" || state.status === "failed") return "No Goal execution action remains.";
  return `Run step or run to continue ${state.phase}.`;
}

function output(args: Parsed, value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, args.options.json ? 2 : 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(`Herdr Codex Goal Runner\n\nCommands:\n  doctor         --config PATH [--json]\n  start          --config PATH --handoff PATH --approve-handoff SHA256 --runner-ref REF [--json]\n  status         --config PATH --run-id ID [--operator] [--json]\n  step           --config PATH --run-id ID [--json]\n  run            --config PATH --run-id ID [--max-steps N] [--json]\n  resume         --config PATH --run-id ID [--json]\n  result export  --config PATH --run-id ID --pull-request N --out FILE [--json]\n`);
}

main().catch((error) => {
  const message = error instanceof ControllerError
    ? `${error.code}: ${error.message}`
    : error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
