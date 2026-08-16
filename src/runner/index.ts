/**
 * Runner factory — creates the appropriate Runner based on configuration.
 *
 * Usage:
 *   import { createRunner } from '../runner';
 *   const runner = await createRunner(lazyRoot);
 *   runner.checkAvailability();
 *   await runner.launchSupervisor(...);
 */

export type { Runner, RunInfo, FollowHandle, RunnerType, HealthCheck } from './types';
export { PROJECT_LABEL_KEY } from './docker-runner';

import type { Runner } from './types';
import type { RunnerType, ResolvedConfig, RoleTarget } from '../config/types';
import { DockerRunner } from './docker-runner';
import { PodmanRunner } from './podman-runner';
import { HostProcessRunner } from './host-process-runner';
import { loadConfig } from '../config/loader';
import { resolveLiveProxyUrl, needsLiveProxyUrl, applyLiveProxyUrl } from '../daemon/auth-env';

/**
 * Point every proxyable role at the live lazy proxy.
 *
 * The proxy is ON BY DEFAULT, so this is the seam that makes "all agent traffic
 * flows through lazy's audit/policy plane" true at launch time. The per-role
 * rules (and the fail-loud contract when the address cannot be resolved) live
 * in `daemon/auth-env`, shared with `lazy pair` and `lazy chat`; the address is
 * resolved ONCE here and applied to both roles.
 *
 * When the proxy is disabled (`[proxy] enabled = false`) targets are returned
 * unchanged and everything connects directly — that is the explicit opt-out.
 * A proxy that is enabled but unreachable is NOT: it throws.
 */
async function withProxyTargets(
  roles: { builder: RoleTarget; agent: RoleTarget },
  config: ResolvedConfig,
): Promise<{ builder: RoleTarget; agent: RoleTarget }> {
  const needed = (['builder', 'agent'] as const).filter(r => needsLiveProxyUrl(roles[r], config));
  if (needed.length === 0) return roles;
  // Throws ProxyUnavailableError when the proxy is enabled but its live address
  // cannot be resolved — a launch never silently escapes the audit plane.
  const proxyUrl = await resolveLiveProxyUrl(config);
  if (!proxyUrl) return roles; // explicit RPC-bypass modes only (test / daemon-self)
  const filled = { ...roles };
  for (const role of needed) filled[role] = applyLiveProxyUrl(roles[role], proxyUrl);
  return filled;
}

/**
 * Re-resolve this runner's live proxy targets against the daemon that is
 * serving RIGHT NOW.
 *
 * WHY THIS EXISTS: role targets are resolved ONCE, in `createRunner`, and
 * stamped onto the runner instance. That is correct for a command that launches
 * and exits — but `lazy builder` holds one runner across a `lazy upgrade`, which
 * RESTARTS the daemon. The proxy port is OS-assigned by default (`[proxy] port`
 * is optional precisely so per-project daemons don't collide), so the restarted
 * daemon almost always serves its proxy on a DIFFERENT port. The stamped
 * pre-upgrade address then wins at launch — `resolveAuthEnvFromDaemon` prefers
 * an already-set `proxyUrl` over the daemon's live one — and the relaunched
 * builder gets `ANTHROPIC_BASE_URL` pointing at a dead port. Every model call
 * fails until the human relaunches by hand.
 *
 * Targets are re-derived from config exactly the way `createRunner` derives
 * them, so this is a genuine re-resolve rather than a patch of the old value.
 * It throws {@link ProxyUnavailableError} when the proxy is enabled but its live
 * address cannot be resolved — a relaunch must fail loudly rather than come back
 * pointed at a dead endpoint, which is the failure this function exists to end.
 *
 * Call it only after the new daemon is known to be serving; calling it earlier
 * would resolve the dying daemon's address or fail spuriously.
 */
export async function refreshRunnerProxyTargets(runner: Runner, lazyRoot: string): Promise<void> {
  const config = await loadConfig(lazyRoot);
  runner.setRoleTargets(await withProxyTargets(config.models.roles, config));
}

/**
 * Create a Runner based on the configured runner type.
 *
 * @param overrideType When provided, this runner type is used instead of the
 *   global `[runner] type` from lazy.toml. Used for per-task runner overrides
 *   (`task.runner_type`) and for monitoring sessions on the runner they ran on
 *   (`session.runner_type`). When omitted, the global config default applies —
 *   so existing zero-override callers keep working unchanged.
 */
export async function createRunner(lazyRoot: string, overrideType?: RunnerType): Promise<Runner> {
  const config = await loadConfig(lazyRoot);
  const runnerType = overrideType ?? config.runner.type;

  // Host-only agents cannot use container runners. Check against the RESOLVED
  // runner type, not the global default — a per-task host override is exactly
  // how a non-claude agent is meant to run on a container-default project.
  const agentId = config.agent.agent_id;
  if (agentId !== 'claude-code' && (runnerType === 'docker' || runnerType === 'podman')) {
    throw new Error(
      `The "${agentId}" agent only supports host-process runner. ` +
      `Set runner = "dangerously-host-process-without-any-isolation" in lazy.toml or use a different agent.`
    );
  }

  // Wire the per-role model targets into runners so they can inject the right
  // backend env vars and preflight reachability per role (builder vs agent).
  // Route proxyable roles through the (default-on) local audit/policy proxy.
  const roleTargets = await withProxyTargets(config.models.roles, config);

  switch (runnerType) {
    case 'docker': {
      const runner = new DockerRunner('docker', 'docker', lazyRoot);
      runner.setRoleTargets(roleTargets);
      return runner;
    }
    case 'podman': {
      const runner = new PodmanRunner(lazyRoot);
      runner.setRoleTargets(roleTargets);
      return runner;
    }
    case 'dangerously-host-process-without-any-isolation': {
      const runner = new HostProcessRunner(lazyRoot);
      runner.setRoleTargets(roleTargets);
      runner.setHostPermission({
        mode: config.runner.permission_mode,
        allowedDomains: config.runner.sandbox_allowed_domains,
        allowWeakerNested: config.runner.sandbox_allow_weaker_nested,
        denyRead: config.runner.sandbox_deny_read,
        denyWrite: config.runner.sandbox_deny_write,
      });
      return runner;
    }
    default:
      throw new Error(`Unknown runner type: ${runnerType}. Valid values: docker, podman, dangerously-host-process-without-any-isolation`);
  }
}

/** Create a Runner from an explicit runner type (used by supervisor inside container). */
export function createRunnerFromType(runnerType: RunnerType): Runner {
  switch (runnerType) {
    case 'docker':
      return new DockerRunner();
    case 'podman':
      return new PodmanRunner();
    case 'dangerously-host-process-without-any-isolation':
      return new HostProcessRunner();
    default:
      throw new Error(`Unknown runner type: ${runnerType}. Valid values: docker, podman, dangerously-host-process-without-any-isolation`);
  }
}
