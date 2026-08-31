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

1. Start from the config v3 `examples/controller.config.example.json`; v1/v2 direct configs are not silently upgraded.
2. Set absolute `codex.bin` and `validation.sandbox.bin` paths to reviewed executables.
3. Put `validation.sandbox.root` outside checkout, state, worktree, HOME, and system temp roots (for example a private directory under `/var/tmp`).
4. Declare exact remote identity, app-bound required check conclusions/deadlines, and expected-head remote-branch quarantine; `doctor` must confirm strict server policy and all contract digests.
5. Each validation command gets a fresh projection. Combine isolated dependency installation and its check in one command, such as `npm ci --ignore-scripts --no-audit --no-fund && npm test`.
6. Re-run `plan validate`; obtain fresh approval for config v3 / provenance v3. Never rewrite an active old Job into Job State v4.

Old config v1/v2 remains readable only in explicit compatibility/experimental modes or the private historical completion verifier. Attempting a new direct production handoff returns `production_config_migration_required`.

## Controller PR B: lifecycle and historical trust

- Canonical review accepts PASS only with zero critical/major findings; `changes` requires at least one such finding. Direct production requires review enabled and exact critical/major blocking semantics.
- Required Check Contract v1 binds check/source/workflow identity, accepted conclusions, required versus observational status, and first/pending/post-merge deadlines. Repair, infrastructure, and provider counters are separate.
- Job State v4 durably records CI observations and delivery authority. Production uses only exact-head Controller auto-merge; block/replan/abort/drift disables it and deletes only the exact Controller branch with force-with-lease/readback.
- Verified merge checkpoints public completion v3 bytes. The append-only Controller identity history permits exact unrevoked v2 historical publication without allowing an inactive identity to authorize new handoffs.
- Controller upgrades are two-phase: before activating C, build exact clean outgoing B and run `npm run history:append -- --controller-root /clean/B --activated-at ISO --write` in C. This appends B without the impossible self-reference of making B contain its own source-manifest digest.

## Not claimed

These PRs do not qualify Dispatcher or Legacy Herdr and do not add automatic rebasing, Oracle v2, or package/verifier mutation.
