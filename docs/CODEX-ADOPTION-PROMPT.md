# Codex Prompt：理解并启用 Herdr Codex Controller

将下面整段 Prompt 交给 Codex。开始前替换尖括号中的值；未知值可以保留，让 Codex通过本地仓库和 GitHub CLI 读取。

---

你是 **Herdr Codex Controller 的接入与运行工程师**。当前目录是已解压的 `herdr-codex-controller` 源码。你的任务不是重新设计它，而是理解其边界、验证源码、为一个目标仓库生成安全配置和 Release Plan，并完成一次可观察的 staged rollout。

## 用户输入

```text
目标仓库本地 checkout：<TARGET_LOCAL_PATH>
GitHub 仓库：<OWNER/REPO>
目标 base branch：<BASE_BRANCH，默认 main>
本批次 Issue 编号（按期望顺序）：<ISSUE_NUMBERS，例如 101,102,103>
私有运行根目录：<PRIVATE_RUNTIME_ROOT>
是否允许创建 PR：<false 或 true；第一次建议 false>
```

## 必须先理解的设计

先完整阅读：

```text
AGENTS.md
README.zh-CN.md
ARCHITECTURE.zh-CN.md
docs/OPERATIONS.zh-CN.md
docs/SECURITY.md
src/controller.ts
src/codex.ts
src/git.ts
src/github.ts
src/validator.ts
src/state.ts
src/prompts.ts
examples/controller.config.example.json
examples/release-plan.example.json
examples/release-plan-v2.example.json
schemas/release-plan-v1.schema.json
schemas/release-plan-v2.schema.json
schemas/release-plan.schema.json
```

用下面这句话作为你的架构判断基线：

> Controller 控制任务顺序和交付事实；Codex 完整负责单个 Issue 的实现、自测和内部自我 Review；Git、命令 exit code 和 GitHub 是事实源；所有 Issue 完成后只做一次 exact-candidate aggregate review。

禁止把项目改回以下方向：

```text
Pi / Pi RPC / Herdr Session
pi-subagents / Agent Teams
每 Issue 独立 Reviewer
Worker Scout 或自建 child-agent protocol
Codex thread/session resume
模型 turn/tool/subagent/compaction 持久化
多 Provider compatibility/qualification matrix
同一 Release 多 Writer 并行
```

Codex Worker 可自行使用原生 subagent 做只读探索，但 Controller 不感知或持久化这些内部行为。

## 阶段 1：验证 Controller 自身

执行并保留结果：

```bash
node --version
git --version
gh --version
codex --version
codex login status
npm install
npm run verify
node dist/src/cli.js --help
```

不得通过删除测试、扩大 retry、跳过 typecheck 或放宽断言来获得绿色结果。若失败，先判断是：

```text
源码缺陷
本机依赖缺失
Codex CLI 版本/flag 不兼容
Git/GitHub 权限
目标仓库环境
```

只有发现可复现的源码缺陷时才修改 Controller；修改必须带回归测试，并保持架构边界不变。

## 阶段 2：检查目标仓库是否适合运行

只读检查：

```bash
git -C <TARGET_LOCAL_PATH> status --short
git -C <TARGET_LOCAL_PATH> rev-parse --show-toplevel
git -C <TARGET_LOCAL_PATH> remote -v
git -C <TARGET_LOCAL_PATH> fetch origin <BASE_BRANCH>
gh repo view <OWNER/REPO>
gh issue view <EACH_ISSUE> --repo <OWNER/REPO> --json number,title,body,state,labels,assignees,url
```

检查目标仓库：

1. 根目录及相关子目录的 `AGENTS.md` 是否短、准确、没有过期冲突；
2. 安装、typecheck、lint、unit、integration、build 命令分别是什么；
3. 哪些命令适合每个 Issue 的快速验证；
4. 哪些命令必须作为 Release 完整验证；
5. validation command 是否只观察结果，不修改 Git-visible 源码；
6. Issue 顺序和依赖是否合理；
7. 一组 Issue 是否仍在限制内：默认不超过 8 个 Issue、50 个文件、约 4,000 行 aggregate diff。

不要为了让 Controller 运行而改写产品需求。Issue 明显缺少验收标准时，在 Release Plan 中做最小、可追溯的补充，并在最终报告中注明推断。

## 阶段 3：生成私有配置

创建：

```text
<PRIVATE_RUNTIME_ROOT>/controller.json
<PRIVATE_RUNTIME_ROOT>/release-plan.json
<PRIVATE_RUNTIME_ROOT>/state/
<PRIVATE_RUNTIME_ROOT>/worktrees/
```

这些路径必须位于目标 checkout 之外，且 `localPath`、`stateDir`、`worktreeRoot` 互不重叠。

以 `examples/controller.config.example.json` 为模板：

- `repo=<OWNER/REPO>`
- `localPath=<TARGET_LOCAL_PATH>`
- `stateDir=<PRIVATE_RUNTIME_ROOT>/state`
- `worktreeRoot=<PRIVATE_RUNTIME_ROOT>/worktrees`
- `baseRef=<BASE_BRANCH>`
- `remote=origin`
- 第一次运行令 `delivery.createPullRequest=false`
- `delivery.autoMerge=false`
- `codex.networkAccess=false` 不得修改
- Worker/Reviewer profile 不确定时先设 `null`
- `maxIssueRepairRounds=1`
- `maxReleaseHardeningRounds=1`
- `maxCiRepairRounds` 第一次设 `0`

注意：setup/validation commands 是 Controller 信任并直接执行的 shell 配置，不在 Codex sandbox 内。禁止把 Issue body、title 或其他不可信文本插值到命令中。

## 阶段 4：生成 Release Plan

先判断来源，不得混用两个版本：

- 手工接入或旧集成：以 `examples/release-plan.example.json` 为模板生成 v1。
- 已由 `pi-ticket-planning` 批准并导出的 exact handoff：原样接收 v2，并用 `examples/release-plan-v2.example.json` 与 schema 核对结构。不要自行猜测或伪造 source hash，也不要读取 Planner 私有 Planning Case/Handoff artifact。

v1 按用户给定顺序写入 Issue。

每个 Issue 至少包含：

```text
number
order
dependsOn
objective（Issue 已足够清晰时可为 null）
acceptanceCriteria
suggestedValidation
allowNoop=false（除非仓库证据证明它确实是声明型/no-op 任务）
```

Release 级包含：

```text
objective
releaseAcceptanceCriteria
reviewFocus
```

`reviewFocus` 优先覆盖跨 Issue 风险：

```text
数据/状态一致性
错误恢复
向后兼容
安全边界
并发
迁移
集成测试缺口
```

不要把完整项目规划系统塞进这个 Plan。它只是当前一组已确定 Issue 的执行输入。

v2 还必须确认：

```text
source.repo == config.repo
source.baseRef == config.baseRef
source.baseSha 是批准时的 40 位小写 exact commit
parentBinding.number == parentIssue
Parent/Child expectedTitle 是 GitHub API 原始 title
Parent/Child expectedBodyHash 是原始 body UTF-8 SHA-256（带 sha256:）
每个 Child 有 3–8 条 AC、suggestedValidation=[]、allowNoop=false
```

不得 trim/normalize `expectedTitle`，不得 trim、转换换行或解析 Markdown 后再 hash body。

## 阶段 5：静态验证与 doctor

执行：

```bash
node dist/src/cli.js config validate \
  --config <PRIVATE_RUNTIME_ROOT>/controller.json --json

node dist/src/cli.js plan validate \
  --config <PRIVATE_RUNTIME_ROOT>/controller.json \
  --plan <PRIVATE_RUNTIME_ROOT>/release-plan.json --json

node dist/src/cli.js doctor \
  --config <PRIVATE_RUNTIME_ROOT>/controller.json --json
```

记录 `config validate` 返回的 `configDigest` 和 `plan validate` 返回的 `planDigest`。digest 是 validated object 递归排序 object keys、保留 array 顺序、`JSON.stringify` 后的 SHA-256 小写 hex；不带 `sha256:` 前缀。

任何失败都要先修真实原因。不要跳过 doctor，也不要在记录 digest 后修改 config。

## 阶段 6：第一次本地 Release 演练

创建 Job：

```bash
node dist/src/cli.js start \
  --config <PRIVATE_RUNTIME_ROOT>/controller.json \
  --plan <PRIVATE_RUNTIME_ROOT>/release-plan.json --json
```

上面是 v1 兼容调用。v2 必须增加刚才批准的 exact config digest：

```bash
node dist/src/cli.js start \
  --config <PRIVATE_RUNTIME_ROOT>/controller.json \
  --plan <PRIVATE_RUNTIME_ROOT>/release-plan.json \
  --expected-config-digest <CONFIG_DIGEST_64_LOWERCASE_HEX> \
  --json
```

v2 第一次 `step` 必须先观察到 current remote base、Parent OPEN/title/body、全部 Child OPEN/title/body exact 通过；只有随后才允许出现 Worktree、setup validation 或 Codex run。任何 `plan_*_drift` / `plan_*_not_open` 都停止，不 retry、不自动更新 Plan，回到 Planner 生成新 handoff。

记录返回的 Job ID，然后先逐步执行并观察前 3～5 个 transition：

```bash
node dist/src/cli.js step --config <PRIVATE_RUNTIME_ROOT>/controller.json --job <JOB_ID> --json
node dist/src/cli.js status --config <PRIVATE_RUNTIME_ROOT>/controller.json --job <JOB_ID> --operator --json
```

确认：

```text
Worktree/branch 正确
Issue snapshot 正确
v2 Parent/Child source verification 发生在 Worktree/setup/Codex run 前
Codex Worker 使用 fresh exec
Codex 未 commit/push/调用 gh
Controller validation 命令正确
Controller 创建 Issue commit
```

确认后运行：

```bash
node dist/src/cli.js run \
  --config <PRIVATE_RUNTIME_ROOT>/controller.json \
  --job <JOB_ID>
```

本地模式应最终产生：

```text
每个 Issue 一个 Controller commit
完整 Release validation receipt
一个 exact-candidate read-only aggregate review
status=completed
无 PR side effect
```

## 阶段 7：处理 blocked

blocked 时先执行：

```bash
node dist/src/cli.js status \
  --config <PRIVATE_RUNTIME_ROOT>/controller.json \
  --job <JOB_ID> --operator --json
```

读取 `job.json`、相关 run 的 `prompt.md/events.jsonl/stderr.log/result.json` 和 validation receipt。

先检查 `blocked.code`。若为 `replan_required`，不得 retry；执行 `abort`，回到 Planner 生成并批准新的公开 Release Plan v2，再以新 Release ID 启动新 Job。

只有可恢复原因已处理且形成新的 recovery evidence file 后，才执行：

```bash
node dist/src/cli.js retry \
  --config <PRIVATE_RUNTIME_ROOT>/controller.json \
  --job <JOB_ID> \
  --reason "<具体、可审计的修复或新增事实>" \
  --evidence <PRIVATE_RUNTIME_ROOT>/recovery-evidence.json
```

不要使用 Planner 私有状态作为 recovery evidence，也不要恢复旧 Codex Session。Controller 会保存 evidence digest、保留 Worktree，并让 fresh Codex 重新检查当前修改；同一 blocked code + 同一 evidence digest 会以 `retry_without_new_evidence` 拒绝。

## 阶段 8：启用 PR

只有本地演练成功后，复制出一个新的配置文件：

```text
delivery.createPullRequest=true
delivery.autoMerge=false
maxCiRepairRounds=0 或 1
```

使用新的 Release ID 启动 fresh Job。不要修改一个已经启动 Job 所绑定的 config。

PR 必须指向 exact reviewed candidate SHA。Checks 通过后，Controller 进入 `ready_to_merge`；由人合并后再执行一次 `step` 观察 `completed`。

## 必须输出的最终报告

完成后给出：

```text
1. Controller 源码验证结果和测试数量
2. 目标仓库 readiness 结论
3. 生成的 config/plan 绝对路径与 digest
4. Job ID、branch、worktree
5. 每个 Issue 的 Worker run、validation、commit SHA
6. Release validation receipt
7. Aggregate review candidate SHA、轮次和结论
8. PR/CI 状态（若启用）
9. 所有人工推断、blocked、retry 和剩余风险
10. 明确确认没有引入 Pi/Herdr/subagent runtime 或 per-Issue Reviewer
11. 若使用 v2，分别列出 config digest gate、base/Parent/Child source gate；未实际运行真实 Planner cross-repo canary 时明确写“未运行”，不得用本地 fixture 代替
```

优先把系统真正运行起来，而不是继续扩展架构。只有实测数据证明某个缺口重复出现，才提出最小改动。

---
