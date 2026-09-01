# Herdr Codex Controller

一个轻量、Codex-first 的 Release 交付控制器。

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

可选 `validation.bootstrap` 是 Controller 私有 HOW：它在每一条 setup、Issue 或 Release command 的全新 disposable projection 中先运行，立即重验 tracked candidate，再由断网 validation policy 执行原始 semantic command 并再次重验。不同 command 不共享 workspace；`validation.setup` 是 baseline validation，不是依赖缓存。推荐 Node 项目使用 `npm ci --ignore-scripts --no-audit --no-fund`，仅 bootstrap 可按配置联网；bootstrap 不进入 Plan、`oracleCommands` 或 `commandSetDigest`。

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
```

任意 Job 状态都可动态导出人工审查入口：

```bash
node dist/src/cli.js report export --config /PRIVATE/PATH/controller.json --job RELEASE_ID --out /PUBLIC/PATH/review.md --json
```

verified merge 后可导出机器结果：

```bash
node dist/src/cli.js result export --config /PRIVATE/PATH/controller.json --job RELEASE_ID --out /PUBLIC/PATH/release-result.json --json
```

两种输出都不会公开 prompt、events、完整日志、环境变量、凭据或私有绝对路径。`review.md` 与 PR Body 使用同一 report model；`release-result:v1` 只包含 Plan、candidate、PR、required checks、merge 与完成时间。

可恢复 blocked 需要新的 Job-private evidence。`replan_required` 只能 `abort → Planner 新 Plan → 新 Job`。Controller 恢复保留 Worktree，但总是启动 fresh Codex execution。
