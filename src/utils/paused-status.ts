/**
 * Parking a task in its correct PAUSED status.
 *
 * A paused task is either `blocked` (nothing owed) or `conflict` (the reviewer
 * still owes an approval decision, at accept, on file-permission violations).
 *
 * INVARIANT (violations-are-the-source-of-truth — fix-ask-nukes-violations):
 * `conflict` is DERIVED from the pending violation set; it is never asserted or
 * cleared independently of it. Every path that parks a task as paused —
 * reconciler turn completion, sync completion, fatal-failure park, stranded
 * recovery, pairing teardown, auto-deliver rollback, `lazy stop` — must go
 * through here rather than writing `'blocked'` directly.
 *
 * A side-channel turn may additionally have a status of its OWN to put back that
 * this derivation does not describe — a sync turn that found the task `submitted`
 * passes it as `restore`, and it applies only when nothing is owed on protected
 * files. See src/task/sync-restore-status.ts.
 *
 * WHY: a dozen call sites wrote `'blocked'` unconditionally, while the only
 * enforcement that matters (the accept gate) reads the violation set. The two
 * fell out of sync the moment ANY side-channel turn finished on a `conflict`
 * task — a `lazy ask` whose response the reconciler flushed, a `lazy sync`, the
 * end of a `lazy pair` session. The task then read `blocked` while violations
 * were still pending, so every surface that shows the reviewer what they owe
 * showed nothing. Deriving the label from the set is what keeps the reviewer's
 * view and the accept gate on one truth.
 */

import type { Storage } from '../storage';
import type { FileViolation, TaskStatus } from '../types';
import type { ActorInput } from '../types';
import type { SyncRestorableStatus } from '../task/sync-restore-status';
import { outstandingFromRecords } from '../protection/outstanding';
import { logger } from './logger';

/** The paused status a task with this violation state belongs in. */
export type PausedStatus = Extract<TaskStatus, 'blocked' | 'conflict'>;

/**
 * Derive the paused status from a session's turns plus (optionally) the set a
 * turn just re-detected.
 *
 * Both sources are unioned rather than letting the fresh set win: a turn that
 * ran no permission check at all (an ask, a sync, a pairing session) reports
 * nothing, and "reported nothing" must never be read as "there is nothing".
 * Equally, a turn that DID re-detect violations owns them even before they are
 * written to a turn.
 *
 * INVARIANT (an empty later re-detect cannot clear an earlier pending file —
 * move-file-approval-to-accept): the records are read ACROSS ALL TURNS, latest
 * decision per file (`outstandingFromRecords`), never off the single latest
 * violation turn. Since the decision moved to accept, a conflict task runs many
 * turns before anyone decides, and a later turn that touches no protected file
 * records `violations: []` — which, read as the whole story, silently parked the
 * task `blocked` with a protected edit still in the diff and nobody told.
 *
 * This is the CONSERVATIVE half of the answer: it can keep saying `conflict`
 * after the agent itself reverted the file. The whole-branch scan behind
 * `resolveOutstandingViolations` is what settles that, and callers with a
 * project root pass its result in as `outstanding`.
 */
export function pausedStatusFor(
  turns: Parameters<typeof outstandingFromRecords>[0],
  detected?: FileViolation[],
  outstanding?: FileViolation[],
): PausedStatus {
  if (outstanding !== undefined) {
    return outstanding.length > 0 || (detected?.length ?? 0) > 0 ? 'conflict' : 'blocked';
  }
  if (detected && detected.length > 0) return 'conflict';
  return outstandingFromRecords(turns).length > 0 ? 'conflict' : 'blocked';
}

/**
 * Park `taskId` as paused, choosing `conflict` or `blocked` from its pending
 * violation set. Returns the status actually written.
 *
 * `detected` is the violation set the just-finished turn re-detected, when the
 * caller has one. Omit it for turns that ran no permission check — omitting is
 * NOT the same as passing `[]`, and neither one can clear a pending set.
 *
 * `projectRoot`, when given, upgrades the answer from the recorded set to the
 * whole-branch scan — which is the only thing that can tell "the agent reverted
 * it" from "the last turn did not look at it". Pass it wherever it is in scope.
 *
 * `restore` is for a SIDE-CHANNEL turn that must put back a status this
 * derivation does not describe — today only a sync turn restoring `submitted`
 * (see src/task/sync-restore-status.ts). It applies ONLY when the derivation says
 * `blocked`: a derived `conflict` always wins, because the reviewer's pending
 * violation set outranks a restored label and `conflict` may never be cleared by
 * anything other than the derivation.
 *
 * Failure to read the turns is not fatal: we fall back to `blocked`, which is
 * exactly the behaviour every one of these call sites had before, and log it.
 */
export async function parkTaskPaused(
  storage: Storage,
  taskId: string,
  actor: ActorInput,
  opts: {
    sessionId?: string;
    detected?: FileViolation[];
    projectRoot?: string;
    restore?: SyncRestorableStatus | null;
  } = {},
): Promise<PausedStatus | SyncRestorableStatus> {
  let status: PausedStatus = 'blocked';
  try {
    const sess = await storage.getSessionByTaskId(taskId);
    const sessionId = opts.sessionId ?? sess?.id;
    const turns = sessionId ? await storage.getSessionTurns(sessionId) : [];
    let outstanding: FileViolation[] | undefined;
    const task = opts.projectRoot ? await storage.getTask(taskId) : null;
    if (opts.projectRoot && task && sess) {
      // Lazy import: paused-status is reached from the CLI too, and the daemon
      // resolver pulls in config + git. The fallback inside it never throws.
      const { resolveOutstandingViolations } = await import('../protection/outstanding-resolver');
      outstanding = (await resolveOutstandingViolations(opts.projectRoot, task, sess, turns, storage)).outstanding;
    }
    status = pausedStatusFor(turns, opts.detected, outstanding);
  } catch (err) {
    logger.warn(
      `Task ${taskId.substring(0, 8)}: could not read violations while parking the task — ` +
      `parking as 'blocked'. A pending violation set (if any) is still enforced at unblock. ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parked: PausedStatus | SyncRestorableStatus =
    status === 'blocked' && opts.restore ? opts.restore : status;
  await storage.updateTaskStatus(taskId, parked, actor);
  return parked;
}
