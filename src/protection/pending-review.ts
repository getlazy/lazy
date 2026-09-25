/**
 * Pending accept review — the builder's review text, captured when a gated
 * accept refuses it.
 *
 * When the builder calls `lazy_accept` on a protected edge, the merge is
 * refused (only a human at a terminal can complete it), but the `reason` the
 * builder supplied is often a real, extensive code review. This module keeps
 * that review on the task so the human's own `lazy accept` can surface it
 * before the passphrase prompt and attach it to the merge — the `[Accepted]`
 * task comment and, on forge drivers, the approving PR/MR review body.
 *
 * INVARIANT: pending_accept_review AUTHORIZES NOTHING. It is review TEXT, not
 * a credential — unlike the deleted `edge_gate_approval` record it can never
 * satisfy the edge gate, skip the passphrase, or let a merge through. The
 * `at_sha` field exists only to LABEL staleness for the human, never to bind
 * or unlock anything. Do not "optimize" it back into an approval token.
 */

import type { Storage } from '../storage';

const PENDING_REVIEW_METADATA_KEY = 'pending_accept_review';

export interface PendingAcceptReview {
  /** Who wrote the review (e.g. 'builder', 'agent:<id>'). */
  actor: string;
  recorded_at: string;
  /** Task branch HEAD when the review was recorded — staleness label only. */
  at_sha: string;
  text: string;
}

/**
 * Record the builder's review on the task (last-write-wins: a retrying builder
 * overwrites its own prior review rather than accumulating copies).
 *
 * Stored as task METADATA, not a comment, on purpose: comments are injected
 * into the agent's next prompt as guidance, and a review of the agent's work
 * must not become an instruction to that agent.
 */
export async function recordPendingAcceptReview(
  storage: Storage,
  taskId: string,
  review: PendingAcceptReview,
): Promise<void> {
  await storage.updateTaskMetadata(taskId, PENDING_REVIEW_METADATA_KEY, JSON.stringify(review));
}

/** Read the pending review, if any. Corrupt records fail loud, not silent. */
export async function peekPendingAcceptReview(
  storage: Storage,
  taskId: string,
): Promise<PendingAcceptReview | null> {
  const raw = await storage.getTaskMetadata(taskId, PENDING_REVIEW_METADATA_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingAcceptReview;
  } catch (err) {
    throw new Error(
      `Corrupt pending review on task ${taskId} (metadata key '${PENDING_REVIEW_METADATA_KEY}'): ` +
      `${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Clear the pending review after a successful merge has attached it. Never
 * called on failure paths — written review text is kept (and labeled stale by
 * SHA when the branch moved), never auto-deleted.
 */
export async function clearPendingAcceptReview(storage: Storage, taskId: string): Promise<void> {
  await storage.updateTaskMetadata(taskId, PENDING_REVIEW_METADATA_KEY, '');
}
