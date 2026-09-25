/**
 * The key a half-typed review comment is stored under.
 *
 * A draft belongs to one BOX, and a box is a surface plus an anchor — never an
 * anchor alone. The same `(file, side, line)` is reachable from at least three
 * places on the review page: the diff row itself, the header of that file's
 * presented document, and a diagram rendered from those lines. Keyed on the
 * anchor alone, two boxes open at once share one stored draft and every
 * keystroke in one overwrites the other, which is the exact loss the draft
 * store exists to prevent; and restoring such a draft could reopen a question
 * about a diagram on a hidden source row, where nobody would ever find it.
 *
 * Shape: `<surface[:control]> <side> <line> <thread|-> <file>`. The file goes
 * LAST because it is the only part that can contain a space, so parsing is four
 * fields and a remainder. The daemon stores the whole thing opaquely — it is
 * built and read here, and by the browser mirror below.
 *
 * The optional `:control` rides INSIDE the first token rather than as a sixth
 * field, because a sixth field would be ambiguous with a path containing a
 * space. It distinguishes two presented controls that resolve to the same
 * anchor: a document's header button and a diagram rendered inside that
 * document both point at the line the document starts on, and without it they
 * are one key and one draft — the same clobbering, one level down.
 *
 * {@link REVIEW_DRAFT_KEY_JS} is that mirror, embedded verbatim in the review
 * island. `test/unit/review-draft-key.test.ts` executes it and compares it
 * against these functions, so the two cannot drift.
 */

/** Which kind of box a draft was typed into. */
export const REVIEW_DRAFT_SURFACES = ['line', 'prose', 'present', 'task'] as const;
export type ReviewDraftSurface = (typeof REVIEW_DRAFT_SURFACES)[number];

export interface ReviewDraftKeyParts {
  surface: ReviewDraftSurface;
  file: string;
  side: string;
  line: number;
  /** Thread being replied to, or '' for a new comment. */
  threadId: string;
  /**
   * Which control on that surface opened the box, when one anchor carries more
   * than one: the diagram's block id, or `doc` for a presented document's own
   * header button. '' where the surface has exactly one box per anchor.
   */
  control?: string;
}

export function reviewDraftKey(parts: ReviewDraftKeyParts): string {
  const surface = parts.control ? `${parts.surface}:${parts.control}` : parts.surface;
  return `${surface} ${parts.side} ${parts.line} ${parts.threadId || '-'} ${parts.file}`;
}

const KEY_RE = new RegExp(
  `^(${REVIEW_DRAFT_SURFACES.join('|')})(?::([A-Za-z0-9_.-]+))? (\\S+) (\\d+) (\\S+) ([\\s\\S]+)$`,
);
/** Four fields and a remainder: a key written before surfaces existed. */
const LEGACY_KEY_RE = /^(\S+) (\d+) (\S+) ([\s\S]+)$/;

/**
 * Parse a stored key, or null if it is not one.
 *
 * A key without a surface is read as a `line` draft rather than discarded:
 * dropping it would mean words a reviewer typed are stored and never shown
 * again, which is the same loss by another route.
 */
export function parseReviewDraftKey(key: string): ReviewDraftKeyParts | null {
  const m = KEY_RE.exec(key);
  if (m) {
    return {
      surface: m[1] as ReviewDraftSurface,
      control: m[2] ?? '',
      side: m[3],
      line: parseInt(m[4], 10),
      threadId: m[5] === '-' ? '' : m[5],
      file: m[6],
    };
  }
  const old = LEGACY_KEY_RE.exec(key);
  if (!old) return null;
  return {
    surface: 'line',
    control: '',
    side: old[1],
    line: parseInt(old[2], 10),
    threadId: old[3] === '-' ? '' : old[3],
    file: old[4],
  };
}

/**
 * The browser mirror, embedded verbatim in the review island (review.ts).
 *
 * MUST stay in lockstep with the two functions above — the island writes keys
 * the server-side helpers have to be able to read (the e2e round trip seeds
 * drafts under keys built in TypeScript and expects the island to find them).
 * The unit test executes this string and compares outputs.
 */
export const REVIEW_DRAFT_KEY_JS = `var REVIEW_DRAFT_SURFACES = ${JSON.stringify(
  REVIEW_DRAFT_SURFACES.join('|'),
)};
function draftKey(a, threadId, surface, control) {
  return (surface || 'line') + (control ? ':' + control : '') + ' ' +
    a.side + ' ' + a.line + ' ' + (threadId || '-') + ' ' + a.file;
}
function parseDraftKey(key) {
  var m = new RegExp('^(' + REVIEW_DRAFT_SURFACES + ')(?::([A-Za-z0-9_.-]+))? (\\\\S+) (\\\\d+) (\\\\S+) ([\\\\s\\\\S]+)' + '$').exec(key);
  if (m) {
    return {
      surface: m[1],
      control: m[2] || '',
      anchor: { file: m[6], side: m[3], line: parseInt(m[4], 10) },
      threadId: m[5] === '-' ? '' : m[5],
    };
  }
  var old = new RegExp('^(\\\\S+) (\\\\d+) (\\\\S+) ([\\\\s\\\\S]+)' + '$').exec(key);
  if (!old) return null;
  return {
    surface: 'line',
    control: '',
    anchor: { file: old[4], side: old[1], line: parseInt(old[2], 10) },
    threadId: old[3] === '-' ? '' : old[3],
  };
}`;
