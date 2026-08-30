# Herdr Codex Controller

A thin, standalone Codex-first release delivery controller.

It runs an ordered group of GitHub Issues on one release branch/worktree. Each Issue gets a fresh non-interactive Codex Worker, the Controller runs deterministic validation and creates one commit per Issue, and the completed aggregate candidate receives one fresh read-only release review before PR/CI delivery.

The Controller does **not** implement an agent runtime. Codex owns internal planning, self-review, and optional native subagents. Git, command exit codes, and GitHub remain the delivery truth sources. Every writing run (`worker`, `issue-repair`, and `release-harden`) is explicitly routed to `gpt-5.6-terra` with `high` reasoning; only the read-only aggregate `review` run is routed to `gpt-5.6-sol` with `max` reasoning.

The qualified production mode is `release-plan-v2-direct`, which is also the default when `executionMode` is omitted. It accepts only source-bound Release Plan v2 and never reads `ready-for-agent`. Release Plan v1 requires explicit `release-plan-v1-compatibility`; the retained Dispatcher requires explicit `dispatcher-experimental` and is not a qualified production path.

Release Plan v2 is the exact source-bound `pi-ticket-planning` handoff: it binds the configured repository/base ref, one 40-character base commit, the Parent and Child Issue bytes, decision/predecessor/dependency digests, and every Issue's immutable Oracle, closed verifier manifest, risk classes, scope budget, write-path families, protected paths, and replan triggers. The Controller protects every Oracle verifier file and `package.json` across the whole Release, runs each Issue's exact Oracle commands before commit, and records their identity, timeout, candidate/worktree binding, process result, and output-log digests in Validation Receipt v2. Release validation runs every Oracle again. Any Oracle/verifier, scope, protected-path, or risk-class drift maps to terminal `replan_required`. `plan validate --json` returns the exact Controller provenance approved by `start`:

`verifier.packageScript.definitionSha256` is SHA-256 over the exact UTF-8 npm script string. The verifier manifest digest is `sha256:` plus the repository's canonical `digestJson` of the manifest with its `digest` field omitted; verifier files remain in supplied lexicographic path order.

```bash
node dist/src/cli.js plan validate --config /private/controller.json --plan /private/release-plan.json --json
node dist/src/cli.js start \
  --config /private/controller.json \
  --plan /private/release-plan.json \
  --expected-config-digest 64HEX \
  --expected-controller-revision 40HEX \
  --expected-controller-provenance-digest 64HEX \
  --json
```

The Job atomically snapshots the Controller commit, canonical tracked-source manifest digest, executable build/package digest, execution mode, config digest, and Release Plan version/digest. Every execution step compares the current identity with that snapshot and blocks on drift. `config validate`, `doctor`, `start`, and `status` expose the relevant identity; `status.provenanceMatches` is the readback comparison.

The pinned schemas are [`release-plan-v1.schema.json`](./schemas/release-plan-v1.schema.json), [`release-plan-v2.schema.json`](./schemas/release-plan-v2.schema.json), and the [`oneOf` aggregate entry point](./schemas/release-plan.schema.json). No Planner/Controller cross-repository canary is claimed by this repository change alone.

The v2 example contains format-valid placeholder hashes; replace every source/expected value with the approved Planner handoff rather than attempting to run it unchanged.

See [README.zh-CN.md](./README.zh-CN.md) for the complete guide and [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md) for the design.

```bash
npm install
npm run verify
node dist/src/cli.js --help
```

Experimental Dispatcher commands use a separate operator-owned policy file and a Controller config with `"executionMode": "dispatcher-experimental"`:

```bash
node dist/src/cli.js dispatch --config /private/controller.json --dispatcher /private/dispatcher.json
node dist/src/cli.js dispatch status --config /private/controller.json --dispatcher /private/dispatcher.json --json
```
