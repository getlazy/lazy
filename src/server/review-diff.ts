/**
 * A line-anchored unified-diff parser and renderer for the review surface.
 *
 * This is the only diff renderer. There was a second one (@pierre/diffs SSR,
 * src/server/diff.ts) which produced a prettier, syntax-highlighted diff but
 * moved every line into a Shadow DOM inside a <diffs-container> web component.
 * Nothing outside a shadow root can address an individual line, so there was
 * nowhere to hang a per-line comment affordance or a threaded reply — it could
 * not grow the one feature the review surface exists for. Rather than keep two
 * diff components with two looks and two sets of behaviour, that one was
 * dropped and this renderer serves both the review page and commit detail.
 *
 * It emits plain light-DOM rows carrying (file, side, line) in data attributes,
 * which is what makes anchored comments possible.
 *
 * Mermaid fences: complete post-image ```mermaid blocks get a presentation row
 * (src/server/mermaid.ts) after the closing fence. The fence lines themselves
 * keep their anchors — the diagram is presentation layered on top, never a
 * replacement that would break per-line comments. Mid-edit incomplete fences
 * stay as source only.
 */

import {
  findMermaidDiffBlocks,
  mermaidDiffIndex,
  mermaidDiffRowHtml,
} from './mermaid';
import { shortHash } from './viewed-cards';
import { escapeHtml, scriptJson } from './escape';
import type { FileLineAttribution, LineAttributionRun } from '../regions';
import { EXPAND_CHUNK_LINES, MAX_EXPAND_LINES } from '../review/file-lines';

export type DiffLineKind = 'context' | 'add' | 'del' | 'meta';
export type DiffSide = 'old' | 'new';

export interface DiffLine {
  kind: DiffLineKind;
  /** 1-based line number in the pre-image, when the line exists there. */
  oldLine: number | null;
  /** 1-based line number in the post-image, when the line exists there. */
  newLine: number | null;
  content: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  /** Set when the file was renamed; the pre-image path. */
  oldPath: string | null;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** True for binary files and other patches with no textual hunks. */
  binary: boolean;
  /**
   * When this card is a filtered presentation snippet of a larger file
   * change, the FULL file's add/del totals. The header then reads
   * `+N −M of +X −Y` so a partial card never pretends to be the whole file.
   * Absent when the card already is the whole file.
   */
  fullAdditions?: number;
  fullDeletions?: number;
  /**
   * Post-image line numbers that are additions in the FULL file's diff.
   * Expand-context consults this so a revealed line that a snippet omitted
   * still paints as an addition — never as unchanged "old" code. Empty /
   * absent when every addition is already in the visible hunks (raw file
   * cards): gaps between real hunks cannot contain adds.
   */
  newSideAdds?: number[];
}

/** Post-image line numbers of every addition in a parsed file. */
export function collectNewSideAdds(file: DiffFile): number[] {
  const out: number[] = [];
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.kind === 'add' && l.newLine !== null) out.push(l.newLine);
    }
  }
  return out;
}

/**
 * How many of `newSideAdds` fall inside a gap's post-image range.
 * Used to label expand controls ("20 hidden lines · 3 changes") so a
 * collapsed snippet never implies the gap is pure context.
 */
export function countAddsInGap(gap: ContextGap, newSideAdds: readonly number[] | undefined): number {
  if (!newSideAdds || newSideAdds.length === 0) return 0;
  let n = 0;
  for (const line of newSideAdds) {
    if (line < gap.start) continue;
    if (gap.end !== null && line > gap.end) continue;
    n++;
  }
  return n;
}

/**
 * Stamp a snippet DiffFile with the full file's totals and add-line index.
 * Call only for presentation-filtered cards — raw whole-file cards leave
 * these unset so the header stays a plain `+N −M` and expand gaps stay
 * ordinary context (git never puts an add between two real hunks).
 */
export function annotateSnippetAgainstFull(snippet: DiffFile, full: DiffFile): DiffFile {
  snippet.fullAdditions = full.additions;
  snippet.fullDeletions = full.deletions;
  snippet.newSideAdds = collectNewSideAdds(full);
  return snippet;
}

/**
 * The anchor a comment attaches to. `side` disambiguates the two numbering
 * spaces: a deleted line only exists in the pre-image, an added line only in
 * the post-image, so (file, line) alone is ambiguous.
 */
export interface DiffAnchor {
  file: string;
  side: DiffSide;
  line: number;
}

/** The side/line a comment on this row should anchor to. */
export function anchorForLine(file: string, line: DiffLine): DiffAnchor | null {
  if (line.kind === 'del') {
    return line.oldLine === null ? null : { file, side: 'old', line: line.oldLine };
  }
  if (line.kind === 'add' || line.kind === 'context') {
    return line.newLine === null ? null : { file, side: 'new', line: line.newLine };
  }
  return null;
}

/**
 * One row of the side-by-side layout: the pre-image line on the left, the
 * post-image line on the right, either of which may be absent.
 */
export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * Pair a hunk's lines into side-by-side rows.
 *
 * The whole point is that a removed line and the line that replaced it sit
 * ACROSS from each other rather than staircasing down the page. Unified order
 * gives us runs — some deletions, then some additions — so a change block is
 * consumed as a whole and its two runs zipped index-wise; whichever run is
 * shorter yields blank filler on that side. Context lines occupy both sides of
 * a single row, which is what keeps the two panes in step.
 *
 * Kept here, in TypeScript, on purpose: the browser only ever shuffles rows the
 * server has already grouped, so this — the part that can actually be wrong —
 * is unit-testable rather than buried in a script string.
 */
export function pairSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const kind = lines[i].kind;
    if (kind === 'context') {
      rows.push({ left: lines[i], right: lines[i] });
      i++;
      continue;
    }
    if (kind === 'del' || kind === 'add') {
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      // git emits deletions before additions within a change block; collecting
      // in that order also copes with an add-only run (dels stays empty), and
      // either way at least one line is consumed so this cannot spin.
      while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++]);
      while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++]);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
      continue;
    }
    i++; // meta lines are not rendered
  }
  return rows;
}

/**
 * The unchanged region between two hunks (or before the first / after the last),
 * expressed in post-image line numbers — what the expand controls reveal.
 *
 * `delta` is `oldLine - newLine` across the gap. Inside a run of unchanged lines
 * the two numbering spaces move in lockstep, so one integer is enough for the
 * browser to number both columns of every line it inserts — no second round trip
 * to ask what the old-side numbers were.
 */
export interface ContextGap {
  /** First unrevealed post-image line, 1-based. */
  start: number;
  /** Last unrevealed post-image line, or null for "to the end of the file". */
  end: number | null;
  delta: number;
}

interface HunkBounds {
  firstOld: number | null;
  firstNew: number | null;
  lastOld: number | null;
  lastNew: number | null;
}

function hunkBounds(h: DiffHunk): HunkBounds {
  const b: HunkBounds = { firstOld: null, firstNew: null, lastOld: null, lastNew: null };
  for (const l of h.lines) {
    if (l.oldLine !== null) {
      if (b.firstOld === null) b.firstOld = l.oldLine;
      b.lastOld = l.oldLine;
    }
    if (l.newLine !== null) {
      if (b.firstNew === null) b.firstNew = l.newLine;
      b.lastNew = l.newLine;
    }
  }
  return b;
}

/**
 * The gaps around a file's hunks: `before[i]` precedes hunk i, `after` follows
 * the last one.
 *
 * Computed from the line numbers the hunks actually carry, NOT from the `@@`
 * headers — a presentation snippet keeps the original header while showing only
 * part of the hunk (see filterFileToSnippet), so a header-derived gap would
 * overlap lines already on screen and expansion would duplicate them.
 *
 * A gap is omitted whenever either side's numbering is unknown at its boundary
 * (a hunk of pure additions has no old-side numbers, so `delta` cannot be
 * derived): no control at all beats a control that inserts wrong line numbers.
 */
export function contextGaps(file: DiffFile): { before: (ContextGap | null)[]; after: ContextGap | null } {
  const bounds = file.hunks.map(hunkBounds);
  const before: (ContextGap | null)[] = [];
  for (let i = 0; i < bounds.length; i++) {
    const cur = bounds[i];
    if (i === 0) {
      const gapEnd = cur.firstNew === null ? null : cur.firstNew - 1;
      before.push(
        gapEnd !== null && gapEnd >= 1 && cur.firstOld !== null && cur.firstNew !== null
          ? { start: 1, end: gapEnd, delta: cur.firstOld - cur.firstNew }
          : null,
      );
      continue;
    }
    const prev = bounds[i - 1];
    if (prev.lastNew === null || prev.lastOld === null || cur.firstNew === null) {
      before.push(null);
      continue;
    }
    const start = prev.lastNew + 1;
    const end = cur.firstNew - 1;
    before.push(start <= end ? { start, end, delta: prev.lastOld - prev.lastNew } : null);
  }

  const last = bounds[bounds.length - 1];
  const after =
    last && last.lastNew !== null && last.lastOld !== null
      ? { start: last.lastNew + 1, end: null, delta: last.lastOld - last.lastNew }
      : null;
  return { before, after };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff (`git diff` output) into files → hunks → numbered lines.
 *
 * Deliberately tolerant: any line it does not recognize is skipped rather than
 * throwing, so a stray git header or a truncated patch still renders the parts
 * it could read. A patch with no `diff --git` headers yields an empty array,
 * which callers render as an empty state.
 */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!diffText) return files;

  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const lines = diffText.split('\n');
  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      current = { path: pathFromGitHeader(raw), oldPath: null, hunks: [], additions: 0, deletions: 0, binary: false };
      hunk = null;
      files.push(current);
      continue;
    }
    if (raw.startsWith('diff --')) {
      // Some OTHER `diff --<something>` header — not a git patch section. The
      // daemon appends a synthetic `diff --lazy a/comments b/comments` block
      // to `lazy diff`, and anything else pasted into a patch can do the same.
      // Falling through here made the following `+++ b/comments` rename the
      // LAST REAL FILE to "comments" and swallow its hunks (the phantom
      // "comments" file on the review page). Close the current file and skip
      // until the next real `diff --git`.
      current = null;
      hunk = null;
      continue;
    }
    if (!current) continue;

    if (raw.startsWith('--- ')) {
      const p = stripPrefix(raw.slice(4));
      if (p && p !== '/dev/null') current.oldPath = p;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = stripPrefix(raw.slice(4));
      // The post-image path is authoritative (handles renames and the
      // ambiguous-space case in `diff --git` headers).
      if (p && p !== '/dev/null') current.path = p;
      continue;
    }
    if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
      current.binary = true;
      continue;
    }

    const m = HUNK_RE.exec(raw);
    if (m) {
      oldNo = parseInt(m[1], 10);
      newNo = parseInt(m[3], 10);
      hunk = { header: raw, lines: [] };
      current.hunks.push(hunk);
      continue;
    }

    if (!hunk) continue;

    if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — belongs to the previous line, not a
      // line of its own, and carries no line number.
      continue;
    }
    if (raw.startsWith('+')) {
      hunk.lines.push({ kind: 'add', oldLine: null, newLine: newNo++, content: raw.slice(1) });
      current.additions++;
    } else if (raw.startsWith('-')) {
      hunk.lines.push({ kind: 'del', oldLine: oldNo++, newLine: null, content: raw.slice(1) });
      current.deletions++;
    } else if (raw.startsWith(' ') || raw === '') {
      // A truly empty string is the trailing element of the final split; a
      // context line for an empty source line arrives as a single space.
      if (raw === '') continue;
      hunk.lines.push({ kind: 'context', oldLine: oldNo++, newLine: newNo++, content: raw.slice(1) });
    }
    // Anything else (index lines, mode changes) is metadata we do not render.
  }

  return files;
}

function stripPrefix(p: string): string {
  const trimmed = p.trim().split('\t')[0];
  if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) return trimmed.slice(2);
  return trimmed;
}

function pathFromGitHeader(header: string): string {
  // `diff --git a/x b/x` — take the b-side. Paths with spaces make this
  // ambiguous, which is why the +++ line overrides it when present.
  const rest = header.slice('diff --git '.length);
  const bIdx = rest.lastIndexOf(' b/');
  if (bIdx >= 0) return rest.slice(bIdx + 3);
  return rest;
}

/**
 * Re-exported, not defined here: the escapers live in ./escape, which imports
 * nothing so that every island renderer can reach them — including
 * viewed-cards.ts, which this module imports. Every existing
 * `import { escapeHtml } from './review-diff'` keeps working.
 */
export { escapeHtml, scriptJson };

export interface RenderedThread {
  threadId: string;
  html: string;
}

/**
 * colspan for full-width rows (hunk headers, threads, the comment form).
 *
 * The unified table has four columns and the split table six, and the SAME rows
 * have to span both because the layout is switched in the browser without
 * re-fetching. A colspan past the end of a row is clamped by every browser, so
 * one value larger than either table is correct in both — as opposed to a value
 * per layout, which would have to be rewritten on every toggle.
 */
export const DIFF_COLSPAN = 6;

/**
 * Render the parsed diff as light-DOM tables.
 *
 * Every content row carries data-file / data-side / data-line so the island
 * script can open a comment box against a stable anchor, and so a thread
 * rendered server-side lands back on exactly the row it was written against
 * after a page reload.
 */
export interface RenderDiffOptions {
  /**
   * Protected files this task changed without permission, by path → current
   * status. The ⛔/✅ decision lives in the header of the FILE it is about —
   * never on a hunk card. A decision is one stored record per path
   * (`file_decisions`, scope `protected`); presenting the same file as several
   * snippets must not mint several controls.
   */
  violations?: Map<string, 'pending' | 'approved' | 'rejected'>;
  /** Task id, for the decision form's action. */
  taskId?: string;
  /**
   * Put the approve/reject control on this file's header. Default true when
   * the path is in `violations`. Presentation sets this false for a later
   * appearance of a file that already showed its (one) control.
   */
  showDecision?: boolean;
  /**
   * Stamp `id="${fileSectionId(path)}"` on the section. Default true.
   * False for a duplicate card of a file that already carries the canonical
   * id (the hidden Raw copy while Presented has it, or a later interleaved
   * hunk). `data-file-section` is always set so hash navigation can find
   * every copy without colliding ids.
   */
  assignSectionId?: boolean;
  /**
   * Emit the per-line "comment on this line" affordance. False on the commit
   * detail page, which shows a historical commit with nothing to reply to.
   */
  allowComments?: boolean;
  /**
   * Emit the per-file "Viewed" tick. Review-only: ticking files off is about
   * working through a change under review, not about reading history.
   */
  allowViewed?: boolean;
  /**
   * Emit the expand-context controls between hunks.
   *
   * Off by default because the controls are useless without somewhere to fetch
   * the lines from: only the review page has a task whose worktree and diff refs
   * the daemon can read (see handleFileLines). Commit detail renders a
   * historical commit and gets none — a dead button is worse than no button.
   */
  allowExpand?: boolean;
  /**
   * Presented views of a file, by path — the file as the thing it IS rather
   * than as changed lines. Markdown is the first (src/server/review-markdown.ts)
   * and deliberately not the last: diagrams, SVGs and images are the same idea.
   *
   * Passed in as HTML rather than rendered here on purpose: producing one needs
   * the file's full text, which is an async read this synchronous renderer has
   * no business doing, and keeping the dependency pointing that way lets a
   * presenter use this module's parsed diff and anchors without a cycle.
   *
   * When a pane is present the file's line diff is wrapped as the `source` pane
   * and the toolbar switch swaps between the two. Absent, nothing about the
   * file changes.
   */
  presentedPanes?: Map<string, string>;
  /**
   * Per-line unit attribution — the SUBTASK-BLAME gutter, by path.
   *
   * A reading aid and nothing more: it labels which unit's work each stretch of
   * changed lines is, the way `git blame` labels a commit. There is deliberately
   * no per-line ownership, sign-off or assignment behind it — those live on the
   * region, which is the thing a partition makes it possible to sign off.
   */
  lineAttribution?: Map<string, FileLineAttribution>;
}

/**
 * The gutter's runs for one file, as rows.
 *
 * Computed per hunk rather than per file: a run breaks where the owning unit
 * changes OR where the hunk ends, because a spine spanning a gap of unshown
 * lines claims those lines too.
 *
 * Lines with no attribution — removals (they are not in the final version, so
 * blame has nothing to say) and lines written before the review — do not break
 * a run and do not start one. They continue whatever run surrounds them, so a
 * unit that replaced three lines with two reads as one stretch of its work
 * rather than as two stretches with a hole.
 */
export function blameRunRows(
  lines: readonly DiffLine[],
  runs: readonly LineAttributionRun[],
): Array<{ region: string; code?: string; title: string; first: number; last: number; label: number }> {
  if (runs.length === 0) return [];
  // Binary search rather than a scan: runs come back line-ordered, and a file
  // with hundreds of runs rendered line by line is the one place in this
  // renderer where a linear lookup would go quadratic.
  const ownerOf = (line: DiffLine): LineAttributionRun | undefined => {
    const n = line.newLine;
    if (n === null) return undefined;
    let lo = 0;
    let hi = runs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const run = runs[mid]!;
      if (n < run.start) hi = mid - 1;
      else if (n > run.end) lo = mid + 1;
      else return run;
    }
    return undefined;
  };

  const out: Array<{ region: string; code?: string; title: string; first: number; last: number; label: number }> = [];
  let current: { region: string; code?: string; title: string; first: number; last: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const owner = ownerOf(lines[i]!);
    if (!owner) continue;
    if (current && current.region === owner.region) {
      current.last = i;
      continue;
    }
    if (current) out.push({ ...current, label: Math.floor((current.first + current.last) / 2) });
    current = {
      region: owner.region,
      ...(owner.code ? { code: owner.code } : {}),
      title: owner.title,
      first: i,
      last: i,
    };
  }
  if (current) out.push({ ...current, label: Math.floor((current.first + current.last) / 2) });
  return out;
}

/**
 * One expand control row: the affordance for reading past the diff's own
 * context, and the numbers the browser needs to render what it gets back.
 *
 * Ships `hidden`, like every other JS-only control on this page — it is a
 * button that does nothing without a fetch, so with scripting off the diff
 * simply reads as it always did.
 */
function expandRowHtml(
  file: DiffFile,
  gap: ContextGap,
  gapId: string,
  kind: 'top' | 'mid' | 'bottom',
): string {
  const size = gap.end === null ? null : gap.end - gap.start + 1;
  const chunked = size === null || size > EXPAND_CHUNK_LINES;
  const button = (dir: string, glyph: string, title: string) =>
    `<button type="button" class="rv-expand-btn" data-rv-expand-dir="${escapeHtml(dir)}"` +
    ` title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${escapeHtml(glyph)}</button>`;

  const buttons: string[] = [];
  // "Up" reveals the lines just above the hunk that FOLLOWS the gap, "down" the
  // lines just below the hunk that precedes it — so each only exists where
  // there is a hunk on that side of the gap. When the whole gap fits in one
  // click, both would do the same thing as "all", so only "all" is offered.
  if (chunked && kind !== 'bottom') {
    buttons.push(button('up', '↑', `Show ${EXPAND_CHUNK_LINES} lines above`));
  }
  if (chunked && kind !== 'top') {
    buttons.push(button('down', '↓', `Show ${EXPAND_CHUNK_LINES} lines below`));
  }
  buttons.push(
    button(
      'all',
      '↔',
      kind === 'top'
        ? 'Show all lines to the start of the file'
        : kind === 'bottom'
          ? 'Show all lines to the end of the file'
          : 'Show all lines between these hunks',
    ),
  );

  const changeCount = countAddsInGap(gap, file.newSideAdds);
  const base =
    size === null ? 'to end of file' : `${size} hidden line${size === 1 ? '' : 's'}`;
  // A presentation snippet can hide real additions inside what looks like a
  // context gap. Name them up front so "Show 20 lines below" never implies
  // the gap is unchanged code.
  const count =
    changeCount > 0
      ? `${base} · ${changeCount} change${changeCount === 1 ? '' : 's'}`
      : base;
  return (
    `<tr class="rv-expand" hidden data-rv-gap="${escapeHtml(gapId)}"` +
    ` data-file="${escapeHtml(file.path)}" data-start="${gap.start}"` +
    (gap.end === null ? '' : ` data-end="${gap.end}"`) +
    ` data-delta="${gap.delta}" data-kind="${kind}">` +
    `<td colspan="${DIFF_COLSPAN}" class="rv-expand-cell">` +
    `<span class="rv-expand-btns">${buttons.join('')}</span>` +
    `<span class="rv-expand-count">${escapeHtml(count)}</span>` +
    `</td></tr>`
  );
}

export function renderReviewDiff(
  files: DiffFile[],
  threadsByAnchor: Map<string, RenderedThread[]>,
  options: RenderDiffOptions = {},
): string {
  const {
    violations = new Map(),
    taskId = '',
    allowComments = true,
    allowViewed = true,
    allowExpand = false,
    presentedPanes,
    showDecision = true,
    assignSectionId = true,
    lineAttribution,
  } = options;
  if (files.length === 0) {
    return '<p class="empty-state">No changes to review.</p>';
  }

  const out: string[] = [];
  for (const file of files) {
    const fileId = fileSectionId(file.path);
    const violation = violations.get(file.path);
    const partialStats =
      file.fullAdditions !== undefined &&
      file.fullDeletions !== undefined &&
      (file.fullAdditions !== file.additions || file.fullDeletions !== file.deletions);
    const newAddsAttr =
      file.newSideAdds && file.newSideAdds.length > 0
        ? ` data-rv-new-adds="${escapeHtml(file.newSideAdds.join(','))}"`
        : '';
    out.push(
      // `rv-viewable` + `data-viewed-key` are the shared collapse/"viewed"
      // contract (src/server/viewed-cards.ts): a file and a markdown card are
      // driven by the same island. The key stays the PATH — ticks stored before
      // cards existed still resolve.
      //
      // `data-rv-new-adds` is the full-file addition index for expand-context:
      // a presentation snippet may omit adds that still sit in a gap, and the
      // browser must paint those as additions when revealed — never as context.
      `<section class="rv-file rv-viewable${violation ? ' rv-file-protected' : ''}"` +
        (assignSectionId ? ` id="${fileId}"` : '') +
        ` data-file="${escapeHtml(file.path)}" data-file-section="${fileId}"` +
        ` data-viewed-key="${escapeHtml(file.path)}"` +
        ` data-content-hash="${fileContentHash(file)}"` +
        ` data-rv-visible-add="${file.additions}" data-rv-visible-del="${file.deletions}"` +
        newAddsAttr +
        `>`,
    );
    out.push(
      `<header class="rv-file-head">` +
        // Hidden until the island unhides them: collapse and "viewed" are view
        // state only, so with JS off they would be dead controls.
        `<button type="button" class="rv-file-toggle rv-vw-toggle" aria-expanded="true" aria-label="Collapse file" hidden>&#9662;</button>` +
        `<span class="rv-file-path">${escapeHtml(file.path)}</span>` +
        (violation && showDecision ? violationDecision(taskId, file.path, violation) : '') +
        `<span class="rv-stat rv-stat-add">+${file.additions}</span>` +
        `<span class="rv-stat rv-stat-del">-${file.deletions}</span>` +
        // Partial snippet cards name the full-file total so `+1 −0` is never
        // mistaken for "this file only added one line". Expand updates the
        // visible counts in place; the "of" clause stays put.
        (partialStats
          ? `<span class="rv-stat rv-stat-of">of +${file.fullAdditions} −${file.fullDeletions}</span>`
          : '') +
        blameHeaderHtml(lineAttribution?.get(file.path)) +
        (allowViewed ? `<label class="rv-viewed" hidden><input type="checkbox" class="rv-viewed-box"> Viewed</label>` : '') +
        `</header>`,
    );

    if (file.binary) {
      out.push('<p class="rv-binary">Binary file — not shown.</p></section>');
      continue;
    }
    if (file.hunks.length === 0) {
      out.push('<p class="rv-binary">No textual changes.</p></section>');
      continue;
    }

    // Complete post-image mermaid fences get a presentation row after the
    // closing fence. Incomplete / mid-edit fences are left as source only —
    // see src/server/mermaid.ts. Anchors on the fence lines are untouched.
    const mermaidBlocks = findMermaidDiffBlocks(file);
    const { srcOf: mermaidSrcOf, afterClose: mermaidAfterClose } = mermaidDiffIndex(
      file,
      mermaidBlocks,
    );

    // The table scrolls inside its own container: diff lines must not wrap
    // (a wrapped line breaks the 1:1 row-to-line-number correspondence the
    // comment anchors rely on), and .rv-file clips overflow for its rounded
    // corners, so without this a long line is simply unreadable past the
    // right edge.
    // A presented view of this file sits beside its line diff, not instead of
    // it: the source pane is only wrapped so the switch has something to hide.
    // Both ship in the page, so switching back is instant and needs no fetch.
    const pane = presentedPanes?.get(file.path);
    if (pane) out.push(pane, '<div data-rv-show="source">');
    // THE SUBTASK-BLAME GUTTER. On by default only where it tells the reviewer
    // something they do not already know: a file several units touched. On a
    // single-claimant file every changed line is the same unit's by
    // construction, so the column would be one label repeated down the page —
    // the header chip above says the same thing once, and the toggle is there
    // for anyone who wants the spine anyway.
    const blame = lineAttribution?.get(file.path);
    // More than one unit TOUCHED the file is not the same as more than one
    // unit's lines SURVIVING in it — a file whose earlier author was entirely
    // rewritten is multi-claimant and still has one owner from top to bottom.
    // The gutter would be one label repeated down the page there, which is
    // exactly the case the default is meant to exclude.
    const blameOn = blameUnitCount(blame) > 1;
    out.push(
      `<div class="rv-diff-scroll${blameOn ? ' rv-blame-on' : ''}">` +
      `<table class="rv-diff"><tbody>`,
    );
    // Split-row index, running across the whole file so no two rows of one
    // table ever share a group id.
    let pair = 0;
    const gaps = allowExpand ? contextGaps(file) : null;
    for (let hi = 0; hi < file.hunks.length; hi++) {
      const h = file.hunks[hi];
      const gapBefore = gaps?.before[hi];
      if (gapBefore) {
        out.push(expandRowHtml(file, gapBefore, `${fileId}-g${hi}`, hi === 0 ? 'top' : 'mid'));
      }
      out.push(
        `<tr class="rv-hunk"><td colspan="${DIFF_COLSPAN}">${escapeHtml(h.header)}</td></tr>`,
      );
      // Which split row each line belongs to, and which pane(s) it fills.
      // Emitted as data attributes so the side-by-side layout is a mechanical
      // regrouping in the browser rather than a second pairing implementation.
      const paneOf = new Map<DiffLine, { pair: number; pane: 'l' | 'r' | 'lr' }>();
      for (const row of pairSplitRows(h.lines)) {
        const idx = pair++;
        if (row.left && row.left === row.right) paneOf.set(row.left, { pair: idx, pane: 'lr' });
        else {
          if (row.left) paneOf.set(row.left, { pair: idx, pane: 'l' });
          if (row.right) paneOf.set(row.right, { pair: idx, pane: 'r' });
        }
      }

      // Runs are computed per hunk — a spine spanning a gap of unshown lines
      // would claim lines nobody is looking at.
      const blameRows = blameOn ? blameRunRows(h.lines, blame!.runs) : [];
      const blameAt = new Map<number, { html: string; cls: string }>();
      for (const run of blameRows) {
        for (let i = run.first; i <= run.last; i++) {
          const edge = i === run.first ? ' rv-blame-first' : '';
          const tail = i === run.last ? ' rv-blame-last' : '';
          blameAt.set(i, {
            cls: `rv-blame-run${edge}${tail}`,
            // ONE label per run, at its vertical middle, not a link repeated on
            // every line — the spine says how far the run reaches.
            html: i === run.label ? blameLabelHtml(run) : '',
          });
        }
      }

      for (let li = 0; li < h.lines.length; li++) {
        const line = h.lines[li];
        const anchor = anchorForLine(file.path, line);
        const cls = line.kind === 'add' ? 'rv-add' : line.kind === 'del' ? 'rv-del' : 'rv-ctx';
        const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
        const attrs = anchor
          ? ` id="${escapeHtml(anchorDomId(anchor))}" data-file="${escapeHtml(anchor.file)}"` +
            ` data-side="${anchor.side}" data-line="${anchor.line}"`
          : '';
        const p = paneOf.get(line);
        const pairAttrs = p ? ` data-rv-pair="${p.pair}" data-rv-pane="${p.pane}"` : '';
        const mermaidId = mermaidSrcOf.get(`${hi}:${li}`);
        const mermaidSrcAttr = mermaidId
          ? ` data-lz-mermaid-src="${escapeHtml(mermaidId)}"`
          : '';
        const blameCell = blameOn
          ? (() => {
            const at = blameAt.get(li);
            return `<td class="rv-blame ${escapeHtml(at?.cls ?? '')}">${at?.html ?? ''}</td>`;
          })()
          : '';
        out.push(
          `<tr class="rv-line ${cls}"${attrs}${pairAttrs}${mermaidSrcAttr}>` +
            blameCell +
            `<td class="rv-num">${line.oldLine ?? ''}</td>` +
            `<td class="rv-num">${line.newLine ?? ''}</td>` +
            `<td class="rv-gutter">${allowComments ? '<button type="button" class="rv-add-comment" title="Comment on this line" aria-label="Comment on this line">+</button>' : ''}</td>` +
            `<td class="rv-code">${escapeHtml(sign + line.content)}</td></tr>`,
        );

        if (anchor) {
          const threads = threadsByAnchor.get(anchorKey(anchor)) ?? [];
          for (const t of threads) {
            // The thread carries its own anchor. In the side-by-side layout the
            // row above it holds BOTH sides, so "the line this reply belongs to"
            // can no longer be read off the preceding row.
            out.push(
              `<tr class="rv-thread-row" data-thread="${escapeHtml(t.threadId)}"` +
                ` data-file="${escapeHtml(anchor.file)}" data-side="${anchor.side}" data-line="${anchor.line}">` +
                `<td colspan="${DIFF_COLSPAN}">${t.html}</td></tr>`,
            );
          }
        }

        const mermaidBlock = mermaidAfterClose.get(`${hi}:${li}`);
        if (mermaidBlock) {
          // A comment on the DIAGRAM anchors to the line the fence opens on:
          // that is the line the reviewer would have clicked if they were
          // reading the source, and it stays put while the diagram is showing.
          const openLine = file.hunks[mermaidBlock.openHunk]?.lines[mermaidBlock.openLine];
          const diagramAnchor = openLine ? anchorForLine(file.path, openLine) : null;
          out.push(
            mermaidDiffRowHtml(
              mermaidBlock,
              allowComments && diagramAnchor ? diagramAnchor : undefined,
            ),
          );
        }
      }
    }
    if (gaps?.after) {
      // The end of the gap is unknown here — the server does not read the file
      // to render the diff, and will not start now. The browser learns where
      // EOF is from the first response and drops the control if there was
      // nothing left to show.
      out.push(expandRowHtml(file, gaps.after, `${fileId}-gend`, 'bottom'));
    }
    out.push('</tbody></table></div>');
    if (pane) out.push('</div>');
    out.push('</section>');
  }
  return out.join('\n');
}

/**
 * One run's label: the task code, linked to that subtask's page.
 *
 * The CODE, not the goal — a goal is a sentence and this sits in a column
 * beside code. The goal is the hover, which is where a name you do not
 * recognise gets explained without costing width.
 *
 * A unit with no task code (a bare commit region, a PR) shows its id, and is
 * not a link: there is no task page to send anyone to, and a dead link is
 * worse than plain text.
 */
function blameLabelHtml(run: { region: string; code?: string; title: string }): string {
  const text = escapeHtml(run.code ?? run.region);
  const title = escapeHtml(run.title);
  return run.code
    ? `<a class="rv-blame-label" href="/tasks/${encodeURIComponent(run.code)}" title="${title}">${text}</a>`
    : `<span class="rv-blame-label" title="${title}">${text}</span>`;
}

/**
 * The file header's attribution chip, and the gutter's toggle.
 *
 * On a SINGLE-claimant file this is the whole annotation: one unit wrote every
 * changed line, so saying it once in the header is both cheaper and easier to
 * read than a column repeating it. On a multi-claimant file it says how many
 * units are in the file and offers the switch, because the gutter is a reading
 * aid and a reader who does not want it should pay nothing for it.
 */
function blameHeaderHtml(attribution: FileLineAttribution | undefined): string {
  if (!attribution) return '';
  const units = blameUnitCount(attribution);
  if (units > 1) {
    return (
      `<button type="button" class="rv-blame-toggle" data-rv-blame-toggle aria-pressed="true"` +
      ` title="Show or hide which subtask wrote each line">` +
      `${units} units</button>`
    );
  }
  // One unit's work, however many touched it: name it once.
  const only = attribution.owner
    ?? (attribution.runs[0] ? { region: attribution.runs[0].region, code: attribution.runs[0].code, title: attribution.runs[0].title } : undefined);
  if (!only) return '';
  return `<span class="rv-blame-chip" title="${escapeHtml(only.title)}">` +
    (only.code
      ? `<a href="/tasks/${encodeURIComponent(only.code)}">${escapeHtml(only.code)}</a>`
      : escapeHtml(only.region)) +
    `</span>`;
}

/** Distinct units whose lines SURVIVE in this file. Zero without attribution. */
function blameUnitCount(attribution: FileLineAttribution | undefined): number {
  if (!attribution || !attribution.multi) return 0;
  return new Set(attribution.runs.map((r) => r.region)).size;
}

/**
 * The reviewer's decision on one protected file — on the FILE header, never
 * on a hunk card. Presented and Raw may each show one copy (they are
 * independent views of the same stored record); consecutive snippets of the
 * same file share this one control.
 *
 * A decision you cannot see the diff for is not a decision, so this does not
 * appear in the summary at the top of the page: that summary reports state and
 * links here. The label states the consequence in full rather than naming a
 * status, because "pending" tells the reviewer nothing about what is going to
 * happen to their code.
 *
 * Two explicit buttons rather than a checkbox, so the standing answer is
 * readable instead of implied by an empty box.
 */
export function violationDecision(
  taskId: string,
  file: string,
  status: 'pending' | 'approved' | 'rejected',
): string {
  const approved = status === 'approved';
  const state = approved
    ? '✅ protected — change accepted'
    : '⛔ protected — change will be reverted';
  const button = (value: '0' | '1', label: string, on: boolean) =>
    `<button type="submit" name="approved" value="${value}"` +
    ` class="rv-decide-btn${on ? ' rv-decide-on' : ''}"` +
    ` aria-pressed="${on ? 'true' : 'false'}">${escapeHtml(label)}</button>`;
  return (
    `<form class="rv-decide" method="post" action="/tasks/${escapeHtml(taskId)}/review/violation"` +
    ` data-rv-decide="${escapeHtml(file)}" data-approved="${approved ? '1' : '0'}">` +
    `<input type="hidden" name="file" value="${escapeHtml(file)}">` +
    `<span class="rv-decide-state">${state}</span>` +
    button('0', 'Reject', !approved) +
    button('1', 'Approve', approved) +
    `</form>`
  );
}

/**
 * A fingerprint of this file's diff content.
 *
 * The "viewed" tick has to survive later review rounds but must clear itself
 * the moment the agent touches the file again — a tick that outlived the change
 * it referred to would be worse than none, because it says "I have read this"
 * about code nobody has read. Hashing the hunk headers and line contents gives
 * exactly that: same content, same key, tick stands; content moves, key
 * changes, tick is gone.
 */
function fileContentHash(file: DiffFile): string {
  const parts: string[] = [];
  for (const h of file.hunks) {
    parts.push(h.header);
    for (const l of h.lines) parts.push(`${l.kind}:${l.content}`);
  }
  return hashKey(parts.join('\n'));
}

/**
 * The DOM id of a file's diff section, so the accept checklist, the
 * protected-file summary, and the Changes ToC can link straight to the file
 * whose decision is outstanding. Hash navigation then scrolls that card into
 * view and marks it current (see review-navigation.ts).
 */
export function fileSectionId(path: string): string {
  return `f-${hashKey(path)}`;
}

/** Stable map key for an anchor. */
export function anchorKey(a: DiffAnchor): string {
  return `${a.file} ${a.side} ${a.line}`;
}

/**
 * The DOM id of the diff row an anchor points at, so a queued comment listed at
 * the top or bottom of the page can link back to the line it was written on.
 *
 * Deliberately built with encodeURIComponent rather than the private hashKey
 * below: the island has to produce the same id in the browser for threads it
 * renders client-side, and duplicating a hash function in two languages is how
 * anchors silently stop resolving. encodeURIComponent exists on both sides and
 * escapes the '/' and '.' of a path into something safe in a URL fragment.
 */
export function anchorDomId(a: DiffAnchor): string {
  return `l-${encodeURIComponent(a.file)}-${a.side}-${a.line}`;
}

/**
 * Same hash the viewable-card mechanism uses — a file's content hash and a
 * card's are produced by one function, so a tick means the same thing on both.
 */
const hashKey = shortHash;

/*
 * The diff PRESENTATION lives in src/server/styles/diff.css, not here.
 *
 * It is served from a route (see ./styles.ts) so a look change is a CSS edit
 * rather than a code edit, and both surfaces that render this module — the
 * review page and commit detail — pick it up from the one stylesheet. Adding a
 * `<style>` block back into this file would give one of them a second source
 * of truth for the same classes.
 */

/**
 * The diff view toolbar: one group per view mode, rendered above the diff on
 * both pages.
 *
 * Deliberately a LIST of modes rather than a pair of hand-written controls. The
 * review surface is heading towards presenting a change (rendered markdown,
 * diagrams, images) rather than printing its lines, and every such mode needs an
 * escape hatch back to the source sitting right next to it. Adding one means
 * adding a row here and an applier in diffViewScript — not inventing a second
 * kind of control somewhere else on the page.
 */
export interface DiffViewMode {
  /** Dataset key on each button; also the localStorage key suffix. */
  name: string;
  label: string;
  /** Values in display order; the first is the default. */
  options: { value: string; label: string }[];
}

export const DIFF_VIEW_MODES: DiffViewMode[] = [
  {
    name: 'layout',
    label: 'Layout',
    options: [
      { value: 'unified', label: 'Unified' },
      { value: 'split', label: 'Split' },
    ],
  },
  {
    name: 'wrap',
    label: 'Long lines',
    options: [
      { value: '0', label: 'Scroll' },
      { value: '1', label: 'Wrap' },
    ],
  },
];

/**
 * Presented vs source, and the escape hatch back to the lines.
 *
 * Deliberately NOT named for markdown. Markdown is simply the first file type
 * with a presented form; diagrams, SVGs and images are the same idea, and when
 * they arrive they hang off this one switch rather than growing a second
 * control per type. A file with no presented form is unaffected by it.
 *
 * Not in DIFF_VIEW_MODES because it is only meaningful on a page that has at
 * least one presentable file — on a page of TypeScript it would toggle nothing.
 * "Files" rather than "View" because the toolbar above it already says
 * "Changes: Presented | Raw files" for the agent's own walkthrough; these are
 * two different questions and they must not read as one.
 */
export const PRESENTED_VIEW_MODE: DiffViewMode = {
  name: 'presented',
  label: 'Files',
  options: [
    { value: 'presented', label: 'Presented' },
    { value: 'source', label: 'Source' },
  ],
};

export function diffViewOptionsHtml(options: { presented?: boolean } = {}): string {
  const modes = options.presented ? [...DIFF_VIEW_MODES, PRESENTED_VIEW_MODE] : DIFF_VIEW_MODES;
  const groups = modes.map((mode) => {
    const buttons = mode.options
      .map(
        (opt, i) =>
          `<button type="button" data-rv-mode="${escapeHtml(mode.name)}" data-rv-value="${escapeHtml(opt.value)}"` +
          ` aria-pressed="${i === 0 ? 'true' : 'false'}">${escapeHtml(opt.label)}</button>`,
      )
      .join('');
    return `<span class="rv-viewopt-group"><span>${escapeHtml(mode.label)}</span>${buttons}</span>`;
  }).join('');
  return `<div class="rv-viewopts" hidden data-rv-viewopts>${groups}</div>`;
}

/**
 * The browser half of the presented/source switch.
 *
 * Emitted inside diffViewScript as part of the shared view-mode machinery, so
 * the choice is remembered exactly like layout and wrap. It knows nothing about
 * markdown: it flips `[data-rv-show]` panes, and any presenter that emits that
 * pair of panes is switched by it for free.
 *
 * Two behaviours beyond the plain switch, both about not stranding the reviewer:
 *   - a per-passage "+" jumps to the source line the passage came from and
 *     opens the comment box there, so commenting on presented prose is one
 *     click, not a mode switch the reviewer has to think about;
 *   - a fragment link into a hidden source pane (a queued comment, a thread
 *     permalink) forces source first, so the row it points at is on screen.
 */
export function presentedViewScript(): string {
  return `
  function applyPresented(value) {
    var panes = root.querySelectorAll('[data-rv-show]');
    var presented = value !== 'source';
    for (var i = 0; i < panes.length; i++) {
      var isPresented = panes[i].getAttribute('data-rv-show') === 'presented';
      panes[i].hidden = isPresented ? !presented : presented;
    }
  }

  // Jump to the source line a presented passage came from, and open its
  // comment box.
  root.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('[data-rv-show-anchor]') : null;
    if (btn) {
      ev.preventDefault();
      set('presented', 'source', false);
      var row = document.getElementById(btn.dataset.target);
      if (row) {
        row.scrollIntoView({ block: 'center' });
        var add = row.querySelector('.rv-add-comment');
        if (add) add.click();
      }
      return;
    }
    var toSource = ev.target.closest ? ev.target.closest('[data-rv-show-source]') : null;
    if (toSource) {
      ev.preventDefault();
      set('presented', 'source', true);
    }
  });

  function revealHashTarget() {
    if (!window.location.hash) return;
    var el = null;
    try { el = document.getElementById(decodeURIComponent(window.location.hash.slice(1))); }
    catch (e) { el = null; }
    if (!el) el = document.getElementById(window.location.hash.slice(1));
    if (!el || !el.closest) return;
    var pane = el.closest('[data-rv-show="source"]');
    // Not persisted: following one link should not silently change how every
    // later file is presented.
    if (pane && pane.hidden) { set('presented', 'source', false); el.scrollIntoView({ block: 'center' }); }
  }
  // This whole script re-runs every time its tab body is (re)fetched (see
  // activateScripts in task-tabs.ts). \`window\` outlives every body, so a
  // \`window.addEventListener\` here would add one more permanent listener —
  // closing over this run's possibly-since-removed \`root\`/\`set\` — on every
  // refetch. Register the listener itself only once per page (window.lzOnce),
  // and always dispatch through whichever run's revealHashTarget is CURRENT:
  // every run overwrites the pointer, so the one listener always drives the
  // live body.
  //
  // window.lzOnce is a hard assumption here, not a feature check — see the
  // matching note in changesViewScript (review-presentation.ts), including
  // why the fallback below (not an \`if\`) is what keeps a genuinely
  // lzOnce-less page (a bare \`?fragment=1\` navigation) surviving instead of
  // crashing.
  window.__lzRevealHashTarget = revealHashTarget;
  (window.lzOnce || function (k, f) { f(); })('diff-hashchange', function () {
    window.addEventListener('hashchange', function () {
      if (window.__lzRevealHashTarget) window.__lzRevealHashTarget();
    });
  });
  setTimeout(revealHashTarget, 0);
`;
}

/**
 * Wrap and layout behaviour, shared by both diff pages. (Per-file collapse
 * moved to the shared viewable-section island, which files and markdown cards
 * both run — see src/server/viewed-cards.ts.)
 *
 * All of it is pure view state, so the controls ship hidden and this unhides
 * them: with JS off they would be dead chrome, while the diff itself still
 * renders — unified, which is the layout that needs no JS at all. Each choice
 * is one setting for the whole tool, not per page and not per file: they
 * describe how this reviewer reads code.
 *
 * Wrap is a class. Layout is a DOM regrouping, because pairing a deletion with
 * the addition that replaced it merges two rows into one, and no stylesheet can
 * change how many rows a table has. The regrouping is mechanical — the server
 * already stamped every line with the split row it belongs to (data-rv-pair /
 * data-rv-pane) — and it moves the original cells rather than re-rendering
 * text, so nothing here can mis-escape a line of code.
 *
 * The unified <tbody> is DETACHED, not hidden, while split is showing. Two
 * copies of the diff in one document would mean two elements carrying each
 * anchor's id, and a duplicated id is a fragment link that lands on the wrong
 * one — the queued-comment list is built entirely out of those links.
 *
 * `rootSelector` is where the mode classes land; the review page scopes it to
 * its diff container, the commit page to the whole document.
 *
 * `expandUrl` turns on the expand-context controls: it is the endpoint that
 * serves a line range of a file at the task's refs. Omitted, the controls stay
 * hidden — a surface with nowhere to fetch lines from renders none anyway, and
 * this keeps that true even if one ever slips into the markup.
 */
export function diffViewScript(rootSelector: string, expandUrl?: string): string {
  return `<script>
(function () {
  var root = document.querySelector(${scriptJson(rootSelector)});
  if (!root) return;

  // Per-file collapse is NOT here: it is the shared viewable-section island
  // (viewedStateScript), which drives files and markdown cards with one
  // handler — it also unhides the chevron, which carries both rv-file-toggle
  // and rv-vw-toggle. Two click handlers on the same chevron would toggle it
  // twice. Every page emitting this script emits that island too.

  // The subtask-blame toggle. Pure view state: both the column and the file's
  // rows are already in the page, so switching costs a class and never a fetch
  // — which is what "a reader who does not want it pays nothing" has to mean
  // for a reader who turns it on again a second later.
  root.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest && ev.target.closest('[data-rv-blame-toggle]');
    if (!btn) return;
    var section = btn.closest('.rv-file');
    if (!section) return;
    var on = false;
    var scrolls = section.querySelectorAll('.rv-diff-scroll');
    for (var i = 0; i < scrolls.length; i++) {
      on = scrolls[i].classList.toggle('rv-blame-on');
    }
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });

  var EXPAND_URL = ${scriptJson(expandUrl ?? '')};
  var CHUNK = ${EXPAND_CHUNK_LINES};
  // The server clamps to this; asking for exactly it keeps "expand to the
  // bottom" a single round trip when the gap fits, and the atEof flag decides
  // whether the control survives when it does not.
  var MAX_EXPAND = ${MAX_EXPAND_LINES};
  if (EXPAND_URL) installExpand();

  // Expanded context is fetched, not guessed: the browser never reads git, and
  // never invents a line it did not receive. Every revealed row carries the
  // same (file, side, line) anchor the server would have given it. When the
  // card is a presentation snippet, a revealed line that is an addition in
  // the FULL file paints as an add — never as unchanged context.
  function installExpand() {
    var rows = root.querySelectorAll('tr.rv-expand');
    for (var i = 0; i < rows.length; i++) rows[i].hidden = false;

    root.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.rv-expand-btn') : null;
      if (!btn || btn.disabled) return;
      var visibleRow = btn.closest('tr.rv-expand');
      var table = btn.closest('table.rv-diff');
      if (!visibleRow || !table) return;
      // In side-by-side the visible row is a clone; the row that actually holds
      // the file's order is the one in the stashed unified body.
      var body = table.__rvUnified || table.tBodies[0];
      var row = body.querySelector('tr.rv-expand[data-rv-gap="' + visibleRow.dataset.rvGap + '"]');
      if (!row) return;
      expand(table, body, row, visibleRow, btn.dataset.rvExpandDir);
    });
  }

  function expand(table, body, row, visibleRow, dir) {
    var start = parseInt(row.dataset.start, 10);
    var end = row.dataset.end ? parseInt(row.dataset.end, 10) : null;
    var delta = parseInt(row.dataset.delta, 10) || 0;
    var from = start;
    var to = end === null ? start + CHUNK - 1 : end;
    if (dir === 'up' && end !== null) from = Math.max(start, end - CHUNK + 1);
    else if (dir === 'down') to = end === null ? start + CHUNK - 1 : Math.min(end, start + CHUNK - 1);
    else if (dir === 'all' && end === null) to = start + MAX_EXPAND - 1;

    setBusy(visibleRow, true);
    var url = EXPAND_URL + '?path=' + encodeURIComponent(row.dataset.file) +
      '&side=new&start=' + from + '&end=' + to;
    fetch(url, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        setBusy(visibleRow, false);
        if (!res.ok) { fail(visibleRow, res.data && res.data.error); return; }
        apply(table, body, row, res.data, delta, dir, start, end);
      })
      .catch(function (err) {
        setBusy(visibleRow, false);
        fail(visibleRow, err && err.message);
      });
  }

  function apply(table, body, row, data, delta, dir, start, end) {
    var lines = data.lines || [];
    var proto = body.querySelector('.rv-add-comment');
    var section = row.closest('section.rv-file');
    var addSet = addSetFor(section);
    var frag = document.createDocumentFragment();
    var revealedAdds = 0;
    for (var i = 0; i < lines.length; i++) {
      var newLine = data.start + i;
      // A presentation snippet can leave real additions in the "gap". Those
      // lines still exist in the post-image; painting them as context is a
      // lie (the engineer then asks how the code compiled before). Classify
      // from the full-file add index stamped on the section.
      var isAdd = addSet && addSet[newLine];
      if (isAdd) revealedAdds++;
      frag.appendChild(revealedRow(row, newLine, delta, lines[i], proto, !!isAdd));
    }
    // Revealed lines sit against the hunk they came from: lines above the next
    // hunk go below the control, lines below the previous hunk go above it.
    if (dir === 'up') body.insertBefore(frag, row.nextSibling);
    else body.insertBefore(frag, row);

    if (revealedAdds > 0) bumpVisibleAdds(section, revealedAdds);

    // A very large gap is clamped by the server, so "expand all" can come back
    // short: what is left over stays behind the control rather than becoming
    // unreachable.
    var exhausted = lines.length === 0 || data.atEof;
    if (dir === 'up') {
      end = data.start - 1;
      if (end < start) exhausted = true;
    } else {
      start = data.end + 1;
      if (end !== null && start > end) exhausted = true;
    }
    if (exhausted) body.removeChild(row);
    else {
      row.dataset.start = start;
      if (end !== null) row.dataset.end = end;
      var count = row.querySelector('.rv-expand-count');
      if (count) {
        var left = end === null ? null : end - start + 1;
        var base = end === null ? 'to end of file' :
          left + ' hidden line' + (left === 1 ? '' : 's');
        var changesLeft = countAddsRemaining(addSet, start, end);
        count.textContent = changesLeft > 0
          ? base + ' · ' + changesLeft + ' change' + (changesLeft === 1 ? '' : 's')
          : base;
      }
    }
    if (table.dataset.rvLayout === 'split' && table.__rvUnified) {
      table.replaceChild(buildSplit(table.__rvUnified), table.tBodies[0]);
      // Side-by-side is rebuilt from the unified body, so anything the LIVE
      // body was holding — a thread posted since, a comment box being typed
      // into — is not in the new one. Announce it exactly as a layout switch
      // does: the review island re-renders threads and puts every saved draft
      // back. Without this, expanding context silently ate the words.
      root.dispatchEvent(new CustomEvent('rv:layout', { bubbles: true, detail: { split: true } }));
    }
  }

  // Full-file addition line numbers, parsed once per section from the
  // server-stamped data-rv-new-adds attribute.
  function addSetFor(section) {
    if (!section || !section.dataset.rvNewAdds) return null;
    if (!section.__rvAddSet) {
      section.__rvAddSet = Object.create(null);
      var parts = section.dataset.rvNewAdds.split(',');
      for (var i = 0; i < parts.length; i++) {
        if (parts[i]) section.__rvAddSet[Number(parts[i])] = true;
      }
    }
    return section.__rvAddSet;
  }

  function countAddsRemaining(addSet, start, end) {
    if (!addSet) return 0;
    var n = 0;
    for (var key in addSet) {
      if (!Object.prototype.hasOwnProperty.call(addSet, key)) continue;
      var line = Number(key);
      if (line < start) continue;
      if (end !== null && line > end) continue;
      n++;
    }
    return n;
  }

  // Keep the card header's +N in sync with what the reviewer can actually see.
  // The "of +X −Y" clause is the full-file total; drop it once visible catches up.
  function bumpVisibleAdds(section, n) {
    if (!section || n <= 0) return;
    var next = (parseInt(section.dataset.rvVisibleAdd, 10) || 0) + n;
    section.dataset.rvVisibleAdd = String(next);
    var el = section.querySelector('.rv-stat-add');
    if (el) el.textContent = '+' + next;
    var of = section.querySelector('.rv-stat-of');
    if (of) {
      // Backslashes DOUBLED: this island is a template literal, so written
      // singly they are eaten and the browser gets /of +(d+)/ — a valid regex
      // that can never match, so the "of +X" clause never cleared and a
      // fully-expanded file went on claiming there was more to see.
      var m = /of \\+(\\d+)/.exec(of.textContent || '');
      if (m && next >= Number(m[1])) of.remove();
    }
  }

  function revealedRow(row, newLine, delta, text, proto, isAdd) {
    var tr = document.createElement('tr');
    tr.className = isAdd ? 'rv-line rv-add' : 'rv-line rv-ctx';
    var file = row.dataset.file;
    tr.id = 'l-' + encodeURIComponent(file) + '-new-' + newLine;
    tr.dataset.file = file;
    tr.dataset.side = 'new';
    tr.dataset.line = String(newLine);
    // Adds fill only the new pane (same as server-rendered additions);
    // context fills both, with old = new + delta.
    tr.dataset.rvPair = row.dataset.rvGap + '-' + newLine;
    tr.dataset.rvPane = isAdd ? 'r' : 'lr';
    tr.appendChild(cell('rv-num', isAdd ? '' : String(newLine + delta)));
    tr.appendChild(cell('rv-num', String(newLine)));
    var gut = cell('rv-gutter');
    if (proto) gut.appendChild(proto.cloneNode(true));
    tr.appendChild(gut);
    tr.appendChild(cell('rv-code', (isAdd ? '+' : ' ') + text));
    return tr;
  }

  function setBusy(visibleRow, busy) {
    var btns = visibleRow.querySelectorAll('.rv-expand-btn');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = busy;
  }

  function fail(visibleRow, message) {
    var count = visibleRow.querySelector('.rv-expand-count');
    if (count) count.textContent = 'Could not load lines' + (message ? ': ' + message : '');
  }

  var bar = document.querySelector('[data-rv-viewopts]');
  if (!bar) return;
  bar.hidden = false;

  // This bar is the second level of the sticky stack, so card headers park
  // under it and the offset they use has just changed: it was 0 tall a moment
  // ago. review-navigation.ts watches the element with a ResizeObserver, but
  // that is an optimisation of this line, not a replacement for it — where
  // ResizeObserver is missing this is the only signal that the bar now has a
  // height, and without it every file header sits underneath this bar.
  if (window.lzRefreshStickyTop) window.lzRefreshStickyTop();

  // Two panes of code do not fit on a phone, and a diff you can only reach by
  // scrolling sideways is worse than one column. Below the breakpoint the
  // layout is forced back to unified and the Split button is disabled — the
  // stored preference is left alone, so widening the window restores it.
  var narrow = window.matchMedia('(max-width: 900px)');

  function cell(cls, text) {
    var td = document.createElement('td');
    td.className = cls;
    if (text !== undefined) td.textContent = text;
    return td;
  }

  // One side of a split row, built from the unified <tr> that supplied it.
  // srcTr is null for filler (the side of a change block with no counterpart).
  function pane(tr, srcTr, which) {
    var kind = 'nil';
    if (srcTr) {
      kind = srcTr.classList.contains('rv-add') ? 'add'
        : srcTr.classList.contains('rv-del') ? 'del' : 'ctx';
    }
    var k = ' rv-c-' + kind;
    var num = cell('rv-num' + k + (which === 'new' ? ' rv-pane-new' : ''));
    var gut = cell('rv-gutter' + k);
    var code = cell('rv-code' + k);
    if (srcTr) {
      var nums = srcTr.querySelectorAll('td.rv-num');
      var n = which === 'old' ? nums[0] : nums[1];
      num.textContent = n ? n.textContent : '';
      var srcCode = srcTr.querySelector('td.rv-code');
      code.textContent = srcCode ? srcCode.textContent : '';
      // The anchor belongs to exactly one side (a context line anchors on the
      // post-image, same as unified), so it lands on that side's code cell and
      // the line stays addressable by the same (file, side, line) it always had.
      if (srcTr.dataset.line && srcTr.dataset.side === which) {
        if (srcTr.id) code.id = srcTr.id;
        code.dataset.file = srcTr.dataset.file;
        code.dataset.side = srcTr.dataset.side;
        code.dataset.line = srcTr.dataset.line;
        var btn = srcTr.querySelector('.rv-add-comment');
        if (btn) gut.appendChild(btn.cloneNode(true));
      }
    }
    tr.appendChild(num);
    tr.appendChild(gut);
    tr.appendChild(code);
  }

  function buildSplit(tbody) {
    var out = document.createElement('tbody');
    var group = null;

    function flush() {
      if (!group) return;
      var tr = document.createElement('tr');
      tr.className = 'rv-pair';
      pane(tr, group.left, 'old');
      pane(tr, group.right, 'new');
      out.appendChild(tr);
      // Threads follow the pair they were written against. Both sides' threads
      // hang off the one row, which is also where a reply form will open.
      for (var i = 0; i < group.extras.length; i++) out.appendChild(group.extras[i]);
      group = null;
    }

    var rows = tbody.rows;
    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i];
      if (tr.classList.contains('rv-line')) {
        var p = tr.dataset.rvPair;
        if (!group || group.pair !== p) { flush(); group = { pair: p, left: null, right: null, extras: [] }; }
        var side = tr.dataset.rvPane || '';
        if (side.indexOf('l') >= 0) group.left = tr;
        if (side.indexOf('r') >= 0) group.right = tr;
      } else if (tr.classList.contains('rv-thread-row')) {
        var copy = tr.cloneNode(true);
        if (group) group.extras.push(copy); else out.appendChild(copy);
      } else if (tr.classList.contains('rv-form-row')) {
        // Not carried across: a cloned <textarea> arrives empty, and this
        // rebuild reads the STASHED unified body, which never held the form in
        // the first place. The words are not in the DOM — they autosave under
        // their anchor — so the review island re-opens the box from the saved
        // draft once the new body is in place (review.ts, restoreDrafts).
        continue;
      } else {
        flush();
        out.appendChild(tr.cloneNode(true));
      }
    }
    flush();
    return out;
  }

  function applyLayout(value) {
    var split = value === 'split' && !narrow.matches;
    var tables = root.querySelectorAll('table.rv-diff');
    var changed = false;
    for (var i = 0; i < tables.length; i++) {
      var table = tables[i];
      var isSplit = table.dataset.rvLayout === 'split';
      if (split === isSplit) continue;
      var live = table.tBodies[0];
      if (!live) continue;
      if (split) {
        // Stash the live unified body — threads and all — so switching back is
        // a re-attach rather than an inverse transform.
        table.__rvUnified = live;
        table.replaceChild(buildSplit(live), live);
        table.dataset.rvLayout = 'split';
      } else if (table.__rvUnified) {
        table.replaceChild(table.__rvUnified, live);
        table.__rvUnified = null;
        table.dataset.rvLayout = 'unified';
      }
      changed = true;
    }
    root.classList.toggle('rv-split', split);
    if (changed) {
      // Threads posted while the other layout was live are in the body that was
      // just swapped out. The review island listens for this and re-renders
      // them; the commit page has none and ignores it.
      root.dispatchEvent(new CustomEvent('rv:layout', { bubbles: true, detail: { split: split } }));
    }
  }

${presentedViewScript()}
  var MODES = {
    presented: { key: 'lazy:diffpresented', def: 'presented', apply: applyPresented },
    layout: { key: 'lazy:difflayout', def: 'unified', apply: applyLayout },
    wrap: {
      key: 'lazy:diffwrap',
      def: '0',
      apply: function (value) { root.classList.toggle('rv-wrap', value === '1'); },
    },
  };

  var current = {};

  function read(name) {
    try {
      var v = localStorage.getItem(MODES[name].key);
      if (v !== null) return v;
    } catch (e) { /* private mode: view state is not worth failing over */ }
    return MODES[name].def;
  }

  function set(name, value, persist) {
    current[name] = value;
    MODES[name].apply(value);
    var btns = bar.querySelectorAll('[data-rv-mode="' + name + '"]');
    for (var i = 0; i < btns.length; i++) {
      // Reflect what is on screen, not what is stored: below the breakpoint the
      // stored 'split' is not what the reviewer is looking at.
      var effective = name === 'layout' && value === 'split' && narrow.matches ? 'unified' : value;
      btns[i].setAttribute('aria-pressed', btns[i].dataset.rvValue === effective ? 'true' : 'false');
    }
    if (persist) {
      try { localStorage.setItem(MODES[name].key, value); } catch (e) { /* private mode */ }
    }
  }

  function syncNarrow() {
    var splitBtn = bar.querySelector('[data-rv-mode="layout"][data-rv-value="split"]');
    if (splitBtn) {
      splitBtn.disabled = narrow.matches;
      splitBtn.title = narrow.matches ? 'Side by side needs a wider window' : '';
    }
    if (current.layout) set('layout', current.layout, false);
  }

  for (var name in MODES) set(name, read(name), false);
  syncNarrow();

  // This whole script re-runs every time its tab body is (re)fetched (see
  // activateScripts in task-tabs.ts). A MediaQueryList's change listener is
  // not \`document\`/\`window.addEventListener\`, so it is easy to miss in a
  // sweep for those two, but it is the same shape of leak: unguarded, every
  // refetch would register one more \`change\` listener closing over this
  // run's \`bar\`/\`current\`/\`set\`, retaining the whole removed Changes body.
  // One watcher for the page, dispatching through whichever run's syncNarrow
  // is CURRENT (every run overwrites the pointer).
  // The fallback below is deliberate, not an \`if\` — see the note near
  // diff-hashchange above.
  // Registers on the \`narrow\` list built above rather than matching the
  // query a second time: the width belongs in ONE place, or Split disables
  // at one breakpoint while crossings are reported at another. Closing over
  // this run's MediaQueryList is safe for the same reason the neighbouring
  // diff-hashchange and changes-goto-raw guards close over theirs — it is a
  // plain window object, not part of the tab body — and the dispatch goes
  // through the freshest syncNarrow either way.
  window.__lzSyncNarrow = syncNarrow;
  (window.lzOnce || function (k, f) { f(); })('diff-narrow-watch', function () {
    function onChange() { if (window.__lzSyncNarrow) window.__lzSyncNarrow(); }
    if (narrow.addEventListener) narrow.addEventListener('change', onChange);
    else if (narrow.addListener) narrow.addListener(onChange);
  });

  bar.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('[data-rv-mode]') : null;
    if (!btn || btn.disabled) return;
    set(btn.dataset.rvMode, btn.dataset.rvValue, true);
  });
})();
</script>`;
}

/** A complete mermaid fence in a file's diff, as a remote client needs it. */
export interface MermaidDiffDiagram {
  /** The daemon's block id — what keys a diagram's comment draft. */
  id: string;
  source: string;
  /** The line a comment on the diagram anchors to: the fence's opening line. */
  anchor: DiffAnchor | null;
  /** The row the picture goes after: the fence's closing line. */
  after: DiffAnchor | null;
}

/**
 * The diagrams this page draws inside a file's line diff, for a client that
 * renders the diff itself (Lazy Teams). Same fences, same ids and same anchors
 * as `renderReviewDiff`'s presentation rows — computed here, once, so no client
 * re-implements the complete-fence rule, the size cap or the id hash.
 */
export function mermaidDiffDiagrams(file: DiffFile): MermaidDiffDiagram[] {
  return findMermaidDiffBlocks(file).map((block) => {
    const open = file.hunks[block.openHunk]?.lines[block.openLine];
    const close = file.hunks[block.closeHunk]?.lines[block.closeLine];
    return {
      id: block.id,
      source: block.source,
      anchor: open ? anchorForLine(file.path, open) : null,
      after: close ? anchorForLine(file.path, close) : null,
    };
  });
}
