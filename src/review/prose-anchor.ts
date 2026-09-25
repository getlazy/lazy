/**
 * Prose anchors — review comments and asks attached to a line of the AGENT'S
 * PROSE (a report section paragraph, a follow-up, a raised item) instead of a
 * diff line.
 *
 * Stored through the same `ReviewComment` machinery as diff-line comments, in
 * the pattern `src/review/task-level-anchor.ts` established: `file` is a
 * pseudo-file naming the prose surface (never a repo path — the parentheses
 * keep it out of path space), `line` is a stable content hash of the block's
 * text, and `anchor_snippet` carries the quoted text itself. The snippet is
 * what the agent receives — prompts built from these anchors quote the text
 * and never render the pseudo-file or the hash as a fake file/line.
 *
 * The hash is over NORMALIZED text (whitespace runs collapsed) so the anchor
 * survives re-renders, wrapping and markdown-to-DOM conversion; it changes
 * when the words change, which is exactly when a thread should detach and fall
 * back to the "no longer in the report" rendering.
 */

import type { ReviewCommentSide } from '../types';

/** Pseudo-file for a block of the agent report card (structured or prose). */
export const PROSE_REPORT_FILE = '(report)';

/**
 * Pseudo-file for one follow-up's body — the LEGACY spelling.
 *
 * Follow-ups and raised items are one entity now
 * (docs/design/raised-items-unified.md), so nothing writes this any more:
 * {@link raisedItemProseFile} is what new anchors use. It stays because
 * comments stored before the unification carry `(followup:<id>)` in their
 * `file`, and a stored anchor that stops parsing is a lost review comment.
 */
export function followUpProseFile(followUpId: string): string {
  return `(followup:${followUpId})`;
}

/** Pseudo-file for one raised item's content. */
export function raisedItemProseFile(raisedItemId: string): string {
  return `(raised:${raisedItemId})`;
}

const PROSE_FILE_RE = /^\((report|followup:[^()\s]+|raised:[^()\s]+)\)$/;

/**
 * Regex source for the client mirror of {@link isProseReviewAnchor}: the review
 * island interpolates this into `new RegExp(...)` so the browser and the server
 * can never disagree about which files are prose anchors.
 */
export const PROSE_ANCHOR_FILE_RE_SOURCE = PROSE_FILE_RE.source;

/**
 * Is this comment anchored to agent prose? Deliberately does NOT match the
 * `(task)` sentinel — that one is a conversation with no anchor at all, with
 * its own rules (src/review/task-level-anchor.ts).
 */
export function isProseReviewAnchor(file: string): boolean {
  return PROSE_FILE_RE.test(file);
}

/** Prose anchors always live on the "new" side; there is no old side of a report. */
export const PROSE_ANCHOR_SIDE: ReviewCommentSide = 'new';

/**
 * Stable line number for a prose block: a positive integer hash of the block's
 * section kind plus its normalized text. Same 31-multiplier scheme as
 * `shortHash` in src/server/viewed-cards.ts, kept numeric because
 * `ReviewComment.line` is a number. Never 0 — 0 belongs to the `(task)`
 * sentinel and a colliding 0 here would make `isTaskLevelReviewAnchor` checks
 * ambiguous on sloppy call sites.
 *
 * MUST stay in lockstep with {@link PROSE_ANCHOR_HASH_JS}, the client mirror
 * the review island embeds. test/unit/review-prose-anchor.test.ts executes the
 * mirror and compares outputs.
 */
export function proseAnchorLine(kind: string, text: string): number {
  const s = `${kind}\n${text.replace(/\s+/g, ' ').trim()}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}

/**
 * Client-side mirror of {@link proseAnchorLine}, embedded verbatim in the
 * review island so the browser derives the same line for the same block. The
 * island computes it from `textContent`; both sides normalize whitespace, so
 * markdown-vs-DOM differences cancel out.
 */
export const PROSE_ANCHOR_HASH_JS = `function proseAnchorLine(kind, text) {
  var s = kind + '\\n' + text.replace(/\\s+/g, ' ').trim();
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}`;

/**
 * Where the anchored prose lives, in words addressed TO THE AGENT ("your
 * report"). Used by the prompt builders; the pseudo-file itself never reaches
 * a prompt.
 */
export function proseAnchorAgentWhere(file: string): string {
  // Legacy anchor spelling; one vocabulary in the words either way.
  if (file.startsWith('(followup:')) return 'an item you raised';
  if (file.startsWith('(raised:')) return 'an item you raised';
  return 'your report';
}

/**
 * Where the anchored prose lives, in words addressed to the REVIEWER ("on the
 * report"). Used by the queued-comments list in place of a file:line link.
 */
export function proseAnchorReviewerWhere(file: string): string {
  if (file.startsWith('(followup:')) return 'on a raised item';
  if (file.startsWith('(raised:')) return 'on a raised item';
  return 'on the report';
}
