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

import { DockerRunner } from './docker-runner';
import { getAuthEnv } from '../capture/claude';
import { logger } from '../utils/logger';

const PODMAN_TIMEOUT_MS = 10_000;

export class PodmanRunner extends DockerRunner {
  constructor() {
    super('podman', 'podman');
  }

  /**
   * Override availability check to provide Podman-specific error messages.
   * checkDocker(binary) in the base class calls process.exit(1) on failure
   * with a Docker-themed message. We provide a better Podman-specific message.
   */
  override checkAvailability(): void {
    logger.debug('Checking Podman...');

    const result = Bun.spawnSync(['podman', 'info'], {
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: PODMAN_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      logger.error(
        'Podman is not installed or not running. Install Podman: https://podman.io/docs/installation'
      );
      process.exit(1);
    }

    logger.debug('Podman is running ✓');

    getAuthEnv(); // Fail fast on missing auth before creating state
  }
}
