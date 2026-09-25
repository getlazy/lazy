/**
 * Daemon-managed sync retry loop with progressive backoff.
 *
 * Periodically checks for tasks with pending_sync > 0 and attempts to sync them.
 * Only targets tasks sync can actually be dispatched from — never working tasks
 * (worktree in use by agent). That list is `SYNC_DISPATCHABLE_STATUSES`, shared
 * with `syncTaskRun`'s own in-lock whitelist; see src/task/sync-dispatch.ts for
 * why the two must not be spelled separately.
 *
 * Backoff schedule: 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, cap at 300s.
 * Backoff state is in-memory only — daemon restart resets all backoff counters,
 * which is fine since it also re-evaluates all tasks from scratch.
 */

import { logger } from '../utils/logger';
import { getOrCreateStorage } from './rpc-handlers';
import { syncTask } from './task-lifecycle';
import { isLinkedTask } from '../task/linked';
import { isSyncDispatchable } from '../task/sync-dispatch';
import { memberInsideTask } from '../server/member-terminals';
import { daemonHealthRecorder, SYNC_RETRY_LOOP } from './health-registry';

/** Maximum backoff interval in milliseconds (5 minutes). */
const MAX_BACKOFF_MS = 300_000;

/** Per-task backoff state, keyed by full task ID. */
export interface BackoffEntry {
  /** Next eligible retry time (Date.now() value). */
  nextRetryAt: number;
  /** Current attempt count (0 = first retry). */
  attempt: number;
  /** Why the last attempt did not sync — what `lazy daemon health` reports. */
  reason?: 'fetch-failed' | 'usage-pause';
}

/**
 * A task whose sync attempt THREW (rather than reporting a held or failed
 * fetch), consecutively. The loop still retries it every tick — the throw is
 * usually a task that changed state between the listing and the call — but a
 * throw that repeats is a sync that will never go through, and without this
 * record `lazy daemon health` could only call it "due on the next tick".
 */
export interface SyncFailureEntry {
  /** Consecutive attempts that threw. */
  failures: number;
  /** The last one's message. */
  lastError: string;
  lastErrorAt: number;
}

const liveFailureState = new Map<string, Map<string, SyncFailureEntry>>();

/** A copy of the sync-retry loop's throw record for a project (empty when the loop is not running). */
export function syncRetryFailureSnapshot(projectRoot: string): Map<string, SyncFailureEntry> {
  return new Map([...(liveFailureState.get(projectRoot) ?? new Map<string, SyncFailureEntry>())].map(([k, v]) => [k, { ...v }]));
}

/**
 * The running loop's backoff state per project, so `lazy daemon health` can
 * say where each held sync stands. Read-only to everyone but the loop.
 */
const liveBackoffState = new Map<string, Map<string, BackoffEntry>>();

/** A copy of the sync-retry loop's backoff state for a project (empty when the loop is not running). */
export function syncRetryBackoffSnapshot(projectRoot: string): Map<string, BackoffEntry> {
  return new Map([...(liveBackoffState.get(projectRoot) ?? new Map<string, BackoffEntry>())].map(([k, v]) => [k, { ...v }]));
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
  failureState: Map<string, SyncFailureEntry> = new Map(),
): Promise<{
  attempted: string[];
  succeeded: string[];
  backedOff: string[];
  skipped: string[];
  /** Held by a member's open terminal: skipped with no backoff and no fetch. */
  heldByMember: string[];
}> {
  const result = {
    attempted: [] as string[],
    succeeded: [] as string[],
    backedOff: [] as string[],
    skipped: [] as string[],
    /** Held by a member's open terminal: skipped with no backoff and no fetch. */
    heldByMember: [] as string[],
  };

  const storage = await getOrCreateStorage();

  // Find tasks needing sync — we need all non-terminal tasks and filter ourselves
  const tasks = await storage.listTasksWithOptions({ nonTerminalOnly: true });
  const pendingSyncTasks = tasks.filter(
    (t) => t.pending_sync > 0 && isSyncDispatchable(t.status) && !isLinkedTask(t),
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

    // A member working in the task's files: nothing to try until their
    // session ends. Not a failure — no backoff, no fetch, no counter bump,
    // nothing logged above debug. The sync stays queued and runs on the first
    // tick after they leave.
    if (memberInsideTask(task.id)) {
      result.heldByMember.push(shortTaskId);
      logger.debug(`Sync retry: ${shortTaskId} held by a member's terminal, waiting`);
      continue;
    }

    result.attempted.push(shortTaskId);

    try {
      const syncResult = await syncTask(projectRoot, { taskId: task.id, queueIfMemberInside: true, daemonLaunch: true });
      // The call answered, whatever it said: the run of throws is over.
      failureState.delete(task.id);

      if (syncResult.status === 'held_by_member') {
        // A member got in between the check above and the sync's lock.
        result.heldByMember.push(shortTaskId);
        logger.debug(`Sync retry: ${shortTaskId} held by a member's terminal, waiting`);
      } else if (syncResult.status === 'pending_sync') {
        // Fetch failed, or the usage pause held the conflict resolution the
        // merge needs — either way, retry later with a growing backoff.
        const attempt = backoff ? backoff.attempt + 1 : 0;
        const delay = calculateBackoffMs(attempt);
        backoffState.set(task.id, {
          nextRetryAt: now + delay,
          attempt,
          reason: syncResult.usagePauseHeld ? 'usage-pause' : 'fetch-failed',
        });
        result.backedOff.push(shortTaskId);
        // Said as what it is: a held sync is not a failed fetch, and a log that
        // called it one sent whoever read it after the network.
        const why = syncResult.usagePauseHeld
          ? 'held by the usage pause (its conflict needs an agent; it runs after the window resets)'
          : 'fetch failed';
        logger.info(`Sync retry: ${shortTaskId} ${why}, backoff ${Math.round(delay / 1000)}s (attempt ${attempt + 1})`);
      } else if (syncResult.status === 'up_to_date' || syncResult.status === 'sync_launched') {
        // Success — reset backoff
        backoffState.delete(task.id);
        result.succeeded.push(shortTaskId);
        logger.info(`Sync retry: ${shortTaskId} ${syncResult.status}`);

        // Post-sync check: if sync_launched, the counter was reset to 0 before launch.
        // New signals during merge will increment it again. The next tick will pick
        // those up once the merge completes and the task parks again — in the
        // status the sync found, which for a submitted task is `submitted`.
        // If up_to_date, counter is already 0. Either way, nothing more to do this tick.
      }
    } catch (err) {
      // syncTask throws RpcError for validation failures (e.g., task became working
      // between our check and the call). Log and skip — next tick will re-evaluate.
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Sync retry: ${shortTaskId} error: ${msg}`);
      result.skipped.push(shortTaskId);
      const previous = failureState.get(task.id);
      failureState.set(task.id, { failures: (previous?.failures ?? 0) + 1, lastError: msg, lastErrorAt: Date.now() });
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
  liveBackoffState.set(projectRoot, backoffState);
  const failureState = new Map<string, SyncFailureEntry>();
  liveFailureState.set(projectRoot, failureState);
  const health = daemonHealthRecorder(projectRoot);
  health.loopStarted(SYNC_RETRY_LOOP, intervalSeconds * 1_000);

  const doTick = async () => {
    if (stopped) return;
    if (running) {
      health.tickSkipped(SYNC_RETRY_LOOP); // Skip if previous tick still running
      return;
    }
    running = true;
    const tickStartedAt = Date.now();
    health.tickStarted(SYNC_RETRY_LOOP);
    let tickError: unknown;

    try {
      const result = await runSyncRetryTick(projectRoot, backoffState, failureState);

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
      tickError = err;
    } finally {
      health.tickFinished(SYNC_RETRY_LOOP, tickStartedAt, tickError);
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
    if (liveBackoffState.get(projectRoot) === backoffState) liveBackoffState.delete(projectRoot);
    if (liveFailureState.get(projectRoot) === failureState) liveFailureState.delete(projectRoot);
  };
}
