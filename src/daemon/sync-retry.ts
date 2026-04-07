/**
 * Daemon-managed sync retry loop with progressive backoff.
 *
 * Periodically checks for tasks with pending_sync > 0 and attempts to sync them.
 * Only targets tasks in syncable states (blocked, conflict, interrupted) — never
 * working tasks (worktree in use by agent).
 *
 * Backoff schedule: 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, cap at 300s.
 * Backoff state is in-memory only — daemon restart resets all backoff counters,
 * which is fine since it also re-evaluates all tasks from scratch.
 */

import { logger } from '../utils/logger';
import { getOrCreateStorage } from './rpc-handlers';
import { syncTask } from './task-lifecycle';

/** Statuses where sync is safe — agent is not running, worktree is idle. */
const SYNCABLE_STATUSES = new Set(['blocked', 'conflict', 'interrupted']);

/** Maximum backoff interval in milliseconds (5 minutes). */
const MAX_BACKOFF_MS = 300_000;

/** Per-task backoff state, keyed by full task ID. */
interface BackoffEntry {
  /** Next eligible retry time (Date.now() value). */
  nextRetryAt: number;
  /** Current attempt count (0 = first retry). */
  attempt: number;
}

/**
 * Calculate backoff delay for a given attempt.
 * Schedule: 1s, 2s, 4s, 8s, ..., capped at 300s.
 */
export function calculateBackoffMs(attempt: number): number {
  const delayMs = 1000 * Math.pow(2, attempt);
  return Math.min(delayMs, MAX_BACKOFF_MS);
}

/**
 * Run one tick of the sync retry loop for a single project.
 *
 * Finds all tasks with pending_sync > 0 in syncable states, respects backoff
 * timing, and calls syncTask() for eligible tasks.
 *
 * Exported for testing.
 */
export async function runSyncRetryTick(
  projectRoot: string,
  backoffState: Map<string, BackoffEntry>,
): Promise<{
  attempted: string[];
  succeeded: string[];
  backedOff: string[];
  skipped: string[];
}> {
  const result = {
    attempted: [] as string[],
    succeeded: [] as string[],
    backedOff: [] as string[],
    skipped: [] as string[],
  };

  const storage = await getOrCreateStorage();

  // Find tasks needing sync — we need all non-terminal tasks and filter ourselves
  const tasks = await storage.listTasksWithOptions({ nonTerminalOnly: true });
  const pendingSyncTasks = tasks.filter(
    (t) => t.pending_sync > 0 && SYNCABLE_STATUSES.has(t.status),
  );

  if (pendingSyncTasks.length === 0) return result;

  const now = Date.now();

  for (const task of pendingSyncTasks) {
    const shortTaskId = task.id.substring(0, 8);

    // Check backoff timing
    const backoff = backoffState.get(task.id);
    if (backoff && now < backoff.nextRetryAt) {
      result.skipped.push(shortTaskId);
      continue;
    }

    result.attempted.push(shortTaskId);

    try {
      const syncResult = await syncTask(projectRoot, { taskId: task.id });

      if (syncResult.status === 'pending_sync') {
        // Fetch failed — increase backoff
        const attempt = backoff ? backoff.attempt + 1 : 0;
        const delay = calculateBackoffMs(attempt);
        backoffState.set(task.id, {
          nextRetryAt: now + delay,
          attempt,
        });
        result.backedOff.push(shortTaskId);
        logger.info(`Sync retry: ${shortTaskId} fetch failed, backoff ${Math.round(delay / 1000)}s (attempt ${attempt + 1})`);
      } else if (syncResult.status === 'up_to_date' || syncResult.status === 'sync_launched') {
        // Success — reset backoff
        backoffState.delete(task.id);
        result.succeeded.push(shortTaskId);
        logger.info(`Sync retry: ${shortTaskId} ${syncResult.status}`);

        // Post-sync check: if sync_launched, the counter was reset to 0 before launch.
        // New signals during merge will increment it again. The next tick will pick
        // those up after the merge completes (task transitions back to blocked).
        // If up_to_date, counter is already 0. Either way, nothing more to do this tick.
      }
    } catch (err) {
      // syncTask throws RpcError for validation failures (e.g., task became working
      // between our check and the call). Log and skip — next tick will re-evaluate.
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Sync retry: ${shortTaskId} error: ${msg}`);
      result.skipped.push(shortTaskId);
    }
  }

  return result;
}

/**
 * Start the daemon sync retry loop for the daemon's single project.
 *
 * Runs alongside the reconcile loop on a 5-second tick. Each tick checks
 * for tasks needing sync retry.
 *
 * Returns a stop function to clean up the interval.
 */
export function startSyncRetryLoop(
  projectRoot: string,
  intervalSeconds: number,
): () => void {
  let running = false;
  let stopped = false;

  // Backoff state (in-memory only)
  const backoffState = new Map<string, BackoffEntry>();

  const doTick = async () => {
    if (stopped) return;
    if (running) return; // Skip if previous tick still running
    running = true;

    try {
      const result = await runSyncRetryTick(projectRoot, backoffState);

      if (result.attempted.length > 0) {
        logger.info(
          `Sync retry tick: ${result.succeeded.length} synced, ` +
          `${result.backedOff.length} backed off, ` +
          `${result.skipped.length} skipped`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Sync retry error: ${msg}`);
    } finally {
      running = false;
    }
  };

  // First tick after a short delay (let reconcile run first)
  const initialTimeout = setTimeout(doTick, 2_000);

  // Subsequent ticks on interval
  const intervalId = setInterval(doTick, intervalSeconds * 1_000);

  logger.debug(`Sync retry loop enabled: every ${intervalSeconds}s`);

  return () => {
    stopped = true;
    clearTimeout(initialTimeout);
    clearInterval(intervalId);
  };
}
