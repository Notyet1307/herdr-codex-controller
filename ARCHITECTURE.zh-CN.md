# 架构：Codex-first Release Delivery Controller

## 1. 目标

本项目只解决一个问题：

> 将一组已经排好顺序的 GitHub Issues，稳定地交给 Codex 实现，并以可验证的 aggregate candidate、一次完整 Review 和一个 PR 完成交付。

系统不控制 Codex 内部推理过程，只控制外部交付事实。

## 2. 三个核心组件和一个实验上层

```text
Release Plan  → 决定做什么、顺序和验收标准
Codex CLI     → 决定如何探索、实现、自测和自我 Review
Controller    → Worktree、状态、验证、commit、PR、CI、人工 gate
Dispatcher    → 保留的 experimental compatibility；不属于 qualified production path
```

## 3. 生产入口、Release Plan 与来源绑定

Controller config 的 `executionMode` 是入口 authority：

| mode | 可启动入口 | qualification |
|---|---|---|
| `release-plan-v2-direct` | 仅 source-bound v2 direct | 默认且唯一 qualified production path |
| `release-plan-v1-compatibility` | v1 direct compatibility | 显式非生产兼容 |
| `dispatcher-experimental` | 保留的 Dispatcher | 显式实验路径 |

缺少 `executionMode` 按 `release-plan-v2-direct` 解析，因此旧配置不会静默保留 v1/Dispatcher admission。production direct 在读取 Dispatcher config、ready label 或 queue 前就拒绝所有 `dispatch*` 命令。

`ReleasePlan = ReleasePlanV1 | ReleasePlanV2`。

- v1 保持手工/旧集成语义，不要求 Parent 或 Planner source binding。
- v2 是 `pi-ticket-planning` 的公开 handoff；Plan 自身携带 repo/baseRef/baseSha、Parent binding 和每个 Child 的 title/body binding。Controller 不依赖 Planner package/runtime，也不读取 Planning Case、Handoff 私有 artifact 或 Delivery Graph。

v2 有四层相互独立的确定性 gate：

1. `start` 的 `--expected-config-digest` 必须等于当前 validated config 的无前缀 64 位小写 SHA-256；因此批准后修改 config 不能静默改变执行策略。
2. `--expected-controller-revision` 必须等于运行该命令的 Controller checkout exact commit。
3. `--expected-controller-provenance-digest` 必须等于 `plan validate` 返回的完整 provenance digest，绑定 build/source、mode、config 与 Plan；三项 expected 值缺失、格式错误或不一致都不能创建 Job。
4. `prepare` 重新读取 Git/GitHub 当前事实，只有 base、Parent、全部 Child 与 Plan exact 相等才可创建 Worktree。

Controller runtime identity 不依赖被控仓库 `config.localPath`：

```text
Controller checkout HEAD commit
+ canonical manifest(path/mode/bytes/hash) of every tracked regular file
+ actual dist/src/**/*.js + package.json + package-lock.json build digest
→ Controller identity self-digest
+ Codex binary bytes/version/path digest + fixed runtime policy
+ validation sandbox binary/policy + exact GitHub fetch/push identity
+ executionMode + validated config digest + Release Plan version/digest
→ Job provenance self-digest
→ atomic Job State v3 snapshot
→ compare again before every Controller step
```

`config validate`/`doctor` 暴露 runtime identity，`plan validate` 暴露完整待绑定 provenance，`start` 原子写入 Job，`status` 回读 snapshot、current 和 match。任何 source/build/config/plan drift 都阻止后续执行；缺少 provenance 的旧 Job 不会被静默 backfill。

```text
preflight(git remote identity → github → codex runtime → validation sandbox capability)
→ fetch remote base and compare exact SHA
→ fetch Parent and compare OPEN/number/title/raw-body-hash
→ fetch every Child and compare OPEN/number/title/raw-body-hash
→ ensureWorktree
→ persist snapshots
→ clean disposable projection + contained setup validation
```

任何 source drift 都 fail closed，不调用 Worktree 创建、setup validator 或 `codex.run`。模型不参与 drift 判断，Controller 也不自动修复 Plan。

## 4. 状态机

```text
prepare
implement
issue_validate
release_validate
review
harden
 deliver
ci
awaiting_merge
complete
```

`harden` 不是常规阶段。只有 full validation、aggregate review 或 CI 给出精确阻断证据时才进入，并受统一次数上限约束。

每次 phase dispatch 前先比较当前 Controller provenance 与 Job snapshot。mismatch 由现有 blocked checkpoint 路径保存为 `controller_provenance_drift`，所以不会到达 Worktree、validator、Codex、push 或 GitHub mutation。

## 5. Issue 边界

每个 Issue：

```text
fresh Codex Worker
→ Worker 自我 Review
→ Controller issue validation
→ Controller commit
```

Issue 之间共享代码 Worktree，但不共享 Codex Session。前一个 Issue 的 commit 是后一个 Issue 的可靠上下文和恢复点。

## 6. Release 边界

所有 Issue commit 后：

```text
clean exact HEAD
→ full validation
→ candidate SHA
→ fresh read-only aggregate review
→ delivery
```

Review 只对一个精确 candidate SHA 有效。任何 hardening commit 都会生成新 candidate，并要求重新执行 full validation 和 aggregate review。

## 7. 恢复

Controller 在启动 Codex 前持久化 `activeRun`。若进程中断：

1. 验证 Worktree 仍属于 Job；
2. 验证 HEAD 没有被 Codex改变；
3. 清除旧 `activeRun`；
4. 保留所有未提交修改；
5. 以 fresh Codex recovery prompt 重新检查当前 Worktree。

不会恢复 thread、transcript 或 prior model conclusion。

Crash window 中 Controller commit 已创建但 `job.json` 尚未更新时，通过 commit trailer 恢复：

```text
Herdr-Release-Id
Herdr-Issue
Herdr-Plan-Digest
```

### Evidence checkpoint 顺序

Release validation 与 Codex run 的 durable artifact 先完整形成并通过 receipt self-digest 或 result schema 验证，Controller 随后把完整 binding 作为一个 `job.json` checkpoint 保存，最后才执行安全 gate、预算判断或 phase 转移：

```text
release receipt(path + digest + candidate SHA)
→ job.validations + job.candidateSha
→ JobStore.save
→ Worktree/diff/hardening policy

schema-valid review result + Codex run record(path + digest + base/final HEAD)
→ job.runs + job.reviewRound + job.lastReviewPath + job.candidateSha
→ JobStore.save
→ Git/Worktree gate + review status + hardening policy
```

`JobStore.save` 原子替换完整 `job.json`。因此在 checkpoint 后退出并重启时，已完成的 receipt/result 不会成为 orphan，`reviewRound` 不会回退；同一 phase 即使需要重新判断或 fresh 执行，也从已绑定 evidence 的状态开始。

hardening budget 已用尽是正常的 durable 状态转移，不通过异常触发恢复：`scheduleHardening` 直接保存 `status=blocked`、`code=replan_required`，并在 message 中保留 cause `release_hardening_exhausted`，让 `blocked.detailsPath` 指向本轮导致阻断的 exact receipt/result。该 binding 的 digest、candidate SHA 和 round 分别保留在对应 validation/run record 与 Job 字段中。外层 step catch 的 reload 仅用于保护此前 checkpoint，不负责形成预算耗尽状态。

## 8. 权限

### Codex Worker / Hardening

- `workspace-write`
- network false
- 不得 commit、push、调用 `gh`、切换 branch、修改 remote

### Release Reviewer

- `read-only`
- network false
- exact aggregate candidate

### Controller

唯一拥有：

- Git commit/push
- PR create
- CI/merge observation
- workflow state write

## 9. 为什么没有每 Issue Reviewer

每个 Worker 被要求在退出前检查完整本次 diff，并修复自查问题。独立 Reviewer 的成本只在 aggregate boundary 支付一次，因为真正高价值的缺陷通常是：

- Issue 之间集成错误；
- 局部实现与 Release 目标不一致；
- 状态、错误处理、安全和兼容边界跨模块失配；
- 局部测试通过但完整流程失败。

## 10. 为什么不持久化 Agent 内部状态

以下状态由 Codex 自己拥有：

```text
thread / turn / tool call / subagent / context / compaction / internal plan
```

Controller 无法从这些状态得到比 Git diff、命令 exit code、PR/CI 更可靠的交付事实。持久化它们只会增加兼容矩阵和恢复分支。

## 11. 扩展边界

V1 可安全增加：

- 多仓库 Fleet（每个 Job 独立进程、目录和锁）；
- 通知和只读观察；
- 更多确定性 validation adapter；
- PR body 和 label 策略；
- 可选人工批准。

实验 Dispatcher 仍位于单个 Release Controller 之上。它只在 `dispatcher-experimental` mode 可调用，不保存 Codex Session，不并行同仓库 Writer，也不决定如何实现 Issue。其新增耐久状态只覆盖无法从单一系统原子重建的跨边界事实：GitHub claim、对应 Controller Job、以及下一次 claim 前必须满足的 post-merge receipts；这些能力不构成 production qualification。

Dispatcher 的选择与交付序列是：

```text
Parent sub-issue order
→ OPEN + ready-for-agent + unassigned + native open blockers=0
→ exclusive current-user claim
→ deterministic one-Issue Plan
→ pre-Worker exact source recheck
→ serial Controller Job
→ exact-HEAD auto-merge
→ origin/base ancestry + Issue CLOSED + required main workflows SUCCESS
→ release next admission slot and claim the next eligible Child in the same dispatch run
```

任何字段缺失、身份漂移、Controller blocked、PR/CI 失败或 post-merge evidence 不完整都会保留 claim 并停止。

V1 不应重新增加：

- Pi/Herdr Agent Runtime；
- 自建 subagent orchestration；
- per-Issue Reviewer；
- transcript resume；
- model/provider lifecycle state；
- 同一 Release 内多 Writer 并行。
