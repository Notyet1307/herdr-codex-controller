# 架构：Codex-first Release Delivery Controller

## 1. 目标

本项目只解决一个问题：

> 将一组已经排好顺序的 GitHub Issues，稳定地交给 Codex 实现，并以可验证的 aggregate candidate、一次完整 Review 和一个 PR 完成交付。

系统不控制 Codex 内部推理过程，只控制外部交付事实。

## 2. 三个组件

```text
Release Plan  → 决定做什么、顺序和验收标准
Codex CLI     → 决定如何探索、实现、自测和自我 Review
Controller    → Worktree、状态、验证、commit、PR、CI、人工 gate
```

## 3. 状态机

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

## 4. Issue 边界

每个 Issue：

```text
fresh Codex Worker
→ Worker 自我 Review
→ Controller issue validation
→ Controller commit
```

Issue 之间共享代码 Worktree，但不共享 Codex Session。前一个 Issue 的 commit 是后一个 Issue 的可靠上下文和恢复点。

## 5. Release 边界

所有 Issue commit 后：

```text
clean exact HEAD
→ full validation
→ candidate SHA
→ fresh read-only aggregate review
→ delivery
```

Review 只对一个精确 candidate SHA 有效。任何 hardening commit 都会生成新 candidate，并要求重新执行 full validation 和 aggregate review。

## 6. 恢复

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

## 7. 权限

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

## 8. 为什么没有每 Issue Reviewer

每个 Worker 被要求在退出前检查完整本次 diff，并修复自查问题。独立 Reviewer 的成本只在 aggregate boundary 支付一次，因为真正高价值的缺陷通常是：

- Issue 之间集成错误；
- 局部实现与 Release 目标不一致；
- 状态、错误处理、安全和兼容边界跨模块失配；
- 局部测试通过但完整流程失败。

## 9. 为什么不持久化 Agent 内部状态

以下状态由 Codex 自己拥有：

```text
thread / turn / tool call / subagent / context / compaction / internal plan
```

Controller 无法从这些状态得到比 Git diff、命令 exit code、PR/CI 更可靠的交付事实。持久化它们只会增加兼容矩阵和恢复分支。

## 10. 扩展边界

V1 可安全增加：

- 多仓库 Fleet（每个 Job 独立进程、目录和锁）；
- 通知和只读观察；
- 更多确定性 validation adapter；
- PR body 和 label 策略；
- 可选人工批准。

V1 不应重新增加：

- Pi/Herdr Agent Runtime；
- 自建 subagent orchestration；
- per-Issue Reviewer；
- transcript resume；
- model/provider lifecycle state；
- 同一 Release 内多 Writer 并行。
