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

1. `delivery.createPullRequest=false`，使用 1 个 disposable Issue 做本地 candidate 演练。
2. 启用 PR，但保持 `autoMerge=false`。
3. 连续完成数个小 Release 后，再考虑 auto-merge。
4. 先保持单仓库单 Job；多仓库并发由独立进程和独立目录实现。

## Dispatcher 上线与定时执行

连续领取是 Controller 上方的可选层。先手工执行并检查至少一次 idle 结果，再交给桌面定时任务：

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

1. 执行 `config validate --json`，记录返回的 `configDigest`。
2. 执行 `plan validate --config ... --plan ... --json`，确认 `source.repo/baseRef` 与配置 exact 一致并记录 `planDigest`。
3. 确认批准后 config 文件没有变化。
4. 使用同一个无 `sha256:` 前缀、64 位小写 `configDigest` 启动：

```bash
node dist/src/cli.js start \
  --config /PRIVATE/PATH/controller.json \
  --plan /PRIVATE/PATH/release-plan.json \
  --expected-config-digest 64位小写CONFIG_DIGEST \
  --json
```

`expected_config_digest_required`、`expected_config_digest_invalid`、`expected_config_digest_mismatch` 和 `plan_source_repo_mismatch`、`plan_source_base_ref_mismatch` 都发生在 Job 创建前。不要通过修改 Plan/config 绕过批准 gate。

v2 Job 的第一次 `step` 只在 git/GitHub/Codex preflight、remote base、Parent 和全部 Child 校验通过后创建 Worktree。可在 `stateDir/jobs/<id>/issues/` 审计 Parent/Child snapshots；`job.json` 中的 `planDigest` 覆盖全部 source 和 expected fields。

## blocked 分类

常见 code：

- `codex_worker_blocked`：需求或仓库事实不足；补充 Issue/文档后 retry。
- `issue_validation_failed`：局部验证在 bounded repair 后仍失败。
- `release_hardening_exhausted`：完整验证、Review 或 CI 要求超过允许的自动修复轮数。
- `validator_mutated_worktree`：验证命令修改了 Git-visible 文件；修复命令或 `.gitignore`。
- `review_candidate_drift`：Review 前 candidate 不再等于 clean HEAD。
- `pull_request_head_drift`：PR 被其他写者更新；人工决定是否重新建立 candidate。
- `dispatcher_issue_source_drift` / `dispatcher_parent_membership_drift`：领取后的 Child 内容或 Parent membership 改变；停止并重新批准 Issue，而不是沿用旧内容。
- `dispatcher_claim_conflict`：Claim 后未观察到当前 GitHub 用户是唯一 assignee。
- `post_merge_ci_failed`：至少一个配置的 main push workflow 非 success；不会领取下一项。
- `post_merge_verification_timeout`：merge/base、Issue closure 或 main workflow receipt 在时限内没有形成完整证据。
- `config_drift`：当前配置与 Job 启动时绑定的 digest 不一致；恢复完全相同的配置后再继续。`config.snapshot.json` 只用于证据和人工核对，不会被运行时静默采用。
- `plan_base_drift`：当前 remote/baseRef commit 不等于 v2 `source.baseSha`。
- `plan_parent_not_open` / `plan_parent_drift`：Parent 已关闭或精确 title/raw-body hash 漂移。
- `plan_issue_not_open` / `plan_issue_drift`：至少一个 Child 已关闭或精确 title/raw-body hash 漂移。

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
- 修改后使用 `retry --reason`；
- 后续仍会经过完整 Controller validation/review。

## 证据保留

不要在 Job 运行中删除：

```text
job.json
runs/
validations/
issues/
```

`cleanup` 只删除 terminal clean Worktree，不删除这些证据。

## 回滚

回滚 v2 Controller 代码只影响未来 v2 Job。不要删除或重写已有 v1/v2 Job 的 `job.json`、Worktree、commit、PR 或证据目录。若必须退回只支持 v1 的 Controller，先让所有 v2 Job 到达终态并保留状态目录；旧 v1 Job 的格式和执行语义不需要迁移。

本版本的 deterministic/fake-port 测试只能证明本地契约和零副作用 gate；不能作为真实 Planner cross-repo canary、真实 Codex run 或真实 GitHub delivery 的证据。
