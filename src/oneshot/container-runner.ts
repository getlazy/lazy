/**
 * Container-only runner factory for machine one-shots.
 *
 * Lives outside src/runner/index.ts so one-shot dispatch does not pull the full
 * runner barrel (and its transitive server imports) into every caller.
 */

import type { Runner } from '../runner/types';
import type { RunnerType, ResolvedConfig, RoleTarget } from '../config/types';
import { DockerRunner } from '../runner/docker-runner';
import { PodmanRunner } from '../runner/podman-runner';
import { loadConfig } from '../config/loader';
import { getAgent, getAgentPackaging } from '../agent/registry';
import {
  applyLiveProxyUrl,
  needsLiveProxyUrl,
  resolveLiveProxyUrl,
} from '../daemon/auth-env';

async function withProxyTargets(
  roles: { builder: RoleTarget; agent: RoleTarget },
  config: ResolvedConfig,
): Promise<{ builder: RoleTarget; agent: RoleTarget }> {
  const needed = (['builder', 'agent'] as const).filter(r => needsLiveProxyUrl(roles[r]));
  if (needed.length === 0) return roles;
  const proxyUrl = await resolveLiveProxyUrl(config);
  if (!proxyUrl) return roles;
  const filled = { ...roles };
  for (const role of needed) {
    filled[role] = applyLiveProxyUrl(roles[role], proxyUrl, config.proxy.upstream);
  }
  return filled;
}

/**
 * Create the container runner used for machine one-shots.
 *
 * One-shots ALWAYS run in a throwaway container — never on the host-process
 * runner, even when the test harness selects host-process for supervised turns.
 */
export async function createOneshotRunner(lazyRoot: string): Promise<Runner> {
  const config = await loadConfig(lazyRoot);
  const containerType: RunnerType =
    config.runner.type === 'podman' ? 'podman' : 'docker';

  // The BUILDER role, not `[agent] agent_id`: a one-shot is a fresh-context call
  // lazy makes on the human's behalf, so it runs the builder's target end to end
  // (see DockerRunner.runOneshot). Config load resolved the role to a validated
  // profile, so `harness` here is already a registry harness name.
  const roleTargets = await withProxyTargets(config.models.roles, config);
  const profileName = roleTargets.builder.profile;
  const harness = roleTargets.builder.harness;
  if (!getAgentPackaging(harness).supportsContainerRunner()) {
    throw new Error(
      `Machine one-shots require a container-capable agent, but the "${profileName}" profile runs ` +
      `${harness}, which does not support container runners. That profile is what ` +
      `[models.roles.builder] agent points at (falling back to [agent] agent_id when the role ` +
      `names none) — point it at a profile whose harness is claude-code, codex, cursor, or pi, ` +
      `and ensure Docker is running.`,
    );
  }

  const runner = containerType === 'podman'
    ? new PodmanRunner(lazyRoot)
    : new DockerRunner(containerType, containerType, lazyRoot);
  runner.setRoleTargets(roleTargets);
  // Both halves, always: the harness picks the binary, the profile name says
  // which profile that binary came from. Handing over only half is how a custom
  // profile ends up launching the built-in's binary.
  //
  // These agree with where the traffic GOES by construction now: `runOneshot`
  // preflights `[models.roles.builder]`'s endpoint and mints its grant for that
  // profile, and both are read off the same resolved target as this line.
  runner.setAgent(getAgent(harness), profileName);
  return runner;
}
