# Herdr Codex Controller

一个独立、轻量的 Codex-first Release 交付控制器。

```text
pi-ticket-planning 的 source-bound Release Plan v2
→ 修改前 baseline
→ 每个 Issue 一个 fresh Codex Worker
→ Controller 权威验证并 commit
→ 完整 Release 验证
→ 一次 fresh、read-only aggregate review
→ PR / required CI / exact-head auto-merge
→ merge SHA、祖先关系与 merge tree 验证
→ review.md + completion v3
```

项目不实现 Agent Runtime，也不保存 thread、turn、transcript、subagent 或模型内部计划。Release Plan v1、Dispatcher、人工 merge authority、可关闭 Review、custom Codex profile 和本地-only production delivery 已删除。

## 权限与事实

| 事实 | authority |
|---|---|
| Issue 与批准范围 | source-bound Release Plan + admission 时 GitHub readback |
| 代码与 diff | Release Worktree / Git |
| 检查结果 | Controller 实际执行的 command exit status |
| Agent 自查 | Worker structured result，仅作审查信息 |
| Aggregate Review | exact candidate 的只读 Reviewer 判断 |
| commit、push、PR、CI、merge | Controller |
| 当前阶段 | 原子 `job.json` |

## 状态机

```text
prepare → implement → verify → review → repair → deliver → complete
```

- `verify` 根据 `currentIssueNumber` 执行 Issue 或 Release validation。
- `repair` 执行 Issue repair 或共用的 Release code-repair budget。
- `deliver` 幂等完成 push、PR、CI、auto-merge 与 merge observation；PR、CI gate 和 delivery authority 是断点恢复依据。
- required CI 只对 exact candidate 在 merge 前判定。merge 后不再轮询 CI，只验证 PR/merge identity、远端祖先关系和 merge tree。

## Source 与 Oracle

Job admission 读取并验证 base、Parent 和全部 Child 的 OPEN/title/body binding。Job 启动后不再因 Issue 文案的小修改失效；Controller 仅在 delivery 与 auto-merge authorization 前重新核对 remote base。

Oracle 是高风险任务的可选严格保护。普通 Issue 可以使用空 `oracleBindings`/`protectedPaths`，仍必须通过 baseline、Issue validation、Release validation 和 aggregate review。声明 Oracle 后，其 artifact、verifier、package script、protected path 与 execution binding 继续 fail closed。

## Config v4

复制并修改：

```bash
cp examples/controller.config.example.json /PRIVATE/PATH/controller.json
cp examples/release-plan-v2.example.json /PRIVATE/PATH/release-plan.json
```

Config 只保留操作者真实选择：repo/path、timeout/output limit、validation commands、change/repair budget、required-check identity、merge method 和 poll interval。

以下策略不再是配置项：

- aggregate review 必开，critical/major 固定阻断；
- 必须创建 PR，必须存在 required checks；
- Controller exact-head auto-merge；
- custom Codex profiles 禁止；
- Worker/Reviewer network 关闭；
- merge authority 固定为 Controller auto-merge + exact-head branch quarantine。

示例 `validation.setup` 在 disposable projection 内执行 `npm ci ... && npm test`，因此 baseline 是实际检查而不只是安装依赖。

需要真实 API/UI 演示时，将 `reviewDemo` 从 `null` 改为一个命令；目标仓库负责 curl、Playwright 或自有 demo script：

```json
{
  "reviewDemo": {
    "command": "npm run review:demo",
    "required": true,
    "networkAccess": false,
    "timeoutMs": 600000,
    "maxOutputBytes": 1048576
  }
}
```

Demo 在 exact candidate disposable projection 中运行，只复制 `.herdr-review-output/` 的安全 regular files。`networkAccess=true` 会在报告中明确标记为 network-enabled demonstration。

## 启动

```bash
npm ci
npm run verify

node dist/src/cli.js config validate --config /PRIVATE/PATH/controller.json --json
node dist/src/cli.js plan validate --config /PRIVATE/PATH/controller.json --plan /PRIVATE/PATH/release-plan.json --json
node dist/src/cli.js doctor --config /PRIVATE/PATH/controller.json --json
```

从 validate 输出复制批准后的 exact 值：

```bash
node dist/src/cli.js start \
  --config /PRIVATE/PATH/controller.json \
  --plan /PRIVATE/PATH/release-plan.json \
  --expected-config-digest 64位小写HEX \
  --expected-controller-revision 40位小写HEX \
  --expected-controller-provenance-digest 64位小写HEX \
  --json

node dist/src/cli.js run --config /PRIVATE/PATH/controller.json --job RELEASE_ID --json
```

## Review Bundle

running、blocked、completed 或 failed Job 都能按需生成 `review.md`：

```bash
node dist/src/cli.js report export \
  --config /PRIVATE/PATH/controller.json \
  --job RELEASE_ID \
  --out /PUBLIC/PATH/review.md \
  --json
```

报告与 PR Body 使用同一个动态 model。报告只读取现有 Job、validation receipt、Agent structured result、Git 和 CI checkpoint；不复制 prompt、events、完整日志、环境变量、凭据或私有绝对路径，也不成为新的 authority state。

## Completion 与恢复

当前 Planner 仍依赖 Completion v3、provenance v3、identity history、runtime lock 和 expected start gates，因此这些边界暂时保留。verified merged Job 可导出：

```bash
node dist/src/cli.js completion export \
  --config /PRIVATE/PATH/controller.json \
  --job RELEASE_ID \
  --out /PUBLIC/PATH/release-completion.json \
  --json
```

可恢复 blocked 必须先修复真实原因，再提供 fresh、Job-private 可校验 evidence 执行 `retry`。`replan_required` 只能 `abort → Planner 新 Plan → 新 Job`。Controller 中断后不会恢复旧 Codex Session，只基于保留的 Worktree 启动 fresh recovery Worker。

完整边界见 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md) 与 [docs/OPERATIONS.zh-CN.md](./docs/OPERATIONS.zh-CN.md)。
