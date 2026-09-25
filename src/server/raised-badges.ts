/**
 * The badges every raised-item surface renders — the web half of
 * src/raised/vocabulary.ts.
 *
 * ONE renderer, so the Raised tab, the review summary, the `/raised` inbox, the
 * item panel and the task-page cards cannot drift into four dialects of the
 * same two facts. A surface that wants a badge imports one of these; it never
 * writes `<span class="tag …">` around a label of its own.
 *
 * WHAT THE READER SEES AND WHY
 *  - A gate badge (🛑 Blocking / ⚠️ FYI) on every item, always toned, because
 *    the previous markup used a `tag-blocking` class no stylesheet defined and
 *    so rendered "gates accept" as naked grey text next to a link.
 *  - A decision badge (✅ Responded, ✅ Dismissed, ✅ Promoted to subtask …)
 *    whenever the item is not open, from the item's real status: five decided
 *    states stay five distinct answers.
 *  - NO bare id. A short hex like `a1249791` sat in the middle of every row,
 *    unclickable and next to a link that already went where it pointed. The
 *    full id rides `data-raised-id` for scripts and is spelled out ONCE, as a
 *    labelled copyable line in the item panel's provenance, for whoever has to
 *    pass it to `lazy accept --respond-raised` and its siblings.
 */

import { escapeHtml } from './review-diff';
import { taskPath } from './task-urls';
import {
  raisedDecisionVocabulary,
  raisedGateVocabulary,
  type RaisedBadgeTone,
  type RaisedVocabularyEntry,
} from '../raised/vocabulary';
import type { RaisedItemStatus } from '../types';

/** Theme class for a tone. Every tone maps to a class the stylesheet defines. */
const TONE_CLASS: Record<RaisedBadgeTone, string> = {
  danger: 'tag-danger',
  warning: 'tag-warning',
  success: 'tag-success',
  accent: 'tag-accent',
  neutral: 'tag-neutral',
};

/** How much of the vocabulary a badge has room for. */
export type RaisedBadgeWidth = 'short' | 'full';

function badgeHtml(
  entry: RaisedVocabularyEntry,
  width: RaisedBadgeWidth,
  extraHtml = '',
): string {
  const text = width === 'full' ? entry.phrase : entry.label;
  return (
    `<span class="tag lz-raised-badge ${TONE_CLASS[entry.tone]}" title="${escapeHtml(entry.hint)}">` +
    `<span class="lz-raised-badge-glyph" aria-hidden="true">${escapeHtml(entry.emoji)}</span>` +
    `${escapeHtml(text)}${extraHtml}</span>`
  );
}

/**
 * 🛑 Blocking / ⚠️ FYI.
 *
 * `full` spells out what the flag does ("Blocking — gates accept"); `short` is
 * for a table cell or a dense row, where the tooltip carries the rest.
 */
export function raisedGateBadgeHtml(blocking: boolean, width: RaisedBadgeWidth = 'short'): string {
  return badgeHtml(raisedGateVocabulary(blocking), width);
}

export interface RaisedDecisionBadgeOptions {
  width?: RaisedBadgeWidth;
  /** Promoted items link to the task they became — the promotion IS the answer. */
  promotedTaskId?: string | null;
  /** Preferred label for that link; falls back to nothing rather than a hex id. */
  promotedTaskCode?: string | null;
  /** Codes shared by more than one task — the promoted link falls back to the id for those. */
  duplicatedCodes?: ReadonlySet<string>;
}

/**
 * ⏳ Open / ✅ Responded / ✅ Dismissed / ✅ Promoted to subtask …
 *
 * A promoted item carries the link to the task it became INSIDE the badge, so
 * "what happened to this?" and "where did it go?" are one glance. The link
 * shows the task's CODE; a task that has none yet is linked as the word "task"
 * rather than as a hex id nobody can read — the route to the promoted task is
 * the point of the badge and never gets dropped to avoid printing one.
 */
export function raisedDecisionBadgeHtml(
  status: RaisedItemStatus | undefined,
  options: RaisedDecisionBadgeOptions = {},
): string {
  const entry = raisedDecisionVocabulary(status);
  const { promotedTaskId, promotedTaskCode } = options;
  // Code-or-id: the badge labels the promoted task's code when it has one.
  const link = promotedTaskId
    ? ` <a class="lz-raised-badge-link" href="${taskPath({ id: promotedTaskId, code: promotedTaskCode ?? null }, options.duplicatedCodes)}">→ ${escapeHtml(promotedTaskCode || 'task')}</a>`
    : '';
  return badgeHtml(entry, options.width ?? 'short', link);
}

/**
 * An identifier, spelled out where someone would go looking for it.
 *
 * THE RULE, and it is the whole carve-out: an id is either a labelled,
 * FULL-LENGTH tool argument in a provenance list, or it is not on the page.
 * There is no third form. A TRUNCATION is the worst of both — unreadable to a
 * human and unusable as an argument — and `Session 3bc4fb1e` mid-sentence is
 * precisely the shape that got reported. Every id a panel shows goes through
 * here, so they cannot drift back into prose one at a time.
 *
 * `usage` says what the id is FOR. If you cannot name a command that takes it,
 * the id does not belong on the page at all.
 *
 * Plain selectable text, not a copy button: a button needing the clipboard API
 * is a dead control wherever the browser refuses it, and a `<code>` is
 * selectable everywhere.
 */
export function raisedIdentifierLineHtml(label: string, id: string, usage: string): string {
  return (
    `<li class="lz-raised-id-line">${escapeHtml(label)} <code>${escapeHtml(id)}</code>` +
    ` <span class="text-muted">— for <code>${escapeHtml(usage)}</code></span></li>`
  );
}

/**
 * The raised item's own id — the argument `lazy accept`'s resolution flags take.
 *
 * `--respond-raised <id>=<text>` is the one named, because it is the flag a
 * reviewer clearing an accept gate reaches for first; the siblings
 * (`--dismiss-raised`, `--acknowledge-raised`, `--promote-raised-subtask`,
 * `--promote-raised-peer`) take the same id in the same position. Named from
 * `RAISED_RESOLUTION_FLAGS`, and checked against it — a previous version of
 * this line printed `--raised-resolutions`, a flag that has never existed.
 */
export function raisedIdLineHtml(id: string): string {
  return raisedIdentifierLineHtml('Item id', id, 'lazy accept --respond-raised <id>=<text>');
}
