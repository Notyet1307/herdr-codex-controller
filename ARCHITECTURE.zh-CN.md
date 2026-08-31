# 架构：最小 Codex-first Release Controller

## 目标

Controller 只把已经规划清楚的一组 Issues 交给 fresh Codex 实现，并以真实 validation、一次 aggregate review、PR/CI 和 verified merge 形成可审查交付。

它不是合规取证平台、软件供应链证明系统或通用 Agent Runtime。

## 主链

```text
Release Plan v2
  → prepare: preflight + exact base/Parent/Child admission + baseline
  → implement: ordered fresh Workers
  → verify: Issue 或 Release authoritative validation
  → review: one fresh read-only aggregate review
  → repair: bounded Issue/Release repair
  → deliver: push + PR + required CI + exact-head auto-merge + merge verification
  → complete
```

`currentIssueNumber` 区分 Issue/Release verify，现有 PR、CI gate 与 delivery authority 区分 deliver 子阶段，因此不新增一套 delivery session state。

## Source 生命周期

Admission 在任何 Worktree、setup 或 Codex 副作用前验证：

```text
remote base == Plan base
Parent OPEN/title/body exact
all Child OPEN/title/body exact
declared Oracle/verifier bytes exact
```

这些事实形成本 Job 的启动边界。启动后不再逐 phase 重取 Issue 文案；delivery 与 auto-merge authorization 前只重核 remote base。merge observation 读取当前 base，并验证 merge SHA 已成为祖先且 merge tree 精确复现 reviewed candidate。

## 权限

- Worker / repair：`workspace-write`、network false，不得 commit/push/gh/改 branch 或 remote。
- Reviewer：`read-only`、network false，只审 exact aggregate candidate。
- Controller：唯一拥有 state、commit、push、PR、CI observation、auto-merge 与 merge facts。

## Validation 与 Oracle

每条 validation command 在独立 disposable projection 内执行，隔离 HOME/TMP/cache，默认断网，命令后重验 candidate blob/mode。Validation Receipt 保存 command、exit、duration、bounded tails 与 digest。

Oracle 是可选高风险保护；未声明 Oracle 的普通 Issue 仍走完整 baseline/Issue/Release/Review。声明 Oracle 后，artifact、verifier manifest、package script、protected path 和 receipt coverage 都必须 exact。

## Delivery

PR 创建前 candidate 必须 clean、通过 Release validation 与 aggregate review，并且 remote base 未漂移。required checks 绑定 exact candidate 和 app/workflow identity，成功后 Controller 用 `--match-head-commit` 授权 auto-merge。

合并后不重新轮询 CI。Controller 只接受已有的成功 pre-merge CI checkpoint，并验证：

- exact PR/candidate 与 Controller-owned authority；
- merge SHA 存在且进入 remote base；
- merge method 的 parent/base 关系；
- merge tree 等于 reviewed candidate tree。

## 恢复

`activeRun` 在 Codex 启动前持久化。中断后 Controller 验证 Worktree/HEAD，清除 stale run，并用 fresh Worker 基于保留修改恢复。Controller commit 的 crash window 通过 exact trailers salvage。

Issue repair 使用每 Issue counter。Release validation/review/CI code failures共用一个 `codeRepairRounds`，CI infrastructure 使用独立 `infrastructureReruns`。预算耗尽形成 durable `replan_required`，不能由 operator reason 增加预算。

## 产物

- `review.md`：动态、bounded、面向人工，和 PR Body 共用 model。
- Review Demo：可选单命令，绑定 exact candidate；失败按 required/WARN 策略处理，仅复制 `.herdr-review-output/`。
- Completion v3：当前跨仓消费者仍依赖，暂时保留。
- 私有 state：完整 receipt、structured Agent result 与 bounded logs；不公开 prompt/events/env。
