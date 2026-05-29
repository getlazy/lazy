/**
 * PodmanRunner — Runner implementation backed by Podman containers.
 *
 * Podman is a Docker-compatible container runtime. This runner extends
 * DockerRunner and overrides only the binary name ('podman' instead of
 * 'docker'). All container operations use the same CLI flags since Podman
 * is designed as a Docker CLI drop-in replacement.
 *
 * Key differences from Docker handled here:
 * - Uses 'podman' binary instead of 'docker'
 * - Availability check looks for 'podman' and provides Podman-specific guidance
 */

import { DockerRunner, type DockerRunnerOptions } from './docker-runner';
import { logger } from '../utils/logger';
import { spawnSync } from '../utils/spawn';

const PODMAN_TIMEOUT_MS = 10_000;

export class PodmanRunner extends DockerRunner {
  constructor(options?: DockerRunnerOptions, lazyRoot?: string) {
    super('podman', 'podman', options, lazyRoot);
  }

  /**
   * Override availability check to provide Podman-specific error messages.
   * The base class checkDocker(binary) throws on failure with a Docker-themed
   * message. We provide a better Podman-specific message.
   */
  override checkAvailability(): void {
    logger.debug('Checking Podman...');

    const result = spawnSync(['podman', 'info'], {
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: PODMAN_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        'Podman is not installed or not running. Install Podman: https://podman.io/docs/installation'
      );
    }

    logger.debug('Podman is running ✓');

    // Auth is NOT enforced here. The daemon credential gate
    // (src/daemon/credential-gate.ts) is the single enforcement point.
  }
}
