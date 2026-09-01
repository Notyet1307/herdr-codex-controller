# Herdr Codex Controller

A thin Codex-first controller for delivering one ordered Release Plan through fresh Workers, Controller-owned validation, one aggregate review, a pull request, required CI, exact-head auto-merge, and verified completion.

Production has one path only: source-bound Release Plan v2. Release Plan v1, Dispatcher commands, custom Codex profiles, optional review, local-only completion, and manual merge authority have been removed.

```text
prepare → implement → verify → review → repair → deliver → complete
```

High-value boundaries remain unchanged:

- one repository, branch, Writer, and isolated worktree per Job;
- one fresh `codex exec --ephemeral` Worker per Issue;
- Controller-owned commits, push, PR, CI observation, and merge facts;
- disposable validation projections with isolated HOME/TMP/cache and no network;
- one fresh read-only aggregate review bound to the exact candidate;
- required exact-head checks before Controller auto-merge;
- merge SHA, ancestry, and merge-tree verification after merge;
- active-run and Controller-commit crash recovery.

Config v4 contains only operator choices. Review, critical/major blocking, PR creation, required checks, exact-head auto-merge, disabled custom profiles, and disabled Worker/Reviewer network are code invariants.

An optional single `reviewDemo` command runs after aggregate review on a disposable exact-candidate projection. It has isolated HOME/TMP/cache, no inherited credentials, network off by default, and copies only safe regular files from `.herdr-review-output/` into private Job artifacts.

```bash
npm ci
npm run verify

node dist/src/cli.js config validate --config /private/controller.json --json
node dist/src/cli.js plan validate --config /private/controller.json --plan /private/release-plan.json --json
node dist/src/cli.js start \
  --config /private/controller.json \
  --plan /private/release-plan.json \
  --expected-config-digest 64HEX \
  --expected-controller-revision 40HEX \
  --expected-controller-provenance-digest 64HEX \
  --json
node dist/src/cli.js run --config /private/controller.json --job RELEASE_ID --json
```

Generate the human review bundle at any Job state:

```bash
node dist/src/cli.js report export --config /private/controller.json --job RELEASE_ID --out /public/review.md --json
```

Verified merged Jobs can still export Completion v3 while the current Planner contract depends on it:

```bash
node dist/src/cli.js completion export --config /private/controller.json --job RELEASE_ID --out /public/completion.json --json
```

See [README.zh-CN.md](./README.zh-CN.md), [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md), and [docs/OPERATIONS.zh-CN.md](./docs/OPERATIONS.zh-CN.md).
