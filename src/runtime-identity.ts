import type { ControllerConfig, ExecutionRuntimeIdentity } from "./types.js";
import { ControllerError } from "./errors.js";
import { digestJson } from "./util.js";
import { readExecutableIdentity } from "./executable-identity.js";

export const WORKER_MODEL = "gpt-5.6-terra";
export const WORKER_REASONING_EFFORT = "high";
export const REVIEWER_MODEL = "gpt-5.6-sol";
export const REVIEWER_REASONING_EFFORT = "max";

export function readExecutionRuntimeIdentity(config: ControllerConfig): ExecutionRuntimeIdentity {
  try {
    const identity = {
      version: 1 as const,
      binary: readExecutableIdentity(config.codex.bin, config.localPath, "Codex executable"),
      fixedPolicyDigest: codexFixedPolicyDigest(config),
      profilesDisabled: config.codex.workerProfile === null && config.codex.reviewerProfile === null,
    };
    return { ...identity, digest: digestJson(identity) };
  } catch (error) {
    throw new ControllerError(
      "execution_runtime_identity_unavailable",
      `Codex execution runtime identity is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function assertExecutionRuntimeIdentity(value: ExecutionRuntimeIdentity): void {
  if (!value || value.version !== 1
    || Object.keys(value as unknown as Record<string, unknown>).sort().join(",") !== "binary,digest,fixedPolicyDigest,profilesDisabled,version"
    || typeof value.profilesDisabled !== "boolean"
    || !/^[a-f0-9]{64}$/u.test(value.fixedPolicyDigest)
    || !value.binary
    || Object.keys(value.binary as unknown as Record<string, unknown>).sort().join(",") !== "byteCount,configuredPathDigest,realPathDigest,sha256,versionOutput"
    || !/^sha256:[a-f0-9]{64}$/u.test(value.binary.configuredPathDigest)
    || !/^sha256:[a-f0-9]{64}$/u.test(value.binary.realPathDigest)
    || !Number.isSafeInteger(value.binary.byteCount) || value.binary.byteCount < 1
    || !/^sha256:[a-f0-9]{64}$/u.test(value.binary.sha256)
    || !value.binary.versionOutput) {
    throw new Error("Codex execution runtime identity is invalid");
  }
  const { digest, ...identity } = value;
  if (!/^[a-f0-9]{64}$/u.test(digest) || digest !== digestJson(identity)) {
    throw new Error("Codex execution runtime identity digest is invalid");
  }
}

export function codexRuntimeControlArgs(config: ControllerConfig, worktreePath: string): string[] {
  const args = [
    "--ignore-user-config",
    "--ignore-rules",
    "--config", "sandbox_workspace_write.network_access=false",
    "--config", "sandbox_workspace_write.writable_roots=[]",
    "--config", "sandbox_workspace_write.exclude_slash_tmp=true",
    "--config", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "--config", "mcp_servers={}",
    "--config", "hooks={}",
    "--config", "plugins={}",
    "--config", "features.plugins=false",
    "--config", "project_doc_max_bytes=0",
    "--config", "project_doc_fallback_filenames=[]",
    "--config", `projects.${JSON.stringify(worktreePath)}.trust_level="untrusted"`,
    "--config", config.validation.sandbox
      ? 'shell_environment_policy.inherit="none"'
      : 'shell_environment_policy.inherit="core"',
    "--config", "shell_environment_policy.ignore_default_excludes=false",
  ];
  if (config.validation.sandbox) {
    args.push(
      "--config",
      `shell_environment_policy.set.PATH=${JSON.stringify(config.validation.sandbox.environmentPath.join(":"))}`,
    );
  }
  return args;
}

function codexFixedPolicyDigest(config: ControllerConfig): string {
  return digestJson({
    version: 1,
    arguments: codexRuntimeControlArgs(config, "$HERDR_WORKTREE"),
    worker: { model: WORKER_MODEL, reasoningEffort: WORKER_REASONING_EFFORT, sandbox: "workspace-write" },
    reviewer: { model: REVIEWER_MODEL, reasoningEffort: REVIEWER_REASONING_EFFORT, sandbox: "read-only" },
    approvalPolicy: "never",
    ephemeral: true,
    structuredOutput: true,
  });
}
