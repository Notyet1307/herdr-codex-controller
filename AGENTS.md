# AGENTS.md

## Project purpose

This repository is a thin Codex-first release delivery controller. It executes an ordered group of GitHub Issues on one release branch/worktree, using one fresh `codex exec --ephemeral` Worker per Issue, deterministic Controller-owned validation, and one fresh read-only aggregate release review after all Issues are committed.

## Non-negotiable boundaries

- The Controller owns release state, Git commits, pushes, pull requests, CI observation, and merge facts.
- Codex owns implementation inside the worktree, including its internal planning, self-review, and optional native subagents.
- Do not add Pi, Herdr sessions, pi-subagents, Agent Teams, model-turn persistence, transcript resume, child-agent state, or per-Issue independent review.
- Never treat a model statement as proof that Git, validation, PR, CI, or merge succeeded.
- Recovery uses the current Git worktree and fresh Codex execution. Do not resume a prior Codex session.
- One repository release is serial. Parallelism belongs above this controller, across isolated repositories/jobs.
- Validation commands are trusted operator configuration and must remain observational: they may not change the Git-visible worktree.
- Worker and hardening Codex runs may not commit, push, invoke `gh`, change branches/remotes, or modify GitHub state.
- The release reviewer is read-only and reviews one exact `baseSha...candidateSha` aggregate candidate.
- Production accepts only source-bound Release Plan v2 and always delivers through reviewed PR checks plus exact-head Controller auto-merge; Release Plan v1, Dispatcher, and manual merge paths do not exist.

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
- `src/provenance.ts`: Controller source/build identity and Job provenance binding.
- `src/prompts.ts`: Issue Worker, release hardening, and aggregate review prompts.
- `src/cli.ts`: operator commands.

## Change discipline

Prefer removing a state or protocol over adding one. New durable state is justified only when a Controller restart cannot reconstruct the fact from Git, the filesystem, the OS process result, or GitHub. Keep runtime dependencies at zero unless a dependency removes substantially more code and failure surface than it adds.
