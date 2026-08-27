# Unreleased

Added an optional fail-closed serial Issue dispatcher and hardened auto-merge:

- select only the first parent-ordered open `ready-for-agent` child with no assignee and zero native open blockers;
- persist claim/job identity across GitHub/local crash windows and recheck exact Issue source immediately before the first Worker;
- require reviewed squash auto-merge with `gh pr merge --auto --match-head-commit <candidateSha>`;
- refuse a subsequent claim until the merge commit is on the configured base, the Issue is closed, and every configured main push workflow succeeds;
- continue in the same dispatcher run to select and claim the next eligible Issue once all post-merge gates pass;
- expose `dispatch`, `dispatch status`, and explicit `dispatch retry` commands with a closed JSON Schema and example policy;
- keep labels, retries, cleanup, Agent state, and same-repository parallelism outside automatic authority.

Pinned Codex execution routing so all writing and hardening runs use `gpt-5.6-terra` with `high` reasoning, while only aggregate read-only release review uses `gpt-5.6-sol` with `max` reasoning. Explicit invocation flags override any profile-level model defaults.

Added a backward-compatible Release Plan v2 source-binding contract for `pi-ticket-planning` handoffs:

- preserved Release Plan v1 validation and execution semantics;
- published versioned v1/v2 schemas plus the existing `release-plan.schema.json` `oneOf` entry point;
- bound v2 plans to exact config `repo`/`baseRef` and required an approved current config digest at `start`;
- verified current remote base, Parent OPEN/title/raw-body hash, and every Child OPEN/title/raw-body hash before Worktree creation, setup validation, or Codex execution;
- persisted the complete v2 plan, plan digest, verified base SHA, and exact GitHub snapshots in Controller-owned Job state;
- added stable config/source drift error codes and zero-side-effect failure tests;
- added schema/runtime/CLI contract fixtures using a development-only JSON Schema validator; runtime npm dependencies remain zero.

Verified with strict TypeScript checking, 27 deterministic tests, and `npm audit` with zero known vulnerabilities at verification time. These tests do not claim that a real cross-repository `pi-ticket-planning` → Controller canary has run; that evidence must come from a later Planner handoff.

Rollback affects only future v2 Job creation: reverting this change does not rewrite existing v1 Jobs, Worktrees, commits, PRs, or Controller evidence.

# v0.1.0

Initial standalone Codex-first release controller.

Implemented:

- one release branch/worktree for an ordered Issue group;
- one fresh `codex exec --ephemeral` Worker per Issue;
- Worker self-review without per-Issue independent Reviewer;
- deterministic setup, Issue, and full Release validation;
- Controller-owned one-commit-per-Issue checkpoints;
- one exact-candidate aggregate read-only release review;
- bounded Issue repair, release hardening, and optional CI repair;
- idempotent PR recovery, exact head/base/branch candidate binding, check observation, manual or auto-merge gates;
- atomic job state, single-Controller lock, stale-lock recovery;
- one active release per repository state root;
- fresh recovery over preserved Worktree after interrupted Codex runs;
- SIGINT/SIGTERM process-group termination with durable fresh-recovery state;
- exact Issue and hardening commit salvage after commit/state crash windows;
- zero runtime npm dependencies.

Verified with TypeScript strict typechecking and 14 deterministic tests using real temporary Git repositories/worktrees plus fake Codex/GitHub executables and ports.

Not claimed in v0.1.0:

- live execution against the user's Codex account or GitHub repository in this build environment;
- containment against unsafe Codex profiles, malicious local binaries, or SIGKILL orphan processes;
- same-repository parallel release execution;
- automatic planning of Issue groups.
