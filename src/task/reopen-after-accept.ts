/**
 * The store's record that an accept was SUPERSEDED by a reopen.
 *
 * The reconciler's zombie sweep heals a task whose accept merged but whose
 * store write was lost, and it recognises one by the accept tag. A task a
 * person reopened after an accept carries that same tag — it is never deleted —
 * so without this record the sweep re-ended the reopened session as `accepted`
 * and flipped the task back to `complete` one tick after the reopen.
 *
 * Reopen writes the accept commit it supersedes here; the sweep treats a tag
 * still pointing at that commit as SPENT. A later accept moves the tag
 * (`git tag -f`) to a new commit, which no longer matches, so the sweep heals
 * a crash of THAT accept normally. The store answers whether an accept is
 * current — git only supplies the SHA, never a subject match.
 */

import type { Storage } from '../storage';

export const REOPENED_AFTER_ACCEPT_KEY = 'reopened_after_accept';

export interface ReopenedAfterAccept {
  /** The accept commit (accept tag target) this reopen superseded. */
  accept_commit: string;
  reopened_at: string;
}

export async function recordReopenAfterAccept(
  storage: Storage,
  taskId: string,
  acceptCommit: string,
  now: Date = new Date(),
): Promise<void> {
  const record: ReopenedAfterAccept = { accept_commit: acceptCommit, reopened_at: now.toISOString() };
  await storage.updateTaskMetadata(taskId, REOPENED_AFTER_ACCEPT_KEY, JSON.stringify(record));
}

export function parseReopenedAfterAccept(raw: string | null): ReopenedAfterAccept | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReopenedAfterAccept>;
    if (typeof parsed.accept_commit === 'string' && parsed.accept_commit && typeof parsed.reopened_at === 'string') {
      return { accept_commit: parsed.accept_commit, reopened_at: parsed.reopened_at };
    }
    return null;
  } catch {
    // Not a record this build wrote — treated as no record (the sweep then
    // behaves as it always did), never as a spent accept.
    return null;
  }
}

export async function readReopenedAfterAccept(storage: Storage, taskId: string): Promise<ReopenedAfterAccept | null> {
  return parseReopenedAfterAccept(await storage.getTaskMetadata(taskId, REOPENED_AFTER_ACCEPT_KEY));
}

/** Pure decision: was the accept at `acceptCommit` superseded by a reopen? */
export function isAcceptSpent(acceptCommit: string, record: ReopenedAfterAccept | null): boolean {
  return record !== null && record.accept_commit === acceptCommit;
}

/** The record on a task already loaded, for display surfaces. */
export function reopenedAfterAcceptOf(task: { metadata?: Record<string, string> | null }): ReopenedAfterAccept | null {
  return parseReopenedAfterAccept(task.metadata?.[REOPENED_AFTER_ACCEPT_KEY] ?? null);
}

/**
 * One line for `lazy show` and the web page, so a reader is not confused by the
 * older accept tag still in the repository. Null once a later accept exists —
 * the caller passes `status === 'complete'` to say so.
 */
export function reopenedAfterAcceptLine(task: { status: string; metadata?: Record<string, string> | null }): string | null {
  if (task.status === 'complete') return null;
  const rec = reopenedAfterAcceptOf(task);
  return rec ? `reopened after accept at ${rec.accept_commit.slice(0, 8)} (${rec.reopened_at})` : null;
}
