/**
 * Runner factory — creates the appropriate Runner based on configuration.
 *
 * Usage:
 *   import { createRunner } from '../runner';
 *   const runner = createRunner(lazyRoot);
 *   runner.checkAvailability();
 *   await runner.launchSupervisor(...);
 */

export type { Runner, RunInfo, FollowHandle, RunnerType, HealthCheck } from './types';
export type { DockerRunnerOptions } from './docker-runner';

import type { Runner } from './types';
import type { RunnerType } from '../config/types';
import { DockerRunner, type DockerRunnerOptions } from './docker-runner';
import { PodmanRunner } from './podman-runner';
import { HostProcessRunner } from './host-process-runner';
import { loadConfig } from '../config/loader';

/**
 * Create a Runner based on the configured runner type.
 * Accepts optional overrides for docker_agent_root and docker_agent_no_network (from CLI flags).
 */
export function createRunner(lazyRoot: string, overrides?: Partial<DockerRunnerOptions>): Runner {
  const config = loadConfig(lazyRoot);

  // Merge config values with CLI overrides (overrides take precedence)
  const dockerOptions: DockerRunnerOptions = {
    dockerAgentRoot: overrides?.dockerAgentRoot ?? config.runner.docker_agent_root,
    dockerAgentNoNetwork: overrides?.dockerAgentNoNetwork ?? config.runner.docker_agent_no_network,
  };

  switch (config.runner.type) {
    case 'docker':
      return new DockerRunner('docker', 'docker', dockerOptions);
    case 'podman':
      return new PodmanRunner(dockerOptions);
    case 'dangerously-host-process-without-any-isolation':
      return new HostProcessRunner();
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
