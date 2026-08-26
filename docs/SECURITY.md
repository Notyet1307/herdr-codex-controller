# Security boundary

- Codex Worker and hardening runs are launched with `workspace-write`, approvals set to `never`, and workspace network access set to false.
- Aggregate review uses `read-only`.
- The configured Codex profile is trusted operator input. Do not enable external write-capable MCP servers, dangerous hooks, extra writable roots, or bypass flags in profiles used by this controller.
- Setup and validation shell commands are trusted Controller configuration and run outside the Codex sandbox. Never interpolate untrusted Issue content into those commands.
- GitHub Issue bodies are untrusted model context. They cannot directly select commands, paths outside the worktree, Git credentials, PR actions, or Controller state transitions.
- The Controller checks Git HEAD and branch after every Codex run and compares the Git-visible worktree around validation/review.
- No credential value is intentionally written to job state or result schemas. Codex environment inheritance is reduced and automatic secret-name exclusions are enabled.
- V0.1 does not claim containment against a malicious local operator, compromised Codex binary, compromised Git/GitHub CLI, unsafe user Codex profile, or `SIGKILL` orphan processes.
