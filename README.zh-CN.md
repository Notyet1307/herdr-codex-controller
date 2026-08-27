# Herdr Codex Controller

一个独立、轻量的 **Codex-first Release 交付控制器**。

它不再尝试实现 Agent Runtime。它只负责：

```text
一组有序 GitHub Issues
→ 一个 Release Worktree/Branch
→ 每个 Issue 一个 fresh Codex Worker
→ Controller 确定性验证并逐 Issue commit
→ 全部完成后一次完整 Release Validation
→ 一次 fresh、read-only Aggregate Review
→ 一个 Release PR
→ CI / Merge 观察
```

Codex 可以在 Worker 内部自行规划、自我 Review，并使用原生 subagent；Controller 不记录 Codex thread、turn、subagent、上下文压缩或中间推理。

## 核心边界

| 事实 | 唯一真源 |
|---|---|
| Issue 内容与状态 | GitHub |
| 当前代码和 diff | Git Worktree |
| Issue 是否完成实现 | Controller 验证 + Controller commit |
| 测试是否通过 | 真实命令 exit code |
| Release 是否通过 Review | 绑定 exact candidate SHA 的 fresh read-only Codex 结果 |
| PR、Checks、Merge | GitHub |
| 当前流程阶段 | 原子写入的 `job.json` |
| Codex 内部怎么工作 | Codex 自己，不进入 Controller truth |

## 明确不包含

- Pi / Pi SDK / Pi RPC
- Herdr Session 或 pane runtime
- `pi-subagents` / Agent Teams
- Worker Scout、自建 child Agent 协议
- 每个 Issue 一个独立 Reviewer
- 模型 Session resume
- 多 Provider compatibility/qualification matrix
- 对模型 turn、tool-call、compaction 的持久化

## 流程

```text
prepare
  ↓
Issue 1: fresh Worker → self-review → issue validation → Controller commit
  ↓
Issue 2: fresh Worker → self-review → issue validation → Controller commit
  ↓
...
  ↓
full release validation
  ↓
fresh read-only aggregate review
  ├─ pass → deliver
  └─ changes → one bounded hardening Worker → commit → full validation → review
  ↓
push / PR / CI
  ↓
complete 或人工 gate
```

默认策略：

- 一个 Release 共用一个 branch/worktree；
- 每个 Issue 一个 commit；
- Issue 验证失败最多一次 fresh repair；
- Release validation/review/CI 问题共用最多一次 hardening round；
- 不恢复 Codex Session；中断后保留 Worktree，并由 fresh Codex 重新检查；
- 单仓库串行：同一 `stateDir` 只允许一个非终态 Release Job；多仓库并发应使用独立进程、独立 `stateDir` 和 `worktreeRoot`。

## 环境要求

- Node.js `>=22.16.0`
- Git
- 已登录目标仓库的 GitHub CLI：`gh auth status`
- 已登录 Codex CLI：`codex login status`
- 目标仓库本地 checkout

## 安装

```bash
unzip herdr-codex-controller-v0.1.0.zip
cd herdr-codex-controller
npm install
npm run verify
```

源码包同时包含构建后的 `dist/`；修改源码后仍应重新执行 `npm run build`。

## 配置

复制：

```bash
cp examples/controller.config.example.json /PRIVATE/PATH/controller.json
cp examples/release-plan.example.json /PRIVATE/PATH/release-plan.json
```

上面的 Release Plan 示例是 v1（手工/旧集成）。只有接收 `pi-ticket-planning` 的精确 source-bound handoff 时，才使用：

```bash
cp examples/release-plan-v2.example.json /PRIVATE/PATH/release-plan.json
```

v2 示例中的 SHA/hash 只是满足格式的占位值，不能直接启动；所有 source/expected 字段必须来自 Planner 批准的真实 handoff。

必须修改：

- `repo`
- `localPath`
- `stateDir`
- `worktreeRoot`
- validation commands
- Release Plan 中的 Issue 编号和验收标准

`localPath`、`stateDir`、`worktreeRoot` 必须是互不重叠的绝对路径。

## Release Plan v1 / v2

- v1 是手工计划和旧集成的兼容格式；`parentIssue` 可为 `null`，Issue `objective` 可为 `null`，并保留既有 `suggestedValidation`、`allowNoop` 语义。
- v2 只表示 `source.planner="pi-ticket-planning"` 的 exact source-bound handoff。它必须绑定 `repo`、`baseRef`、40 位小写 `baseSha`、Parent Issue 的精确 title/body hash，以及每个 Child Issue 的精确 title/body hash。
- Controller 不读取 Planner 的 Planning Case、Handoff 私有 artifact 或 Delivery Graph；v2 文件本身就是完整公开契约。

公开 schema：

```text
schemas/release-plan-v1.schema.json
schemas/release-plan-v2.schema.json
schemas/release-plan.schema.json       # oneOf(v1, v2)
```

`expectedTitle` 使用 GitHub API 返回的原始字符串做 `===` 比较，不 trim、不大小写折叠、不 Unicode normalize。`expectedBodyHash` 对 GitHub API 返回的原始 body 做 UTF-8 SHA-256；不 trim、不 normalize、不转换换行、不解析 Markdown，空 body 按空字符串计算。Issue body hash 带 `sha256:` 前缀，config/plan digest 不带前缀。

config/plan digest 的算法为：先验证并构造 Controller 返回的对象；递归排序每个 object 的 key，保留 array 顺序；对 `JSON.stringify` 结果计算 SHA-256，输出 64 位小写 hex。`config validate` 和 `plan validate` 返回的 digest 是启动时应使用和记录的权威值。

v2 prepare 严格按以下顺序执行：

```text
git preflight
→ GitHub preflight
→ Codex 版本/登录 preflight（不执行 codex exec）
→ fetch 当前 remote/baseRef
→ baseSha exact gate
→ fetch + verify Parent OPEN/title/body
→ fetch + verify 全部 Child OPEN/title/body
→ ensureWorktree
→ 写入 snapshots
→ setup validation
→ implement
```

`plan_base_drift`、`plan_parent_not_open`、`plan_parent_drift`、`plan_issue_not_open`、`plan_issue_drift` 都发生在 Worktree、setup 和 Codex run 之前。Controller 不自动更新漂移的 Plan；应停止旧 Job，回到 Planner 生成并批准新的 v2 Plan。

Codex Worker 固定使用（approval policy 是 `codex` 顶层参数）：

```text
codex
--ask-for-approval never
exec
--ephemeral
--json
--strict-config
--sandbox workspace-write
--output-schema schemas/worker-result.schema.json
--output-last-message <run>/result.json
```

Release Reviewer 使用 `read-only` sandbox。Controller 同时覆盖：

```text
sandbox_workspace_write.network_access=false
shell_environment_policy.inherit="core"
shell_environment_policy.ignore_default_excludes=false
```

`workerProfile` 和 `reviewerProfile` 可以先设为 `null`，使用当前 Codex 默认配置。若指定 profile，该 profile 不应启用可写外部 MCP、危险 hooks、额外 writable roots 或 live web search。

## 第一次使用

```bash
npm run build

node dist/src/cli.js config validate \
  --config /PRIVATE/PATH/controller.json --json

node dist/src/cli.js plan validate \
  --config /PRIVATE/PATH/controller.json \
  --plan /PRIVATE/PATH/release-plan.json --json

node dist/src/cli.js doctor \
  --config /PRIVATE/PATH/controller.json --json

node dist/src/cli.js start \
  --config /PRIVATE/PATH/controller.json \
  --plan /PRIVATE/PATH/release-plan.json --json
```

上面的 `start` 对 v1 保持兼容。v2 必须从刚才 `config validate` 的输出复制精确 `configDigest`，且不得带 `sha256:` 前缀：

```bash
node dist/src/cli.js start \
  --config /PRIVATE/PATH/controller.json \
  --plan /PRIVATE/PATH/release-plan.json \
  --expected-config-digest 64位小写CONFIG_DIGEST \
  --json
```

缺失、格式非法或与当前已验证配置不一致会分别以 `expected_config_digest_required`、`expected_config_digest_invalid`、`expected_config_digest_mismatch` 失败，并且不会创建 Job。

`start` 返回 Job ID。随后运行：

```bash
node dist/src/cli.js run \
  --config /PRIVATE/PATH/controller.json \
  --job RELEASE_ID
```

也可以逐步观察：

```bash
node dist/src/cli.js step --config /PRIVATE/PATH/controller.json --job RELEASE_ID --json
node dist/src/cli.js status --config /PRIVATE/PATH/controller.json --job RELEASE_ID --operator --json
```

## 人工操作

Job blocked 后，先处理真实原因，再显式授权一次 fresh retry：

```bash
node dist/src/cli.js retry \
  --config /PRIVATE/PATH/controller.json \
  --job RELEASE_ID \
  --reason "已补充缺失的本地依赖，允许基于当前 Worktree fresh retry"
```

中止：

```bash
node dist/src/cli.js abort \
  --config /PRIVATE/PATH/controller.json \
  --job RELEASE_ID \
  --reason "需求发生变化，停止本批次"
```

终态后清理 Worktree：

```bash
node dist/src/cli.js cleanup --config /PRIVATE/PATH/controller.json --job RELEASE_ID
```

清理只接受 clean 且 `completed/failed` 的 Worktree，不会删除 release branch 或历史证据。

## 状态目录

```text
stateDir/
  jobs/<release-id>/
    job.json
    config.snapshot.json
    plan.snapshot.json
    issues/
      parent-issue-<number>.json   # v2
      issue-<number>.json
    runs/
      <run-id>/
        prompt.md
        events.jsonl
        stderr.log
        result.json
    validations/
      <validation-id>/
        *.stdout.log
        *.stderr.log
        receipt.json
    delivery/
      pull-request-body.md
```

## 安全说明

- Codex shell 使用 `workspace-write` 或 `read-only` sandbox，且 Worker 网络显式关闭。
- Controller 的 setup/validation commands 是**受信任的运维配置**，由 Controller 直接执行，不处于 Codex sandbox 内；不要把不可信 Issue 文本拼入命令。
- Controller 在 Codex 返回后验证 HEAD 与 branch 未被 Agent 改变。
- Controller 在 validation/review 前后比较 Git-visible Worktree digest，拒绝会修改源码状态的验证命令。
- 当前 v0.1 对正常退出、SIGINT、SIGTERM 有进程组终止处理。若 Controller 被 `SIGKILL`，OS 级孤儿进程仍需由运维检查；下一次 workflow 不会恢复旧 Session，只会基于 Worktree fresh retry。
- `createPullRequest=false` 可用于本地试跑；此时 Release 完成于本地 exact candidate。

## 验证

```bash
npm run verify
```

当前测试覆盖：

- 配置和有序依赖计划；
- v1 向后兼容，以及 v2 JSON Schema/runtime/CLI 契约一致性；
- v2 config digest 启动 gate、Job 持久化和 digest 漂移阻断；
- v2 base/Parent/Child 精确校验及所有漂移路径的零 Worktree/setup/Codex 副作用；
- 真实 Git branch/worktree/commit；
- 多 Issue fresh Worker；
- Issue validation 失败后的 bounded repair；
- Aggregate Review changes 后的 hardening、全量重验和新 candidate Review；
- 中断运行基于 Worktree 的 fresh recovery；
- `SIGINT`/`SIGTERM` 终止子进程组并保留 fresh-recovery 边界；
- `codex exec` 的 ephemeral、structured output、sandbox 和网络关闭参数；
- PR 的 exact head branch、base branch 与 candidate SHA 绑定。

这些是确定性本地/假端口测试，不代表 `pi-ticket-planning` 与真实 Controller/GitHub/Codex 的跨仓 canary 已执行。跨仓闭环只有在 Planner 后续以真实 v2 handoff 运行通过后才能宣称。

更详细的边界见 [`ARCHITECTURE.zh-CN.md`](./ARCHITECTURE.zh-CN.md) 和 [`docs/OPERATIONS.zh-CN.md`](./docs/OPERATIONS.zh-CN.md)。
