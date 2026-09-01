# 运维手册

## 上线前

确认 `git`、`gh`、`codex`、Node、目标 checkout、remote identity、required-check server policy 和 validation sandbox 均可用。先执行：

```bash
npm ci
npm run verify
node dist/src/cli.js config validate --config /PRIVATE/PATH/controller.json --json
node dist/src/cli.js doctor --config /PRIVATE/PATH/controller.json --json
node dist/src/cli.js plan validate --config /PRIVATE/PATH/controller.json --plan /PRIVATE/PATH/release-plan.json --json
```

Config 必须是 v4。固定生产策略不接受 JSON override；required-check app/workflow identity、timeouts、merge method 和 paths 必须与目标仓库真实策略一致。

## 启动与观察

```bash
node dist/src/cli.js start \
  --config /PRIVATE/PATH/controller.json \
  --plan /PRIVATE/PATH/release-plan.json \
  --expected-config-digest CONFIG_DIGEST \
  --expected-controller-revision CONTROLLER_SHA \
  --expected-controller-provenance-digest PROVENANCE_DIGEST \
  --json

node dist/src/cli.js run --config /PRIVATE/PATH/controller.json --job RELEASE_ID --json
node dist/src/cli.js status --config /PRIVATE/PATH/controller.json --job RELEASE_ID --operator --json
```

Admission 才核对 Parent/Child title/body。Job 启动后 Issue 文案变化不会自动使旧 Job 失效；remote base 会在 delivery 与 auto-merge authorization 前重新核对。

## Blocked

- `replan_required`：保存 review/receipt，执行 `abort`，回 Planner 生成并批准新 Plan，再创建新 Job。
- recoverable：修复不改变 Plan authority 的基础设施/凭据/固定依赖问题，生成新的 regular evidence file，再执行 `retry --reason ... --evidence ...`。

不要通过 retry 改 Plan、base、Issue snapshot、accepted ADR 或 dependency handoff，也不要增加 code-repair budget。

## 中断

优先使用 SIGINT/SIGTERM。若被 SIGKILL，先确认无遗留 Codex 进程，再执行 `step`。Controller 会核对 Worktree/HEAD 并使用 fresh recovery；不会恢复 transcript/session。

## Review 与 Completion

```bash
node dist/src/cli.js report export --config /PRIVATE/PATH/controller.json --job RELEASE_ID --out /PUBLIC/PATH/review.md --json
node dist/src/cli.js completion export --config /PRIVATE/PATH/controller.json --job RELEASE_ID --out /PUBLIC/PATH/completion.json --json
```

`report export` 可用于非终态 Job；Completion 只允许 verified merged checkpoint。两种输出都必须在 `stateDir` 外，已有不同字节的目标文件会被拒绝。

## 清理

`cleanup` 只删除 terminal 且 clean 的 Worktree，不删除 Job、receipt、runs、retry evidence、branch 或公开结果。历史 state 迁移前先确认没有 active Job/process，并使用可逆归档。
