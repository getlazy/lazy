/**
 * Port for the web "Review with builder" session loop.
 *
 * Same boundary as {@link ReviewActions}: the web layer never opens Storage or
 * launches agents itself — it calls these methods on an implementation the
 * daemon injects at bind time. Lives in src/server/ (not src/daemon/) to avoid
 * a module cycle with src/daemon/server.ts.
 */

import type { ActorInput, ReviewSession, ReviewSessionMessage } from '../types';
import { LIVE_ASK_STATUSES } from './review-actions';

/** Fixed closer appended to the preamble on the first auto-started turn (§6.2). */
export const REVIEW_SESSION_FIRST_TURN_CLOSER =
  'Open items and initial read first; then wait for the human.';

/**
 * Why a review session cannot be started for this task right now, or null when
 * it can. v1 allows entry only while the task is paused for review — same gate
 * as review-page ask threads.
 */
export function reviewSessionEntryBlockedReason(status: string): string | null {
  if (LIVE_ASK_STATUSES.has(status)) return null;
  return (
    `Task is ${status} — review sessions only run while the task is blocked or in conflict. ` +
    `Wait until the task is paused for review, then try again.`
  );
}

export interface ReviewSessionActions {
  get(taskId: string): Promise<ReviewSession | null>;
  /**
   * Create or return an idle session. Brand-new sessions durable-append the
   * preamble as the first human message and launch one headless builder turn.
   * Existing idle sessions are returned as-is — no preamble re-injection, no launch.
   */
  start(taskId: string, opts?: { actor?: ActorInput }): Promise<ReviewSession>;
  /** Durable-append the human message, then enqueue a headless builder follow-up turn. */
  send(taskId: string, message: string, opts?: { actor?: ActorInput }): Promise<void>;
  getTranscript(taskId: string): Promise<ReviewSessionMessage[]>;
}
