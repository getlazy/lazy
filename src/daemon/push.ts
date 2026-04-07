/**
 * Daemon push-after-state-change — pushes task branches to remote tracking
 * branches after state transitions (turn end, accept, upstream merge).
 *
 * The daemon is the single process that sees all state transitions. Instead of
 * relying on periodic sync (slow/unreliable), we push immediately after each
 * change so remote branches never drift far from local state.
 *
 * Design:
 * - Pushes are serialized per-project to avoid concurrent git push conflicts
 * - Push failures are logged and queued for retry on the next reconcile tick
 * - Only active when the remote driver needs sync (no-op for local driver)
 * - Called from the reconcile loop after state transitions
 */

import { loadConfig } from '../config/loader';
import { createDriver, type RepositoryDriver } from '../remote';
import { localBranchExists } from '../git/operations';
import { logger } from '../utils/logger';

/** Branches that failed to push and should be retried. Keyed by project root. */
const retryQueues = new Map<string, Set<string>>();

/** Tracks whether a push is currently in progress for a project. */
const pushingProjects = new Set<string>();

/**
 * Push a task branch to the remote after a state change.
 *
 * Safe to call from the reconcile loop — serializes concurrent pushes
 * per-project and handles failures gracefully (logs + queues for retry).
 *
 * @param projectRoot - The project root directory
 * @param branch - The git branch name to push (e.g., "lazy/fix.abc12345")
 */
export async function pushBranchAfterStateChange(
  projectRoot: string,
  branch: string,
): Promise<void> {
  // Queue this branch for pushing
  let queue = retryQueues.get(projectRoot);
  if (!queue) {
    queue = new Set();
    retryQueues.set(projectRoot, queue);
  }
  queue.add(branch);

  // If already pushing for this project, the queued branch will be
  // picked up when the current push finishes.
  if (pushingProjects.has(projectRoot)) {
    logger.debug(`Push already in progress for ${projectRoot}, queued branch ${branch}`);
    return;
  }

  await drainPushQueue(projectRoot);
}

/**
 * Drain the push queue for a project — pushes all queued branches.
 * Serializes pushes to avoid concurrent git operations.
 */
async function drainPushQueue(projectRoot: string): Promise<void> {
  if (pushingProjects.has(projectRoot)) return;
  pushingProjects.add(projectRoot);

  try {
    let driver: RepositoryDriver | null = null;

    try {
      const config = await loadConfig(projectRoot, { cwd: projectRoot });
      driver = createDriver(config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`Push skipped: could not create driver for ${projectRoot}: ${msg}`);
      // Clear the queue since we can't push without a driver
      retryQueues.delete(projectRoot);
      return;
    }

    if (!driver.needsSync) {
      logger.debug('Push skipped: driver does not need sync (local driver)');
      retryQueues.delete(projectRoot);
      return;
    }

    const queue = retryQueues.get(projectRoot);
    if (!queue || queue.size === 0) return;

    // Snapshot and clear the queue before pushing so new entries
    // added during push aren't lost
    const branches = [...queue];
    queue.clear();

    for (const branch of branches) {
      try {
        if (!await localBranchExists(branch, projectRoot)) {
          logger.debug(`Push skipped: local branch ${branch} does not exist (may only exist on remote)`);
          continue;
        }

        await driver.pushBranch(branch);
        logger.debug(`Pushed branch ${branch} after state change`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Push failed for branch ${branch}: ${msg}`);
        // Re-queue for retry on next reconcile tick
        queue.add(branch);
      }
    }
  } finally {
    pushingProjects.delete(projectRoot);
  }
}

/**
 * Retry any branches that failed to push on a previous tick.
 * Called at the start of each reconcile cycle.
 *
 * @param projectRoot - The project root directory
 */
export async function retryFailedPushes(projectRoot: string): Promise<void> {
  const queue = retryQueues.get(projectRoot);
  if (!queue || queue.size === 0) return;

  logger.debug(`Retrying ${queue.size} failed push(es) for ${projectRoot}`);
  await drainPushQueue(projectRoot);
}

/**
 * Get the count of branches pending push for a project.
 * Useful for monitoring/debugging.
 */
export function getPendingPushCount(projectRoot: string): number {
  return retryQueues.get(projectRoot)?.size ?? 0;
}

/**
 * Clear all retry state. Used in tests.
 */
export function _resetPushState(): void {
  retryQueues.clear();
  pushingProjects.clear();
}
