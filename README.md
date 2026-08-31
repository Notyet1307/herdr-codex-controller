# Herdr Codex Controller

A thin, standalone Codex-first release delivery controller.

It runs an ordered group of GitHub Issues on one release branch/worktree. Each Issue gets a fresh non-interactive Codex Worker, the Controller runs deterministic validation and creates one commit per Issue, and the completed aggregate candidate receives one fresh read-only release review before PR/CI delivery.

The Controller does **not** implement an agent runtime. Codex owns internal planning, self-review, and optional native subagents. Git, command exit codes, and GitHub remain the delivery truth sources. Every writing run (`worker`, `issue-repair`, and `release-harden`) is explicitly routed to `gpt-5.6-terra` with `high` reasoning; only the read-only aggregate `review` run is routed to `gpt-5.6-sol` with `max` reasoning.

The qualified production mode is `release-plan-v2-direct`, which is also the default when `executionMode` is omitted. It accepts only source-bound Release Plan v2 and never reads `ready-for-agent`. Release Plan v1 requires explicit `release-plan-v1-compatibility`; the retained Dispatcher requires explicit `dispatcher-experimental` and is not a qualified production path.

Release Plan v2 is the exact source-bound `pi-ticket-planning` handoff: it binds the configured repository/base ref, one 40-character base commit, the Parent and Child Issue bytes, decision/predecessor/dependency digests, and every Issue's immutable Oracle, closed verifier manifest, canonical mirrored risk classes, scope budget, literal-first-segment write families, protected paths, and replan triggers. The Controller protects every Oracle verifier file and `package.json` across the whole Release. Validation Receipt v3 binds the exact clean candidate tree, sandbox policy, command identities, bounded streaming output hashes/termination, and cleanup completion. Release validation runs every Oracle again. Any Oracle/verifier, scope, protected-path, or risk-class drift maps to terminal `replan_required`. `plan validate --json` returns the exact Controller provenance approved by `start`:

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

Config v3 extends the containment contract with canonical aggregate-review semantics, app-bound required-check identities/conclusions/deadlines, separate repair budgets, and exact-head Controller auto-merge. Job State v4 / provenance v3 bind those policies alongside Controller, Codex, sandbox, remote, config, and Plan identities. Missing or pending checks reach durable deadlines; observational checks never control delivery; infrastructure failures never trigger code changes without exact bounded evidence. Any source/config/provenance loss after PR creation revokes auto-merge and deletes the Controller-owned remote branch with an expected-head force-with-lease; a changed head is never mutated.

Every validation command still receives its own disposable blob projection with isolated HOME/TMP/cache, no inherited Controller secrets, no network or Unix sockets, and no writes outside the projection. A check that needs dependencies must install them inside that same command (for example `npm ci --ignore-scripts --no-audit --no-fund && npm test`). Config v1/v2 remain compatibility-readable but cannot start new production direct Jobs.

The pinned schemas include [`release-plan-v2.schema.json`](./schemas/release-plan-v2.schema.json), public [`release-completion-v3.schema.json`](./schemas/release-completion-v3.schema.json), and the append-only [`controller-identity-history-v1.schema.json`](./schemas/controller-identity-history-v1.schema.json). Verified merge atomically checkpoints public-safe completion bytes. A later Controller can re-publish an older v2 completion only when its exact identity and owned schema hashes remain qualified and unrevoked in the tracked history.

Before activating a future Controller C, its release branch must append the exact clean outgoing B identity with `npm run history:append -- --controller-root /clean/B --activated-at ISO --write`. The active Planner lock still selects C for new handoffs; the history registry is only for completion produced by outgoing qualified identities.

```bash
node dist/src/cli.js completion export --config /private/controller.json --job RELEASE_ID --out /public/release-completion.json --json
```

The v3 config example contains placeholders; bind its exact check/app/workflow identities and time budgets to the approved repository policy before use.

See [README.zh-CN.md](./README.zh-CN.md) for the complete guide, [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md) for the design, and [docs/P0-HARDENING.md](./docs/P0-HARDENING.md) for migration and release notes.

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
