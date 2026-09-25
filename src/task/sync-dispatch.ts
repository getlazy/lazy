/**
 * The statuses a sync turn may be dispatched from.
 *
 * ONE list, read by both halves of sync, because they drifted: `syncTaskRun`'s
 * in-lock whitelist has accepted `submitted` for as long as a submitted task
 * could be synced at all, while the daemon's retry loop kept its own set of
 * three and silently skipped them. That was harmless only because a synced task
 * always landed back in `blocked`, so the retry loop caught its `pending_sync`
 * on the next tick under a different label. Once a sync RESTORES `submitted`
 * (src/task/sync-restore-status.ts) that is no longer true: a submitted task
 * whose upstream fetch failed would hold a `pending_sync` counter nobody drains,
 * and fall quietly behind its parent with its PR still open.
 *
 * A WHITELIST, never a blacklist of the busy ones — see the note at the
 * dispatch site. `pairing` and `merging` are both reachable while sync is
 * resolving refs, and neither has a `→ working` edge in `TASK_TRANSITIONS`, so
 * a blacklist would bind a turn credential and then die on an invalid
 * transition for a turn that never launches.
 *
 * Zero imports beyond the status type, deliberately: this is the home of the
 * rule, and both a daemon lifecycle module and the retry loop read it.
 */

import type { TaskStatus } from '../types';

/** A status sync may launch a turn from: the agent is not running, the worktree is idle. */
export type SyncDispatchableStatus = Extract<
  TaskStatus,
  'blocked' | 'conflict' | 'submitted' | 'interrupted'
>;

export const SYNC_DISPATCHABLE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'blocked',
  'conflict',
  'submitted',
  'interrupted',
]);

/**
 * Can a sync turn be dispatched from this status?
 *
 * A type guard, not a plain boolean: the dispatch site narrows `task.status` off
 * this call, exactly as the hand-written comparison chain it replaced did.
 */
export function isSyncDispatchable(status: TaskStatus): status is SyncDispatchableStatus {
  return SYNC_DISPATCHABLE_STATUSES.has(status);
}
