/**
 * Optional OS-level isolation (DESIGN §4 residual-risk note, `isolation_mode: process`). The
 * default sandbox is in-agent (the capability guard + settings allowlist); for hardened or
 * public deployments the avatar's agent can run in a separate process whose environment is
 * SCRUBBED, so secrets in the parent process env (API keys, tokens) are invisible to it.
 *
 * This is a building block the autopilot (F6.2) uses to launch a headless agent under
 * isolation; here it is provided + smoke-tested.
 */
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";

/** Env vars always safe to pass to an isolated child (no secrets). */
export const BASE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM"];

/**
 * Build a scrubbed environment: only the base keys plus explicitly-allowed names survive;
 * every other parent-process variable (secrets, tokens) is dropped.
 */
export function isolatedEnv(
  allow: string[] = [],
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [...BASE_ENV_KEYS, ...allow]) {
    const v = base[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export type IsolationOptions = {
  /** Extra env var names to pass through (in addition to BASE_ENV_KEYS). Never pass secrets. */
  allowEnv?: string[];
  cwd?: string;
  stdio?: StdioOptions;
};

/**
 * Spawn a child process with a scrubbed environment (`isolation_mode: process`). Parent
 * secrets not in `allowEnv`/`BASE_ENV_KEYS` are not visible to the child.
 */
export function launchIsolated(
  command: string,
  args: string[] = [],
  opts: IsolationOptions = {},
): ChildProcess {
  return spawn(command, args, {
    env: isolatedEnv(opts.allowEnv),
    cwd: opts.cwd,
    stdio: opts.stdio ?? "pipe",
  });
}
