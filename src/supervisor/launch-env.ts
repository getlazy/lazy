/**
 * Refresh a supervisor's model/proxy launch environment from the live daemon.
 *
 * Task-agent supervisors run inside a container whose `ANTHROPIC_BASE_URL` (and
 * related auth vars) were resolved once at `docker run` and copied into
 * `process.env`. Claude Code reads them at startup and never re-reads them — so
 * a daemon restart (including during `lazy upgrade`) leaves a mid-turn agent
 * pointed at a dead proxy port until something replaces those vars.
 *
 * Builder continuity (`src/builder/continuity.ts`) and interactive sessions
 * (`src/supervisor/interactive.ts`) already relaunch with fresh env. Task
 * agents get the same treatment here: before every retry relaunch, and whenever
 * a generation watch stops an in-flight agent after a restart.
 */

import { loadConfig } from '../config/loader';
import { profileNameForAgent } from '../config/agent-profiles';
import { findLazyRoot } from '../project-paths';
import { resolveRoleTarget, type LaunchSurface } from '../utils/role-target';
import {
  resolveAuthEnvFromDaemon,
  withLiveProxyTarget,
  type AuthEnvVar,
} from '../daemon/auth-env';
import type { LaunchIdentity } from '../proxy/placeholder-env';
import { readDaemonMcpConfigMinimal } from '../builder/launch-env';
import { containerNameForTask } from '../capture/claude';
import { log } from './log';

export interface RefreshSupervisorLaunchEnvOpts {
  taskId: string;
  /** Grant label — defaults to the task's container name (`lazy-<shortId>`). */
  label?: string;
  /**
   * Agent (= profile) this turn runs.
   *
   * Must match what the original launch passed: the grant registry keys an
   * identity by profile as well as role/task/env var, so refreshing under a
   * different profile would mint a SECOND placeholder — and the refreshed env
   * would then route to a different upstream mid-turn. Omitted only by callers
   * with no agent to name, which resolve to the default profile exactly as the
   * launch did.
   */
  agentId?: string;
}

/**
 * Resolve the project root for a supervisor process.
 *
 * A daemon-launched supervisor carries `LAZY_DAEMON_CONFIG` — in a container or
 * as a host process, the daemon writes one either way. Only a supervisor the
 * daemon did not launch (daemonless, tests) falls back to walking up from cwd.
 */
export async function resolveSupervisorProjectRoot(): Promise<string | null> {
  const daemonConfigPath = process.env.LAZY_DAEMON_CONFIG;
  if (daemonConfigPath) {
    const cfg = await readDaemonMcpConfigMinimal(daemonConfigPath);
    return cfg.projectRoot;
  }
  return findLazyRoot();
}

/** Write auth/proxy env vars into this process for the next agent spawn. */
export function applyAuthEnvToProcess(vars: AuthEnvVar[]): void {
  for (const { key, value } of vars) {
    process.env[key] = value;
  }
}

function launchSurfaceFor(config: Awaited<ReturnType<typeof loadConfig>>): LaunchSurface {
  const runnerType = config.runner.type;
  return runnerType === 'docker' || runnerType === 'podman' ? 'container' : 'host';
}

/**
 * How long a launch-env refresh waits for the daemon.
 *
 * The refresh exists to fail LOUDLY rather than relaunch onto a dead proxy, and
 * a daemon that accepts the connection and then stalls would otherwise leave the
 * retry path waiting forever in the one place whose whole purpose is to fail
 * fast. The route is BOUNDED (see the route table in src/daemon/server.ts) — a
 * handful of small local reads and one locked append — so 30s is far past any
 * honest answer and short enough that a stall surfaces as an error the caller
 * reports.
 */
const LAUNCH_ENV_TIMEOUT_MS = 30_000;

/** Auth/proxy env the daemon hands back for a task relaunch. */
interface AgentLaunchEnv {
  authEnvVars: AuthEnvVar[];
  proxyBaseUrl?: string;
  lazyVersion?: string;
}

/**
 * Ask the daemon for this container's fresh launch env over GET
 * /agent/launch-env, authenticated with the per-task MCP token in the mounted
 * daemon config. Sibling of `fetchBuilderLaunchEnv` (src/builder/launch-env.ts).
 *
 * Throws on any non-2xx: the caller must fail the relaunch rather than retry
 * into a dead proxy address.
 */
async function fetchAgentLaunchEnv(configPath: string): Promise<AgentLaunchEnv> {
  const cfg = await readDaemonMcpConfigMinimal(configPath);
  const url = `${cfg.target.replace(/\/$/, '')}/agent/launch-env`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'X-Lazy-Project': cfg.projectRoot,
    },
    signal: AbortSignal.timeout(LAUNCH_ENV_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(
      `the daemon refused to refresh this task's launch environment (${resp.status}): ` +
      `${body || resp.statusText}. Check \`lazy daemon status\` and retry.`,
    );
  }
  return await resp.json() as AgentLaunchEnv;
}

/**
 * Re-resolve the live proxy address and credential placeholders from the daemon
 * that is serving RIGHT NOW, and apply them to `process.env`.
 *
 * Two transports, chosen by whether the daemon mounted a config for this
 * supervisor — NOT by container-vs-host, which the branch comment below spells
 * out. Every daemon-launched turn takes the HTTP route on either runner; the
 * RPC client is left for supervisors the daemon did not launch.
 *
 * Throws when the live proxy address cannot be resolved — a relaunch must fail
 * loudly rather than retry into a dead endpoint.
 */
export async function refreshSupervisorLaunchEnv(
  opts: RefreshSupervisorLaunchEnvOpts,
): Promise<void> {
  // A MOUNTED DAEMON CONFIG — not "in a container". Say what the condition
  // tests, because the two are not the same set: the daemon writes this config
  // for every supervisor it launches, so a HOST-PROCESS supervisor takes this
  // path too whenever the daemon gave it one. In practice that is every
  // daemon-launched turn on either runner, and the RPC path below is left for
  // supervisors the daemon did not launch — daemonless and test modes.
  //
  // Both surfaces are served correctly: the daemon derives the launch surface
  // from the configured runner type, so a host process is handed the loopback
  // spelling of the proxy address and a container the Docker alias.
  //
  // WHY the route rather than the RPC client at all: `tryRpc` finds the daemon
  // through its port-marker and token FILES, which are deliberately never
  // mounted into a task container — so an in-container refresh could only ever
  // answer "Daemon is not running" against a daemon that was serving the whole
  // time, and the retry it was preparing became a fatal error naming the wrong
  // cause. The mounted config carries a per-task MCP token, which is what
  // /agent/launch-env authenticates; the task it refreshes for comes from that
  // token, not from this process.
  const daemonConfigPath = process.env.LAZY_DAEMON_CONFIG;
  if (daemonConfigPath) {
    const env = await fetchAgentLaunchEnv(daemonConfigPath);
    applyAuthEnvToProcess(env.authEnvVars);
    const proxied = env.proxyBaseUrl ?? env.authEnvVars.find(v => v.key === 'ANTHROPIC_BASE_URL')?.value;
    log(
      proxied
        ? `[work] Refreshed model launch env from the live daemon (proxy ${proxied}).`
        : '[work] Refreshed model launch env from the live daemon.',
    );
    return;
  }

  const projectRoot = await resolveSupervisorProjectRoot();
  if (!projectRoot) {
    throw new Error(
      'Could not resolve the lazy project root to refresh the model launch environment. ' +
      'Is LAZY_DAEMON_CONFIG set inside this container?',
    );
  }

  const config = await loadConfig(projectRoot);
  const surface = launchSurfaceFor(config);
  const target = await withLiveProxyTarget(resolveRoleTarget('agent', config), config);

  const shortId = opts.taskId.substring(0, 8);
  const label = opts.label ?? containerNameForTask(shortId);
  const identity: LaunchIdentity = {
    role: 'agent',
    taskId: opts.taskId,
    label,
    profile: profileNameForAgent(opts.agentId),
  };

  const authEnvVars = await resolveAuthEnvFromDaemon(
    target,
    { role: 'agent', taskId: opts.taskId },
    surface,
    config,
    identity,
  );

  applyAuthEnvToProcess(authEnvVars);

  const proxyUrl = authEnvVars.find(v => v.key === 'ANTHROPIC_BASE_URL')?.value;
  if (proxyUrl) {
    log(`[work] Refreshed model launch env from the live daemon (proxy ${proxyUrl}).`);
  } else {
    log('[work] Refreshed model launch env from the live daemon.');
  }
}
