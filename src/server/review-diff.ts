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
 */

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

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
   * status. The ⛔/✅ decision lives in the header of the file it is about —
   * the one place on the page it exists, because it is stored state rather
   * than a field of some form.
   */
  violations?: Map<string, 'pending' | 'approved' | 'rejected'>;
  /** Task id, for the decision form's action. */
  taskId?: string;
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
}

export function renderReviewDiff(
  files: DiffFile[],
  threadsByAnchor: Map<string, RenderedThread[]>,
  options: RenderDiffOptions = {},
): string {
  const { violations = new Map(), taskId = '', allowComments = true, allowViewed = true } = options;
  if (files.length === 0) {
    return '<p class="empty-state">No changes to review.</p>';
  }

  const out: string[] = [];
  for (const file of files) {
    const fileId = fileSectionId(file.path);
    const violation = violations.get(file.path);
    out.push(
      `<section class="rv-file${violation ? ' rv-file-protected' : ''}" id="${fileId}"` +
        ` data-file="${escapeHtml(file.path)}" data-content-hash="${fileContentHash(file)}">`,
    );
    out.push(
      `<header class="rv-file-head">` +
        // Hidden until the island unhides them: collapse and "viewed" are view
        // state only, so with JS off they would be dead controls.
        `<button type="button" class="rv-file-toggle" aria-expanded="true" aria-label="Collapse file" hidden>&#9662;</button>` +
        `<span class="rv-file-path">${escapeHtml(file.path)}</span>` +
        (violation ? violationDecision(taskId, file.path, violation) : '') +
        `<span class="rv-stat rv-stat-add">+${file.additions}</span>` +
        `<span class="rv-stat rv-stat-del">-${file.deletions}</span>` +
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

    // The table scrolls inside its own container: diff lines must not wrap
    // (a wrapped line breaks the 1:1 row-to-line-number correspondence the
    // comment anchors rely on), and .rv-file clips overflow for its rounded
    // corners, so without this a long line is simply unreadable past the
    // right edge.
    out.push('<div class="rv-diff-scroll"><table class="rv-diff"><tbody>');
    // Split-row index, running across the whole file so no two rows of one
    // table ever share a group id.
    let pair = 0;
    for (const h of file.hunks) {
      out.push(
        `<tr class="rv-hunk"><td colspan="${DIFF_COLSPAN}">${escapeHtml(h.header)}</td></tr>`,
      );
      // Which split row each line belongs to, and which pane(s) it fills.
      // Emitted as data attributes so the side-by-side layout is a mechanical
      // regrouping in the browser rather than a second pairing implementation.
      const paneOf = new Map<DiffLine, { pair: number; pane: string }>();
      for (const row of pairSplitRows(h.lines)) {
        const idx = pair++;
        if (row.left && row.left === row.right) paneOf.set(row.left, { pair: idx, pane: 'lr' });
        else {
          if (row.left) paneOf.set(row.left, { pair: idx, pane: 'l' });
          if (row.right) paneOf.set(row.right, { pair: idx, pane: 'r' });
        }
      }

      for (const line of h.lines) {
        const anchor = anchorForLine(file.path, line);
        const cls = line.kind === 'add' ? 'rv-add' : line.kind === 'del' ? 'rv-del' : 'rv-ctx';
        const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
        const attrs = anchor
          ? ` id="${escapeHtml(anchorDomId(anchor))}" data-file="${escapeHtml(anchor.file)}"` +
            ` data-side="${anchor.side}" data-line="${anchor.line}"`
          : '';
        const p = paneOf.get(line);
        const pairAttrs = p ? ` data-rv-pair="${p.pair}" data-rv-pane="${p.pane}"` : '';
        out.push(
          `<tr class="rv-line ${cls}"${attrs}${pairAttrs}>` +
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
      }
    }
    out.push('</tbody></table></div></section>');
  }
  return out.join('\n');
}

/**
 * The reviewer's decision on one protected file — the ONLY copy of this control
 * on the page, and deliberately inside the file's own box.
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
    ` aria-pressed="${on ? 'true' : 'false'}">${label}</button>`;
  return (
    `<form class="rv-decide" method="post" action="/review/${escapeHtml(taskId)}/violation"` +
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
 * The DOM id of a file's diff section, so the summary at the top of the page
 * can link straight to the file whose decision is outstanding.
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

function hashKey(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

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
 * escape hatch back to the raw lines sitting right next to it. Adding one means
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

export function diffViewOptionsHtml(): string {
  const groups = DIFF_VIEW_MODES.map((mode) => {
    const buttons = mode.options
      .map(
        (opt, i) =>
          `<button type="button" data-rv-mode="${mode.name}" data-rv-value="${escapeHtml(opt.value)}"` +
          ` aria-pressed="${i === 0 ? 'true' : 'false'}">${escapeHtml(opt.label)}</button>`,
      )
      .join('');
    return `<span class="rv-viewopt-group"><span>${escapeHtml(mode.label)}</span>${buttons}</span>`;
  }).join('');
  return `<div class="rv-viewopts" hidden data-rv-viewopts>${groups}</div>`;
}

/**
 * Collapse, wrap and layout behaviour, shared by both diff pages.
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
 */
export function diffViewScript(rootSelector: string): string {
  return `<script>
(function () {
  var root = document.querySelector(${JSON.stringify(rootSelector)});
  if (!root) return;

  var toggles = document.querySelectorAll('.rv-file-toggle');
  for (var i = 0; i < toggles.length; i++) toggles[i].hidden = false;

  document.addEventListener('click', function (ev) {
    var toggle = ev.target.closest ? ev.target.closest('.rv-file-toggle') : null;
    if (!toggle) return;
    var section = toggle.closest('.rv-file');
    var collapsed = section.dataset.collapsed === '1';
    section.dataset.collapsed = collapsed ? '0' : '1';
    toggle.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
  });

  var bar = document.querySelector('[data-rv-viewopts]');
  if (!bar) return;
  bar.hidden = false;

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
        // An open, half-typed comment form is not worth carrying across a
        // relayout — a cloned <textarea> loses what was typed into it anyway,
        // so dropping it is the honest outcome rather than a blank form that
        // looks like it kept something.
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

  var MODES = {
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

  if (narrow.addEventListener) narrow.addEventListener('change', syncNarrow);
  else if (narrow.addListener) narrow.addListener(syncNarrow);

  bar.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('[data-rv-mode]') : null;
    if (!btn || btn.disabled) return;
    set(btn.dataset.rvMode, btn.dataset.rvValue, true);
  });
})();
</script>`;
}
