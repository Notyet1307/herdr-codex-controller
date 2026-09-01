# Herdr Codex Controller

A thin Codex-first controller for one ordered group of GitHub Issues:

```text
release-plan.json
→ baseline
→ fresh Worker per Issue
→ Controller validation and commits
→ aggregate read-only review
→ optional review Demo
→ PR, required CI, exact-head auto-merge, merge verification
→ review.md + release-result.json
```

The shared boundary is semantic `controllerContractVersion: 1`; Planner does not pin Controller source or build bytes. Controller keeps runtime, remote, sandbox, candidate, PR, CI, and merge checks as local authority.

```bash
npm ci
npm run verify

node dist/src/cli.js plan validate --config /private/controller.json --plan /private/release-plan.json --json
node dist/src/cli.js start \
  --config /private/controller.json \
  --plan /private/release-plan.json \
  --approve-plan 64HEX \
  --json
node dist/src/cli.js run --config /private/controller.json --job RELEASE_ID --json
```

Export the human review bundle at any Job state:

```bash
node dist/src/cli.js report export --config /private/controller.json --job RELEASE_ID --out /public/review.md --json
```

Export the concise machine result after verified merge:

```bash
node dist/src/cli.js result export --config /private/controller.json --job RELEASE_ID --out /public/release-result.json --json
```

See [README.zh-CN.md](./README.zh-CN.md), [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md), and [docs/OPERATIONS.zh-CN.md](./docs/OPERATIONS.zh-CN.md).
