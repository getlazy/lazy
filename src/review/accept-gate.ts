/**
 * "Before you can accept" — what stands between a task and accept, as DATA.
 *
 * One builder, two renderers: the daemon's Current review tab renders these
 * rows as HTML, and the `show` RPC serves them as `acceptGate` so Lazy Teams
 * renders the same rows without re-deriving a rule it cannot review. The row
 * TEXT is composed here too, so the two surfaces cannot word a gate
 * differently; each surface only decides where a row links.
 *
 * Disclosure only — naming a gate here does not change whether accept
 * succeeds. The daemon's accept still refuses on its own reading; this list
 * says why, and where to go to clear it.
 */

import type { FileViolation, RaisedItem, Turn } from '../types';
import { reviewSettingsOf } from './mode';
import {
  GATING_REVIEW_CONTEXT,
  reviewIssuesAwaitingWork,
  type ReviewTurnLike,
} from './success';
import { describeReviewFailureShort, reviewWasNeverDispatched } from './verdict';

export type AcceptGateRow =
  | {
      kind: 'review';
      /** The review turn holding the gate. */
      sequence: number;
      /** Whole sentence, plain text — every surface escapes it itself. */
      label: string;
      /**
       * False when the review never RAN: it has no findings for an agent to
       * address, so "Unblock to address" would be advice that cannot work.
       */
      unblockable: boolean;
    }
  | { kind: 'raised'; raisedId: string; label: string }
  | { kind: 'file'; file: string; label: string }
  /**
   * Comments a human wrote that no prompt has carried yet. Accept refuses on
   * these (without `--allow-queued-comments`): merging would end the task
   * with that feedback never read.
   */
  | { kind: 'comments'; count: number; label: string };

export interface AcceptGate {
  rows: AcceptGateRow[];
}

/** Stored turns in the shape the review gate reads — the same shape accept uses. */
export function acceptGateTurns(turns: Pick<Turn, 'sequence' | 'role' | 'turn_type' | 'review' | 'timestamp' | 'review_dispatch' | 'review_addressed'>[]): ReviewTurnLike[] {
  return turns.map((t) => ({
    sequence: t.sequence,
    role: t.role,
    turn_type: t.turn_type,
    review: t.review,
    created_at: t.timestamp,
    ...(t.review_dispatch !== undefined ? { review_dispatch: t.review_dispatch } : {}),
    ...(t.review_addressed ? { review_addressed: true } : {}),
  }));
}

export function buildAcceptGate(input: {
  turns: ReviewTurnLike[];
  raisedItems: RaisedItem[];
  fileViolations: FileViolation[];
  taskMetadata: Record<string, string> | null | undefined;
  /**
   * Human feedback the agent has not been shown — `queuedHumanFeedbackCount`
   * (src/task/queued-feedback.ts), the same count accept refuses on. Counted
   * by the caller, which already holds the comments.
   */
  queuedComments?: number;
}): AcceptGate {
  // The task's own pinned settings decide whether the review row can exist at
  // all — read from the task, never from config, because this is DISCLOSURE
  // and it must say what the daemon will actually do.
  //
  // The fallback is {@link GATING_REVIEW_CONTEXT}, the same one
  // `reviewIssuesAwaitingWork` picks for a caller that names nothing: this row
  // failing OPEN would tell a reviewer nothing is blocking accept while the
  // daemon refuses it, the one direction a gate disclosure may not be wrong in.
  const gateContext = reviewSettingsOf(input.taskMetadata, {
    ...GATING_REVIEW_CONTEXT,
    auto_fix: false,
  });
  const rows: AcceptGateRow[] = [];

  // A MISSING FINAL IS NOT A GATE ROW. Accept works from any normal park — the
  // human deciding with the open items in hand IS the declaration.

  // Reads the same item state accept reads: a raise the human PROMOTED into
  // its own task no longer counts, so this row disappears exactly when accept
  // stops refusing.
  const awaiting = reviewIssuesAwaitingWork(input.turns, input.raisedItems, gateContext);
  if (awaiting) {
    // A FAILED review gates with nothing to count, so it says what is wrong
    // instead of "0 issues still unaddressed", which reads like nothing is.
    const what = awaiting.verdict === 'unparsed'
      ? describeReviewFailureShort(awaiting.review)
      : `raised ${awaiting.raiseCount} issue${awaiting.raiseCount === 1 ? '' : 's'} still unaddressed`;
    rows.push({
      kind: 'review',
      sequence: awaiting.sequence,
      label: `Formal review (turn #${awaiting.sequence}) ${what} and no work turn has run since`,
      unblockable: !reviewWasNeverDispatched(awaiting.review),
    });
  }
  for (const item of input.raisedItems) {
    if (item.status !== 'open' || !item.blocking) continue;
    rows.push({
      kind: 'raised',
      raisedId: item.id,
      label: item.title ?? item.content.split('\n')[0] ?? item.id.slice(0, 8),
    });
  }
  const queued = input.queuedComments ?? 0;
  if (queued > 0) {
    rows.push({
      kind: 'comments',
      count: queued,
      // NEUTRAL wording: the count is every PERSON's undelivered comments, and
      // whoever is accepting is often not the one who wrote them.
      label: `${queued} queued comment${queued === 1 ? ' has' : 's have'} not reached the agent — Unblock to deliver ${queued === 1 ? 'it' : 'them'}`,
    });
  }
  for (const v of input.fileViolations) {
    if (v.status === 'approved') continue;
    rows.push({ kind: 'file', file: v.file, label: `${v.file} has no decision` });
  }
  return { rows };
}
