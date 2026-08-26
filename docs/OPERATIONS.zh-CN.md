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

## blocked 分类

常见 code：

- `codex_worker_blocked`：需求或仓库事实不足；补充 Issue/文档后 retry。
- `issue_validation_failed`：局部验证在 bounded repair 后仍失败。
- `release_hardening_exhausted`：完整验证、Review 或 CI 要求超过允许的自动修复轮数。
- `validator_mutated_worktree`：验证命令修改了 Git-visible 文件；修复命令或 `.gitignore`。
- `review_candidate_drift`：Review 前 candidate 不再等于 clean HEAD。
- `pull_request_head_drift`：PR 被其他写者更新；人工决定是否重新建立 candidate。
- `config_drift`：当前配置与 Job 启动时绑定的 digest 不一致；恢复完全相同的配置后再继续。`config.snapshot.json` 只用于证据和人工核对，不会被运行时静默采用。

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
