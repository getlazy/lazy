/**
 * Lazy's own mechanical text in a turn, marked where it is written and folded
 * where it is read.
 *
 * A cluster's work turn is pages of repeated contract around a sentence or two
 * of a person's feedback, and a wrap-up nudge is entirely lazy's. Both have to
 * reach the agent verbatim; neither should bury the human's words on a review
 * surface. So every site that composes text AROUND someone's words wraps its
 * own parts in a marker, and every surface folds the marked spans into one
 * collapsed "lazy's instructions" drawer.
 *
 * THE MARKER IS AN HTML COMMENT ON ITS OWN LINE:
 *
 *     <!-- lazy:fold cluster-constraints -->
 *     ...lazy's text...
 *     <!-- /lazy:fold -->
 *
 * Chosen over a fenced tag or an XML-ish element because a comment is the one
 * markdown construct every renderer already drops and every model already reads
 * as "not part of the message": the agent's understanding does not change, a
 * plain-text surface shows two unremarkable lines, and storage and the `show`
 * RPC carry it as ordinary text with no schema change.
 *
 * NOT FORGEABLE INTO HIDING SOMEONE'S WORDS. Four rules, each load-bearing:
 *   1. Markers are honoured in HUMAN-role turns only — the role lazy composes.
 *      An agent-role turn is the agent's own output and is never folded by a
 *      marker it may have written.
 *   2. Text lazy did not write is passed through {@link neutralizeLazyMarkers}
 *      before it is composed into a turn, so a marker a person typed is shown
 *      literally, and {@link lazyFold} neutralizes its own body so a block
 *      cannot be closed early from inside.
 *   3. A turn whose recorded human words (`feedback_items`) spell a marker
 *      is not folded at all — a composition path that forgot rule 2 then
 *      hides nothing.
 *   4. A turn whose markers are not well formed — unclosed, nested, a stray
 *      closer — folds nothing at all; a marker not alone on its line is text.
 *
 * Turns written before markers existed are folded only where the text is
 * RECOGNISED ({@link legacyFold}): the cluster contract by exact match, a pure
 * wrap-up nudge by its heading; anything else stays open. Never hide
 * text that cannot be identified as lazy's.
 *
 * The daemon computes the split ({@link foldTurn}) and sends it on `show`
 * (`turns[].fold`); the dashboard calls the same function. No client parses
 * markers itself (AGENTS.md: `show` sends the answer, never the rule).
 */

import type { Turn } from '../types';
import clusterConstraints from '../prompts/cluster-constraints.md' with { type: 'text' };

const LABEL_RE = /^[a-z0-9][a-z0-9-]*$/;
const OPEN_RE = /^<!-- lazy:fold ([a-z0-9][a-z0-9-]*) -->$/;
const CLOSE_LINE = '<!-- /lazy:fold -->';

/** Any spelling that could be read as a marker, opening or closing. */
const MARKER_LIKE_RE = /<!--(\s*\/?\s*)lazy:fold/g;

/**
 * Make a marker in foreign text inert. The `<` becomes `&lt;`, so it no longer
 * matches a marker line. Both review surfaces escape HTML, so a reader (and the
 * agent) sees the escaped `&lt;!-- lazy:fold`, not byte-for-byte what was typed —
 * deliberately visible, so a forgery attempt is never silent. Text with no marker-like spelling is returned
 * unchanged — the only text this alters is text that tried to look like lazy.
 */
export function neutralizeLazyMarkers(text: string): string {
  return text.replace(MARKER_LIKE_RE, '&lt;!--$1lazy:fold');
}

/**
 * Wrap text lazy composed in a fold marker. `label` names what the span is
 * (`cluster-constraints`, `notes-header`, …) and becomes the drawer's caption.
 */
export function lazyFold(label: string, text: string): string {
  if (!LABEL_RE.test(label)) throw new Error(`lazyFold: invalid label "${label}" (lowercase letters, digits and dashes)`);
  return `<!-- lazy:fold ${label} -->\n${neutralizeLazyMarkers(text)}\n${CLOSE_LINE}`;
}

/** One stretch of a turn: the turn's own text, or a span lazy wrote. */
export interface TurnFoldSegment {
  kind: 'text' | 'lazy';
  /** What lazy's span is, for its caption. Absent on `text`. */
  label?: string;
  text: string;
}

/**
 * A turn split into what a reader came for and lazy's wrapper — the projection
 * `show` sends as `turns[].fold`.
 */
export interface TurnFold {
  /** Every segment, in order, marker lines removed. */
  segments: TurnFoldSegment[];
  /** The turn's own text with lazy's spans removed — what renders on top. */
  primary: string;
  /** Lines of lazy's text folded away — the drawer's count. */
  lazy_lines: number;
  /** Why the turn was folded: explicit markers, or a recognised legacy template. */
  source: 'markers' | 'legacy';
}

type FoldableTurn = Pick<Turn, 'role' | 'content'> &
  Partial<Pick<Turn, 'actor' | 'turn_type' | 'feedback_items'>>;

function parseMarkers(content: string): TurnFoldSegment[] | null {
  const lines = content.split('\n');
  const segments: TurnFoldSegment[] = [];
  let text: string[] = [];
  let open: { label: string; body: string[] } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const opener = OPEN_RE.exec(line);
    if (opener) {
      // Rule 4: nesting is malformed — the whole turn folds nothing.
      if (open) return null;
      if (text.length) segments.push({ kind: 'text', text: text.join('\n') });
      text = [];
      open = { label: opener[1]!, body: [] };
    } else if (line === CLOSE_LINE) {
      if (!open) return null; // a stray closer is malformed too
      // A bare `---` separator lazy put right after its own block is lazy's too.
      let j = i + 1;
      while (j < lines.length && lines[j] === '') j++;
      if (lines[j] === '---') {
        open.body.push(...lines.slice(i + 1, j + 1));
        i = j;
      }
      segments.push({ kind: 'lazy', label: open.label, text: open.body.join('\n') });
      open = null;
    } else if (open) {
      open.body.push(line);
    } else {
      text.push(line);
    }
  }
  if (open) return null; // unclosed
  if (!segments.some((s) => s.kind === 'lazy')) return null;
  if (text.length) segments.push({ kind: 'text', text: text.join('\n') });
  return segments;
}

/** The constraints block exactly as `typeConstraintsSection` wrote it before markers. */
const LEGACY_CLUSTER_PREFIX = `${clusterConstraints}\n\n---\n\n`;

/**
 * Supervisor nudge headings whose WHOLE prompt is lazy's own template — no
 * person's or reviewer's words interpolated. Kinds that carry foreign text
 * (pending comments, PR comments, reviewer findings, user-configured rules) are
 * deliberately absent and stay open on legacy turns.
 */
const LEGACY_PURE_NUDGE_HEADINGS = new Set([
  '## Permission Violation Review',
  '## Uncommitted Work',
  '## Uncommitted Changes Check',
  '## Stopped Background Work Check',
  '## Presentation Walkthrough',
  '## Low-High Loop Self-Review',
]);

/** Recognise lazy's text in a turn written before markers. Null when nothing is recognised. */
function legacyFold(turn: FoldableTurn): TurnFoldSegment[] | null {
  const content = turn.content;
  if (turn.actor === 'supervisor' && turn.turn_type === 'nudge') {
    const heading = content.split('\n', 1)[0]!.trim();
    if (LEGACY_PURE_NUDGE_HEADINGS.has(heading)) {
      const nl = content.indexOf('\n');
      if (nl < 0) return null;
      return [
        { kind: 'text', text: content.slice(0, nl) },
        { kind: 'lazy', label: 'wrap-up', text: content.slice(nl + 1) },
      ];
    }
    return null;
  }
  if (content.startsWith(LEGACY_CLUSTER_PREFIX)) {
    const rest = content.slice(LEGACY_CLUSTER_PREFIX.length);
    return [
      { kind: 'lazy', label: 'cluster-constraints', text: LEGACY_CLUSTER_PREFIX },
      ...(rest.trim() ? [{ kind: 'text' as const, text: rest }] : []),
    ];
  }
  return null;
}

/**
 * Rule 3: a turn whose recorded human words themselves spell a marker is not
 * folded at all. Composition neutralizes those words, so this only fires on a
 * path that forgot to — and then the safe answer is to hide nothing.
 */
function humanWordsSpellAMarker(turn: FoldableTurn): boolean {
  return (turn.feedback_items ?? []).some((item) =>
    typeof item?.text === 'string' && /<!--\s*\/?\s*lazy:fold/.test(item.text));
}

function lineCount(text: string): number {
  const trimmed = text.replace(/^\n+|\n+$/g, '');
  return trimmed ? trimmed.split('\n').length : 0;
}

/**
 * Split a turn into its own text and lazy's wrapper, or null when nothing in it
 * is lazy's (the surface then renders the turn exactly as before).
 */
export function foldTurn(turn: FoldableTurn): TurnFold | null {
  if (turn.role !== 'human' || typeof turn.content !== 'string' || !turn.content) return null;
  if (humanWordsSpellAMarker(turn)) return null;
  let source: TurnFold['source'] = 'markers';
  let segments = parseMarkers(turn.content);
  if (!segments) {
    segments = legacyFold(turn);
    source = 'legacy';
  }
  if (!segments) return null;
  const lazy = segments.filter((s) => s.kind === 'lazy');
  if (lazy.length === 0) return null;
  const primary = segments
    .filter((s) => s.kind === 'text')
    .map((s) => s.text.replace(/^\n+|\n+$/g, ''))
    .filter((t) => t.trim().length > 0)
    .join('\n\n');
  return {
    segments,
    primary,
    lazy_lines: lazy.reduce((n, s) => n + lineCount(s.text), 0),
    source,
  };
}

/** The drawer caption every surface uses: "lazy's instructions (12 lines)". */
export function foldCaption(fold: Pick<TurnFold, 'lazy_lines'>): string {
  return `lazy's instructions (${fold.lazy_lines} line${fold.lazy_lines === 1 ? '' : 's'})`;
}

/**
 * Supervised follow-up kinds whose prompt is wholly lazy's template (the
 * interpolations are file paths and counts lazy computed, never someone's
 * prose). Their recorded prompt folds whole.
 */
const PURE_SUPERVISED_KINDS = new Set([
  'permission_pushback', 'commit_leftovers', 'commit_nudge', 'background_nudge', 'present', 'low_high_review',
]);

/**
 * The stored content of a supervised follow-up's prompt turn. Its heading stays
 * the turn's visible first line — a label the reader wants, and what callers
 * recognise the turn by. A pure-template prompt folds under it; `pending_notes` arrives
 * already marked (the notes block is composed by {@link lazyFold}-aware code,
 * with the comments neutralized); every other kind carries foreign prose — PR
 * comments, a reviewer's findings, user-configured rules — which is neutralized
 * and left open.
 */
export function supervisedTurnContent(kind: string, heading: string, prompt: string): string {
  if (PURE_SUPERVISED_KINDS.has(kind)) return `${heading}\n\n${lazyFold('wrap-up', prompt)}`;
  const body = kind === 'pending_notes' ? prompt : neutralizeLazyMarkers(prompt);
  return `${heading}\n\n${body}`;
}
