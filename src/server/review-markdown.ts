/**
 * Markdown files in the review diff, rendered as Markdown.
 *
 * A prose file read as a wall of `+` lines is the worst way to review prose:
 * the reviewer is handed the source of a document whose whole point is how it
 * reads. So a `.md` file in a review is PRESENTED — the document, rendered —
 * with the change marked on top of it:
 *
 *   - added / removed file: the whole document, rendered, badged as added or
 *     removed (a removed one renders its PRE-image, muted);
 *   - modified file: the NEW document rendered whole, unchanged stretches
 *     folded away behind "N unchanged lines", changed blocks accented, and
 *     removed text shown inline, muted, where it was removed from.
 *
 * The raw line diff is never replaced, only hidden: both panes are emitted for
 * every markdown file and a page-level toggle switches between them. The
 * presented pane ships `hidden`, so with scripting off the reviewer gets exactly
 * the diff they always got — same posture as every other view control here.
 *
 * PRECISION OF THE MAPPING, in two layers.
 *
 * The file is split into top-level markdown blocks (heading, paragraph, list
 * run, fence, blockquote, rule) carrying their source line ranges, and adjacent
 * blocks of the same kind merge into regions. That layer decides what is FOLDED:
 * a quiet stretch collapses behind "N unchanged lines", a stretch containing a
 * change stays open. It is deliberately coarse — the reviewer wants the changed
 * passage in its context, not a highlight per paragraph.
 *
 * Inside an open region, the added lines are marked on the ELEMENT each one
 * produced: the changed `<li>`, the changed `<p>`, the changed table `<tr>`.
 * That layer decides what is ACCENTED, and it has to be fine, because a region
 * is not: a CHANGELOG's `### Added` list is one block, so accenting the block
 * would paint thirty untouched bullets green to report a two-line edit. Elements
 * are as fine as a renderer of blocks can honestly go — a word changed inside a
 * paragraph accents that paragraph — and the raw diff, one click away, is where
 * character-precision lives.
 *
 * The two layers are why a region is rendered by ONE `renderMarkdown` call over
 * its joined text rather than one call per block: a list run has to stay a
 * single `<ul>` for the document to read as the document, and an `<ol>` split
 * across calls would restart at 1.
 *
 * The source text comes from the file-lines RPC (the same endpoint the expand
 * controls use), fetched server-side before the page renders — no new daemon
 * capability, and no markdown renderer shipped to the browser.
 */

import { renderMarkdown } from './markdown';
import { escapeHtml, anchorDomId, type DiffFile } from './review-diff';
import { MAX_EXPAND_LINES } from '../review/file-lines';

/** Extensions rendered as Markdown. `.mdx` is close enough to read as prose. */
const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdx'];

export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Ceiling on how much of a file we will render.
 *
 * A rendered document is inlined into the page whole (folds hide it, they do
 * not defer it), so an enormous markdown file would be paid for in full by
 * every reviewer who opens the task. Past this, the file keeps its ordinary
 * line diff and nothing else — a slow page is a worse outcome than a plain one.
 */
export const MAX_MARKDOWN_LINES = 4000;

/** An unchanged run shorter than this is left in place rather than folded. */
export const FOLD_MIN_LINES = 6;

export type MarkdownChangeKind = 'added' | 'removed' | 'modified';

/**
 * How this file changed, read off the parsed hunks rather than off the git
 * headers: a file with no pre-image line anywhere was added, one with no
 * post-image line anywhere was removed, anything else was modified. The
 * `+++ /dev/null` header is not carried by the parser, so this is the only
 * signal available — and it is the one that matches what will be rendered.
 */
export function markdownDiffKind(file: DiffFile): MarkdownChangeKind | null {
  if (file.binary || file.hunks.length === 0) return null;
  let sawOld = false;
  let sawNew = false;
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.oldLine !== null) sawOld = true;
      if (l.newLine !== null) sawNew = true;
    }
  }
  if (!sawOld && sawNew) return 'added';
  if (sawOld && !sawNew) return 'removed';
  if (!sawOld && !sawNew) return null;
  return 'modified';
}

/** The side of a markdown file whose text has to be fetched to render it. */
export interface MarkdownSourceRequest {
  /** Path as the file-lines endpoint wants it: post-image for new, pre for old. */
  path: string;
  side: 'old' | 'new';
  /** Path as it appears in the parsed diff — the key the renderer looks up. */
  diffPath: string;
  kind: MarkdownChangeKind;
}

export function markdownSourceRequests(files: DiffFile[]): MarkdownSourceRequest[] {
  const out: MarkdownSourceRequest[] = [];
  for (const file of files) {
    if (!isMarkdownPath(file.path)) continue;
    const kind = markdownDiffKind(file);
    if (kind === null) continue;
    // A removed file only exists on the old side, and there under its
    // pre-image name; everything else renders its post-image.
    out.push(
      kind === 'removed'
        ? { path: file.oldPath ?? file.path, side: 'old', diffPath: file.path, kind }
        : { path: file.path, side: 'new', diffPath: file.path, kind },
    );
  }
  return out;
}

export interface MarkdownSource {
  /** Full text of the side that will be rendered, or null if unavailable. */
  text: string | null;
  /** Set when the file is longer than MAX_MARKDOWN_LINES: render nothing. */
  truncated?: boolean;
}

export type MarkdownSources = Map<string, MarkdownSource>;

export interface FileLinesReader {
  (query: { path: string; side: 'old' | 'new'; start: number; end: number }): Promise<{
    lines: string[];
    atEof: boolean;
  }>;
}

/**
 * Fetch the text behind every markdown file in the diff.
 *
 * One failure is one file that renders as a plain diff, never a failed page:
 * the review surface exists to show the change, and a file whose contents could
 * not be read still has its hunks.
 */
export async function loadMarkdownSources(
  files: DiffFile[],
  read: FileLinesReader,
): Promise<MarkdownSources> {
  const sources: MarkdownSources = new Map();
  for (const req of markdownSourceRequests(files)) {
    try {
      const lines: string[] = [];
      let start = 1;
      let atEof = false;
      while (lines.length < MAX_MARKDOWN_LINES) {
        const end = Math.min(start + MAX_EXPAND_LINES - 1, MAX_MARKDOWN_LINES);
        const chunk = await read({ path: req.path, side: req.side, start, end });
        lines.push(...chunk.lines);
        atEof = chunk.atEof;
        if (atEof || chunk.lines.length === 0) break;
        start = lines.length + 1;
      }
      sources.set(req.diffPath, atEof ? { text: lines.join('\n') } : { text: null, truncated: true });
    } catch {
      // A path the daemon refuses, a worktree that moved, a read error: the
      // file simply keeps its line diff. Nothing here is worth a broken page.
      sources.set(req.diffPath, { text: null });
    }
  }
  return sources;
}

/** A top-level markdown block with the 1-based source lines it came from. */
export interface MarkdownBlock {
  start: number;
  end: number;
  text: string;
}

/**
 * Split markdown into top-level blocks, in source order, with line ranges.
 *
 * Deliberately mirrors the block boundaries `renderMarkdown` itself uses — a
 * fence runs to its closing fence (or, unterminated, to end of file), a run of
 * list lines is ONE block (rendering each item alone would emit a `<ul>` per
 * item), a blank line closes a list or paragraph. Blank lines are absorbed into
 * the preceding block so every line of the file belongs to exactly one block:
 * the fold counts have to add up to the file, and a line owned by nothing would
 * be a line the reviewer never sees in either state.
 */
export function splitMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // A trailing newline terminates the last line; it is not an empty line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  const isFence = (l: string) => l.trimStart().startsWith('```');
  const isBlank = (l: string) => l.trim() === '';
  const isList = (l: string) => /^(\s*)([-*+]|\d+\.)\s+/.test(l);
  const isQuote = (l: string) => l.startsWith('> ');
  const isHeading = (l: string) => /^#{1,6}\s+/.test(l);
  const isHr = (l: string) => /^(-{3,}|\*{3,}|_{3,})$/.test(l.trim());

  while (i < lines.length) {
    const start = i;
    const line = lines[i];

    if (isFence(line)) {
      i++;
      while (i < lines.length && !isFence(lines[i])) i++;
      if (i < lines.length) i++; // closing fence; unterminated stops at EOF
    } else if (isBlank(line)) {
      while (i < lines.length && isBlank(lines[i])) i++;
    } else if (isHeading(line) || isHr(line)) {
      i++;
    } else if (isList(line)) {
      while (i < lines.length && isList(lines[i])) i++;
    } else if (isQuote(line)) {
      while (i < lines.length && isQuote(lines[i])) i++;
    } else {
      // Paragraph: consecutive lines that start no other block.
      i++;
      while (
        i < lines.length &&
        !isBlank(lines[i]) &&
        !isFence(lines[i]) &&
        !isHeading(lines[i]) &&
        !isHr(lines[i]) &&
        !isList(lines[i]) &&
        !isQuote(lines[i])
      ) {
        i++;
      }
    }

    // Trailing blanks belong to the block they follow, so a fold's line count
    // covers the whitespace it swallowed and every line of the file is owned by
    // exactly one block.
    if (!isBlank(lines[start])) {
      while (i < lines.length && isBlank(lines[i])) i++;
    }

    blocks.push({ start: start + 1, end: i, text: lines.slice(start, i).join('\n') });
  }
  return blocks;
}

/** Text removed at a point in the new file, and where it sat. */
export interface RemovedRun {
  /** New-side line this removal follows; 0 means "before the first line". */
  afterLine: number;
  lines: string[];
}

export interface MarkdownRegion {
  kind: 'changed' | 'unchanged';
  blocks: MarkdownBlock[];
  /** 1-based inclusive source range of the whole region. */
  start: number;
  end: number;
  /** Removals anchored inside this region, in source order. */
  removed: RemovedRun[];
  /** First new-side line in this region that the diff marks as added, if any. */
  firstChangedLine: number | null;
  /**
   * Every new-side line in this region the diff marks as added, ascending.
   *
   * This is what accents individual elements inside the region. A region is the
   * unit of folding, not of highlighting: without this, a two-line edit to a
   * long list would report the whole list as new.
   */
  changedLines: number[];
}

/**
 * Deletions in the post-image coordinates they were removed from.
 *
 * A deleted line has no new-side number — that is what makes it deleted — so it
 * is anchored to the post-image line it FOLLOWS: the nearest new-side line
 * above it, or, for a deletion at the very top of a hunk, one line above the
 * first new-side line below it. Anchor 0 means "before the first line of the
 * file", which is where a deletion from the top of the file lands.
 */
export function removedRuns(file: DiffFile): RemovedRun[] {
  const runs: RemovedRun[] = [];
  for (const h of file.hunks) {
    // Next post-image line at or after each index, so a deletion that opens a
    // hunk is anchored just above the hunk instead of at the top of the file.
    const nextNew: (number | null)[] = new Array(h.lines.length).fill(null);
    let seen: number | null = null;
    for (let i = h.lines.length - 1; i >= 0; i--) {
      if (h.lines[i].newLine !== null) seen = h.lines[i].newLine;
      nextNew[i] = seen;
    }

    let lastNew: number | null = null;
    for (let i = 0; i < h.lines.length; i++) {
      const l = h.lines[i];
      if (l.newLine !== null) {
        lastNew = l.newLine;
        continue;
      }
      if (l.kind !== 'del') continue;
      const following = nextNew[i];
      const after = lastNew ?? (following === null ? 0 : Math.max(0, following - 1));
      // Consecutive deletions share an anchor (no post-image line came between
      // them), so they are one removed passage rather than N removed lines.
      const tail = runs[runs.length - 1];
      if (tail && tail.afterLine === after) tail.lines.push(l.content);
      else runs.push({ afterLine: after, lines: [l.content] });
    }
  }
  return runs;
}

/**
 * Map a modified file's diff onto the blocks of its new text.
 *
 * Adjacent blocks of the same kind merge into one region, so the page shows
 * "one changed passage" rather than a highlight per paragraph, and one fold per
 * quiet stretch rather than one per block.
 */
export function mapMarkdownRegions(file: DiffFile, newText: string): MarkdownRegion[] {
  const blocks = splitMarkdownBlocks(newText);
  if (blocks.length === 0) return [];

  const added = new Set<number>();
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.kind === 'add' && l.newLine !== null) added.add(l.newLine);
    }
  }

  const runs = removedRuns(file);
  const newLines = newText.replace(/\r\n?/g, '\n').split('\n');
  const removedFor = new Map<number, RemovedRun[]>();
  for (const run of runs) {
    // A removal is attached to the block its anchor line falls in; one anchored
    // above line 1, or past the end of the file, goes to the first / last block.
    let idx = blocks.findIndex((b) => run.afterLine >= b.start && run.afterLine <= b.end);
    if (idx === -1) idx = run.afterLine <= 0 ? 0 : blocks.length - 1;
    // A deletion anchored to the blank line that ENDS a block was removed from
    // the gap between two blocks, not from the one above it. Prose is separated
    // by exactly such blanks, so without this a replaced paragraph accents the
    // untouched paragraph before it and shows the old text under the wrong one.
    if (
      idx < blocks.length - 1 &&
      run.afterLine === blocks[idx].end &&
      (newLines[run.afterLine - 1] ?? '').trim() === ''
    ) {
      idx++;
    }
    const list = removedFor.get(idx) ?? [];
    list.push(run);
    removedFor.set(idx, list);
  }

  const regions: MarkdownRegion[] = [];
  blocks.forEach((block, idx) => {
    const changedLines: number[] = [];
    for (let ln = block.start; ln <= block.end; ln++) {
      if (added.has(ln)) changedLines.push(ln);
    }
    const firstChanged = changedLines.length > 0 ? changedLines[0] : null;
    const removals = removedFor.get(idx) ?? [];
    // A block that only lost text is still a change: folding it away would hide
    // the deletion entirely.
    const kind: 'changed' | 'unchanged' =
      firstChanged !== null || removals.length > 0 ? 'changed' : 'unchanged';
    const tail = regions[regions.length - 1];
    if (tail && tail.kind === kind) {
      tail.blocks.push(block);
      tail.end = block.end;
      tail.removed.push(...removals);
      tail.changedLines.push(...changedLines);
      if (tail.firstChangedLine === null) tail.firstChangedLine = firstChanged;
      return;
    }
    regions.push({
      kind,
      blocks: [block],
      start: block.start,
      end: block.end,
      removed: removals,
      firstChangedLine: firstChanged,
      changedLines,
    });
  });
  return regions;
}

function removedHtml(run: RemovedRun): string {
  return (
    `<div class="rv-md-removed" data-rv-md-removed>` +
    `<span class="rv-md-removed-tag">removed</span>` +
    `<div class="turn-content">${renderMarkdown(run.lines.join('\n'))}</div>` +
    `</div>`
  );
}

function foldHtml(count: number, bodyHtml: string): string {
  return (
    `<details class="rv-md-fold" data-rv-md-fold>` +
    `<summary class="rv-md-fold-summary">${count} unchanged line${count === 1 ? '' : 's'}</summary>` +
    `<div class="rv-md-block rv-md-context turn-content">${bodyHtml}</div>` +
    `</details>`
  );
}

function contextHtml(bodyHtml: string): string {
  return `<div class="rv-md-block rv-md-context turn-content">${bodyHtml}</div>`;
}

/** Class stamped on the element each added line produced. */
const CHANGED_LINE_CLASS = 'rv-md-added';

const NO_LINES: ReadonlySet<number> = new Set<number>();

/**
 * Render a contiguous run of blocks as ONE document, accenting changed lines.
 *
 * Blocks are contiguous and each absorbs the blank lines that follow it, so
 * joining their text reproduces that slice of the source exactly. Rendering the
 * slice in one call is what keeps a list run a single `<ul>` (and an `<ol>`
 * numbered from where it actually starts) instead of one list per block.
 */
function renderBlocks(blocks: MarkdownBlock[], changed: ReadonlySet<number> = NO_LINES): string {
  if (blocks.length === 0) return '';
  return renderMarkdown(blocks.map((b) => b.text).join('\n'), {
    firstLine: blocks[0].start,
    markLines: changed,
    markClass: CHANGED_LINE_CLASS,
  });
}

const HEADING_BLOCK_RE = /^#{1,6}\s+/;

/**
 * Split trailing heading blocks off a run about to be folded.
 *
 * A fold must never swallow the heading that introduces what comes AFTER it.
 * In a CHANGELOG every change sits under `## [version]` / `### Added`, all of
 * them unchanged lines — so without this the reviewer is shown an accented list
 * of bullets with no indication of which release or which section they belong
 * to, and has to unfold the quiet stretch above to find out.
 */
function peelTrailingHeadings(blocks: MarkdownBlock[]): {
  folded: MarkdownBlock[];
  headings: MarkdownBlock[];
} {
  let cut = blocks.length;
  while (cut > 0 && HEADING_BLOCK_RE.test(blocks[cut - 1].text)) cut--;
  return { folded: blocks.slice(0, cut), headings: blocks.slice(cut) };
}

function commentButtonHtml(file: string, line: number): string {
  const title = 'Comment on this change (opens the source view)';
  return (
    `<button type="button" class="rv-md-comment" data-rv-show-anchor` +
    ` data-file="${escapeHtml(file)}" data-line="${line}"` +
    ` data-target="${escapeHtml(anchorDomId({ file, side: 'new', line }))}"` +
    ` title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">+</button>`
  );
}

/**
 * The presented pane's header: what it is, how to ask about it, and the escape
 * hatch back to the lines.
 *
 * Both controls are here because a rendered document offered NEITHER before:
 * there was no way to ask a question about what you were reading, and nothing
 * said that switching to Source was what made line comments possible. So the
 * Source button now states what it buys, and "Comment" opens the ordinary
 * ask/comment box against the document as a whole — the anchor is one line
 * (`line`), but the question is about the passage in front of the reviewer.
 *
 * The ask button ships `hidden`, like every other JS-only control on this page;
 * the review island unhides it, so a surface with no comment machinery (commit
 * detail) never shows a button that could not do anything.
 */
function headHtml(badge: string, file: string, anchor: PaneAnchor | null, extra = ''): string {
  const ask = !anchor
    ? ''
    : `<button type="button" class="rv-md-ask" hidden data-rv-present-ask="Ask or comment on this document"` +
      ` data-rv-present-quote="${escapeHtml(`${file} (rendered document)`)}"` +
      ` data-file="${escapeHtml(file)}" data-side="${anchor.side}" data-line="${anchor.line}"` +
      ` title="Ask the agent about this document, or leave a comment on it">Comment</button>`;
  return (
    `<div class="rv-md-head">` +
    `<span class="rv-md-badge">${escapeHtml(badge)}</span>` +
    extra +
    ask +
    `<button type="button" class="rv-md-source-btn" data-rv-show-source` +
    ` title="Show the raw line diff, where a comment can be attached to one specific line">` +
    `Source — comment line by line</button>` +
    `</div>`
  );
}

export interface PaneAnchor {
  side: 'old' | 'new';
  line: number;
}

/**
 * The line a whole-document comment hangs off: the first line of the document
 * as it exists. A deleted file only exists in the pre-image, so its anchor is
 * on the old side — the same rule anchorForLine() applies to a diff row.
 */
function paneAnchor(file: DiffFile): PaneAnchor | null {
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.newLine !== null) return { side: 'new', line: l.newLine };
      if (l.oldLine !== null) return { side: 'old', line: l.oldLine };
    }
  }
  return null;
}

export interface RenderMarkdownFileOptions {
  /** Emit the per-block comment affordance (review page only). */
  allowComments?: boolean;
  /** How many review threads are anchored in this file, for the honesty note. */
  threadCount?: number;
}

/**
 * One markdown file rendered as a document, WITHOUT the pane's chrome (badge,
 * Comment and Source buttons): the part a client other than this page wraps in
 * its own header. The daemon's page wraps it in {@link renderMarkdownFile};
 * Lazy Teams receives it over the `reviewPresentations` RPC. Either way the
 * folding, the accenting and the document's comment anchor are computed once,
 * here — never re-derived by a client.
 *
 * A changed block carries `data-rv-md-line` (its first added line), which is
 * where a client hangs a per-passage comment affordance.
 */
export interface MarkdownDocument {
  kind: MarkdownChangeKind;
  /** The line a comment on the whole document anchors to, or null if none. */
  anchor: PaneAnchor | null;
  /** "This file was deleted…" for a removed file; empty otherwise. */
  noteHtml: string;
  bodyHtml: string;
}

export function renderMarkdownDocument(
  file: DiffFile,
  source: MarkdownSource | undefined,
  options: { allowComments?: boolean } = {},
): MarkdownDocument | null {
  const kind = markdownDiffKind(file);
  if (kind === null) return null;
  if (!source || source.truncated || source.text === null) return null;
  const text = source.text;
  const { allowComments = true } = options;
  const anchor = paneAnchor(file);

  if (kind === 'added' || kind === 'removed') {
    const removed = kind === 'removed';
    return {
      kind,
      anchor,
      noteHtml: removed
        ? `<p class="rv-md-note rv-md-note-removed">This file was deleted — showing its last contents.</p>`
        : '',
      bodyHtml:
        `<div class="rv-md-block ${removed ? 'rv-md-whole-removed' : 'rv-md-whole-added'} turn-content">` +
        renderMarkdown(text) +
        `</div>`,
    };
  }

  const regions = mapMarkdownRegions(file, text);
  if (regions.length === 0) return null;

  const parts: string[] = [];
  for (const region of regions) {
    if (region.kind === 'unchanged') {
      const { folded, headings } = peelTrailingHeadings(region.blocks);
      if (folded.length > 0) {
        const count = folded[folded.length - 1].end - folded[0].start + 1;
        const body = renderBlocks(folded);
        parts.push(count >= FOLD_MIN_LINES ? foldHtml(count, body) : contextHtml(body));
      }
      if (headings.length > 0) parts.push(contextHtml(renderBlocks(headings)));
      continue;
    }
    const body = renderBlocks(region.blocks, new Set(region.changedLines));
    const before = region.removed.filter((r) => r.afterLine < region.start).map(removedHtml).join('');
    const after = region.removed.filter((r) => r.afterLine >= region.start).map(removedHtml).join('');
    const line = region.firstChangedLine;
    const gutter =
      allowComments && line !== null ? commentButtonHtml(file.path, line) : '';
    parts.push(
      `<div class="rv-md-block rv-md-changed"${line === null ? '' : ` data-rv-md-line="${line}"`}>` +
        gutter +
        before +
        `<div class="turn-content">${body}</div>` +
        after +
        `</div>`,
    );
  }
  return { kind, anchor, noteHtml: '', bodyHtml: parts.join('\n') };
}

/**
 * The rendered pane for one markdown file, or null when it cannot be rendered
 * (no source text, too long, or a change shape this does not model). Null means
 * "show the ordinary diff and nothing else" — never a broken or partial render.
 */
export function renderMarkdownFile(
  file: DiffFile,
  source: MarkdownSource | undefined,
  options: RenderMarkdownFileOptions = {},
): string | null {
  const { allowComments = true, threadCount = 0 } = options;
  const doc = renderMarkdownDocument(file, source, { allowComments });
  if (doc === null) return null;

  const threadNote =
    threadCount > 0
      ? `<p class="rv-md-note">${threadCount} comment${threadCount === 1 ? '' : 's'}` +
        ` on this file — open the raw diff to read ${threadCount === 1 ? 'it' : 'them'}.</p>`
      : '';

  return (
    `<div class="rv-md" data-rv-show="presented" hidden>` +
    headHtml(`markdown · ${doc.kind}`, file.path, allowComments ? doc.anchor : null) +
    doc.noteHtml +
    threadNote +
    doc.bodyHtml +
    `</div>`
  );
}

// The browser half of the presented/source switch lives in review-diff.ts, with
// the rest of the view-mode machinery: it is not markdown-specific — markdown is
// only the first file type that has a presented form.
