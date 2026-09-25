/**
 * Mermaid diagram presentation for the web surface.
 *
 * Shared by markdown views and the review/commit diff renderer: one wrapper,
 * one client enhancer, one asset route. The sibling presentation-first review
 * work (`present-review-changes`) can call the same helpers without inventing
 * a second mechanism.
 *
 * Design (v1):
 * - Complete fences only. A mid-edit incomplete fence stays as source.
 * - Diffs reconstruct the POST-image and render that. Toggle to source to see
 *   the +/- characters. No before/after diagram pair.
 * - Broken diagrams degrade to readable source + a visible error — never a
 *   blank pane or a broken-image box.
 * - mermaid.js is vendored as a dependency and served from /assets/mermaid.js
 *   (no CDN). The enhance script lazy-loads it only when a page has a block.
 * - securityLevel: 'strict'; a render timeout for pathological input.
 *
 * The escape hatch is mandatory, not optional: every rendered block has a
 * one-click toggle back to the raw fence (see memory presenting-not-rendering-prs).
 */

import { readFile } from 'fs/promises';

// Compiled into the binary the same way stylesheets are — a released `lazy`
// has no node_modules next to it, so the bytes have to travel with the binary.
// TypeScript resolves the package file on disk and ignores an ambient module
// for it; the import is string content at runtime via Bun's text loader.
// @ts-expect-error mermaid.min.js ships without types for a text import
import mermaidMinJs from 'mermaid/dist/mermaid.min.js' with { type: 'text' };
import { escapeHtml, scriptJson } from './escape';

/**
 * Must NOT import from review-diff.ts — that module imports this one for the
 * presentation rows, and a cycle would break both at load time. Only the
 * colspan is duplicated for that reason; escaping comes from `./escape`, which
 * imports nothing and so cannot close a cycle.
 */
/** Same value as DIFF_COLSPAN in review-diff.ts — spans both unified and split. */
const MERMAID_DIFF_COLSPAN = 6;

/** Minimal line shape — enough to scan a parsed DiffFile without importing it. */
export interface MermaidScanLine {
  kind: string;
  content: string;
}

export interface MermaidScanFile {
  path: string;
  hunks: { lines: MermaidScanLine[] }[];
}

/** The route every page loads the library from (lazily, only when needed). */
export const MERMAID_ASSET_PATH = '/assets/mermaid.js';

/** Soft cap on diagram source size — beyond this we leave the fence as source. */
export const MERMAID_MAX_SOURCE_CHARS = 50_000;

/** Client-side render budget; a pathological diagram must not hang the page. */
export const MERMAID_RENDER_TIMEOUT_MS = 5_000;

/** The mermaid UMD build, as compiled into this binary. */
export function bundledMermaidJs(): string {
  return mermaidMinJs;
}

/**
 * Re-read mermaid.min.js from node_modules.
 *
 * Only a process running FROM SOURCE can do this — same contract as
 * stylesheetFromDisk. The caller decides which source to use.
 */
export async function mermaidJsFromDisk(): Promise<string> {
  // Resolve via the package entry so a nested install layout still works.
  const resolved = await import.meta.resolve('mermaid/dist/mermaid.min.js');
  const path = resolved.startsWith('file:') ? new URL(resolved).pathname : resolved;
  return readFile(path, 'utf-8');
}

/**
 * Open fence: optional indent, ```, optional space, language "mermaid".
 * Close fence: optional indent, ```, nothing else (whitespace ok).
 *
 * Deliberately prefix-based on the trimmed line so a fence inside a markdown
 * list indent still counts — but a JS comment like `// ```mermaid` does not.
 */
export function isMermaidOpenFence(content: string): boolean {
  return /^```\s*mermaid\b/i.test(content.trimStart());
}

export function isFenceClose(content: string): boolean {
  return /^```\s*$/.test(content.trimStart());
}

/**
 * Wrap a mermaid fence body for markdown (and any other non-diff surface).
 *
 * The `<pre><code class="language-mermaid">` stays in the DOM so the Source
 * toggle is the real fence text, not a second copy. The diagram mount and the
 * toolbar ship hidden; the enhance script unhides them after a successful
 * render (and leaves the source alone on failure / with JS off).
 */
export function wrapMermaidFence(source: string): string {
  const id = mermaidBlockId(source);
  const safe = escapeHtml(source);
  return (
    `<div class="lz-mermaid" data-lz-mermaid="${id}" data-lz-view="source">` +
    `<div class="lz-mermaid-bar" hidden>` +
    `<button type="button" class="lz-mermaid-btn" data-lz-mermaid-view="diagram" aria-pressed="false">Diagram</button>` +
    `<button type="button" class="lz-mermaid-btn" data-lz-mermaid-view="source" aria-pressed="true">Source</button>` +
    askButtonHtml(source) +
    `</div>` +
    `<pre class="lz-mermaid-source"><code class="language-mermaid">${safe}</code></pre>` +
    `<div class="lz-mermaid-diagram" data-lz-mermaid-diagram hidden></div>` +
    `<p class="lz-mermaid-error" hidden>Could not render this diagram — showing source.</p>` +
    `</div>`
  );
}

/**
 * "Comment" in a diagram's toolbar.
 *
 * A rendered diagram used to be the one thing on the review page a reviewer
 * could look at and not ask about: the source lines it came from are hidden
 * while the diagram is showing, and with them every comment affordance. This
 * puts one back, next to Diagram/Source, carrying a quote of the diagram source
 * so the question the agent receives says what it was about.
 *
 * Ships `hidden`, like the bar itself: the review island unhides it, so a page
 * with no comment machinery (commit detail, a plain markdown render) shows no
 * button that could not do anything.
 */
function askButtonHtml(source: string): string {
  const quote = source.replace(/\s+/g, ' ').trim().slice(0, 120);
  return (
    `<button type="button" class="lz-mermaid-btn lz-mermaid-ask" hidden` +
    ` data-rv-present-ask="Ask or comment on this diagram"` +
    ` data-rv-present-quote="${escapeHtml(`diagram: ${quote}`)}"` +
    ` title="Ask the agent about this diagram, or leave a comment on it">Comment</button>`
  );
}

export interface MermaidDiffBlock {
  /** Stable id shared by the source rows and the presentation row. */
  id: string;
  /** Fence body (no opening/closing ``` lines). */
  source: string;
  /** Indices into the file's hunk.lines arrays. */
  openHunk: number;
  openLine: number;
  closeHunk: number;
  closeLine: number;
}

/**
 * Find complete mermaid fences in a file's POST-image.
 *
 * Walks context + add lines in order (skips deletions). An open without a
 * matching close — the mid-edit case — yields nothing for that fence, so the
 * renderer leaves the source lines alone. Source longer than
 * {@link MERMAID_MAX_SOURCE_CHARS} is also skipped: better to show the fence
 * than to try a multi-megabyte diagram.
 */
export function findMermaidDiffBlocks(file: MermaidScanFile): MermaidDiffBlock[] {
  const blocks: MermaidDiffBlock[] = [];
  let open: { hunk: number; line: number; body: string[] } | null = null;

  for (let hi = 0; hi < file.hunks.length; hi++) {
    const hunk = file.hunks[hi];
    for (let li = 0; li < hunk.lines.length; li++) {
      const line = hunk.lines[li];
      if (line.kind === 'del' || line.kind === 'meta') continue;

      if (!open) {
        if (isMermaidOpenFence(line.content)) {
          open = { hunk: hi, line: li, body: [] };
        }
        continue;
      }

      if (isFenceClose(line.content)) {
        const source = open.body.join('\n');
        if (source.length > 0 && source.length <= MERMAID_MAX_SOURCE_CHARS) {
          blocks.push({
            id: mermaidBlockId(`${file.path}:${open.hunk}:${open.line}:${source}`),
            source,
            openHunk: open.hunk,
            openLine: open.line,
            closeHunk: hi,
            closeLine: li,
          });
        }
        open = null;
        continue;
      }

      // A second open without a close abandons the previous incomplete fence.
      if (isMermaidOpenFence(line.content)) {
        open = { hunk: hi, line: li, body: [] };
        continue;
      }

      open.body.push(line.content);
    }
  }
  // Trailing unclosed open → incomplete → ignored.
  return blocks;
}

/**
 * Full-width presentation row for a diff fence, inserted after the closing
 * fence line. Ships `hidden` so no-JS viewers never see an empty diagram box;
 * the enhance script unhides it after a successful render.
 *
 * Source lines keep their (file, side, line) anchors — this row is presentation
 * only and must not steal or duplicate them.
 */
export function mermaidDiffRowHtml(
  block: MermaidDiffBlock,
  /**
   * The diff line a comment on this diagram anchors to — the fence's opening
   * line, which the caller knows and this module deliberately does not (it must
   * not import review-diff). Absent, the Comment button is anchor-less and the
   * island resolves it from the surrounding markup.
   */
  anchor?: { file: string; side: string; line: number },
): string {
  const id = escapeHtml(block.id);
  const anchorAttrs = anchor
    ? ` data-file="${escapeHtml(anchor.file)}" data-side="${escapeHtml(anchor.side)}"` +
      ` data-line="${anchor.line}"`
    : '';
  // The source rides in a data attribute so the client does not have to
  // re-derive it from +/- rows (which would be wrong for a changed fence).
  // HTML-escaped; the enhance script reads it via dataset (decoded).
  const sourceAttr = escapeHtml(block.source);
  return (
    `<tr class="rv-mermaid-row" data-lz-mermaid-row="${id}" hidden${anchorAttrs}>` +
    `<td colspan="${MERMAID_DIFF_COLSPAN}">` +
    `<div class="lz-mermaid" data-lz-mermaid="${id}" data-lz-view="source" data-lz-mermaid-source="${sourceAttr}">` +
    `<div class="lz-mermaid-bar" hidden>` +
    `<button type="button" class="lz-mermaid-btn" data-lz-mermaid-view="diagram" aria-pressed="false">Diagram</button>` +
    `<button type="button" class="lz-mermaid-btn" data-lz-mermaid-view="source" aria-pressed="true">Source</button>` +
    askButtonHtml(block.source) +
    `</div>` +
    `<div class="lz-mermaid-diagram" data-lz-mermaid-diagram hidden></div>` +
    `<p class="lz-mermaid-error" hidden>Could not render this diagram — showing source.</p>` +
    `</div>` +
    `</td></tr>`
  );
}

/**
 * Lookup helpers used while rendering a file's rows: which lines belong to a
 * fence, and which close-line should be followed by a presentation row.
 *
 * Pass the same file that produced `blocks` so multi-hunk fences tag the
 * intervening lines correctly without guessing hunk lengths.
 */
export function mermaidDiffIndex(
  file: MermaidScanFile,
  blocks: MermaidDiffBlock[],
): {
  srcOf: Map<string, string>;
  afterClose: Map<string, MermaidDiffBlock>;
} {
  const srcOf = new Map<string, string>();
  const afterClose = new Map<string, MermaidDiffBlock>();
  for (const b of blocks) {
    afterClose.set(`${b.closeHunk}:${b.closeLine}`, b);
    for (let hi = b.openHunk; hi <= b.closeHunk; hi++) {
      const lines = file.hunks[hi]?.lines;
      if (!lines) continue;
      const from = hi === b.openHunk ? b.openLine : 0;
      const to = hi === b.closeHunk ? b.closeLine : lines.length - 1;
      for (let li = from; li <= to; li++) {
        // Only post-image lines are toggle-hidden; a deletion sitting between
        // the open and close in unified order is not part of the rendered fence.
        const kind = lines[li]?.kind;
        if (kind === 'del' || kind === 'meta') continue;
        srcOf.set(`${hi}:${li}`, b.id);
      }
    }
  }
  return { srcOf, afterClose };
}

function mermaidBlockId(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return `m-${Math.abs(h).toString(36)}`;
}

/**
 * Client enhancer: finds `[data-lz-mermaid]`, lazy-loads the vendored library,
 * renders, and wires the Diagram/Source toggle.
 *
 * Page-level (emitted once, unconditionally — see layoutHtml): a diagram can
 * arrive later than the initial page load, in a tab fragment an in-place
 * switch brings in, which a check against only the FIRST render's content
 * would miss. \`run()\` is exposed as \`window.lzRefreshMermaid\` so
 * \`applyFragment\` (task-tabs.ts) can call it again for whatever a fresh
 * body just added; it only processes blocks it has not already marked, so a
 * repeat call is cheap and never re-renders a diagram twice.
 */
export function mermaidEnhanceScript(): string {
  return `<script>
(function () {
  var ASSET = ${scriptJson(MERMAID_ASSET_PATH)};
  var TIMEOUT_MS = ${MERMAID_RENDER_TIMEOUT_MS};
  var uid = 0;

  function loadMermaid(cb) {
    if (window.mermaid) { cb(null); return; }
    var s = document.createElement('script');
    s.src = ASSET;
    s.onload = function () { cb(null); };
    s.onerror = function () { cb(new Error('mermaid asset failed to load')); };
    document.head.appendChild(s);
  }

  function sourceOf(el) {
    if (el.dataset.lzMermaidSource != null && el.dataset.lzMermaidSource !== '') {
      return el.dataset.lzMermaidSource;
    }
    var code = el.querySelector('.lz-mermaid-source code, .lz-mermaid-source');
    return code ? code.textContent || '' : '';
  }

  function setView(el, view) {
    el.dataset.lzView = view;
    var id = el.getAttribute('data-lz-mermaid');
    var btns = el.querySelectorAll('[data-lz-mermaid-view]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', btns[i].getAttribute('data-lz-mermaid-view') === view ? 'true' : 'false');
    }
    var diagram = el.querySelector('[data-lz-mermaid-diagram]');
    var source = el.querySelector('.lz-mermaid-source');
    if (diagram) diagram.hidden = view !== 'diagram';
    if (source) source.hidden = view !== 'source';
    // Diff source lines live outside the widget, tagged with the same id.
    if (id) {
      var rows = document.querySelectorAll('[data-lz-mermaid-src="' + id + '"]');
      for (var j = 0; j < rows.length; j++) {
        rows[j].hidden = view === 'diagram';
      }
      var row = document.querySelector('[data-lz-mermaid-row="' + id + '"]');
      if (row) row.hidden = false;
    }
  }

  function showError(el, msg) {
    var err = el.querySelector('.lz-mermaid-error');
    if (err) {
      if (msg) err.textContent = msg;
      err.hidden = false;
    }
    setView(el, 'source');
    var id = el.getAttribute('data-lz-mermaid');
    if (id) {
      var row = document.querySelector('[data-lz-mermaid-row="' + id + '"]');
      // Keep the row visible so the error is readable; source lines stay too.
      if (row) row.hidden = false;
    }
    var bar = el.querySelector('.lz-mermaid-bar');
    if (bar) bar.hidden = false;
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('diagram render timed out')); }, ms);
      promise.then(
        function (v) { clearTimeout(t); resolve(v); },
        function (e) { clearTimeout(t); reject(e); }
      );
    });
  }

  function enhanceOne(el) {
    var src = sourceOf(el).trim();
    if (!src) { showError(el, 'Empty mermaid fence — showing source.'); return Promise.resolve(); }
    var diagram = el.querySelector('[data-lz-mermaid-diagram]');
    if (!diagram || !window.mermaid) {
      showError(el, 'Could not render this diagram — showing source.');
      return Promise.resolve();
    }
    var renderId = 'lz-mmd-' + (++uid);
    return withTimeout(window.mermaid.render(renderId, src), TIMEOUT_MS).then(function (out) {
      var svg = typeof out === 'string' ? out : (out && out.svg);
      if (!svg) throw new Error('empty render');
      // Mermaid returns SVG markup under securityLevel:strict (tags encoded,
      // clicks disabled). Assigning via a DOMParser avoids executing scripts
      // that a future mermaid regression might emit as HTML.
      var parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      var svgEl = parsed.documentElement;
      if (!svgEl || svgEl.tagName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror')) {
        throw new Error('render did not produce SVG');
      }
      diagram.replaceChildren(document.importNode(svgEl, true));
      var bar = el.querySelector('.lz-mermaid-bar');
      if (bar) bar.hidden = false;
      var err = el.querySelector('.lz-mermaid-error');
      if (err) err.hidden = true;
      setView(el, 'diagram');
    }).catch(function () {
      showError(el, 'Could not render this diagram — showing source.');
    });
  }

  // Guarded by a JS property, not an attribute: a background live update
  // (task-live-status.ts's lzMorph) matches this node POSITIONALLY and
  // keeps it, but syncAttributes strips data-lz-mermaid-claimed (it is not
  // in MORPH_PRESERVED_ATTRIBUTES) — so a naive re-run's "unclaimed" query
  // would find this same, already-wired node again and bind a second click
  // listener on it, unbounded over a session. A JS property is not an
  // attribute; morph never touches it.
  function wireToggle(el) {
    if (el.__lzMermaidWired) return;
    el.__lzMermaidWired = true;
    el.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-lz-mermaid-view]') : null;
      if (!btn || !el.contains(btn)) return;
      var view = btn.getAttribute('data-lz-mermaid-view');
      if (view === 'diagram' || view === 'source') setView(el, view);
    });
  }

  // Re-run SAFELY on a page whose Changes/prose body arrived after this
  // script (a fragment fetched by an in-place tab switch, or a
  // data-lz-stale refetch): only blocks not yet claimed are processed, so a
  // repeat call from window.lzRefreshMermaid is a no-op for anything already
  // rendered, and a diagram is never enhanced twice.
  function run() {
    var blocks = document.querySelectorAll('[data-lz-mermaid]:not([data-lz-mermaid-claimed])');
    if (!blocks.length) return;
    for (var b = 0; b < blocks.length; b++) blocks[b].setAttribute('data-lz-mermaid-claimed', '1');

    loadMermaid(function (err) {
      if (err || !window.mermaid) {
        for (var i = 0; i < blocks.length; i++) {
          showError(blocks[i], 'Could not load the diagram library — showing source.');
          wireToggle(blocks[i]);
        }
        return;
      }
      // strict: encode HTML in labels, disable click handlers. startOnLoad:false
      // because we render explicitly and only the blocks we opted into.
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
      });
      var chain = Promise.resolve();
      for (var i = 0; i < blocks.length; i++) {
        (function (el) {
          wireToggle(el);
          chain = chain.then(function () { return enhanceOne(el); });
        })(blocks[i]);
      }
    });
  }

  run();
  window.lzRefreshMermaid = run;

  // After a unified⇄split regrouping the visible source rows are new nodes;
  // re-apply the current view so a diagram-mode block stays hidden in source.
  // Page-level, registered once: this script itself never re-runs (see
  // window.lzRefreshMermaid above for what DOES need to re-run on a fresh
  // body), so this needs no lzOnce guard.
  document.addEventListener('rv:layout', function () {
    var all = document.querySelectorAll('[data-lz-mermaid]');
    for (var i = 0; i < all.length; i++) {
      var view = all[i].dataset.lzView || 'source';
      setView(all[i], view);
    }
  });
})();
</script>`;
}
