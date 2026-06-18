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
export type { DockerRunnerOptions } from './docker-runner';
export { PROJECT_LABEL_KEY } from './docker-runner';

import type { Runner } from './types';
import type { RunnerType } from '../config/types';
import { DockerRunner } from './docker-runner';
import { PodmanRunner } from './podman-runner';
import { HostProcessRunner } from './host-process-runner';
import { loadConfig } from '../config/loader';

/**
 * Create a Runner based on the configured runner type.
 */
export async function createRunner(lazyRoot: string): Promise<Runner> {
  const config = await loadConfig(lazyRoot);

  // Host-only agents cannot use container runners
  const agentId = config.agent.agent_id;
  if (agentId !== 'claude-code' && (config.runner.type === 'docker' || config.runner.type === 'podman')) {
    throw new Error(
      `The "${agentId}" agent only supports host-process runner. ` +
      `Set runner = "dangerously-host-process-without-any-isolation" in lazy.toml or use a different agent.`
    );
  }

  // Wire the per-role model targets into runners so they can inject the right
  // backend env vars and preflight reachability per role (builder vs agent).
  const roleTargets = config.models.roles;

  switch (config.runner.type) {
    case 'docker': {
      const runner = new DockerRunner('docker', 'docker', undefined, lazyRoot);
      runner.setRoleTargets(roleTargets);
      return runner;
    }
    case 'podman': {
      const runner = new PodmanRunner(undefined, lazyRoot);
      runner.setRoleTargets(roleTargets);
      return runner;
    }
    case 'dangerously-host-process-without-any-isolation': {
      const runner = new HostProcessRunner(lazyRoot);
      runner.setRoleTargets(roleTargets);
      return runner;
    }
    default:
      throw new Error(`Unknown runner type: ${config.runner.type}. Valid values: docker, podman, dangerously-host-process-without-any-isolation`);
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
