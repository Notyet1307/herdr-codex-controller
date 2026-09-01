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

依赖准备必须放在可选 `validation.bootstrap`，不能拼入 Planner 绑定的 Oracle command。Bootstrap 对每一条 semantic command 的独立 projection 重跑；`validation.setup` 只验证 baseline，不提供后续缓存。通常使用 `npm ci --ignore-scripts --no-audit --no-fund`。只有 bootstrap 可按配置联网，随后 semantic validation 总是重新进入断网 policy；doctor 分别返回 validation 与 bootstrap policy digest。

`validation.sandbox.environmentPath` 必须指向 sandbox 可读的稳定系统 runtime。不要使用被 HOME 拒绝规则覆盖的版本管理器路径，不要全局安装项目工具，也不要复制 checkout 的 `node_modules`。

Controller 为每条 command projection 在 configured sandbox root 内创建独立 runtime sibling；其 TMP 位于 candidate 根之外，bootstrap 与对应 semantic command 共享，下一条 command、另一个 Job 或另一个 repository 不复用。整个 validation run 最终统一清理。不同 repository 仍应配置不同的 `stateDir`、`worktreeRoot` 与 `validation.sandbox.root`，便于运维隔离；即使误用同一 sandbox root，run/command identity 也不得发生路径碰撞或临时状态复用。

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
