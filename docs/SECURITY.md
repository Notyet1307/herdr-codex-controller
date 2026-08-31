# Security boundary

## Untrusted inputs

Repository bytes, Issue and Planner strings, validation/CI output, and prior model results are untrusted data. Model prompts place them once in a size- and digest-bound JSON envelope whose delimiter characters are escaped; fixed Controller instructions remain outside. Model output never grants Git, GitHub, validation, retry, or merge authority.

## Codex runtime

Production direct mode requires absolute executable paths and disallows custom Codex profiles. Every run uses fresh ephemeral execution, approvals `never`, fixed models/reasoning, `--ignore-user-config`, `--ignore-rules`, an untrusted project layer, empty MCP/hooks/plugins, no extra writable roots, a closed shell environment policy, and network disabled. Job provenance binds executable bytes/version/path digests and the fixed policy digest; drift blocks before model execution.

## Authoritative validation

Trusted command strings do not make candidate scripts trusted. Validation runs only in a disposable projection built from the exact tracked candidate tree plus admitted non-ignored changes. Worker-created `.env`, `.npmrc`, node_modules, caches, generated ignored files, and implementation-worktree state are absent. New/changed symlinks, hardlinks, devices, FIFOs, and sockets are rejected.

The Codex permission-profile sandbox uses an isolated HOME/TMP/cache and a closed `HERDR_*` environment allowlist. It denies network and Unix sockets, credential roots, and writes outside the projection. Streamed stdout/stderr and aggregate output have hard byte limits and process-group termination; final structured results are descriptor-read only after type/link/size checks. Validation commands may create disposable dependencies or build output, but every authoritative candidate file's bytes, mode, link count, and type are reverified afterward. Cleanup intent is durable and restart-safe.

## Git and GitHub

Config v2 binds exact canonical GitHub fetch/push endpoints to `repo`. Doctor, fetch, Worktree preparation, push, and completion re-read raw remote config and reject local/file/helper endpoints, multiple URLs, unexpected pushurl, and URL rewrites. Controller Git commands disable hooks and fsmonitor; commits/pushes also use `--no-verify`, file/ext transports are denied in production, and SSH ignores ambient host/ProxyCommand configuration. GitHub mutations remain Controller-owned and exact-identity bound.

## Evidence and residual trust

Private logs and state use bounded, regular, non-symlink files. Public completion v2 contains executable path digests rather than local paths. This release does not claim containment against a malicious local operator with the Controller OS account, a compromised kernel, or compromised exact bytes of the bound Git/GitHub/Codex executables. Review/CI/merge-authority lifecycle and historical identity revocation are delivered by the dependent lifecycle hardening release, not inferred from this containment layer.
