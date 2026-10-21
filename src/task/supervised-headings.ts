/**
 * The heading lazy writes at the top of each supervised follow-up turn (the
 * supervisor half of a `nudge` pair), per follow-up kind. ONE table: the
 * reconciler writes these, and the conversation view reads them back to tell
 * a wrap-up step from a self-review from a person's mid-turn comment — the
 * recorded `turn_type` is `nudge` for all of them.
 */
import type { SupervisedKind } from '../protocol/types';
import { REVIEW_REASK_HEADING } from '../review/verdict';

export const SUPERVISED_HEADINGS: Record<SupervisedKind, string> = {
  permission_pushback: '## Permission Violation Review',
  maintain: '## Maintained Files Review',
  react: '## Reactive Automation',
  commit_leftovers: '## Uncommitted Work',
  commit_nudge: '## Uncommitted Changes Check',
  background_nudge: '## Stopped Background Work Check',
  pending_notes: '## New Comments During the Turn',
  present: '## Presentation Walkthrough',
  low_high_review: '## Low-High Loop Self-Review',
  low_high_revise: '## Low-High Loop Revision',
  // Carried on the review RESPONSE, not as a supervised turn of its own; here
  // for completeness of the union. See src/supervisor/review-reask.ts.
  review_reask: REVIEW_REASK_HEADING,
};

/** Which supervised kind a recorded supervisor turn is, from its heading; null if none matches. */
export function supervisedKindOfContent(content: string): SupervisedKind | null {
  const firstLine = content.split('\n', 1)[0]!.trim();
  for (const [kind, heading] of Object.entries(SUPERVISED_HEADINGS) as Array<[SupervisedKind, string]>) {
    if (firstLine === heading) return kind;
  }
  return null;
}
