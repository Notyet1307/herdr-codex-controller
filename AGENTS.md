# AGENTS.md

## Project purpose

This repository contains the thin Codex-first release Controller and a separate opt-in Goal Runner. Controller executes one fresh `codex exec --ephemeral` Worker per Issue. Goal Runner uses one persistent Goal thread per Issue, deterministic Runner-owned validation/commit checkpoints, a fresh read-only release review, and human merge.

## Non-negotiable boundaries

- The Controller owns release state, Git commits, pushes, pull requests, CI observation, and merge facts.
- Codex owns implementation inside the worktree, including its internal planning, self-review, and optional native subagents.
- The Controller path does not use Pi, Herdr sessions, pi-subagents, Agent Teams, model-turn persistence, transcript resume, child-agent state, or per-Issue independent review.
- Never treat a model statement as proof that Git, validation, PR, CI, or merge succeeded.
- Controller recovery uses the current Git worktree and fresh Codex execution; it never resumes a prior session. Goal Runner may resume only the exact Thread recorded for the current Ticket.
- One repository release is serial. Parallelism belongs above this controller, across isolated repositories/jobs.
- Validation commands are trusted operator configuration and must remain observational: they may not change the Git-visible worktree.
- Worker, hardening, and Goal Codex runs may not commit, push, invoke `gh`, change branches/remotes, or modify GitHub state.
- The release reviewer is read-only and reviews one exact `baseSha...candidateSha` aggregate candidate.
- Production accepts only semantic `controllerContractVersion: 1` Plans and always delivers through reviewed PR checks plus exact-head Controller auto-merge.
- Goal Runner state and Controller Job state never substitute for each other. Goal Runner accepts only a dedicated exact Goal handoff, keeps one Thread inside each Ticket, starts a fresh Thread for the next Ticket, and stops at human merge.

## Build and verification

```bash
npm install
npm run typecheck
npm run build
npm test
npm run verify
```

Do not weaken tests, enlarge retry loops, or hide command failures to make a gate green.

## Important modules

- `src/controller.ts`: minimal release state machine and policy.
- `src/codex.ts`: bounded `codex exec` adapter and structured-result validation.
- `src/git.ts`: worktree, commit, candidate, diff, push, and recovery facts.
- `src/github.ts`: Issue/PR/check observation and PR delivery.
- `src/validator.ts`: deterministic command execution and receipts.
- `src/state.ts`: atomic job state and paths.
- `src/release-result.ts`: concise verified-merge result creation and export.
- `src/report.ts`: shared review bundle and PR-body model/rendering.
- `src/demo.ts`: optional isolated exact-candidate demonstration.
- `src/prompts.ts`: Issue Worker, release hardening, and aggregate review prompts.
- `src/cli.ts`: operator commands.
- `src/goal-cli.ts`, `src/goal-runner.ts`, and `src/goal-app-server.ts`: separate Goal-channel commands, evidence state machine, and App Server adapter.

## Change discipline

Prefer removing a state or protocol over adding one. New durable state is justified only when a Controller restart cannot reconstruct the fact from Git, the filesystem, the OS process result, or GitHub. Keep runtime dependencies at zero unless a dependency removes substantially more code and failure surface than it adds.
