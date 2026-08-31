import { spawnSync } from "node:child_process";
import type { ControllerConfig, VerifiedGitRemote } from "./types.js";
import { ControllerError } from "./errors.js";

type Endpoint = {
  repo: string;
  url: string;
  transport: "https" | "ssh";
};

export function parseRemoteIdentityContract(
  value: unknown,
  repo: string,
): NonNullable<ControllerConfig["remoteIdentity"]> {
  const object = exactObject(value, ["fetchUrl", "pushUrl", "version"], "config.remoteIdentity");
  if (object.version !== 1) throw new Error("config.remoteIdentity.version must be 1");
  const fetch = endpoint(object.fetchUrl, "config.remoteIdentity.fetchUrl");
  const push = endpoint(object.pushUrl, "config.remoteIdentity.pushUrl");
  const expected = repo.toLowerCase();
  if (fetch.repo !== expected || push.repo !== expected) {
    throw new ControllerError("git_remote_identity_mismatch", "Configured Git fetch/push endpoints do not match config.repo.");
  }
  return { version: 1, fetchUrl: fetch.url, pushUrl: push.url };
}

function exactObject(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new Error(`${label} keys are invalid`);
  }
  return object;
}

export function configuredRemoteIdentity(config: ControllerConfig): VerifiedGitRemote {
  if (!config.remoteIdentity) {
    throw new ControllerError("git_remote_identity_unavailable", "Controller config has no versioned Git remote identity contract.");
  }
  const fetch = endpoint(config.remoteIdentity.fetchUrl, "config.remoteIdentity.fetchUrl");
  const push = endpoint(config.remoteIdentity.pushUrl, "config.remoteIdentity.pushUrl");
  return {
    remote: config.remote,
    repo: config.repo.toLowerCase(),
    fetchUrl: fetch.url,
    pushUrl: push.url,
    fetchTransport: fetch.transport,
    pushTransport: push.transport,
  };
}

export async function inspectGitRemoteIdentity(config: ControllerConfig): Promise<VerifiedGitRemote> {
  const expected = configuredRemoteIdentity(config);
  const rewrites = gitConfigValues(config.localPath, ["config", "--null", "--get-regexp", "^url\\..*\\.(insteadOf|pushInsteadOf)$"]);
  if (rewrites.length > 0) {
    throw new ControllerError("git_remote_url_rewrite_forbidden", "Ambient Git URL rewrite configuration is forbidden in production delivery.");
  }
  const fetchUrls = gitConfigValues(config.localPath, ["config", "--local", "--null", "--get-all", `remote.${config.remote}.url`]);
  const pushUrls = gitConfigValues(config.localPath, ["config", "--local", "--null", "--get-all", `remote.${config.remote}.pushurl`]);
  if (fetchUrls.length !== 1 || pushUrls.length > 1) {
    throw new ControllerError("git_remote_endpoint_ambiguous", "Git remote fetch/push endpoint identity is missing or ambiguous.");
  }
  const observedFetch = endpoint(fetchUrls[0]!, "Git remote fetch URL");
  const observedPush = endpoint(pushUrls[0] ?? fetchUrls[0]!, "Git remote push URL");
  const observed = {
    remote: config.remote,
    repo: config.repo.toLowerCase(),
    fetchUrl: observedFetch.url,
    pushUrl: observedPush.url,
    fetchTransport: observedFetch.transport,
    pushTransport: observedPush.transport,
  };
  if (observedFetch.repo !== expected.repo || observedPush.repo !== expected.repo
    || observed.fetchUrl !== expected.fetchUrl || observed.pushUrl !== expected.pushUrl
    || observed.fetchTransport !== expected.fetchTransport || observed.pushTransport !== expected.pushTransport) {
    throw new ControllerError("git_remote_identity_mismatch", "Observed Git fetch/push endpoints differ from the configured repository identity.");
  }
  return observed;
}

function endpoint(value: unknown, label: string): Endpoint {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_000 || /[\0\r\n]/u.test(value)) {
    throw new ControllerError("git_remote_endpoint_unsupported", `${label} is invalid.`);
  }
  let match = value.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u);
  if (match) {
    const repo = `${match[1]}/${match[2]}`.toLowerCase();
    return { repo, url: `https://github.com/${repo}.git`, transport: "https" };
  }
  match = value.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u)
    ?? value.match(/^ssh:\/\/git@github\.com(?::22)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u);
  if (match) {
    const repo = `${match[1]}/${match[2]}`.toLowerCase();
    return { repo, url: `git@github.com:${repo}.git`, transport: "ssh" };
  }
  throw new ControllerError(
    "git_remote_endpoint_unsupported",
    `${label} must be an exact GitHub HTTPS or SSH repository endpoint; helpers, local paths, and file URLs are forbidden.`,
  );
}

function gitConfigValues(cwd: string, args: string[]): string[] {
  const result = spawnSync("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-C", cwd,
    ...args,
  ], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_COUNT: "0", GIT_EXTERNAL_DIFF: undefined },
  });
  if (result.status === 1) return [];
  if (result.status !== 0 || result.signal || result.error) {
    throw new ControllerError("git_remote_identity_unavailable", "Git remote identity configuration cannot be read safely.");
  }
  return String(result.stdout).split("\0").filter(Boolean);
}
