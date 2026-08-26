# Herdr Codex Controller

A thin, standalone Codex-first release delivery controller.

It runs an ordered group of GitHub Issues on one release branch/worktree. Each Issue gets a fresh non-interactive Codex Worker, the Controller runs deterministic validation and creates one commit per Issue, and the completed aggregate candidate receives one fresh read-only release review before PR/CI delivery.

The Controller does **not** implement an agent runtime. Codex owns internal planning, self-review, and optional native subagents. Git, command exit codes, and GitHub remain the delivery truth sources.

See [README.zh-CN.md](./README.zh-CN.md) for the complete guide and [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md) for the design.

```bash
npm install
npm run verify
node dist/src/cli.js --help
```
