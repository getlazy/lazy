/**
 * Agent-declared presentation for the review Changes block.
 *
 * Renders semantic groups (with snippets) before the raw per-file diff. Raw stays
 * one click away — see changesViewScript. Reuses renderReviewDiff for anchors.
 */

import type {
  PresentationCapRefusal,
  PresentationGroup,
  PresentationItem,
  PresentationFile,
  PresentationSnippet,
  PresentationScreenshot,
  PresentationTier,
  ReviewPresentation,
} from '../types';
import { viewedCardHtml } from './viewed-cards';
import { SHOT_LINK_ATTR } from './screenshot-lightbox';
import { PROSE_REPORT_FILE } from '../review/prose-anchor';
import { renderMarkdown, type RenderMarkdownOptions } from './markdown';
import {
  appendResidualGroup,
  fileClaimsFromGroups,
  fileItemPaths,
  sortPresentationGroupsForDisplay,
  tierExpandedByDefault,
} from '../storage/presentation';
import {
  escapeHtml,
  fileSectionId,
  renderReviewDiff,
  annotateSnippetAgainstFull,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
  type RenderDiffOptions,
  type RenderedThread,
} from './review-diff';

/**
 * URL the review page loads a screenshot from.
 *
 * Always the artifact store behind the dashboard's session guard — NEVER a
 * path in the task worktree. The worktree is agent-writable and its files are
 * not the ones the agent declared; the artifact is.
 */
export function screenshotUrl(taskId: string, artifactName: string): string {
  // taskId is the ESCAPED path segment (taskPathSegment) — interpolate raw;
  // the artifact name is a raw value and is escaped once.
  return `/api/review/${taskId}/artifact?name=${encodeURIComponent(artifactName)}`;
}

/**
 * The screenshots card — what the agent built, rendered above everything else.
 *
 * Returns '' when the report declared none, so the card costs nothing on the
 * ordinary text-only review.
 *
 * Each image stays a real link to its own full-size bytes, and the lightbox
 * island (screenshot-lightbox.ts) intercepts the click into an in-page overlay
 * with left/right navigation. The link is the no-JS fallback, not dead markup:
 * without the island a click opens the picture in its own tab exactly as it
 * did before.
 */
export function screenshotsCardHtml(
  taskId: string,
  screenshots: readonly PresentationScreenshot[] | undefined,
): string {
  if (!screenshots || screenshots.length === 0) return '';

  const figures = screenshots
    .map((shot) => {
      const url = screenshotUrl(taskId, shot.artifact);
      const alt = escapeHtml(shot.caption ?? shot.artifact);
      const caption = escapeHtml(shot.caption ?? shot.artifact);
      return (
        `<figure class="rv-shot">` +
        `<a class="rv-shot-link" href="${escapeHtml(url)}" target="_blank" rel="noopener"` +
        ` ${SHOT_LINK_ATTR} data-lz-shot-caption="${alt}"` +
        ` aria-label="View screenshot: ${alt}">` +
        `<img class="rv-shot-img" src="${escapeHtml(url)}" alt="${alt}" loading="lazy">` +
        `</a>` +
        `<figcaption class="rv-shot-caption">${caption}` +
        (shot.caption ? ` <code>${escapeHtml(shot.artifact)}</code>` : '') +
        `</figcaption>` +
        `</figure>`
      );
    })
    .join('\n');

  const plural = screenshots.length === 1 ? 'screenshot' : 'screenshots';
  return viewedCardHtml({
    key: 'screenshots',
    // Re-shown when the agent changes what it is showing.
    content: screenshots.map((s) => `${s.artifact}\n${s.caption ?? ''}`).join('\n---\n'),
    headHtml:
      `<strong>Screenshots</strong> <span class="rv-hint">${screenshots.length} ${plural} from the agent</span>`,
    // A picture is a presented surface like any other, so it takes comments
    // like any other: the body is declared as report prose, which gives each
    // caption the same anchored "+" a paragraph of the report has. The hint
    // says so, because an affordance that only appears on hover is not one a
    // reviewer can be expected to discover.
    bodyHtml:
      `<p class="rv-hint">Click a screenshot to open it here, &larr; / &rarr; for the rest. ` +
      `Hover a caption to ask the agent about that screenshot.</p>` +
      `<div class="rv-shots" data-rv-prose="${escapeHtml(PROSE_REPORT_FILE)}" data-rv-prose-kind="screenshots">${figures}</div>`,
    sectionClass: 'rv-screenshots',
  });
}

const TIER_LABELS: Record<PresentationTier, string> = {
  core: 'Core',
  tests: 'Tests',
  docs: 'Docs',
  generated: 'Generated',
  other: 'Other',
};

function lineInSnippetRange(line: DiffLine, start: number, end: number, side: 'old' | 'new'): boolean {
  const lineNo = side === 'old' ? line.oldLine : line.newLine;
  return lineNo !== null && lineNo >= start && lineNo <= end;
}

/** Extract a line-range window from a parsed diff file for snippet rendering. */
export function filterFileToSnippet(
  file: DiffFile,
  start: number,
  end: number,
  side: 'old' | 'new' = 'new',
): DiffFile | null {
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  for (const h of file.hunks) {
    const lines = h.lines.filter((l) => lineInSnippetRange(l, start, end, side));
    if (lines.length === 0) continue;
    for (const l of lines) {
      if (l.kind === 'add') additions++;
      else if (l.kind === 'del') deletions++;
    }
    hunks.push({ header: h.header, lines });
  }
  if (hunks.length === 0) return null;
  return {
    path: file.path,
    oldPath: file.oldPath,
    hunks,
    additions,
    deletions,
    binary: file.binary,
  };
}

/**
 * Concatenate snippet windows of the same path into one DiffFile so
 * consecutive hunks render as one file section (one header, the hunks
 * inside) instead of N cards.
 */
export function mergeDiffFiles(parts: DiffFile[]): DiffFile {
  const first = parts[0];
  if (!first) {
    throw new Error('mergeDiffFiles requires at least one file');
  }
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  for (const p of parts) {
    hunks.push(...p.hunks);
    additions += p.additions;
    deletions += p.deletions;
  }
  return {
    path: first.path,
    oldPath: first.oldPath,
    hunks,
    additions,
    deletions,
    binary: first.binary,
  };
}

type FileishItem = PresentationFile | PresentationSnippet;

function isFileish(item: PresentationItem): item is FileishItem {
  return item.kind === 'file' || item.kind === 'snippet';
}

/**
 * Group consecutive snippet/file items of the SAME path. A prose item, or a
 * different file, is a run break — that's the "keep hunk-level cards only
 * where other files genuinely interleave" rule. Group boundaries also
 * break (the caller runs this per group).
 */
export function consecutiveFileRuns(items: PresentationItem[]): PresentationItem[][] {
  const runs: PresentationItem[][] = [];
  for (const item of items) {
    const prev = runs[runs.length - 1];
    const head = prev?.[0];
    if (
      prev &&
      head &&
      isFileish(item) &&
      isFileish(head) &&
      prev.every(isFileish) &&
      head.file === item.file
    ) {
      prev.push(item);
    } else {
      runs.push([item]);
    }
  }
  return runs;
}

/** First-occurrence tracker so one path gets one id and one decision control. */
interface FileRenderSeen {
  sectionId: Set<string>;
  decision: Set<string>;
}

export function findDiffFile(files: DiffFile[], path: string): DiffFile | undefined {
  return files.find((f) => f.path === path || f.oldPath === path);
}

function groupDomId(title: string, index: number): string {
  return `rv-pg-${index}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
}

/**
 * How many path chips a group header shows before the rest become a count.
 *
 * A header is a glance, not an inventory: the files are in the block below it
 * and the whole list is one click away on the Regions tab. Before the
 * item-cap split a group could not hold more than 64 items, so this never
 * bit; a group that claims `test/` as one item now routinely owns hundreds.
 */
const MAX_HEADER_CHIPS = 8;

/**
 * The header's path chips, built from the walkthrough AS WRITTEN — before a
 * pattern is spread into its files.
 *
 * That is the whole point of a pattern claim: `src/review/ — 42 files` is one
 * chip that says what the group is, where forty-two paths say nothing a
 * reader can hold. A literal list is capped too, for the walkthrough that
 * names its files one by one.
 */
function headerChips(group: PresentationGroup): string[] {
  const chips: string[] = [];
  for (const item of group.items) {
    if (item.kind !== 'snippet' && item.kind !== 'file') continue;
    const count = item.kind === 'file' && item.matched ? item.matched.length : 0;
    const label = count > 0 ? `${item.file} — ${count} file${count === 1 ? '' : 's'}` : item.file;
    if (!chips.includes(label)) chips.push(label);
  }
  if (chips.length <= MAX_HEADER_CHIPS) return chips;
  return [...chips.slice(0, MAX_HEADER_CHIPS), `+${chips.length - MAX_HEADER_CHIPS} more`];
}

function renderSnippetMiss(item: { file: string; note?: string }): string {
  const fileId = fileSectionId(item.file);
  const note = item.note ? `<p class="rv-hint">${escapeHtml(item.note)}</p>` : '';
  return (
    `<div class="rv-pres-snippet-miss">` +
    note +
    `<p class="rv-hint">Snippet range not found in the current diff.` +
    ` <a href="#${escapeHtml(fileId)}" data-rv-goto-raw="${escapeHtml(item.file)}">View full file</a></p>` +
    `</div>`
  );
}

function notesHtml(items: FileishItem[]): string {
  return items
    .map((i) => i.note)
    .filter((n): n is string => Boolean(n))
    .map((n) => `<p class="rv-hint">${escapeHtml(n)}</p>`)
    .join('');
}

function fullFileLink(path: string): string {
  return (
    ` <a href="#${escapeHtml(fileSectionId(path))}" data-rv-goto-raw="${escapeHtml(path)}">Full file</a>`
  );
}

function diffOptsFor(
  path: string,
  options: RenderPresentedChangesOptions,
  seen: FileRenderSeen,
): RenderDiffOptions {
  // First card of this path in the walkthrough carries the canonical id and
  // the (one) approve/reject control. Later interleaved leftover hunks of
  // the same file stay as cards but do not repeat the decision — it is a
  // property of the file, not of the hunk.
  const assignSectionId = !seen.sectionId.has(path);
  seen.sectionId.add(path);
  const showDecision = Boolean(options.violations?.has(path)) && !seen.decision.has(path);
  if (options.violations?.has(path)) seen.decision.add(path);
  return { ...options, showDecision, assignSectionId };
}

/**
 * Render consecutive snippet/file items of one path as a single file
 * section. A `file` item in the run wins (the whole diff); otherwise the
 * snippet windows merge into one table of hunks.
 */
function renderFileRun(
  items: FileishItem[],
  files: DiffFile[],
  fileMap: Map<string, DiffFile>,
  threadsByAnchor: Map<string, RenderedThread[]>,
  options: RenderPresentedChangesOptions,
  seen: FileRenderSeen,
): string {
  const path = items[0]!.file;
  const whole = items.find((i): i is PresentationFile => i.kind === 'file');
  const notes = notesHtml(items);
  const opts = diffOptsFor(path, options, seen);

  if (whole) {
    const file = fileMap.get(path) ?? findDiffFile(files, path);
    if (!file) return renderSnippetMiss(whole);
    return notes + renderReviewDiff([file], threadsByAnchor, opts);
  }

  const snippets: DiffFile[] = [];
  const misses: string[] = [];
  let fullFile: DiffFile | undefined;
  for (const item of items) {
    if (item.kind !== 'snippet') continue;
    const file = fileMap.get(item.file) ?? findDiffFile(files, item.file);
    if (!file) {
      misses.push(renderSnippetMiss(item));
      continue;
    }
    fullFile = file;
    const side = item.side ?? 'new';
    const snippet = filterFileToSnippet(file, item.start, item.end, side);
    if (!snippet) {
      misses.push(
        `<p class="rv-hint">Lines ${item.start}–${item.end} (${side}) not in diff.${fullFileLink(item.file)}</p>`,
      );
      continue;
    }
    snippets.push(snippet);
  }
  if (snippets.length === 0) {
    return notes + misses.join('\n');
  }
  const merged = mergeDiffFiles(snippets);
  // Hand expand the FULL file's addition index and totals. Without this, a
  // narrow snippet's "Show 20 lines below" fetches omitted additions from the
  // post-image and paints them as unchanged context — the lie this task fixes.
  if (fullFile) annotateSnippetAgainstFull(merged, fullFile);
  // One "Full file" for the merged section, not one per former snippet card.
  const head =
    `<div class="rv-pres-snippet-head"><code>${escapeHtml(path)}</code>${fullFileLink(path)}</div>`;
  return notes + head + misses.join('\n') + renderReviewDiff([merged], threadsByAnchor, opts);
}

function renderItemRun(
  run: PresentationItem[],
  files: DiffFile[],
  fileMap: Map<string, DiffFile>,
  threadsByAnchor: Map<string, RenderedThread[]>,
  options: RenderPresentedChangesOptions,
  seen: FileRenderSeen,
): string {
  const first = run[0];
  if (!first) return '';
  if (first.kind === 'prose') {
    // The agent's walkthrough text is presented prose, and a reviewer must be
    // able to ask about it where they read it: declaring it as report prose
    // gives every paragraph the anchored "+" the report card has.
    return (
      `<div class="rv-pres-prose turn-content" data-rv-prose="${escapeHtml(PROSE_REPORT_FILE)}">` +
      `${renderMarkdown(first.body, options.markdown)}</div>`
    );
  }
  if (!run.every(isFileish)) {
    // A mixed run cannot happen with consecutiveFileRuns; keep the first
    // item rather than silently dropping the rest.
    return renderFileRun([first], files, fileMap, threadsByAnchor, options, seen);
  }
  return renderFileRun(run, files, fileMap, threadsByAnchor, options, seen);
}

function renderPresentationGroup(
  group: PresentationGroup,
  index: number,
  files: DiffFile[],
  fileMap: Map<string, DiffFile>,
  threadsByAnchor: Map<string, RenderedThread[]>,
  options: RenderPresentedChangesOptions,
  isResidual: boolean,
  seen: FileRenderSeen,
  /** The chips for this group's header, built before its patterns were spread. */
  chips: string[],
): string {
  const expanded = tierExpandedByDefault(group.tier);
  // Agent markdown can link here as `[the retry path](#group-retry)` when
  // they set `id: "retry"`. A missing id keeps the title-slug fallback.
  const gid = group.id ? `group-${group.id}` : groupDomId(group.title, index);
  const tierLabel = TIER_LABELS[group.tier] ?? group.tier;
  const summaryPaths =
    chips.length > 0
      ? `<span class="rv-pres-paths">${chips.map((p) => `<code>${escapeHtml(p)}</code>`).join(', ')}</span>`
      : '';
  const residualHint = isResidual
    ? `<p class="rv-hint rv-pres-residual">Not listed in the agent's walkthrough — shown for completeness.</p>`
    : '';
  const summary = group.summary
    ? `<div class="rv-pres-group-summary turn-content" data-rv-prose="${escapeHtml(PROSE_REPORT_FILE)}">${renderMarkdown(group.summary, options.markdown)}</div>`
    : '';

  // A file claim whose path is not in the diff BEING SHOWN is not a broken
  // item: on a hub this block renders the task's own direct diff while the
  // walkthrough claims the whole branch, so every file an accepted child
  // brought is legitimately absent here. Said ONCE for the group, and in
  // file-claim words — the per-item path said "Snippet range not found",
  // which is wrong twice over for a whole-file claim and, since a pattern
  // may claim hundreds, said it hundreds of times.
  const outOfRange: string[] = [];
  const renderable = group.items.filter((item) => {
    if (item.kind !== 'file') return true;
    if (fileMap.has(item.file) || findDiffFile(files, item.file)) return true;
    outOfRange.push(item.file);
    return false;
  });
  const outOfRangeHint = outOfRange.length > 0
    ? `<p class="rv-hint rv-pres-outside">${outOfRange.length} file${outOfRange.length === 1 ? '' : 's'} ` +
      `claimed by this group ${outOfRange.length === 1 ? 'is' : 'are'} not in the diff shown here — ` +
      `they are on the branch but outside this view. Open the Regions tab, or ` +
      `<code>lazy diff &lt;task&gt; --region ${escapeHtml(group.id ?? '')} --full</code>.</p>`
    : '';

  const itemsHtml = consecutiveFileRuns(renderable)
    .map((run) =>
      renderItemRun(run, files, fileMap, threadsByAnchor, options, seen),
    )
    .join('\n');

  return (
    `<section class="rv-pres-group" id="${escapeHtml(gid)}" data-tier="${escapeHtml(group.tier)}"` +
    ` data-rv-pres-expanded="${expanded ? '1' : '0'}">` +
    `<details class="rv-pres-details"${expanded ? ' open' : ''}>` +
    `<summary class="rv-pres-summary">` +
    `<span class="rv-pres-tier rv-pres-tier-${escapeHtml(group.tier)}">${escapeHtml(tierLabel)}</span>` +
    `<strong>${escapeHtml(group.title)}</strong>` +
    summaryPaths +
    `</summary>` +
    residualHint +
    summary +
    outOfRangeHint +
    `<div class="rv-pres-items">${itemsHtml}</div>` +
    `</details></section>`
  );
}

/** Toolbar: Presented | Raw — only when the agent declared a presentation. */
export function changesViewOptionsHtml(): string {
  return (
    `<div class="rv-changes-viewopts" hidden data-rv-changes-viewopts>` +
    `<span class="rv-viewopt-group"><span>Changes</span>` +
    `<button type="button" data-rv-changes-value="presented" aria-pressed="true">Presented</button>` +
    `<button type="button" data-rv-changes-value="raw" aria-pressed="false">Raw files</button>` +
    `</span></div>`
  );
}

export interface RenderPresentedChangesOptions extends RenderDiffOptions {
  /** When set, omitted maintain globs render under "Maintained files", not Other. */
  isMaintainedPath?: (path: string) => boolean;
  /** Shared linkify (task codes + symbols) for group summaries and prose items. */
  markdown?: RenderMarkdownOptions;
  /**
   * A cap this task's walkthrough was refused for, recorded with the report
   * being rendered. Stated on the residual group, where the reviewer is
   * deciding what to make of an unassigned block.
   */
  capRefusal?: PresentationCapRefusal;
}

/**
 * Render a group's items with every directory/glob claim spread back into
 * the files it resolved to.
 *
 * A pattern is one ITEM (that is the point — a 40-file test mass costs one
 * slot), but it is many MEMBERS, and the Changes block shows a group's
 * members as diff cards. The note rides the first card so it is said once,
 * where the run begins, rather than repeated forty times.
 */
function expandItemsForDisplay(items: PresentationItem[]): PresentationItem[] {
  return items.flatMap((item) =>
    item.kind === 'file' && item.matched
      ? item.matched.map((file, i): PresentationItem => ({
          kind: 'file',
          file,
          ...(i === 0 && item.note ? { note: item.note } : {}),
        }))
      : [item],
  );
}

/**
 * Every path this block has ALREADY DRAWN somewhere — claims and snippet
 * targets alike — so the residual does not card a file the reviewer has just
 * read in its group's story.
 *
 * Rendering only. What the walkthrough ACCOUNTED for is `fileClaimsFromGroups`
 * (a snippet is narrative, not membership), and that is what the residual
 * block's sentence counts.
 */
function renderedPathsFromGroups(groups: readonly PresentationGroup[]): Set<string> {
  const paths = new Set<string>();
  for (const g of groups) {
    for (const item of g.items) {
      if (item.kind === 'file') {
        for (const path of fileItemPaths(item)) paths.add(path);
      } else if (item.kind === 'snippet') {
        paths.add(item.file);
      }
    }
  }
  return paths;
}

export function renderPresentedChanges(
  presentation: ReviewPresentation,
  files: DiffFile[],
  threadsByAnchor: Map<string, RenderedThread[]>,
  options: RenderPresentedChangesOptions,
): string {
  // TWO sets, deliberately, and they answer different questions.
  //
  // `rendered` decides which files this block CARDS: a file some group quoted
  // as a snippet is already on the page, in its story, so re-carding it below
  // would show one diff twice (an invariant test pins that).
  //
  // `claimed` is the walkthrough's membership — file items only, the same rule
  // every region surface uses — and it is what the residual SENTENCE counts. A
  // quote is not a claim (final-turn design §6.1), so a snippet-only file is
  // unaccounted for however this block chooses to draw it; counting per
  // surface made one page report "5 of 277 files are not named" here and
  // "17 of 277" on the Regions tab, about one walkthrough at one head.
  const rendered = renderedPathsFromGroups(presentation.groups);
  const claimed = fileClaimsFromGroups(presentation.groups);
  const diffPaths = files.map((f) => f.path);
  const displayed = sortPresentationGroupsForDisplay(
    appendResidualGroup(presentation.groups, diffPaths, rendered, {
      isMaintainedPath: options.isMaintainedPath,
      claimed,
      ...(options.capRefusal ? { capRefusal: options.capRefusal } : {}),
    }),
  );
  // Chips come from the walkthrough AS WRITTEN, so a pattern stays one chip;
  // the items are then spread, because the block below the header shows the
  // group's members as diff cards.
  const groups = displayed.map((g) => ({
    group: { ...g, items: expandItemsForDisplay(g.items) },
    chips: headerChips(g),
  }));
  const fileMap = new Map(files.map((f) => [f.path, f]));
  // Walk the displayed groups in order so the first card of each path is
  // the one that gets the file id and the approve/reject control.
  const seen: FileRenderSeen = { sectionId: new Set(), decision: new Set() };

  return groups
    .map(({ group, chips }, i) =>
      renderPresentationGroup(
        group,
        i,
        files,
        fileMap,
        threadsByAnchor,
        options,
        group.title === 'Other changes' || group.title === 'Maintained files',
        seen,
        chips,
      ),
    )
    .join('\n');
}

/**
 * Toggle Presented vs Raw; switch to Raw when clicking "full file" from a snippet.
 * diffViewScript targets #rv-changes so layout/wrap apply to both panes.
 */
export function changesViewScript(): string {
  return `<script>
(function () {
  var bar = document.querySelector('[data-rv-changes-viewopts]');
  var presented = document.getElementById('rv-presented');
  var raw = document.getElementById('rv-root');
  if (!bar || !presented || !raw) return;
  bar.hidden = false;

  var KEY = 'lazy:review-changes-view';

  function read() {
    try {
      var q = new URLSearchParams(window.location.search).get('view');
      if (q === 'raw' || q === 'presented') return q;
      var v = localStorage.getItem(KEY);
      if (v === 'raw' || v === 'presented') return v;
    } catch (e) { /* private mode */ }
    return 'presented';
  }

  function set(mode, persist) {
    var isPresented = mode === 'presented';
    presented.hidden = !isPresented;
    raw.hidden = isPresented;
    var btns = bar.querySelectorAll('[data-rv-changes-value]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', btns[i].dataset.rvChangesValue === mode ? 'true' : 'false');
    }
    if (persist) {
      try { localStorage.setItem(KEY, mode); } catch (e) { /* private mode */ }
    }
  }

  set(read(), false);

  bar.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('[data-rv-changes-value]') : null;
    if (!btn) return;
    set(btn.dataset.rvChangesValue, true);
  });

  // This script re-runs every time the Changes body is (re)fetched — first
  // load, and every data-lz-stale refetch after (task-tabs.ts's
  // activateScripts). \`bar\`/\`presented\`/\`raw\` above are fine to close over:
  // they belong to THIS run's body, which is only ever appended once. But
  // \`document\` outlives every body, so a \`document.addEventListener\` here
  // would add one more permanent listener — closing over this run's
  // possibly-since-removed \`set\` — on every refetch. Register the listener
  // itself only once per page (window.lzOnce, from task-tabs.ts), and always
  // dispatch through whichever run's \`set\` is CURRENT: every run overwrites
  // the pointer, so the one listener always drives the live body.
  //
  // window.lzOnce is a hard assumption, not a silently-skipped feature
  // check — a \`if (window.lzOnce)\` here would hide a broken guarantee
  // behind "the link just does nothing," the exact failure mode this whole
  // task was filed over. But layoutOpenHtml's guarantee has one honest gap:
  // \`?fragment=1\` is honoured directly off the query string (a bookmark, a
  // typed URL), returning strip + body with no <html>/<head> at all — so
  // \`window.lzOnce\` can genuinely be undefined here. Falling straight
  // through to \`f()\` on that page is a DEGRADED once-guard (a later refetch
  // could re-register), not a crash that takes the rest of this island's
  // setup down with it — see the note on lzOnceScriptHtml in templates.ts.
  window.__lzSetChangesView = set;
  (window.lzOnce || function (k, f) { f(); })('changes-goto-raw', function () {
    document.addEventListener('click', function (ev) {
      var link = ev.target.closest ? ev.target.closest('[data-rv-goto-raw]') : null;
      if (!link || typeof window.__lzSetChangesView !== 'function') return;
      window.__lzSetChangesView('raw', true);
      var id = link.getAttribute('href');
      if (id && id.charAt(0) === '#') {
        var target = id.slice(1);
        setTimeout(function () {
          // Prefer the Raw pane's copy — Presented may also carry this
          // file-section token, and getElementById would return that hidden one.
          var raw = document.getElementById('rv-root');
          var el = raw ? raw.querySelector('[data-file-section="' + target.replace(/"/g, '') + '"]') : null;
          if (!el) el = document.getElementById(target);
          if (el) el.scrollIntoView({ block: 'start' });
        }, 0);
      }
    });
  });
})();
</script>`;
}
