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
import { assertSiblingContainerLaunchSupported } from './sibling-containers';
import { logger } from '../utils/logger';
import { spawn } from '../utils/spawn';

const PODMAN_TIMEOUT_MS = 10_000;

export class PodmanRunner extends DockerRunner {
  constructor(lazyRoot?: string) {
    super('podman', 'podman', lazyRoot);
  }

  /**
   * Override availability check to provide Podman-specific error messages.
   * The base class checkDocker(binary) throws on failure with a Docker-themed
   * message. We provide a better Podman-specific message.
   */
  override async checkAvailability(): Promise<void> {
    // FIRST, exactly as DockerRunner does it, and NOT via `super` — the whole
    // point of this override is that the base method's probe is Docker-themed.
    // Re-stating the gate is the cost of that.
    //
    // It has to be here rather than only at the launch sites: this is the
    // preflight every task-turn path runs before a worktree, a branch, a
    // session row or a credential placeholder exists. An override that skipped
    // it left podman with the failure mode the gate was moved to avoid — the
    // task recorded `interrupted`, auto-resumed, re-queued, and rebuilt all of
    // that on every attempt just to be refused at the launch site again.
    assertSiblingContainerLaunchSupported('use the podman runner');

    logger.debug('Checking Podman...');

    const proc = spawn(['podman', 'info'], {
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: PODMAN_TIMEOUT_MS,
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(
        'Podman is not installed or not running. Install Podman: https://podman.io/docs/installation'
      );
    }

    logger.debug('Podman is running ✓');

    // Auth is NOT enforced here. The daemon credential gate
    // (src/daemon/credential-gate.ts) is the single enforcement point.
  }
}
