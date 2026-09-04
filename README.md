# Herdr Codex Controller

A thin Codex-first controller for one ordered group of GitHub Issues:

```text
release-plan.json
→ Prepare Gate (network-optional bootstrap, offline setup, clean source)
→ fresh Worker per Issue
→ Controller validation and commits
→ aggregate read-only review
→ optional review Demo
→ PR, required CI, exact-head auto-merge, merge verification
→ review.md + release-result.json
```

The shared boundary is semantic `controllerContractVersion: 2`; Planner does not pin Controller source or build bytes. Controller keeps runtime, remote, sandbox, candidate, PR, CI, and merge checks as local authority.

```bash
npm ci
npm run verify

node dist/src/cli.js plan validate --config /private/controller.json --plan /private/release-plan.json --json
node dist/src/cli.js start \
  --config /private/controller.json \
  --plan /private/release-plan.json \
  --approve-plan 64HEX \
  --json
node dist/src/cli.js run --config /private/controller.json --job JOB_ID --json
node dist/src/cli.js status --config /private/controller.json --plan /private/release-plan.json --public --json
```

`JOB_ID` is `job-<full planDigest>`; semantic `releaseId` remains `plan.id`. Public status is a bounded, redacted, on-demand projection. It never exposes private Job paths or replaces `release-result:v1`.

## Opt-in Goal channel

The separate Goal Runner consumes an exact `pi-ticket-planning:goal-handoff:v1`. It uses one fresh Thread per Issue, keeps the Goal persistent only inside that Issue, validates and commits deterministically, runs one detached read-only release review, then stops for human PR and merge.

```bash
node dist/src/goal-cli.js start --config /private/controller.json --handoff /private/goal-handoff.json --approve-handoff sha256:64HEX --runner-ref local --json
node dist/src/goal-cli.js run --config /private/controller.json --run-id RELEASE_ID --json
node dist/src/goal-cli.js status --config /private/controller.json --run-id RELEASE_ID --json
node dist/src/goal-cli.js result export --config /private/controller.json --run-id RELEASE_ID --pull-request 123 --out /public/goal-release-result.json --json
```

`GOAL_REMOTE` runs this same CLI on the allowlisted SSH target, accepts the handoff on stdin, and verifies the approved OS hostname before creating state. WebSocket App Server transport is not a production dependency. Goal turns and the detached Reviewer remain network-disabled; the model control connection is separate. Goal Thread start/resume also clears MCP, plugins, hooks, project documents, inherited shell state, and rejects any reported instruction source.

Export the human review bundle at any Job state:

```bash
node dist/src/cli.js report export --config /private/controller.json --job JOB_ID --out /public/review.md --json
```

Export the concise machine result after verified merge:

```bash
node dist/src/cli.js result export --config /private/controller.json --job JOB_ID --out /public/release-result.json --json
```

See [README.zh-CN.md](./README.zh-CN.md), [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md), and [docs/OPERATIONS.zh-CN.md](./docs/OPERATIONS.zh-CN.md).
