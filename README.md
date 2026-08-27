# Herdr Codex Controller

A thin, standalone Codex-first release delivery controller.

It runs an ordered group of GitHub Issues on one release branch/worktree. Each Issue gets a fresh non-interactive Codex Worker, the Controller runs deterministic validation and creates one commit per Issue, and the completed aggregate candidate receives one fresh read-only release review before PR/CI delivery.

The Controller does **not** implement an agent runtime. Codex owns internal planning, self-review, and optional native subagents. Git, command exit codes, and GitHub remain the delivery truth sources.

Release Plan v1 remains the backward-compatible format for manual and existing integrations. Release Plan v2 is the exact source-bound `pi-ticket-planning` handoff: it binds the configured repository/base ref, one 40-character base commit, the Parent Issue, and every Child Issue title/body. Before creating a Worktree, v2 re-fetches and verifies all of those facts. Its `start` command also requires the exact digest of the currently validated Controller config:

```bash
CONFIG_DIGEST=$(node dist/src/cli.js config validate --config /private/controller.json --json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).configDigest))')
node dist/src/cli.js start --config /private/controller.json --plan /private/release-plan.json --expected-config-digest "$CONFIG_DIGEST" --json
```

The pinned schemas are [`release-plan-v1.schema.json`](./schemas/release-plan-v1.schema.json), [`release-plan-v2.schema.json`](./schemas/release-plan-v2.schema.json), and the [`oneOf` aggregate entry point](./schemas/release-plan.schema.json). No Planner/Controller cross-repository canary is claimed by this repository change alone.

The v2 example contains format-valid placeholder hashes; replace every source/expected value with the approved Planner handoff rather than attempting to run it unchanged.

See [README.zh-CN.md](./README.zh-CN.md) for the complete guide and [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md) for the design.

```bash
npm install
npm run verify
node dist/src/cli.js --help
```
