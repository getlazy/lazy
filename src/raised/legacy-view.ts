/**
 * The pre-unification follow-up shape, in ONE place.
 *
 * Two jobs, and no others:
 *
 *  1. **Reading** what is already on disk. `follow-ups.json` files written
 *     before unification hold `LegacyFollowUpRecord`; the migration parses that
 *     shape and converts it (see `migrateFollowUpsToRaisedItems`).
 *  2. **Answering Lazy Teams.** The Rails app still calls the daemon's
 *     `getTaskFollowUps` / `listFollowUps` / `triageFollowUp` /
 *     `promoteFollowUp` RPC methods. Those are adapters over raised items now,
 *     and they project back through `toFollowUpView` so Teams keeps rendering
 *     until it is ported.
 *
 * Nothing else in lazy may import this: the domain has one entity, `RaisedItem`.
 * When Teams is ported, delete this file and the four RPC adapters with it.
 *
 * See docs/design/raised-items-unified.md.
 */

import type { Actor, FollowUpTriageStatus, RaisedItem, RaisedItemStatus } from '../types';

/** A record as stored in a pre-unification `follow-ups.json`. */
export interface LegacyFollowUpRecord {
  id: string;
  task_id: string;
  content: string;
  created_at: number;
  title?: string;
  explanation?: string;
  proposed_code?: string;
  proposed_prompt?: string;
  session_id?: string | null;
  triage_status?: FollowUpTriageStatus;
  triaged_at?: number;
  triaged_by?: Actor;
  triage_note?: string | null;
  promoted_task_id?: string;
  promoted_task_code?: string;
}

/** Internal format for a pre-unification `follow-ups.json`. */
export interface LegacyFollowUpsFile {
  follow_ups: LegacyFollowUpRecord[];
}

/** What the deprecated RPC methods return to Lazy Teams. */
export type FollowUpView = LegacyFollowUpRecord;

/**
 * The triage state a raised item's status corresponds to.
 *
 * `responded` maps to `acknowledged`: from a follow-up reader's point of view a
 * response is a human decision that dispatched no task, which is exactly what
 * acknowledge meant. There is no follow-up state for "answered but still open",
 * and reporting it as `open` would show Teams a decided item as undecided.
 */
export function triageStatusForRaised(status: RaisedItemStatus): FollowUpTriageStatus {
  switch (status) {
    case 'promoted_subtask':
    case 'promoted_peer':
      return 'promoted';
    case 'dismissed':
      return 'dismissed';
    case 'acknowledged':
    case 'responded':
    case 'answered':
      return 'acknowledged';
    case 'open':
      return 'open';
  }
}

/** Project a raised item back into the follow-up shape Teams still reads. */
export function toFollowUpView(item: RaisedItem): FollowUpView {
  const triage = triageStatusForRaised(item.status);
  return {
    id: item.id,
    task_id: item.task_id,
    content: item.content,
    created_at: item.created_at,
    ...(item.title ? { title: item.title } : {}),
    ...(item.explanation ? { explanation: item.explanation } : {}),
    ...(item.proposed_code ? { proposed_code: item.proposed_code } : {}),
    ...(item.proposed_prompt ? { proposed_prompt: item.proposed_prompt } : {}),
    ...(item.session_id !== undefined ? { session_id: item.session_id } : {}),
    ...(triage === 'open' ? {} : { triage_status: triage }),
    ...(item.resolved_at !== undefined ? { triaged_at: item.resolved_at } : {}),
    ...(item.resolved_by ? { triaged_by: item.resolved_by } : {}),
    ...(item.resolution !== undefined && item.resolution !== null
      ? { triage_note: item.resolution }
      : {}),
    ...(item.promoted_task_id ? { promoted_task_id: item.promoted_task_id } : {}),
    ...(item.promoted_task_code ? { promoted_task_code: item.promoted_task_code } : {}),
  };
}
