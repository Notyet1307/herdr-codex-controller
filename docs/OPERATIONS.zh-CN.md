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

Prepare Gate 在真实 Release Worktree 中先执行一次可选 `validation.bootstrap`，再执行 `validation.setup`。Bootstrap 只使用既有 `networkAccess`；setup 强制断网。两者前后都重验 HEAD、branch、remote 与 Git-visible clean；允许保留被 `.gitignore` 忽略的依赖/cache，不允许修改源码、测试、脚本、manifest 或 lockfile。失败时 Job 保留在 `prepare`，且零产品 Worker；显式 retry 会重跑完整 Gate。

依赖准备必须放在可选 `validation.bootstrap`，不能拼入 Planner 绑定的 Oracle command。后续 Issue/Release semantic validation 仍在每条 command 的独立 projection 中重跑 Bootstrap；semantic command 始终断网。通常使用 `npm ci --ignore-scripts --no-audit --no-fund`。doctor 分别返回 validation 与 bootstrap policy digest。

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
node dist/src/cli.js status --config /PRIVATE/PATH/controller.json --job RELEASE_ID --public --json
```

`--approve-plan` 必须等于 `plan validate` 返回的 64 位 digest。Controller 私下 snapshot config/Plan 并在恢复时拒绝 drift，但不要求 Planner 批准 config 或 Controller build。

`start` 只验证 Config/Plan/精确批准并持久化 `prepare` Job；Git/GitHub/Codex/Sandbox preflight 由后续 `step/run` 的 Prepare Gate 执行。这样环境失败仍有同一 Job 作为显式 retry/abort 的恢复锚点。

`--public` 与 `--operator` 互斥。Public Status 只投影 release/Plan identity、phase、Issue 进度、candidate、脱敏 Block 摘要和精简 merge 结果；不包含路径、日志、prompt、retry evidence、环境或凭据。它是按需读取，不产生 public receipt，也不轮询。不存在的 Job 返回稳定 `job_not_found`。

## Blocked 与中断

- `recoverable`：确定的环境/执行器故障；修复后提供新的 regular evidence file，再显式 `retry --reason ... --evidence ...`。
- `manual`：Controller 不能确定应 retry、人工修复还是 abort/replan；只允许 Operator 做出决定后显式操作。
- `replan_required`：仅确定性的 Plan/base/Parent/Child 权威失效；保存 report/receipt，显式 `abort`，回 Planner 生成并批准新 Plan，再创建新 Job。

`blocked.code` 始终保留原始 cause；`blocked.kind` 才是恢复路由。模型自称 replan、越界、repair budget 耗尽、Reviewer blocked 和未知 code 均为 `manual`。旧 Job 缺少 kind 时继续只读兼容，Public Status 标记 `legacy=true`，status 不改写其 bytes。

Codex CLI、Provider 或登录检查失败统一保留为 `codex_preflight_failed / recoverable`，且公开/终端错误不回显 Provider diagnostic 中的凭据形文本。

`development_bootstrap_failed` 与 `development_setup_failed` 是可修复环境失败；`development_bootstrap_mutated_source`、`development_setup_mutated_source` 与 bootstrap policy 失败需要人工检查。不要因此给 Worker 开网。

优先用 SIGINT/SIGTERM。若异常中断，先确认无遗留 Codex 进程，再执行 `step`；Controller 会核对 Worktree/HEAD 并启动 fresh recovery。

## 输出

```bash
node dist/src/cli.js report export --config /PRIVATE/PATH/controller.json --job RELEASE_ID --out /PUBLIC/PATH/review.md --json
node dist/src/cli.js result export --config /PRIVATE/PATH/controller.json --job RELEASE_ID --out /PUBLIC/PATH/release-result.json --json
```

`report export` 可用于非终态 Job；Result 只允许 verified merged Job。输出必须位于 `stateDir` 外，已有不同字节的目标文件会被拒绝。

`cleanup` 只删除 terminal 且 clean 的 Worktree，不删除 Job、receipts、runs、retry evidence、branch 或公开结果。
