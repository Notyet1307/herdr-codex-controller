# 架构：最小 Codex-first Release Controller

## 主链

```text
semantic Release Plan
  → prepare: preflight + base/OPEN Issue admission + baseline
  → implement: ordered fresh Workers
  → verify: Issue 或 Release authoritative validation
  → review: one fresh read-only aggregate review
  → repair: bounded Issue/Release repair
  → deliver: push + PR + required CI + exact-head auto-merge + merge verification
  → complete: release-result:v1
```

`currentIssueNumber` 区分 Issue/Release verify；PR、CI gate 与 delivery authority 保存可恢复的 delivery 断点，不另建 session runtime。

## 语义边界

Plan 只携带目标、repo/base、Parent/Child number、顺序和依赖、目标与 AC、可选 expected paths、`low|normal|high` risk、可选 Oracle command、Release AC 与 review focus。唯一兼容键是 `controllerContractVersion: 1`。

Planner 不传 Spec、Graph、decision、predecessor、waiver、Controller revision/build、schema hash、runtime lock 或 identity history。Controller 不解释 `plannerContextDigest`。

## Authority

- Worker / repair：`workspace-write`、network false，不得 commit/push/gh/改 branch 或 remote。
- Reviewer：`read-only`、network false，只审 exact aggregate candidate。
- Controller：唯一拥有 state、commit、push、PR、CI、auto-merge 与 merge facts。

每条 validation command 在独立 disposable projection 内执行，隔离 HOME/TMP/cache，默认断网，并在命令后重验 candidate 文件。TMP 是该 command projection 专属、位于 candidate 根之外的私有 runtime sibling；bootstrap 与紧随其后的 semantic command 共享这一轮 runtime，但不同 command、Job 或 repository 不共享，validation run 结束时统一清理。Oracle command 必须匹配 trusted config，普通任务不要求独立 Oracle。

PR 前 candidate 必须 clean、通过 Release validation、aggregate review 与 required Demo（若配置），并且 remote base 未漂移。required checks 绑定 exact candidate 和 app/workflow identity；成功后 Controller 用 `--match-head-commit` 授权 auto-merge。merge 后不再轮询 CI，只验证 PR/merge identity、远端祖先关系与 merge tree。

`activeRun` 在 Codex 启动前持久化。中断后保留 Worktree 并使用 fresh recovery Worker；Controller commit 的 crash window 通过 exact trailers salvage。

输出只有动态 `review.md`、精简 `release-result.json` 与可选 Demo artifacts。完整 receipt、structured Agent result 和 bounded logs 留在私有 state。
