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
import { getAgentPackaging } from '../agent/registry';
import { resolveLiveProxyUrl, needsLiveProxyUrl, applyLiveProxyUrl } from '../daemon/auth-env';

/**
 * Point EVERY role at the live lazy proxy.
 *
 * The proxy is ALWAYS ON, so this is the seam that makes "all agent traffic
 * flows through lazy's audit/policy plane" true at launch time. The fail-loud
 * contract when the address cannot be resolved lives in `daemon/auth-env`,
 * shared with `lazy pair` and `lazy chat`; the address is resolved ONCE here
 * and applied to both roles.
 *
 * There is no "proxy off" path to return targets unchanged for: an unreachable
 * proxy throws, and no backend opts out. A role whose `endpoint` names a
 * different upstream (ollama, another Anthropic-native service) is proxied like
 * any other — the proxy forwards it there. The only roles skipped here are ones
 * that already carry a `proxyUrl`.
 */
async function withProxyTargets(
  roles: { builder: RoleTarget; agent: RoleTarget },
  config: ResolvedConfig,
): Promise<{ builder: RoleTarget; agent: RoleTarget }> {
  const needed = (['builder', 'agent'] as const).filter(r => needsLiveProxyUrl(roles[r]));
  if (needed.length === 0) return roles;
  // Throws ProxyUnavailableError when the live proxy address cannot be
  // resolved — a launch never silently escapes the audit plane.
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
 * It throws {@link ProxyUnavailableError} when the live proxy address
 * cannot be resolved — a relaunch must fail loudly rather than come back
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
  // how a host-only agent is meant to run on a container-default project.
  // Capability comes from the agent's packaging, not a hardcoded id list.
  const agentId = config.agent.agent_id;
  if (
    (runnerType === 'docker' || runnerType === 'podman') &&
    !getAgentPackaging(agentId).supportsContainerRunner()
  ) {
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
