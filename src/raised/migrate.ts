/**
 * Follow-up → raised-item conversion, and read-repair of pre-flag records.
 *
 * Pure functions: the storage backend owns reading, writing and renaming files.
 * Keeping the conversion here means the FileStorage migration and its unit
 * tests exercise the same code, and a future backend gets it for free.
 *
 * See docs/design/raised-items-unified.md.
 */

import type { RaisedItem } from '../types';
import type { LegacyFollowUpRecord } from './legacy-view';

/** Thrown for a record the migration refuses to guess about. */
export class FollowUpConversionError extends Error {
  constructor(
    readonly followUpId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'FollowUpConversionError';
  }
}

/**
 * Convert one stored follow-up into a raised item.
 *
 * INVARIANT: the id is PRESERVED. Every existing link, search hit, promotion
 * hint and Teams reference resolves through it; a fresh id would silently orphan
 * all of them.
 *
 * INVARIANT: a converted resolution never gets a `pending_comment`. Follow-up
 * triage never scheduled one, and inventing one would post a comment to the
 * agent long after the fact.
 *
 * Throws `FollowUpConversionError` rather than guessing — an unconvertible
 * record is reported and left on disk.
 */
export function raisedItemFromFollowUp(
  record: LegacyFollowUpRecord,
  taskId: string,
): RaisedItem {
  if (!record || typeof record !== 'object') {
    throw new FollowUpConversionError(undefined, 'record is not an object');
  }
  if (typeof record.id !== 'string' || !record.id) {
    throw new FollowUpConversionError(undefined, 'record has no id');
  }
  const content = typeof record.content === 'string' ? record.content : '';
  if (!content.trim() && !record.title?.trim()) {
    throw new FollowUpConversionError(record.id, 'record has neither content nor title');
  }
  if (typeof record.created_at !== 'number' || !Number.isFinite(record.created_at)) {
    throw new FollowUpConversionError(record.id, 'record has no usable created_at');
  }

  const triage = record.triage_status ?? 'open';
  let status: RaisedItem['status'];
  switch (triage) {
    case 'open':
      status = 'open';
      break;
    case 'acknowledged':
      status = 'acknowledged';
      break;
    case 'dismissed':
      status = 'dismissed';
      break;
    case 'promoted':
      // A follow-up promotion always created a task under the ORIGINATING
      // task's parent — a peer, in the unified vocabulary.
      status = 'promoted_peer';
      break;
    default:
      throw new FollowUpConversionError(
        record.id,
        `unrecognized triage_status '${String(triage)}'`,
      );
  }

  const resolved = status !== 'open';

  return {
    id: record.id,
    task_id: record.task_id || taskId,
    content: content.trim() ? content : record.title!.trim(),
    // Every follow-up was orthogonal by definition — none of them ever gated.
    blocking: false,
    ...(record.title ? { title: record.title } : {}),
    ...(record.explanation ? { explanation: record.explanation } : {}),
    ...(record.proposed_code ? { proposed_code: record.proposed_code } : {}),
    ...(record.proposed_prompt ? { proposed_prompt: record.proposed_prompt } : {}),
    created_at: record.created_at,
    ...(record.session_id !== undefined ? { session_id: record.session_id } : {}),
    status,
    ...(resolved && typeof record.triaged_at === 'number'
      ? { resolved_at: record.triaged_at }
      : {}),
    ...(resolved && record.triaged_by ? { resolved_by: record.triaged_by } : {}),
    ...(resolved && record.triage_note !== undefined && record.triage_note !== null
      ? { resolution: record.triage_note }
      : {}),
    ...(record.promoted_task_id ? { promoted_task_id: record.promoted_task_id } : {}),
    ...(record.promoted_task_code ? { promoted_task_code: record.promoted_task_code } : {}),
    migrated_from: 'follow_up',
  };
}

/**
 * Read-repair a raised item loaded from disk.
 *
 * Records written before the flag existed have no `blocking`: they are read as
 * `true`, because `raised-items.json` only ever held accept-gating items. A
 * stray `promoted` status (never written by lazy, but cheap to tolerate) is
 * normalized to `promoted_peer`.
 */
export function repairStoredRaisedItem(raw: RaisedItem): RaisedItem {
  const item = raw as RaisedItem & { status?: string };
  const repaired: RaisedItem = {
    ...raw,
    blocking: typeof raw.blocking === 'boolean' ? raw.blocking : true,
  };
  if ((item.status as string) === 'promoted') {
    repaired.status = 'promoted_peer';
  }
  if (!repaired.status) {
    repaired.status = 'open';
  }
  return repaired;
}
