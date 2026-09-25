/**
 * The status a SYNC turn restores when it ends.
 *
 * A sync is a side-channel turn: it merges upstream into the task branch and
 * changes nothing about where the task stands with its reviewer. It moves the
 * task through `working` only because the merge (and any conflict resolution)
 * needs an agent turn — so when it ends, the task belongs back in the status the
 * sync FOUND, exactly as an `ask` turn restores its `restore_status` and a failed
 * acceptance gate restores the status the accept began from.
 *
 * WHY THIS EXISTS: sync recorded no such status, so the reconciler's end-of-turn
 * park sent every synced task to `blocked`. A `submitted` task — one with an open
 * PR waiting for review — therefore left `submitted` on any sync, manual or
 * automatic. It dropped out of the submitted view, and PR-comment auto-react,
 * which is gated on `submitted`, stopped reacting to the review comments the task
 * existed to receive.
 *
 * ONLY `submitted` IS RESTORED, and the other three dispatchable statuses are
 * deliberately not:
 *   - `blocked` / `conflict` are the paused label, DERIVED from the pending
 *     violation set on every park (see src/utils/paused-status.ts). Recording
 *     them and writing them back would assert a label the derivation owns, which
 *     is the bug `violations-are-the-source-of-truth` exists to prevent — and a
 *     derived `conflict` therefore WINS over a restored `submitted`: a sync can
 *     merge a protected file in, and the reviewer still owes that decision.
 *   - `interrupted` means "the agent died, resume it". A completed sync is
 *     positive evidence the worktree is healthy (the same path resets the
 *     interruption counter), so restoring it would re-arm auto-resume over a
 *     turn that succeeded.
 *
 * THE MARKER NAMES ITS OWN TURN, and that is what makes it safe to leave lying
 * around. It stores the sync COMMAND ID next to the status, and a reader gets
 * the status back only when the turn it is parking carries that same id.
 *
 * An earlier revision stored the status alone and relied on "only a sync's own
 * park ever reads it". That was false: the crash reader
 * (`handleErrorResponse`) deliberately sees EVERY turn type, so a marker left
 * behind by a sync that died without a response — a killed supervisor, or a
 * throw between the marker write and the command write — could be picked up by
 * a completely unrelated WORK turn crashing fatally some turns later, and park
 * `submitted` on a task nobody had submitted: in the review queue, on
 * PR-comment auto-react, with no PR behind it. The id closes that window
 * entirely rather than narrowing it, which clearing-on-every-launch would only
 * have done.
 *
 * Consequences of the id, all deliberate:
 *   - A mismatched read changes NOTHING — it does not clear the marker either,
 *     because a marker that is not yours may still be owed to its own turn.
 *   - A leftover marker is inert for as long as it lives: its id names a command
 *     that is over, and no future turn can present it. The next sync launch
 *     overwrites it.
 *   - A response with NO command id (version skew from an older supervisor) is
 *     never a match, so the restore is skipped. Losing a restore is the safe
 *     direction; asserting `submitted` on the strength of an unidentified turn
 *     is not.
 */

import type { CommandId } from '../protocol';
import type { Storage } from '../storage';
import type { TaskStatus } from '../types';
import { logger } from '../utils/logger';

/**
 * Task metadata key holding the status a sync turn in flight must restore, and
 * the id of the sync command that must be the one ending for it to apply. Same
 * marker shape as `accept_in_flight_from` (src/daemon/stranded-merge.ts), with
 * the id added — see the module doc for what that id prevents.
 */
export const SYNC_RESTORE_STATUS_KEY = 'sync_restore_status';

/** The statuses a sync turn restores. See the module doc for why it is only this one. */
export type SyncRestorableStatus = Extract<TaskStatus, 'submitted'>;

/** Is this a status a sync turn should put back when it ends? */
export function isSyncRestorable(status: string): status is SyncRestorableStatus {
  return status === 'submitted';
}

/** What the marker holds: a status, and the one turn allowed to claim it. */
interface SyncRestoreMarker {
  status: SyncRestorableStatus;
  command_id: CommandId;
}

/**
 * Parse a stored marker, tolerating anything that is not one.
 *
 * Returns null for an empty key, for a value written by a build that stored the
 * bare status with no id, and for any shape that is no longer restorable. Each
 * of those means the same thing to a caller — there is nothing here you may
 * claim — so none of them is an error.
 */
function parseMarker(raw: string | null): SyncRestoreMarker | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A bare status string from an older build. Not an error and not a match:
    // it names no turn, so nobody can claim it. See the module doc.
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { status, command_id: commandId } = parsed as Record<string, unknown>;
  if (typeof status !== 'string' || !isSyncRestorable(status)) return null;
  if (typeof commandId !== 'string' || commandId === '') return null;
  return { status, command_id: commandId };
}

/**
 * Record the status a launching sync turn found, against the command that turn
 * will run, so its park can put the status back.
 *
 * Writes the marker for a restorable status and CLEARS it for anything else —
 * clearing matters as much as writing: the launch is the one moment that knows
 * this sync's starting point, and leaving a previous sync's value in place would
 * hand a reader something to find that this launch never vouched for.
 *
 * Call it as late in the dispatch as possible — right before the command is
 * written — so a launch that throws on the way there leaves nothing at all.
 *
 * Never throws: failing to record the marker costs the restore (the task parks
 * `blocked`, exactly as it did before this existed), and must not fail the sync.
 */
export async function markSyncRestoreStatus(
  storage: Storage,
  taskId: string,
  priorStatus: TaskStatus,
  commandId: CommandId,
): Promise<void> {
  const value: string = isSyncRestorable(priorStatus)
    ? JSON.stringify({ status: priorStatus, command_id: commandId } satisfies SyncRestoreMarker)
    : '';
  try {
    await storage.updateTaskMetadata(taskId, SYNC_RESTORE_STATUS_KEY, value);
  } catch (err) {
    logger.warn(
      `Task ${taskId.substring(0, 8)}: could not record the status to restore after the sync ` +
      `('${priorStatus}') — the sync will park the task as usual. ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Drop the marker: this sync is not going to park the task, so nothing is owed.
 * Used when a launch fails after the marker was written and puts the status back
 * itself. Never throws, for the same reason {@link markSyncRestoreStatus} does not.
 */
export async function clearSyncRestoreStatus(storage: Storage, taskId: string): Promise<void> {
  try {
    await storage.updateTaskMetadata(taskId, SYNC_RESTORE_STATUS_KEY, '');
  } catch (err) {
    logger.warn(
      `Task ${taskId.substring(0, 8)}: could not clear the sync restore marker. ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Claim the status a marker owes to THIS turn, identified by the command id the
 * ending turn carries, and clear it.
 *
 * Returns null — changing nothing — when there is no marker, when it names a
 * different command, or when the caller has no id to present (an unidentified
 * turn never matches; see the module doc). A marker that is not yours is LEFT IN
 * PLACE: it may still be owed to the turn it names.
 */
export async function consumeSyncRestoreStatus(
  storage: Storage,
  taskId: string,
  commandId: CommandId | undefined,
): Promise<SyncRestorableStatus | null> {
  if (!commandId) return null;
  let raw: string | null = null;
  try {
    raw = await storage.getTaskMetadata(taskId, SYNC_RESTORE_STATUS_KEY);
  } catch (err) {
    logger.warn(
      `Task ${taskId.substring(0, 8)}: could not read the status to restore after the sync — ` +
      `parking as usual. ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  const marker = parseMarker(raw);
  if (!marker || marker.command_id !== commandId) return null;

  try {
    await storage.updateTaskMetadata(taskId, SYNC_RESTORE_STATUS_KEY, '');
  } catch (err) {
    // The answer is already in hand; a failed clear leaves an inert marker whose
    // command is over, so restore anyway rather than dropping a real restore.
    logger.warn(
      `Task ${taskId.substring(0, 8)}: could not clear the sync restore marker after claiming ` +
      `it ('${marker.status}'). ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return marker.status;
}
