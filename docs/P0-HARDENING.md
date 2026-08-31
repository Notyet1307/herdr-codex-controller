# P0 hardening release notes

## Controller PR A: execution containment and identity

- Config v2 / Job State v3 / Controller provenance v2 are required for `release-plan-v2-direct`.
- Validation Receipt v3 binds a clean per-command candidate projection, sandbox policy, command set, bounded streamed outputs, termination reason, and restart-safe cleanup.
- Production validation uses a verified Codex permission-profile sandbox with isolated HOME/TMP/cache, closed `HERDR_*` environment, a digest-bound Node stdio normalization shim, network and Unix sockets denied, private Controller roots unreadable, and projection-external writes denied.
- Ignored implementation state is never projected. Changed symlinks/hardlinks/devices/FIFOs/sockets are rejected; unchanged tracked symlinks are accepted only when they resolve inside the projection.
- Codex execution binds binary bytes/version/path digests and fixed no-profile/no-user-config/no-rules/no-AGENTS/no-MCP/no-hooks/no-plugins runtime controls. Events, stderr, and final result files are byte-bounded.
- Git fetch/push endpoints are explicit GitHub identities bound to `repo`; raw remote drift, pushurl ambiguity, URL rewrites, helpers, and local/file transports fail before production Git side effects. Controller Git hooks and fsmonitor are disabled.
- Public completion v2 includes runtime/sandbox/remote identities without local paths. `npm run contract:generate` deterministically updates the owned-schema lock; `npm run contract:check` verifies it.

## Operator migration

1. Start from `examples/controller.config.example.json`; do not add new authority to a v1 file in place.
2. Set absolute `codex.bin` and `validation.sandbox.bin` paths to reviewed executables.
3. Put `validation.sandbox.root` outside checkout, state, worktree, HOME, and system temp roots (for example a private directory under `/var/tmp`).
4. Declare exact `remoteIdentity.fetchUrl` and `pushUrl`; run `doctor` and confirm the returned identity and sandbox policy digest.
5. Each validation command gets a fresh projection. Combine isolated dependency installation and its check in one command, such as `npm ci --ignore-scripts --no-audit --no-fund && npm test`.
6. Re-run `plan validate`; obtain fresh approval for the new config/provenance digest. Never rewrite an active old Job into Job State v3.

Old config v1 remains readable only in explicit `release-plan-v1-compatibility` or `dispatcher-experimental` mode. Attempting direct production use returns `production_config_migration_required`.

## Not claimed by PR A

Canonical review/CI semantics, durable CI deadlines and budgets, remote merge-authority revocation/quarantine, and historical Controller completion trust are delivered by dependent Controller PR B. PR A does not qualify Dispatcher or Legacy Herdr and does not add automatic rebasing or Oracle v2/package mutation.
