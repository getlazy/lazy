/**
 * Fetch a builder container's fresh model/proxy launch environment from the daemon.
 *
 * Used when the builder supervisor relaunches Claude Code in place after a
 * daemon restart or upgrade — the container's original env vars (ANTHROPIC_BASE_URL
 * especially) were resolved once at `docker run` and never update on their own.
 *
 * Mirrors what the host does via getAuthEnv RPC in resolveAuthEnvFromDaemon, but
 * over HTTP with the builder's per-session MCP token — the same credential the
 * container already holds for tool calls and capture.
 */

import { readFile } from 'fs/promises';

import type { BuilderLaunchDirective } from './launch-directive';

export interface BuilderLaunchEnv {
  /** The builder role's CURRENT model/effort. Absent from a daemon that predates it. */
  directive?: BuilderLaunchDirective;
  authEnvVars: Array<{ key: string; value: string }>;
  proxyBaseUrl?: string;
  lazyVersion?: string;
}

export interface DaemonMcpConfigMinimal {
  token: string;
  projectRoot: string;
  target: string;
}

/** Read the mounted daemon MCP config the builder supervisor was launched with. */
export async function readDaemonMcpConfigMinimal(path: string): Promise<DaemonMcpConfigMinimal> {
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<DaemonMcpConfigMinimal>;
  if (!parsed.token || !parsed.projectRoot || !parsed.target) {
    throw new Error(
      `Daemon MCP config at ${path} is missing required fields (token, projectRoot, target). ` +
      `Relaunch the builder if this persists after lazy upgrade.`,
    );
  }
  return { token: parsed.token, projectRoot: parsed.projectRoot, target: parsed.target };
}

/**
 * Ask the daemon for env vars to pass to a relaunched Claude Code process.
 *
 * Throws on network/401 failures — the supervisor surfaces these rather than
 * relaunching into a dead audit proxy.
 */
/** See the task-side copy in src/supervisor/launch-env.ts for the rationale. */
const LAUNCH_ENV_TIMEOUT_MS = 30_000;
const PROXY_STARTUP_RETRY_MS = 250;

export async function fetchBuilderLaunchEnv(configPath: string): Promise<BuilderLaunchEnv> {
  const cfg = await readDaemonMcpConfigMinimal(configPath);
  const url = `${cfg.target.replace(/\/$/, '')}/builder/launch-env`;
  const deadline = Date.now() + LAUNCH_ENV_TIMEOUT_MS;
  while (true) {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'X-Lazy-Project': cfg.projectRoot,
      },
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (resp.ok) return await resp.json() as BuilderLaunchEnv;
    const body = await resp.text().catch(() => '');
    if (resp.status === 503 && body.includes('daemon proxy is not running') && Date.now() < deadline) {
      await Bun.sleep(Math.min(PROXY_STARTUP_RETRY_MS, deadline - Date.now()));
      continue;
    }
    throw new Error(launchEnvRefusalText(resp.status, body || resp.statusText));
  }
}

/**
 * The daemon's refusal in its own words: the `error` field of a JSON body when
 * there is one (the daemon's routes answer `{ error }`), else the raw text.
 * No CLI advice — a Teams member reading this from the builder page has no
 * terminal to run it in.
 */
export function launchEnvRefusalText(status: number, body: string): string {
  let reason = body;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
      reason = (parsed as { error: string }).error;
    }
  } catch (err) {
    // Not JSON (a proxy's HTML error page, plain text): the raw body is the reason.
    if (!(err instanceof SyntaxError)) throw err;
  }
  return `The daemon refused this builder's launch environment (${status}): ${reason}`;
}

/** Overlay launch env keys onto a base env record for spawn(). */
export function overlayLaunchEnv(
  base: Record<string, string | undefined>,
  launch: BuilderLaunchEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) out[k] = v;
  }
  for (const { key, value } of launch.authEnvVars) {
    out[key] = value;
  }
  return out;
}
