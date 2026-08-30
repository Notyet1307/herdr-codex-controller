# 运维手册

## 上线前检查

```bash
git --version
gh auth status
codex --version
codex login status
node --version
```

目标仓库必须：

- 本地 checkout 为 Git root；
- `origin/main` 或配置的 remote/baseRef 可 fetch；
- 当前用户可创建 branch、push、读取 Issue、创建 PR；
- 仓库的 `AGENTS.md`、构建命令和测试命令准确；
- setup/validation commands 可重复且不修改 Git-visible 源码。

## 推荐上线顺序

1. 保持 `executionMode=release-plan-v2-direct`；`delivery.createPullRequest=false`，使用 1 个 source-bound v2 disposable Issue 做本地 candidate 演练。
2. 启用 PR，但保持 `autoMerge=false`。
3. 连续完成数个小 Release 后，再考虑 auto-merge。
4. 先保持单仓库单 Job；多仓库并发由独立进程和独立目录实现。

## 实验 Dispatcher 与定时执行

连续领取是 Controller 上方保留的 experimental 层，不属于 qualified production path。必须先把独立 Controller config 显式设为 `executionMode=dispatcher-experimental`，再手工执行并检查至少一次 idle 结果：

```bash
node dist/src/cli.js config validate --config /PRIVATE/PATH/controller.json --json
node dist/src/cli.js doctor --config /PRIVATE/PATH/controller.json --json
node dist/src/cli.js dispatch --config /PRIVATE/PATH/controller.json --dispatcher /PRIVATE/PATH/dispatcher.json --json
node dist/src/cli.js dispatch status --config /PRIVATE/PATH/controller.json --dispatcher /PRIVATE/PATH/dispatcher.json --json
```

安全前提：

- Dispatcher 配置的 `parentIssue` 是唯一 admission map；只按 GitHub 返回的 sub-issue 顺序选择；
- `readyLabel` 固定为 `ready-for-agent`；Dispatcher 不添加或删除该标签；
- 必须观察到 Child 为 OPEN、无 assignee、原生 `issue_dependencies_summary.blocked_by=0`；字段缺失即失败；
- Claim 是 `gh issue edit --add-assignee <当前登录用户>`，写后必须观察到唯一 assignee 正是该用户；
- Controller 必须启用 aggregate review、critical/major 阻断、PR checks、squash auto-merge，并禁用 `allowNoChecks`；
- `postMerge.requiredWorkflows` 使用 `gh run list` 返回的精确 workflow name，列表不能为空；
- 定时任务只运行 `dispatch` 命令，不修改 label、不执行 Controller retry、不清理 Worktree/证据。

`issue_completed_verified` 不是终态：形成完整 post-merge 证据后，同一个 `dispatch` 进程会立即选择并领取下一个合格 Issue。`queue_idle` 才是正常终态，表示当前没有满足全部 admission gate 的 Issue。`repository_busy` 表示同一 state root 已有其他 Job；本次不领取，下一次计划运行再检查。`job_blocked` 和 `dispatcher_blocked` 都是人工处理点，不应通过扩大 retry 次数绕过。

每次成功交付后，Dispatcher 在 `stateDir/dispatcher/state.json` 保留候选 SHA、PR、merge SHA、main workflow receipts 和完成时间；只有这些证据齐全才清空当前 claim，并在当前运行内开放后继 Issue 的 admission slot。桌面定时任务仍可在 `queue_idle` 后定期唤醒，以领取后来新增或解除 blocker 的 Issue。

## v2 Planner handoff 启动

v2 只接受公开 Release Plan 文件；不要安装/加载 `pi-ticket-planning` package，也不要让 Controller 读取 Planner 私有 artifact。

1. 确认 Controller config 为 `executionMode=release-plan-v2-direct`。
2. 执行 `config validate --json`，记录返回的 `configDigest` 和 `controller` identity。
3. 执行 `plan validate --config ... --plan ... --json`，确认 `source.repo/baseRef` 与配置 exact 一致，并记录完整 `provenance`。
4. 确认批准后 Controller checkout/build、config 和 Plan 文件都没有变化。
5. 使用无 `sha256:` 前缀的 exact 值启动：

```bash
node dist/src/cli.js start \
  --config /PRIVATE/PATH/controller.json \
  --plan /PRIVATE/PATH/release-plan.json \
  --expected-config-digest 64位小写CONFIG_DIGEST \
  --expected-controller-revision 40位小写CONTROLLER_COMMIT \
  --expected-controller-provenance-digest 64位小写PROVENANCE_DIGEST \
  --json
```

`expected_config_digest_*`、`expected_controller_revision_*`、`expected_controller_provenance_*` 和 `plan_source_repo_mismatch`、`plan_source_base_ref_mismatch` 都发生在 Job 创建前。不要通过修改 Controller、Plan/config 绕过批准 gate。

v2 Job 的第一次 `step` 只在 Controller provenance、git/GitHub/Codex preflight、remote base、Parent 和全部 Child 校验通过后创建 Worktree。可在 `stateDir/jobs/<id>/issues/` 审计 Parent/Child snapshots；`job.json.provenance` 可回读 exact Controller commit、tracked source manifest digest、build digest、config digest 和 Plan version/digest。`status --json` 同时返回 current provenance 与 `provenanceMatches`。

## blocked 分类

blocked 分为两类：

- `replan_required`：当前 Job 的终态阻断。`blocked.message` 保留原始 cause code；至少包括 `release_hardening_exhausted`、`release_diff_too_large`、source-bound Plan/Parent/Child drift、`oracle_binding_drift`、`protected_path_changed`、`issue_scope_budget_exceeded`、`issue_scope_path_drift`、`hardening_scope_unattributed`、`unknown_risk_class`、`issue_risk_class_drift`，以及 Worker 确认必须改变未包含 Issue scope、accepted ADR、source-bound Plan 或 dependency handoff 的 finding。同一 Job 禁止 retry；必须保存证据、`abort`，回到 Planner 生成并批准新的公开 Release Plan v2，再用新 Release ID 启动新 Job。
- 可恢复阻断：不改变 product scope、Plan、base SHA、Issue snapshot、ADR 或 dependency handoff 的暂态事实，例如基础设施/Provider 故障、凭据重新登录、恢复 exact config，或已修复的本地依赖。只有这类阻断可 retry。

常见 cause/recoverable code：

- `codex_worker_recoverable` / `codex_hardening_recoverable`：Worker 结构化返回 `blockedKind=recoverable`；修复本地/外部事实并提供新证据后可 retry。旧版无 `blockedKind` 的 `codex_worker_blocked` / `codex_hardening_blocked` 无法证明可恢复，升级后 fail closed 为 `replan_required`。
- `codex_worker_replan_required` / `codex_hardening_replan_required`：Worker 结构化返回 `blockedKind=replan_required`；映射为 `replan_required`，必须 abort/replan。
- `issue_validation_failed`：局部验证在 bounded repair 后仍失败。
- `release_hardening_exhausted` / `release_diff_too_large`：映射为 `replan_required`，不能由 operator reason 增加 hardening budget。
- `validator_mutated_worktree`：验证命令修改了 Git-visible 文件；修复命令或 `.gitignore`。
- `review_candidate_drift`：Review 前 candidate 不再等于 clean HEAD。
- `pull_request_head_drift`：PR 被其他写者更新；人工决定是否重新建立 candidate。
- `dispatcher_issue_source_drift` / `dispatcher_parent_membership_drift`：领取后的 Child 内容或 Parent membership 改变；停止并重新批准 Issue，而不是沿用旧内容。
- `dispatcher_claim_conflict`：Claim 后未观察到当前 GitHub 用户是唯一 assignee。
- `post_merge_ci_failed`：至少一个配置的 main push workflow 非 success；不会领取下一项。
- `post_merge_verification_timeout`：merge/base、Issue closure 或 main workflow receipt 在时限内没有形成完整证据。
- `config_drift`：当前配置与 Job 启动时绑定的 digest 不一致；恢复完全相同的配置后再继续。`config.snapshot.json` 只用于证据和人工核对，不会被运行时静默采用。
- `controller_provenance_drift`：当前 Controller commit、tracked source manifest 或 executable build/package identity 与 Job snapshot 不一致；该 Job 不得由漂移后的 Controller 继续执行。恢复 snapshot 对应的 exact Controller build，或 abort 后用新 provenance 创建新 Job。
- `controller_provenance_unavailable`：Controller 无法证明自己的 Git revision、tracked files 或实际 build；修复 checkout/build 后再操作，不得绕过 identity gate。
- `plan_base_drift`：当前 remote/baseRef commit 不等于 v2 `source.baseSha`；映射为 `replan_required`。
- `plan_parent_not_open` / `plan_parent_drift`：Parent 已关闭或精确 title/raw-body hash 漂移；映射为 `replan_required`。
- `plan_issue_not_open` / `plan_issue_drift`：至少一个 Child 已关闭或精确 title/raw-body hash 漂移；映射为 `replan_required`。

source drift 不应对旧 Job 执行 retry 来采用新事实，因为 Job 内 Plan 不允许被覆盖。应保存 evidence、`abort` 旧 Job，回到 Planner 基于新 base/Issue 生成并批准新 Plan，再以新 Release ID 启动。Controller 不自动更新 drifted Plan，也不让 Codex 判断漂移。

## 中断

正常使用 `SIGINT`/`SIGTERM`。Controller 会向当前子进程组发送终止信号，并在 grace period 后 SIGKILL。

若 Controller 被 `SIGKILL`：

1. 检查是否仍有遗留 `codex` 进程；
2. 确认无旧进程后执行 `step`；
3. stale lock 会在记录 PID 已不存在时自动回收；
4. Controller 校验 HEAD，保留 Worktree，fresh retry。

## 手工修改 Worktree

Job blocked 时可以人工修复，但必须：

- 不切换 branch；
- 不 push；
- 不创建与 Controller trailer 混淆的 commit；
- 只处理不改变 Job authority 的可恢复问题；
- 生成一份新的、非空、最大 1 MiB 的 regular evidence file；不要使用 Planner 私有状态；
- 修改后使用 `retry --reason TEXT --evidence PATH`；Controller 按原始字节计算 SHA-256 并将 evidence snapshot 保存到 Job 私有目录；
- 同一 blocked code + 同一 evidence digest 再次授权会返回 `retry_without_new_evidence`；
- 后续仍会经过完整 Controller validation/review。

`retry` 的 durable authorization 保存在 `job.json.retryAuthorizations`，记录 previous blocked code/phase/details path、operator reason、Job-private recovery evidence path、evidence digest 和 authorization time。每次 reload 都会验证 snapshot 仍位于 Job 私有根且字节 SHA-256 匹配。retry 只回到原 blocked phase，不增加 hardening/CI round，也不改 Plan、base SHA 或 Issue snapshots。

## 证据保留

Release validation 或 aggregate review 完成后，Controller 按以下 durability 顺序处理：先落盘 receipt/result，再将 path、digest、candidate SHA、Codex run record、review round/last review path 原子 checkpoint 到 `job.json`，最后判断 Worktree/diff policy、Review 结论或 hardening budget。进程在 checkpoint 后退出时，重启会保留这些 binding，不会把 round 或 last evidence 回退到上一轮。

verified merge 完成时还会原子保存 immutable completion checkpoint，绑定 exact candidate、Issue commits、release validation/review digest、PR/merge/checks、与 verified merge SHA 相同的 exact merged main、handoff digests 和 provenance。`completion export` 只从该 checkpoint 与重新验证的 private evidence 生成 public allowlist artifact；旧的 local-only 或无 checkpoint Job 不可导出。

`release_hardening_exhausted` 由 `scheduleHardening` 直接保存为 `replan_required`，不依赖异常后的 reload。排查时应同时核对：

- `blocked.detailsPath` 是本轮 exact receipt/result；
- `validations` 中同 path 的 digest 与 receipt 自身 digest 一致；或 `runs` 中同 result path 的 `resultDigest`、`baseHeadSha` 与当前 candidate 一致；
- aggregate review 的 `reviewRound` 和 `lastReviewPath` 对应最新 review run。

不要只看到 evidence 文件就推断 Job 已绑定；以重载后的 `job.json` 上述字段为准。

不要在 Job 运行中删除：

```text
job.json
runs/
validations/
issues/
retry-evidence-*.bin
operator-retry-*.json
```

`cleanup` 只删除 terminal clean Worktree，不删除这些证据。

## 回滚

带 provenance 的 Job state version 为 2。升级不会为旧 Job 静默补写 Controller identity；升级前应让旧 Job 到达终态，或保留原 Controller build 完成/中止它。不要删除或重写已有 Job 的 `job.json`、Worktree、commit、PR 或证据目录。回滚 Controller 时，同样只能让 snapshot 匹配的 exact build 继续对应 Job。

本版本的 deterministic/fake-port 测试只能证明本地契约和零副作用 gate；不能作为真实 Planner cross-repo canary、真实 Codex run 或真实 GitHub delivery 的证据。
