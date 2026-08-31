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
| 执行本 Job 的 Controller | `job.json.provenance` 与当前 runtime readback |
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

- `executionMode` 缺省为 `release-plan-v2-direct`：只允许 source-bound Release Plan v2 direct；
- 一个 Release 共用一个 branch/worktree；
- 每个 Issue 一个 commit；
- Issue 验证失败最多一次 fresh repair；
- Release validation/review/CI 问题共用最多一次 hardening round；
- 不恢复 Codex Session；中断后保留 Worktree，并由 fresh Codex 重新检查；
- 单仓库串行：同一 `stateDir` 只允许一个非终态 Release Job；多仓库并发应使用独立进程、独立 `stateDir` 和 `worktreeRoot`。

## 实验性的连续 Issue Dispatcher

Dispatcher 代码保留为 Controller 上方的薄 admission/串行调度层，但不属于 qualified production path。只有 Controller 配置显式设置 `"executionMode": "dispatcher-experimental"` 才能调用 `dispatch*`；默认 production direct 会在读取 Dispatcher 配置或 `ready-for-agent` 前拒绝。每次只处理一个 Parent 的一个 Child：

```text
读取 Parent 的原生 sub-issue 顺序
→ 选择第一个 OPEN + ready-for-agent + 无 assignee + open blocker=0 的 Child
→ 以当前 GitHub 登录身份独占领取
→ 从固定的 What to build / Acceptance criteria 段生成单 Issue v1 Plan
→ Controller prepare 后、首个 Worker 前再次核对 Parent membership、title、raw body hash、label、assignee 和 blocker
→ 串行运行一个 Controller Job
→ exact candidate review + PR checks
→ gh pr merge --squash --auto --match-head-commit <candidateSha>
→ 验证 merge SHA 已进入 origin/base、Issue 已关闭、配置的 main push workflows 全部 success
→ 同一次 dispatch 立即选择并领取下一个合格 Issue
→ 队列无合格项时以 queue_idle 正常停止；blocked/failure 时 fail closed
```

它不会自动添加 `ready-for-agent`、不会抢已分配 Issue、不会跳过 blocker、不会在 blocked/CI failure 时自动 retry，也不会同时驱动两个同仓库 Job。GitHub 未返回原生 dependency summary 时也会 fail closed。

Dispatcher 只接受以下 Controller 策略：`review.enabled=true`、`critical`/`major` 都阻断、`createPullRequest=true`、`autoMerge=true`、`allowNoChecks=false`、`mergeMethod=squash`。

配置和命令：

```bash
cp examples/dispatcher.config.example.json /PRIVATE/PATH/dispatcher.json

node dist/src/cli.js dispatch \
  --config /PRIVATE/PATH/controller.json \
  --dispatcher /PRIVATE/PATH/dispatcher.json

node dist/src/cli.js dispatch status \
  --config /PRIVATE/PATH/controller.json \
  --dispatcher /PRIVATE/PATH/dispatcher.json --json
```

只有 Dispatcher 自身因外部事实漂移或 post-merge gate 失败进入 `blocked` 时，解决真实原因后才显式授权：

```bash
node dist/src/cli.js dispatch retry \
  --config /PRIVATE/PATH/controller.json \
  --dispatcher /PRIVATE/PATH/dispatcher.json \
  --reason "已检查并解决阻断原因"
```

若内部 Controller Job 是可恢复 blocked，使用 `retry --job ... --reason ... --evidence ...`；若为 `replan_required`，必须 abort 后由 Planner 生成新的 Release Plan v2 和新 Job。Dispatcher 不代替这些授权。

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
cp examples/release-plan-v2.example.json /PRIVATE/PATH/release-plan.json
```

生产默认只接受 `pi-ticket-planning` 的精确 source-bound v2 handoff。v2 示例中的 SHA/hash 只是满足格式的占位值，不能直接启动；所有 source/expected 字段必须来自 Planner 批准的真实 handoff。

手工/旧集成如需 v1，必须同时显式设置非生产兼容模式：

```json
{ "executionMode": "release-plan-v1-compatibility" }
```

Dispatcher 则只能使用 `dispatcher-experimental`；两种 opt-in 都不会自动升级为 qualified。

必须修改：

- `repo`
- `executionMode`（生产保持 `release-plan-v2-direct`）
- `localPath`
- `stateDir`
- `worktreeRoot`
- `remoteIdentity.fetchUrl` / `remoteIdentity.pushUrl`（必须精确指向 `repo`）
- `codex.bin` 与 `validation.sandbox.bin`（绝对路径）
- `validation.sandbox.root`（必须位于 checkout/state/worktree、用户 HOME 和系统临时目录之外）
- validation commands
- Release Plan 中的 Issue 编号和验收标准

`localPath`、`stateDir`、`worktreeRoot` 与 validation sandbox root 必须保持规定的隔离关系。旧 config v1 direct 不会被静默升级；它以 `production_config_migration_required` fail closed。v1 compatibility/Dispatcher 仍显式属于非生产路径。

## Release Plan v1 / v2

- v1 是手工计划和旧集成的兼容格式；`parentIssue` 可为 `null`，Issue `objective` 可为 `null`，并保留既有 `suggestedValidation`、`allowNoop` 语义。
- v2 只表示 `source.planner="pi-ticket-planning"` 的 exact source-bound handoff。它必须绑定 `repo`、`baseRef`、40 位小写 `baseSha`、Parent/Child 精确 title/body hash、decision/predecessor/dependency digests，以及每个 Child 的 immutable Oracle、closed verifier manifest、镜像 registry 中的 canonical risk classes、scope budget、首段无 wildcard 的 expected write paths、protected paths 和 replan triggers。
- `release-plan-v2-direct` 拒绝 v1；v1 只有在 `release-plan-v1-compatibility` 或 Dispatcher 内部的 `dispatcher-experimental` 路径才可创建 Job。
- Controller 不读取 Planner 的 Planning Case、Handoff 私有 artifact 或 Delivery Graph；v2 文件本身就是完整公开契约。

公开 schema：

```text
schemas/release-plan-v1.schema.json
schemas/release-plan-v2.schema.json
schemas/release-plan.schema.json       # oneOf(v1, v2)
schemas/dispatcher-config.schema.json  # experimental Dispatcher policy
```

`expectedTitle` 使用 GitHub API 返回的原始字符串做 `===` 比较，不 trim、不大小写折叠、不 Unicode normalize。`expectedBodyHash` 对 GitHub API 返回的原始 body 做 UTF-8 SHA-256；不 trim、不 normalize、不转换换行、不解析 Markdown，空 body 按空字符串计算。Issue body hash 带 `sha256:` 前缀，config/plan digest 不带前缀。

config/plan digest 的算法为：先验证并构造 Controller 返回的对象；递归排序每个 object 的 key，保留 array 顺序；对 `JSON.stringify` 结果计算 SHA-256，输出 64 位小写 hex。`config validate` 和 `plan validate` 返回的 digest 是启动时应使用和记录的权威值。

`verifier.packageScript.definitionSha256` 对 `package.json` 中对应 npm script 的精确 UTF-8 字符串计算 SHA-256。verifier manifest digest 使用同一 canonical `digestJson`，preimage 不含自身 `digest` 字段，输出带 `sha256:` 前缀；`files` 必须按 path 字典序提供。

Controller runtime identity 绑定 checkout commit、tracked-source manifest 与实际 build digest。Job State v3 / provenance v2 还绑定 Codex executable bytes/version/路径摘要、固定的无 profile/MCP/hooks/额外 writable-root runtime policy、validation sandbox executable/policy，以及 exact GitHub fetch/push remote identity。公开 completion 只包含路径摘要，不泄露本机路径。每个 Controller step 都重新计算并比较；任一 source/build/runtime/sandbox/remote/config/plan 漂移都会 fail closed。

v2 prepare 严格按以下顺序执行：

```text
git preflight
→ GitHub preflight
→ Codex 版本/登录 preflight（不执行 codex exec）
→ fetch 当前 remote/baseRef
→ baseSha exact gate
→ fetch + verify Parent OPEN/title/body
→ fetch + verify 全部 Child OPEN/title/body
→ verify reviewed-base Oracle data、verifier files 和 package script definition
→ ensureWorktree + clean gate + verify Oracle/verifier bytes again
→ 写入 snapshots
→ setup validation
→ implement
```

每个 writing Worker 前后都会全局重新验证所有 Oracle data、verifier source/helper/schema 与 `package.json`。权威验证不再在实现 Worktree 中执行：Controller 用临时 Git index 生成 exact tracked candidate + admitted uncommitted changes 的 disposable blob projection，排除 `.env`、`.npmrc`、node_modules、cache 和所有 ignored Worker state；隔离 HOME/TMP/cache、清空环境 allowlist、默认断网、禁止外部写入，并在命令后重验全部 candidate blob/mode。每条 validation command 使用独立 projection，不能把新建状态传给下一条；需要依赖的检查必须在同一 command 内先执行隔离安装，例如 `npm ci --ignore-scripts --no-audit --no-fund && npm test`。Validation Receipt v3 绑定 candidate tree/manifest、sandbox policy、命令身份、streaming byte limits/hash、termination reason 与 cleanup；cleanup 中断可在重启后幂等恢复。

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

模型路由由每次调用的显式参数固定：`worker`、`issue-repair`、`release-harden` 使用 `gpt-5.6-terra` + `high`；只有只读 aggregate `review` 使用 `gpt-5.6-sol` + `max`。`workerProfile` 和 `reviewerProfile` 可以先设为 `null`；若指定 profile，它只用于附加安全配置，显式模型/推理档位仍覆盖 profile，并且 profile 不应启用可写外部 MCP、危险 hooks、额外 writable roots 或 live web search。

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
```

`config validate` 和 `doctor` 返回 `controller` identity；`plan validate` 返回完整 `provenance`。v2 `start` 必须从这些输出复制 exact `configDigest`、`provenance.controller.sourceRevision` 和 `provenance.digest`，digest 均不得带 `sha256:` 前缀：

```bash
node dist/src/cli.js start \
  --config /PRIVATE/PATH/controller.json \
  --plan /PRIVATE/PATH/release-plan.json \
  --expected-config-digest 64位小写CONFIG_DIGEST \
  --expected-controller-revision 40位小写CONTROLLER_COMMIT \
  --expected-controller-provenance-digest 64位小写PROVENANCE_DIGEST \
  --json
```

三项 expected gate 的缺失、格式非法或不一致都会在 Job 创建前失败。Controller 还会在 `JobStore.create` 内重新计算一次 provenance，关闭 gate 与原子 snapshot 之间的漂移窗口。

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

`status` 同时返回 Job 的 exact `provenance`、当前 `currentProvenance` 和 `provenanceMatches`。Planner 集成应调用这些公开 CLI，而不是读取 Controller 私有 `job.json`；Controller 也不会让 Planner 读取任何 Job 私有状态。

verified merged Job 可导出 deterministic public completion artifact；命令会重新验证 private receipt/review、PR/checks、merge 与 provenance，输出不含私有路径、日志或 Issue body：

```bash
node dist/src/cli.js completion export \
  --config /PRIVATE/PATH/controller.json \
  --job RELEASE_ID \
  --out /PUBLIC/PATH/release-completion.json \
  --json
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
- expected Controller revision/provenance match、mismatch、格式和缺失 gate；
- tracked source manifest/build drift 在任何 Worktree/setup/Codex 副作用前阻断；
- production direct 拒绝 v1 和 Dispatcher，并完整执行 v2 direct；
- v2 base/Parent/Child 精确校验及所有漂移路径的零 Worktree/setup/Codex 副作用；
- 真实 Git branch/worktree/commit；
- 多 Issue fresh Worker；
- Issue validation 失败后的 bounded repair；
- Aggregate Review changes 后的 hardening、全量重验和新 candidate Review；
- 中断运行基于 Worktree 的 fresh recovery；
- `SIGINT`/`SIGTERM` 终止子进程组并保留 fresh-recovery 边界；
- `codex exec` 的 ephemeral、structured output、sandbox 和网络关闭参数；
- Codex 写入 run 的 `gpt-5.6-terra/high` 与 aggregate Reviewer 的 `gpt-5.6-sol/max` 显式路由；
- PR 的 exact head branch、base branch 与 candidate SHA 绑定。
- auto-merge 的 `--match-head-commit` exact reviewed-candidate 绑定；
- experimental Dispatcher 的 Parent 顺序、ready label、原生 blocker、独占 assignee、pre-Worker source binding 和 post-merge main workflow gate。

这些是确定性本地/假端口测试，不代表 `pi-ticket-planning` 与真实 Controller/GitHub/Codex 的跨仓 canary 已执行。跨仓闭环只有在 Planner 后续以真实 v2 handoff 运行通过后才能宣称。

更详细的边界见 [`ARCHITECTURE.zh-CN.md`](./ARCHITECTURE.zh-CN.md) 和 [`docs/OPERATIONS.zh-CN.md`](./docs/OPERATIONS.zh-CN.md)。
