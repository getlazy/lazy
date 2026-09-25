/**
 * The one vocabulary for a raised item's two states: whether it gates accept,
 * and what was decided about it.
 *
 * WHY THIS EXISTS: every surface used to spell these itself. The review summary
 * said `gates accept` / `FYI` in a `.tag-blocking` class that was never defined
 * in any stylesheet, so both rendered as unstyled 11px text between a bare hex
 * id and a link — and read as debug output rather than as state. The task page
 * said `blocking` / `non-blocking`, the inbox said the same in different tones,
 * and resolved items showed the raw stored status (`promoted_subtask`). Four
 * spellings of two facts.
 *
 * DEFINE ONCE, RENDER EVERYWHERE — the same rule src/protection/status.ts
 * follows for protection markers. This module holds the WORDS, the glyph and
 * the tone; the HTML badge lives in src/server/raised-badges.ts. A new surface
 * renders these; it never re-derives a label from `blocking` or from a stored
 * status string.
 *
 * EMOJI ARE PAIRED WITH A WORD, ALWAYS. The emoji is what makes the badge
 * legible at a glance (engineer's call, 2026-09); the word is what makes it
 * legible at all — in a screen reader, in a terminal that renders the glyph as
 * a box, and in a copy-paste. Neither stands alone.
 *
 * THE GLYPH IS FOR SURFACES THAT FLOW, NOT FOR COLUMNS. `lazy raised` renders
 * {@link RaisedVocabularyEntry.label} into `padEnd`-ed columns and deliberately
 * leaves {@link RaisedVocabularyEntry.emoji} out: an emoji is two terminal
 * cells in some emulators and zero in others, so one in a width-computed column
 * silently misaligns every row after it. `PROTECTED_MARKER` is ASCII for the
 * same reason. Same two WORDS on both surfaces; the glyph rides along only
 * where the layout can take it.
 */

import type { RaisedItemStatus } from '../types';

/** Where a badge's colour comes from — a `tag-*` class in the web theme. */
export type RaisedBadgeTone = 'danger' | 'warning' | 'success' | 'accent' | 'neutral';

export interface RaisedVocabularyEntry {
  /** Glyph — never rendered without {@link label}, and never in a padded column. */
  emoji: string;
  /** Short label for dense rows, table cells and terminal columns. */
  label: string;
  /** Fuller phrasing, for a badge or a sentence with room around it. */
  phrase: string;
  /** What this state means for the reader — badge tooltip, and prose. */
  hint: string;
  tone: RaisedBadgeTone;
}

function entry(e: RaisedVocabularyEntry): RaisedVocabularyEntry {
  return e;
}

const BLOCKING = entry({
  emoji: '🛑',
  label: 'Blocking',
  phrase: 'Blocking — gates accept',
  hint: 'Accept on this task refuses until this item is responded to, promoted, dismissed, or acknowledged.',
  tone: 'danger',
});

const NON_BLOCKING = entry({
  emoji: '⚠️',
  label: 'FYI',
  phrase: 'FYI — never gates accept',
  hint: 'Raised for your information. It never holds up accept.',
  tone: 'warning',
});

/** Does this item hold up accept, said the same way everywhere. */
export function raisedGateVocabulary(blocking: boolean): RaisedVocabularyEntry {
  return blocking ? BLOCKING : NON_BLOCKING;
}

/**
 * What was decided, per stored status — one entry per status, never collapsed.
 *
 * ✅ marks every state a human ACTED on, which is all of them but `open`:
 * dismissing is a decision as much as responding is. What the human did is
 * carried by the label, not by the glyph, so the five decided states stay five
 * distinct answers to "what happened to this?".
 *
 * `answered` is the legacy spelling of `responded` and shares its words — a
 * reader should not have to know which release recorded the row.
 */
const DECISIONS: Record<RaisedItemStatus, RaisedVocabularyEntry> = {
  open: entry({
    emoji: '⏳',
    label: 'Open',
    phrase: 'Open — awaiting your decision',
    hint: 'Nobody has decided this yet.',
    tone: 'neutral',
  }),
  responded: entry({
    emoji: '✅',
    label: 'Responded',
    phrase: 'Responded',
    hint: 'Your answer is quoted back to the agent on its next turn.',
    tone: 'success',
  }),
  answered: entry({
    emoji: '✅',
    label: 'Responded',
    phrase: 'Responded',
    hint: 'Your answer is quoted back to the agent on its next turn.',
    tone: 'success',
  }),
  acknowledged: entry({
    emoji: '✅',
    label: 'Acknowledged',
    phrase: 'Acknowledged — seen, maybe later',
    hint: 'Seen and noted; nothing was started.',
    tone: 'success',
  }),
  dismissed: entry({
    emoji: '✅',
    label: 'Dismissed',
    phrase: 'Dismissed — not being pursued',
    hint: "Seen and won't be pursued. The item stays on the record.",
    tone: 'neutral',
  }),
  promoted_subtask: entry({
    emoji: '✅',
    label: 'Promoted to subtask',
    phrase: 'Promoted to subtask',
    hint: 'A child task was created from this item. It never auto-starts.',
    tone: 'accent',
  }),
  promoted_peer: entry({
    emoji: '✅',
    label: 'Promoted to peer task',
    phrase: 'Promoted to peer task',
    hint: 'A sibling task was created from this item. It never auto-starts.',
    tone: 'accent',
  }),
};

/**
 * What was decided about this item.
 *
 * An unrecognised status falls back to `open` rather than being echoed raw:
 * showing the reader a stored enum spelling is the failure this module exists
 * to end.
 */
export function raisedDecisionVocabulary(status: RaisedItemStatus | undefined): RaisedVocabularyEntry {
  return DECISIONS[status as RaisedItemStatus] ?? DECISIONS.open;
}
