# 运维手册

## 上线前

```bash
npm ci
npm run verify
node dist/src/cli.js config validate --config /PRIVATE/PATH/controller.json --json
node dist/src/cli.js doctor --config /PRIVATE/PATH/controller.json --json
node dist/src/cli.js plan validate --config /PRIVATE/PATH/controller.json --plan /PRIVATE/PATH/release-plan.json --json
```

Config 必须是 v4；required-check identity、timeout、merge method、paths 与 validation commands 必须符合目标仓库真实策略。

## 启动与观察

```bash
node dist/src/cli.js start \
  --config /PRIVATE/PATH/controller.json \
  --plan /PRIVATE/PATH/release-plan.json \
  --approve-plan PLAN_DIGEST \
  --json

node dist/src/cli.js run --config /PRIVATE/PATH/controller.json --job RELEASE_ID --json
node dist/src/cli.js status --config /PRIVATE/PATH/controller.json --job RELEASE_ID --operator --json
```

`--approve-plan` 必须等于 `plan validate` 返回的 64 位 digest。Controller 私下 snapshot config/Plan 并在恢复时拒绝 drift，但不要求 Planner 批准 config 或 Controller build。

## Blocked 与中断

- `replan_required`：保存 report/receipt，执行 `abort`，回 Planner 生成并批准新 Plan，再创建新 Job。
- recoverable：修复不改变 Plan authority 的基础设施问题，提供新的 regular evidence file，再执行 `retry --reason ... --evidence ...`。

优先用 SIGINT/SIGTERM。若异常中断，先确认无遗留 Codex 进程，再执行 `step`；Controller 会核对 Worktree/HEAD 并启动 fresh recovery。

## 输出

```bash
node dist/src/cli.js report export --config /PRIVATE/PATH/controller.json --job RELEASE_ID --out /PUBLIC/PATH/review.md --json
node dist/src/cli.js result export --config /PRIVATE/PATH/controller.json --job RELEASE_ID --out /PUBLIC/PATH/release-result.json --json
```

`report export` 可用于非终态 Job；Result 只允许 verified merged Job。输出必须位于 `stateDir` 外，已有不同字节的目标文件会被拒绝。

`cleanup` 只删除 terminal 且 clean 的 Worktree，不删除 Job、receipts、runs、retry evidence、branch 或公开结果。
