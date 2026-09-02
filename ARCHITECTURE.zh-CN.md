# 架构：最小 Codex-first Release Controller

## 主链

```text
semantic Release Plan
  → prepare: preflight + base/OPEN Issue admission + exact worktree
      → network-optional Development Bootstrap
      → offline Development Setup
      → clean source proof
  → implement: ordered fresh Workers
  → verify: Issue 或 Release authoritative validation
  → review: one fresh read-only aggregate review
  → repair: bounded Issue/Release repair
  → deliver: push + PR + required CI + exact-head auto-merge + merge verification
  → complete: release-result:v1
```

`currentIssueNumber` 区分 Issue/Release verify；PR、CI gate 与 delivery authority 保存可恢复的 delivery 断点，不另建 session runtime。

Prepare Gate 通过后才持久化 `phase=implement`。Gate 失败保留同一 Job 作为恢复锚点，但不会产生产品 Worker run、Worker result、commit、push、PR 或 GitHub mutation；显式 retry 从完整 Gate 重新开始。

Block 保留原始 `code`，并集中分类为 `recoverable | manual | replan_required`。只有 base/Plan/Parent/Child 的确定性权威失效要求 abort 后重规划；模型建议、scope drift、repair/review 耗尽与未知原因都停在 manual。`status --public --json` 只按需投影脱敏运行摘要，不成为 Planner 或 Job 的新权威。

## 语义边界

Plan 只携带目标、repo/base、Parent/Child number、顺序和依赖、目标与 AC、可选 expected paths、`low|normal|high` risk、可选 Oracle command、Release AC 与 review focus。唯一兼容键是 `controllerContractVersion: 1`。

Planner 不传 Spec、Graph、decision、predecessor、waiver、Controller revision/build、schema hash、runtime lock 或 identity history。Controller 不解释 `plannerContextDigest`。

## Authority

- Worker / repair：`workspace-write`、network false，不得 commit/push/gh/改 branch 或 remote。
- Reviewer：`read-only`、network false，只审 exact aggregate candidate。
- Controller：唯一拥有 state、commit、push、PR、CI、auto-merge 与 merge facts。

Development Bootstrap 与 Offline Development Setup 在真实 Release Worktree 执行，隔离 HOME/TMP/cache，且只允许 `.gitignore` 已忽略的依赖产物留下。Bootstrap 使用既有网络配置，setup 强制断网。之后每条 validation command 仍在独立 disposable projection 内执行，默认断网，并在命令后重验 candidate 文件；每个 projection 会独立运行配置的 bootstrap。Oracle command 必须匹配 trusted config，普通任务不要求独立 Oracle。

PR 前 candidate 必须 clean、通过 Release validation、aggregate review 与 required Demo（若配置），并且 remote base 未漂移。required checks 绑定 exact candidate 和 app/workflow identity；成功后 Controller 用 `--match-head-commit` 授权 auto-merge。merge 后不再轮询 CI，只验证 PR/merge identity、远端祖先关系与 merge tree。

`activeRun` 在 Codex 启动前持久化。中断后保留 Worktree 并使用 fresh recovery Worker；Controller commit 的 crash window 通过 exact trailers salvage。

输出只有动态 `review.md`、精简 `release-result.json` 与可选 Demo artifacts。完整 receipt、structured Agent result 和 bounded logs 留在私有 state。
