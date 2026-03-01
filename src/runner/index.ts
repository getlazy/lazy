/**
 * Runner factory — creates the appropriate Runner based on configuration.
 *
 * Usage:
 *   import { createRunner } from '../runner';
 *   const runner = createRunner(lazyRoot);
 *   runner.checkAvailability();
 *   await runner.launchSupervisor(...);
 */

export type { Runner, RunInfo, FollowHandle, RunnerType } from './types';

import type { Runner } from './types';
import type { RunnerType } from '../config/types';
import { DockerRunner } from './docker-runner';
import { HostProcessRunner } from './host-process-runner';
import { loadConfig } from '../config/loader';

/** Create a Runner based on the configured runner type. */
export function createRunner(lazyRoot: string): Runner {
  const config = loadConfig(lazyRoot);
  return createRunnerFromType(config.runner);
}

/** Create a Runner from an explicit runner type. */
export function createRunnerFromType(runnerType: RunnerType): Runner {
  switch (runnerType) {
    case 'docker':
      return new DockerRunner();
    case 'dangerously-host-process-without-any-isolation':
      return new HostProcessRunner();
    default:
      throw new Error(`Unknown runner type: ${runnerType}. Valid values: docker, dangerously-host-process-without-any-isolation`);
  }
}
