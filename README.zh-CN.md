# Herdr Codex Controller

一个轻量、Codex-first 的 Release 交付控制器。

仓库同时提供一个独立、显式启用的 Goal Runner。它不改变 Controller Job：每个 Ticket 使用一个 fresh Codex Thread，Ticket 内保持 persistent Goal，确定性验证后由 Runner commit，Release 级 fresh read-only Review 通过后停在人工 PR/合并。

```text
pi-ticket-planning 的 release-plan.json
→ 修改前 baseline
→ 每个 Issue 一个 fresh Codex Worker
→ Controller 权威验证并 commit
→ 完整 Release 验证
→ 一次 fresh、read-only aggregate review
→ 可选真实 Demo
→ PR / required CI / exact-head auto-merge
→ merge identity/tree 验证
→ review.md + release-result.json
```

项目不实现通用 Agent Runtime、Transcript Resume、per-Issue Reviewer、Evidence Manifest 或 Proof Closure。生产只有一条语义 Plan 主路径；Dispatcher、Plan v1/v2 兼容执行、人工 merge、Completion v1-v3、Controller provenance、runtime lock 与 identity history 已删除。

## 权限与事实

| 事实 | authority |
|---|---|
| 目标、Issue 顺序与 AC | approved `release-plan.json` |
| 代码与 diff | Release Worktree / Git |
| baseline、Issue、Release 检查 | Controller 实际 command exit status |
| Agent 自查 | Worker structured result，仅作审查信息 |
| Aggregate Review | exact candidate 的只读 Reviewer 判断 |
| commit、push、PR、CI、merge | Controller |

状态机是：

```text
prepare → implement → verify → review → repair → deliver → complete
```

Admission 在创建 Worktree 前验证 exact base，并确认 Parent 与所有 Child 仍为 OPEN。Plan 不绑定 Issue title/body，因此 Job 启动后的小幅文案修改不会使其失效。remote base 会在 delivery 和 auto-merge authorization 前重新核对。

普通 Issue 依赖 baseline、Worker 测试、Issue/Release validation 与 aggregate review。高风险 Issue 可携带 `oracleCommands`；每个命令必须精确匹配一条受信任的 `config.validation.release` command，Plan 不能注入任意 shell。

## Config 与 Demo

```bash
cp examples/controller.config.example.json /PRIVATE/PATH/controller.json
cp examples/release-plan.example.json /PRIVATE/PATH/release-plan.json
```

Config v4 只保留操作者真实选择：路径、timeout、输出限制、validation commands、变更/repair budget、required-check identity、merge method 与 poll interval。Review、critical/major 阻断、PR、required checks、exact-head auto-merge、禁用 custom profile、Worker/Reviewer 断网均为代码不变量。

可选 `validation.bootstrap` 是 Controller 私有 HOW。Prepare Gate 在真实 Release Worktree 中执行一次 bootstrap，再由断网 policy 执行 `validation.setup`；它们前后都重验 HEAD、branch、remote 与 Git-visible clean，只有被忽略的依赖/cache 可以留下。后续每条 Issue 或 Release semantic command 仍在全新 disposable projection 中先独立运行 bootstrap，再断网验证 candidate。推荐 Node 项目使用 `npm ci --ignore-scripts --no-audit --no-fund`；bootstrap 不进入 Plan、`oracleCommands` 或 semantic `commandSetDigest`。

新 validation 写入 Receipt v4，分别绑定 validation/bootstrap policy、每轮 bootstrap 有界结果、两次 source-integrity 检查和 cleanup。历史 v2/v3 receipt 只读兼容。

可选 `reviewDemo` 在通过 Release validation 和 aggregate review 后，对 exact candidate 的 disposable projection 执行一个真实命令。默认断网、隔离 HOME/TMP/cache、不继承 Controller/GitHub/Codex 凭据，只复制 `.herdr-review-output/` 中有界的普通文件。

## 启动与输出

```bash
npm ci
npm run verify

node dist/src/cli.js plan validate --config /PRIVATE/PATH/controller.json --plan /PRIVATE/PATH/release-plan.json --json
node dist/src/cli.js start \
  --config /PRIVATE/PATH/controller.json \
  --plan /PRIVATE/PATH/release-plan.json \
  --approve-plan 64位小写HEX \
  --json
node dist/src/cli.js run --config /PRIVATE/PATH/controller.json --job RELEASE_ID --json
node dist/src/cli.js status --config /PRIVATE/PATH/controller.json --job RELEASE_ID --public --json
```

Goal 通道使用专用、精确批准的 `goal-handoff:v1`：

```bash
node dist/src/goal-cli.js start --config /PRIVATE/PATH/controller.json --handoff /PRIVATE/PATH/goal-handoff.json --approve-handoff sha256:64HEX --runner-ref local --json
node dist/src/goal-cli.js run --config /PRIVATE/PATH/controller.json --run-id RELEASE_ID --json
node dist/src/goal-cli.js status --config /PRIVATE/PATH/controller.json --run-id RELEASE_ID --json
node dist/src/goal-cli.js result export --config /PRIVATE/PATH/controller.json --run-id RELEASE_ID --pull-request 123 --out /PUBLIC/PATH/goal-release-result.json --json
```

`GOAL_REMOTE` 在 allowlist 指定的 SSH 目标上运行同一个 CLI，从 stdin 接收 handoff，并在建状态前核对获批 OS hostname；不把实验性的 App Server WebSocket transport 作为生产依赖。Goal shell 与 detached Reviewer 都保持断网，Thread start/resume 会清空 MCP、plugin、hook、项目文档和继承 shell 环境，并拒绝任何返回的 instruction source。

任意 Job 状态都可动态导出人工审查入口：

```bash
node dist/src/cli.js report export --config /PRIVATE/PATH/controller.json --job RELEASE_ID --out /PUBLIC/PATH/review.md --json
```

verified merge 后可导出机器结果：

```bash
node dist/src/cli.js result export --config /PRIVATE/PATH/controller.json --job RELEASE_ID --out /PUBLIC/PATH/release-result.json --json
```

Public Status 是按需读取的有界脱敏投影，不是新 receipt；它和两种导出都不会公开 prompt、events、完整日志、环境变量、凭据或私有绝对路径。`review.md` 与 PR Body 使用同一 report model；`release-result:v1` 只包含 Plan、candidate、PR、required checks、merge 与完成时间。

Block 保留原始 code，并分类为 `recoverable | manual | replan_required`。前两者都需要 Operator 决定和新的 Job-private evidence 才能 retry；只有确定性 Plan 权威失效使用 `abort → Planner 新 Plan → 新 Job`。Controller 恢复保留 Worktree，但总是启动 fresh Codex execution。
