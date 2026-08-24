/**
 * Recovery for tasks stranded in `merging`.
 *
 * WHAT `merging` MEANS
 * --------------------
 * `merging` is a transient state owned by the accept orchestration
 * (src/daemon/task-lifecycle.ts). It is stamped in two very different
 * situations, told apart by the {@link ACCEPT_IN_FLIGHT_KEY} marker:
 *
 *  - **Local merge in flight** (marker PRESENT, carrying the status the task
 *    held before the accept). The accept process is doing the merge right now.
 *    Only that process clears the state — by completing, or by restoring the
 *    recorded prior status when it aborts.
 *  - **Remote merge pending** (marker ABSENT). `driver.merge()` handed the merge
 *    to the forge; the task waits there until the remote-sync reconciler sees
 *    the PR/MR merged or closed. This is a legitimate resting state and must
 *    never be swept.
 *
 * THE BUG THIS EXISTS FOR (fix-stranded-merging)
 * ----------------------------------------------
 * Nothing answered "is the owner still alive?". If the daemon died mid-accept —
 * restart, crash, OOM, `kill -9` — the marker and the `merging` status stayed on
 * disk with no process left to clear them, and every exit refused:
 * `reject`/`close` hit `Invalid status transition: 'merging' → 'abandoned'`,
 * `submit` hit its own blocked/conflict-only guard, and `reconcileTasks`
 * deliberately excluded `merging` from every sweep. One task in the field sat
 * wedged for two weeks.
 *
 * THE ANSWER
 * ----------
 * The daemon already serializes lifecycle mutations per task
 * ({@link isTaskLifecycleLocked}), and an accept holds that lock for its whole
 * orchestration. So "a `merging` task whose lifecycle lock is NOT held" is
 * exactly "a merge whose owner is gone" — no heartbeat, no timestamp guessing.
 * A dead daemon cannot hold an in-process lock, which is what makes this a
 * complete answer for the case that actually strands tasks.
 *
 * WHY NOT JUST ALLOW `merging` → `abandoned`
 * ------------------------------------------
 * Because a task genuinely mid-merge must NOT be abandonable — the transition
 * table is protecting a real in-flight operation there, and widening it would
 * trade a wedge for a corrupted half-merge. Recovery instead returns the task to
 * a real RESTING state and lets the ordinary transitions apply from it, so the
 * FSM keeps meaning what it says.
 */

import type { Storage } from '../storage';
import type { Actor, Task, TaskStatus } from '../types';
import { createDriver } from '../remote';
import { loadConfig } from '../config/loader';
import { pausedStatusFor } from '../utils/paused-status';
import { displayId } from '../cli/helpers';
import { logger } from '../utils/logger';
import { isTaskLifecycleLocked, tryWithTaskLifecycleLock } from './task-lifecycle-lock';
import { RpcError } from './rpc-error';

/**
 * Task metadata key marking a LOCAL merge phase that is in flight, carrying the
 * status the task held before the accept began.
 *
 * WHY: `merging` means two different things. On the remote path it means "the
 * forge has the merge, we are waiting" — a durable state a later accept
 * re-enters to ask the forge what happened. Stamping `merging` at the START of
 * the local merge phase (which is what makes status honest during the minutes
 * the merge actually takes) would make a CRASHED local merge look exactly like
 * that, sending the next accept down the remote re-entry path for a merge no
 * forge ever heard of. This marker distinguishes them, and doubles as the record
 * of what to restore to.
 */
export const ACCEPT_IN_FLIGHT_KEY = 'accept_in_flight_from';

/** The status a stranded merge was returned to, and how it was classified. */
export interface StrandedMergeRecovery {
  /** Status the task now holds. */
  status: TaskStatus;
  /** Prior status recorded by the in-flight marker, when there was one. */
  recordedPriorStatus: TaskStatus | null;
}

/**
 * Is an accept actively merging this task in this process right now?
 *
 * The one question recovery must get right: a live merge is untouchable, a dead
 * one is wreckage.
 */
export function mergeOwnerIsLive(taskId: string): boolean {
  return isTaskLifecycleLocked(taskId);
}

/**
 * The resting status a stranded merge belongs in.
 *
 * INVARIANT (violations-are-the-source-of-truth): pending file-permission
 * violations mean `conflict`, always — the label is DERIVED from the set, never
 * asserted independently of it (see src/utils/paused-status.ts and the
 * fix-ask-nukes-violations incident, where the two falling out of sync silently
 * destroyed committed agent work).
 *
 * INVARIANT (restore the TRUE prior status): with nothing owed, a task that was
 * `submitted` before the accept goes back to `submitted` — it has an open PR
 * awaiting review, and rewriting that to `blocked` loses a real signal. Any
 * other recorded prior status rests at `blocked`.
 */
export function strandedMergeRestingStatus(
  turns: Parameters<typeof pausedStatusFor>[0],
  recordedPriorStatus: TaskStatus | null,
): TaskStatus {
  const paused = pausedStatusFor(turns);
  if (paused === 'conflict') return 'conflict';
  return recordedPriorStatus === 'submitted' ? 'submitted' : 'blocked';
}

/**
 * Return a task stranded in `merging` to a real resting state.
 *
 * Callers MUST have established that no accept owns the merge — either by
 * holding the task's lifecycle lock, or via {@link mergeOwnerIsLive}. This
 * function does not re-check, because the only safe way to check is to hold the
 * lock while acting.
 *
 * `note` is recorded as a task comment so the recovery is visible in history
 * rather than being a silent status rewrite.
 */
export async function recoverStrandedMerge(
  storage: Storage,
  task: Task,
  actor: Actor,
  note: string,
): Promise<StrandedMergeRecovery> {
  const recorded = (task.metadata?.[ACCEPT_IN_FLIGHT_KEY] || null) as TaskStatus | null;

  let turns: Awaited<ReturnType<Storage['getSessionTurns']>> = [];
  try {
    const sess = await storage.getSessionByTaskId(task.id);
    if (sess) turns = await storage.getSessionTurns(sess.id);
  } catch (err) {
    // Same posture as parkTaskPaused: failing to read the violation set is not
    // fatal — we fall back to `blocked`, and the pending set (if any) is still
    // enforced at unblock. Recovering the task matters more than the label.
    logger.warn(
      `Task ${displayId(task)}: could not read violations while recovering a stranded merge — ` +
      `resting as 'blocked'. ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const status = strandedMergeRestingStatus(turns, recorded);
  await storage.updateTaskStatus(task.id, status, actor);
  // Clear the marker only AFTER the status write lands: the marker is what a
  // later accept (or another recovery) reads to know a local merge died, so it
  // must outlive any failure of the restore itself.
  await storage.updateTaskMetadata(task.id, ACCEPT_IN_FLIGHT_KEY, '');
  await storage.createComment(task.id, note, actor);

  return { status, recordedPriorStatus: recorded };
}

/**
 * Should the automatic sweep recover this `merging` task?
 *
 * The sweep is deliberately narrower than the on-demand escape a human gets from
 * reject/close/submit. A human asking to close a task has decided; the sweep is
 * acting on its own, so it only moves tasks that provably have no owner AND
 * nothing that could ever finish them:
 *
 *  - marker present → a local merge phase died. Recover.
 *  - marker absent, no remote driver → nobody handed this to a forge and no
 *    forge can complete it. It cannot be a legitimate remote-pending merge, so
 *    something stamped `merging` and died. Recover.
 *  - marker absent, remote driver configured → the forge owns the merge and
 *    remote-sync polls it. Leave it alone; `lazy doctor` reports it if it sits
 *    there, and the human can still escape it explicitly.
 */
export function shouldSweepStrandedMerge(opts: {
  hasInFlightMarker: boolean;
  remoteDriverCanFinishMerge: boolean;
}): boolean {
  return opts.hasInFlightMarker || !opts.remoteDriverCanFinishMerge;
}

/**
 * Sweep tasks stranded in `merging` back to a resting state.
 *
 * Runs on every reconcile tick, which means it also runs shortly after daemon
 * startup — the moment that matters most, since a daemon restart is the likeliest
 * way to kill an accept mid-merge.
 */
export async function sweepStrandedMerging(storage: Storage, lazyRoot: string): Promise<void> {
  const merging = await storage.listTasksWithOptions({ mergingOnly: true });
  if (merging.length === 0) return;

  let remoteDriverCanFinishMerge = false;
  try {
    const config = await loadConfig(lazyRoot);
    remoteDriverCanFinishMerge = createDriver(config).needsSync;
  } catch (err) {
    // Unreadable config or an unconstructable driver is not evidence that no
    // forge owns these merges. Assume one might, so the sweep only acts on
    // tasks carrying the in-flight marker.
    remoteDriverCanFinishMerge = true;
    logger.debug(`Stranded-merge sweep: could not resolve the remote driver: ${err instanceof Error ? err.message : err}`);
  }

  for (const task of merging) {
    try {
      // A live accept owns this merge — never touch it.
      if (mergeOwnerIsLive(task.id)) continue;

      const hasInFlightMarker = !!task.metadata?.[ACCEPT_IN_FLIGHT_KEY];
      if (!shouldSweepStrandedMerge({ hasInFlightMarker, remoteDriverCanFinishMerge })) continue;

      const recovery = await recoverStrandedMerge(
        storage,
        task,
        'system',
        `[Recovered] The accept that put this task in 'merging' is no longer running, so nothing could ` +
        `finish or undo the merge. Returned to '${await previewRestingStatus(storage, task)}' — accept, ` +
        `unblock, submit, reject or close it as usual.`,
      );
      logger.warn(
        `Task ${displayId(task)}: recovered from a stranded 'merging' state to '${recovery.status}' ` +
        `(no accept in flight${recovery.recordedPriorStatus ? `; local merge died from '${recovery.recordedPriorStatus}'` : '; no merge was handed to a forge'}).`,
      );
    } catch (err) {
      logger.warn(`Stranded-merge recovery failed for ${displayId(task)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** The status {@link recoverStrandedMerge} will pick, for use in its own comment text. */
async function previewRestingStatus(storage: Storage, task: Task): Promise<TaskStatus> {
  try {
    const sess = await storage.getSessionByTaskId(task.id);
    const turns = sess ? await storage.getSessionTurns(sess.id) : [];
    return strandedMergeRestingStatus(turns, (task.metadata?.[ACCEPT_IN_FLIGHT_KEY] || null) as TaskStatus | null);
  } catch {
    // Only used to phrase a comment; the authoritative pick happens in
    // recoverStrandedMerge, which logs its own fallback.
    return 'blocked';
  }
}

/**
 * On-demand escape from `merging` for a human-initiated operation
 * (reject / close / submit / unblock).
 *
 * Returns the task unchanged when it is not `merging`. Otherwise:
 *
 *  - a live accept owns the merge → refuse with an actionable 409. Interrupting
 *    a real merge is the one outcome worse than the wedge.
 *  - nothing owns it → recover to a resting state and return the refreshed task,
 *    so the caller's ordinary transition applies from a state the FSM allows.
 *
 * Unlike {@link sweepStrandedMerging} this does NOT exempt a forge-pending merge:
 * the human has explicitly asked to close/reject/submit THIS task and is entitled
 * to act on it. The automatic sweep is the cautious one; a direct instruction is
 * not second-guessed.
 */
export async function escapeMergingForOperation(
  storage: Storage,
  task: Task,
  actor: Actor,
  operation: string,
): Promise<Task> {
  if (task.status !== 'merging') return task;

  const attempt = await tryWithTaskLifecycleLock(task.id, async () => {
    // Re-read under the lock: an accept may have finished (or aborted) between
    // the caller's read and our acquisition, in which case there is nothing to
    // recover and the caller should act on the real current status.
    const fresh = (await storage.getTask(task.id)) ?? task;
    if (fresh.status !== 'merging') return fresh;

    await recoverStrandedMerge(
      storage,
      fresh,
      actor,
      `[Recovered] \`lazy ${operation}\` found this task stranded in 'merging' with no accept running. ` +
      `The merge that stamped it is gone, so the task was returned to a resting state and ${operation} proceeded.`,
    );
    return (await storage.getTask(task.id)) ?? fresh;
  });

  if (!attempt.ran) {
    throw new RpcError(
      409,
      `Task ${displayId(task)} is merging right now — an accept is actively merging it in this daemon, ` +
      `so ${operation} would interrupt a merge in progress. Wait for the accept to finish ` +
      `(\`lazy show ${displayId(task)}\` reports the resulting status), then run ${operation} again.`,
    );
  }
  return attempt.value;
}
