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
