# Security boundary

## Untrusted inputs

Repository bytes, Issue and Planner strings, validation/CI output, and prior model results are untrusted data. Model prompts place them once in a size- and digest-bound JSON envelope whose delimiter characters are escaped; fixed Controller instructions remain outside. Model output never grants Git, GitHub, validation, retry, or merge authority.

## Codex runtime

Production direct mode requires absolute executable paths and disallows custom Codex profiles. Every run uses fresh ephemeral execution, approvals `never`, fixed models/reasoning, `--ignore-user-config`, `--ignore-rules`, an untrusted project layer, empty MCP/hooks/plugins, no extra writable roots, a closed shell environment policy, and network disabled. Job provenance binds executable bytes/version/path digests and the fixed policy digest; drift blocks before model execution.

## Authoritative validation

Trusted command strings do not make candidate scripts trusted. Validation runs only in a disposable projection built from the exact tracked candidate tree plus admitted non-ignored changes. Worker-created `.env`, `.npmrc`, node_modules, caches, generated ignored files, and implementation-worktree state are absent. New/changed symlinks, hardlinks, devices, FIFOs, and sockets are rejected.

The Codex permission-profile sandbox uses an isolated HOME/TMP/cache and a closed `HERDR_*` environment allowlist. It denies network and Unix sockets, credential roots, and writes outside the projection. Streamed stdout/stderr and aggregate output have hard byte limits and process-group termination; final structured results are descriptor-read only after type/link/size checks. Validation commands may create disposable dependencies or build output, but every authoritative candidate file's bytes, mode, link count, and type are reverified afterward. Cleanup intent is durable and restart-safe.

## Git and GitHub

Config v4 retains exact remote binding and an app-bound required-check contract. Controller-owned exact-head auto-merge is the only merge authority. On block, replan, abort, or drift, the Controller verifies the exact PR, disables auto-merge, and quarantines by deleting only the exact expected remote head with `--force-with-lease`; a changed head is untouched and the failure remains visibly unsafe.

## Evidence and residual trust

Private logs and state use bounded, regular, non-symlink files. Public completion v3 contains path digests rather than local paths and is byte-checkpointed at verified merge. Historical v2 publication requires the tracked identity registry's exact identity, schema hashes, digest algorithm, qualification, and non-revocation. This release does not claim containment against a malicious local operator with the Controller OS account, a compromised kernel, or compromised exact bytes of bound executables.
