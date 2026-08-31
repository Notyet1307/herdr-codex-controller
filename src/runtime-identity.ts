import type { ControllerConfig } from "./types.js";

export const WORKER_MODEL = "gpt-5.6-terra";
export const WORKER_REASONING_EFFORT = "high";
export const REVIEWER_MODEL = "gpt-5.6-sol";
export const REVIEWER_REASONING_EFFORT = "max";

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
    "--config", 'shell_environment_policy.inherit="none"',
    "--config", "shell_environment_policy.ignore_default_excludes=false",
  ];
  args.push(
    "--config",
    `shell_environment_policy.set.PATH=${JSON.stringify(config.validation.sandbox.environmentPath.join(":"))}`,
  );
  return args;
}
