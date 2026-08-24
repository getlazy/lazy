/**
 * Parking a task in its correct PAUSED status.
 *
 * A paused task is either `blocked` (nothing owed) or `conflict` (the reviewer
 * still owes an approve/revert decision on file-permission violations).
 *
 * INVARIANT (violations-are-the-source-of-truth — fix-ask-nukes-violations):
 * `conflict` is DERIVED from the pending violation set; it is never asserted or
 * cleared independently of it. Every path that parks a task as paused —
 * reconciler turn completion, sync completion, fatal-failure park, stranded
 * recovery, pairing teardown, auto-deliver rollback, `lazy stop` — must go
 * through here rather than writing `'blocked'` directly.
 *
 * WHY: a dozen call sites wrote `'blocked'` unconditionally, while the only
 * enforcement that matters (the revert in `launchUnblockTask`) reads the
 * violation set. The two fell out of sync the moment ANY side-channel turn
 * finished on a `conflict` task — a `lazy ask` whose response the reconciler
 * flushed, a `lazy sync`, the end of a `lazy pair` session. The task then read
 * `blocked` while violations were still pending, which made the state
 * unexpressible: the reviewer surfaces refused `approved_files` ("this task has
 * no violations") and the daemon then reverted the unapproved files anyway,
 * silently destroying committed agent work. Deriving the label from the set is
 * what keeps the reviewer's view and the daemon's enforcement on one truth.
 */

import type { Storage } from '../storage';
import type { FileViolation, TaskStatus } from '../types';
import type { Actor } from '../types';
import { pendingViolations } from './turns';
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
 */
export function pausedStatusFor(
  turns: Parameters<typeof pendingViolations>[0],
  detected?: FileViolation[],
): PausedStatus {
  if (detected && detected.length > 0) return 'conflict';
  return pendingViolations(turns).length > 0 ? 'conflict' : 'blocked';
}

/**
 * Park `taskId` as paused, choosing `conflict` or `blocked` from its pending
 * violation set. Returns the status actually written.
 *
 * `detected` is the violation set the just-finished turn re-detected, when the
 * caller has one. Omit it for turns that ran no permission check — omitting is
 * NOT the same as passing `[]`, and neither one can clear a pending set.
 *
 * Failure to read the turns is not fatal: we fall back to `blocked`, which is
 * exactly the behaviour every one of these call sites had before, and log it.
 */
export async function parkTaskPaused(
  storage: Storage,
  taskId: string,
  actor: Actor,
  opts: { sessionId?: string; detected?: FileViolation[] } = {},
): Promise<PausedStatus> {
  let status: PausedStatus = 'blocked';
  try {
    let sessionId = opts.sessionId;
    if (!sessionId) {
      const sess = await storage.getSessionByTaskId(taskId);
      sessionId = sess?.id;
    }
    const turns = sessionId ? await storage.getSessionTurns(sessionId) : [];
    status = pausedStatusFor(turns, opts.detected);
  } catch (err) {
    logger.warn(
      `Task ${taskId.substring(0, 8)}: could not read violations while parking the task — ` +
      `parking as 'blocked'. A pending violation set (if any) is still enforced at unblock. ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await storage.updateTaskStatus(taskId, status, actor);
  return status;
}
