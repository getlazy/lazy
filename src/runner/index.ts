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

import type { Runner } from './types';
import type { RunnerType } from '../config/types';
import { DockerRunner } from './docker-runner';
import { PodmanRunner } from './podman-runner';
import { HostProcessRunner } from './host-process-runner';
import { loadConfig } from '../config/loader';

/** Create a Runner based on the configured runner type. */
export function createRunner(lazyRoot: string): Runner {
  const config = loadConfig(lazyRoot);
  return createRunnerFromType(config.runner.type);
}

/** Create a Runner from an explicit runner type. */
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
