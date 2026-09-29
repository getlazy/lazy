/**
 * The Changes tab at any size: the file list first, hunks file by file.
 *
 * A task's diff is its WHOLE branch (engineer decision 2026-09-25), and a
 * release branch is 2,000 files / 12 MB. Rendering that as one synchronous
 * response is what the old hub exclusion papered over by hiding files. This
 * module is the other answer: nothing is hidden, capped or truncated —
 *
 * - The page asks git for the file list alone (`--numstat`, no patch) and
 *   renders every file's row and card at once.
 * - The first files' hunks come inline, up to a small budget, so a normal
 *   task's page is exactly what it always was.
 * - Every other file is a PENDING card that the browser fills in as the
 *   reader scrolls towards it, a few files per request, through the same
 *   path-scoped diff the page itself used (`getDiff({ files })`).
 * - A very large single file (a lockfile, generated code) is never loaded
 *   unasked: its card says how big it is and loads on click. Still listed,
 *   still counted, never dropped.
 */
import type { DiffFileEntry } from '../git/operations';
import type { ReviewActions } from './review-actions';
import { escapeHtml, scriptJson } from './escape';
import { fileSectionId } from './review-diff';

/**
 * A diff goes progressive only past these: more files than this…
 * Below them the page renders in one response exactly as it always did —
 * walkthrough included, since a walkthrough cuts snippets from the whole diff.
 */
export const PROGRESSIVE_FILES = 300;
/** …or more changed lines than this. */
export const PROGRESSIVE_LINES = 30000;

/** In progressive mode: files whose hunks render in the first response, at most. */
export const INLINE_FILE_BUDGET = 40;
/** Changed lines (+ and −) the first response renders, at most. */
export const INLINE_LINE_BUDGET = 3000;
/** A file with more changed lines than this loads on click, never by itself. */
export const LARGE_FILE_LINES = 1500;
/** One progressive request carries at most this many files… */
export const BATCH_FILES = 8;
/** …and at most this many changed lines (a single larger file goes alone). */
export const BATCH_LINES = 2000;
/**
 * Under "Load all" nobody is waiting on one particular card, so requests are
 * this many times larger: the per-request cost (resolving the task's range)
 * dominates small batches.
 */
export const LOAD_ALL_BATCH_FACTOR = 5;
/** A batch's query string stays under this many characters, whatever its paths. */
export const BATCH_QUERY_CHARS = 6000;

export interface ChangesLoadPlan {
  /** Every file of the diff, in git's order. */
  entries: DiffFileEntry[];
  /** Rendered in the first response. */
  inline: Set<string>;
  /** Loaded by the browser as the reader scrolls. */
  deferred: Set<string>;
  /** Loaded only when the reader asks. */
  large: Set<string>;
}

function linesOf(e: DiffFileEntry): number {
  return e.additions + e.deletions;
}

/**
 * Which files render inline, which load as the reader scrolls, which on click.
 *
 * Inline files are a PREFIX of the list (large files aside), so the page reads
 * top to bottom with no hole in the middle waiting for a request.
 */
export function planChangesLoad(entries: DiffFileEntry[]): ChangesLoadPlan {
  const inline = new Set<string>();
  const deferred = new Set<string>();
  const large = new Set<string>();
  let files = 0;
  let lines = 0;
  let budgetOpen = true;
  for (const e of entries) {
    if (linesOf(e) > LARGE_FILE_LINES) {
      large.add(e.path);
      continue;
    }
    if (budgetOpen && files < INLINE_FILE_BUDGET && lines + linesOf(e) <= INLINE_LINE_BUDGET) {
      inline.add(e.path);
      files++;
      lines += linesOf(e);
    } else {
      budgetOpen = false;
      deferred.add(e.path);
    }
  }
  return { entries, inline, deferred, large };
}

/** True when the diff is too large for one response and loads file by file. */
export function needsProgressive(entries: DiffFileEntry[]): boolean {
  if (entries.length > PROGRESSIVE_FILES) return true;
  let lines = 0;
  for (const e of entries) lines += linesOf(e);
  return lines > PROGRESSIVE_LINES;
}

/** Pathspecs for a set of files: the post-image path, plus the pre-image of a rename. */
export function pathspecsFor(entries: DiffFileEntry[], wanted: Set<string>): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (!wanted.has(e.path)) continue;
    out.push(e.path);
    if (e.oldPath && e.oldPath !== e.path) out.push(e.oldPath);
  }
  return out;
}

export interface ChangesDiff {
  /** Unified diff text for the files rendered in this response. */
  diffText: string;
  /** The plan, when the diff is too large to render in one response. */
  progressive: ChangesLoadPlan | null;
}

/**
 * Load what the Changes block renders in its first response.
 *
 * A port without `listDiffFiles`, or a diff below the progressive thresholds, is one
 * `getDiff` exactly as before. Otherwise only the inline prefix's hunks are
 * read; the rest is the plan's to schedule.
 */
export async function loadChangesDiff(
  actions: ReviewActions,
  taskId: string,
  region: string | null,
): Promise<ChangesDiff> {
  const regionOpt = region ? { region } : undefined;
  if (typeof actions.listDiffFiles !== 'function') {
    return { diffText: await actions.getDiff(taskId, regionOpt), progressive: null };
  }
  const entries = await actions.listDiffFiles(taskId, regionOpt);
  if (!needsProgressive(entries)) {
    return { diffText: await actions.getDiff(taskId, regionOpt), progressive: null };
  }
  const plan = planChangesLoad(entries);
  const specs = pathspecsFor(entries, plan.inline);
  const diffText = specs.length > 0 ? await actions.getDiff(taskId, { files: specs }) : '';
  return { diffText, progressive: plan };
}

/**
 * The file list: every file of the diff with its +/− and region, each row a
 * link to its card. Rendered before any hunk, so it is the first thing a
 * reviewer of a large branch can read.
 */
export function fileListHtml(
  plan: ChangesLoadPlan,
  opts: { fileRegions?: Record<string, string>; regionLabels?: Map<string, string> } = {},
): string {
  let adds = 0;
  let dels = 0;
  const rows = plan.entries.map((e) => {
    adds += e.additions;
    dels += e.deletions;
    const regionId = opts.fileRegions?.[e.path];
    const regionLabel = regionId ? (opts.regionLabels?.get(regionId) ?? regionId) : '';
    const stat = e.binary
      ? '<span class="rv-stat">binary</span>'
      : `<span class="rv-stat rv-stat-add">+${e.additions}</span> <span class="rv-stat rv-stat-del">-${e.deletions}</span>`;
    return (
      `<tr data-rv-list-file="${escapeHtml(e.path)}">` +
      `<td><a href="#${fileSectionId(e.path)}">${escapeHtml(e.path)}</a>` +
      (e.oldPath && e.oldPath !== e.path ? ` <span class="rv-hint">(from ${escapeHtml(e.oldPath)})</span>` : '') +
      (plan.large.has(e.path) ? ' <span class="rv-hint">large — loads on click</span>' : '') +
      `</td><td>${stat}</td><td class="rv-hint">${escapeHtml(regionLabel)}</td></tr>`
    );
  }).join('');
  const n = plan.entries.length;
  return (
    `<details class="rv-file-list" open data-rv-file-list>` +
    `<summary><strong>${n} file${n === 1 ? '' : 's'}</strong> ` +
    `<span class="rv-stat rv-stat-add">+${adds}</span> <span class="rv-stat rv-stat-del">-${dels}</span>` +
    ` · diffs load as you scroll ` +
    `<button type="button" class="btn-sm" data-rv-load-all>Load all diffs</button></summary>` +
    `<table class="rv-file-list-table"><thead><tr><th>File</th><th>Changes</th><th>Region</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></details>`
  );
}

/**
 * A file whose hunks are not in this response. It carries the canonical
 * section id so a `#f-…` link or the file list lands on it, and deliberately
 * NOT the viewable-card attributes: with no content hash to compare, the
 * "viewed" island would read a stored tick as stale and discard it.
 */
export function pendingFileHtml(entry: DiffFileEntry, large: boolean): string {
  const id = fileSectionId(entry.path);
  const lines = entry.additions + entry.deletions;
  const body = large
    ? `<p class="rv-binary">Large file (${lines} changed lines) — ` +
      `<button type="button" class="btn-sm" data-rv-load-file>Load diff</button></p>`
    : `<p class="rv-binary rv-file-loading">Loading…</p>`;
  return (
    `<section class="rv-file rv-file-pending" id="${id}" data-file-section="${id}"` +
    ` data-rv-pending="${escapeHtml(entry.path)}"` +
    (entry.oldPath && entry.oldPath !== entry.path ? ` data-rv-old-path="${escapeHtml(entry.oldPath)}"` : '') +
    ` data-rv-lines="${lines}"${large ? ' data-rv-large' : ''}>` +
    `<header class="rv-file-head"><span class="rv-file-path">${escapeHtml(entry.path)}</span>` +
    `<span class="rv-stat rv-stat-add">+${entry.additions}</span>` +
    `<span class="rv-stat rv-stat-del">-${entry.deletions}</span></header>` +
    body +
    `</section>`
  );
}

/**
 * The browser half: fill pending cards in order as the reader nears them.
 *
 * One request at a time, a few files each, so the server never renders more
 * than a batch and the page stays responsive while a 2,000-file branch fills
 * in. Large files load only from their own button (or "Load all"). After each
 * batch the page's islands are told, so collapse/viewed controls, split view,
 * expand-context rows and comment threads work on the new cards exactly as on
 * the first ones.
 *
 * Listeners are on `root` or scoped to it, which is replaced wholesale when
 * the tab body is refetched, so a re-run of this script leaks nothing.
 */
export function progressiveLoaderScript(filesUrl: string): string {
  return `<script>
(function () {
  var root = document.getElementById('rv-root');
  if (!root) return;
  var URL_BASE = ${scriptJson(filesUrl)};
  var BATCH_FILES = ${BATCH_FILES};
  var BATCH_LINES = ${BATCH_LINES};
  var ALL_FACTOR = ${LOAD_ALL_BATCH_FACTOR};
  var MAX_QUERY = ${BATCH_QUERY_CHARS};
  var busy = false;
  var wantAll = false;
  var near = new Set();

  function pending(includeLarge) {
    var all = root.querySelectorAll('.rv-file-pending[data-rv-pending]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].dataset.rvLoading === '1') continue;
      // A card that failed loads again only from its own Retry button — never
      // from the scroll or Load-all pump, which would retry it in a tight loop.
      if (all[i].hasAttribute('data-rv-failed')) continue;
      if (!includeLarge && all[i].hasAttribute('data-rv-large')) continue;
      out.push(all[i]);
    }
    return out;
  }

  // The next batch: consecutive pending cards starting at the first one the
  // reader is near (or the first at all, under Load all).
  function nextBatch() {
    var list = pending(wantAll);
    var start = -1;
    for (var i = 0; i < list.length; i++) {
      if (wantAll || near.has(list[i])) { start = i; break; }
    }
    if (start < 0) return [];
    var batch = [];
    var lines = 0;
    var chars = 0;
    var maxFiles = wantAll ? BATCH_FILES * ALL_FACTOR : BATCH_FILES;
    var maxLines = wantAll ? BATCH_LINES * ALL_FACTOR : BATCH_LINES;
    for (var j = start; j < list.length && batch.length < maxFiles; j++) {
      var n = parseInt(list[j].dataset.rvLines, 10) || 0;
      var q = encodeURIComponent(list[j].dataset.rvPending).length +
        (list[j].dataset.rvOldPath ? encodeURIComponent(list[j].dataset.rvOldPath).length : 0) + 12;
      if (batch.length > 0 && (lines + n > maxLines || chars + q > MAX_QUERY)) break;
      batch.push(list[j]);
      lines += n;
      chars += q;
    }
    return batch;
  }

  function load(batch) {
    if (!batch.length) return Promise.resolve();
    var qs = [];
    for (var i = 0; i < batch.length; i++) {
      batch[i].dataset.rvLoading = '1';
      qs.push('path=' + encodeURIComponent(batch[i].dataset.rvPending));
      if (batch[i].dataset.rvOldPath) qs.push('old=' + encodeURIComponent(batch[i].dataset.rvOldPath));
    }
    return fetch(URL_BASE + '?' + qs.join('&'), { headers: { accept: 'application/json' } })
      .then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
          return j;
        });
      })
      .then(function (j) {
        var added = [];
        for (var k = 0; k < batch.length; k++) {
          var card = batch[k];
          var html = j.files && j.files[card.dataset.rvPending];
          if (!html) { fail(card, 'The server returned no diff for this file.'); continue; }
          var tpl = document.createElement('template');
          tpl.innerHTML = html;
          var nodes = Array.prototype.slice.call(tpl.content.childNodes);
          card.replaceWith(tpl.content);
          for (var m = 0; m < nodes.length; m++) if (nodes[m].nodeType === 1) added.push(nodes[m]);
          near.delete(card);
        }
        if (j.orphans) {
          var box = document.getElementById('rv-orphans');
          var late = document.getElementById('rv-orphans-late');
          if (box && late) {
            late.insertAdjacentHTML('beforeend', j.orphans);
            box.hidden = false;
          }
        }
        announce(added);
      })
      .catch(function (err) {
        // One bad file must not fail its batch-mates: a failed batch is split
        // and each file tried once on its own; only a file that fails alone
        // is marked failed (and then waits for its Retry button).
        if (batch.length === 1) { fail(batch[0], err.message); return; }
        var chain = Promise.resolve();
        batch.forEach(function (card) {
          card.dataset.rvLoading = '0';
          chain = chain.then(function () { return load([card]); });
        });
        return chain;
      });
  }

  function fail(card, message) {
    card.dataset.rvLoading = '0';
    card.setAttribute('data-rv-failed', '');
    var p = card.querySelector('.rv-binary');
    if (p) p.innerHTML = 'Could not load this diff (' + escapeText(message) +
      ') — <button type="button" class="btn-sm" data-rv-load-file>Retry</button>';
  }

  function escapeText(s) {
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // Let the page's islands pick up the new cards.
  function announce(added) {
    root.dispatchEvent(new CustomEvent('rv:files-loaded', { bubbles: true, detail: { sections: added } }));
    if (typeof window.lzRefreshViewable === 'function') window.lzRefreshViewable();
    if (typeof window.lzRefreshMermaid === 'function') window.lzRefreshMermaid();
    root.dispatchEvent(new CustomEvent('rv:layout', { bubbles: true, detail: {} }));
    root.dataset.rvPendingCount = String(root.querySelectorAll('.rv-file-pending').length);
  }

  function pump() {
    if (busy || !document.contains(root)) return;
    var batch = nextBatch();
    if (!batch.length) return;
    busy = true;
    load(batch).then(function () { busy = false; pump(); });
  }

  var io = 'IntersectionObserver' in window
    ? new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) near.add(entries[i].target);
          else near.delete(entries[i].target);
        }
        pump();
      }, { rootMargin: '2000px 0px' })
    : null;
  var cards = root.querySelectorAll('.rv-file-pending');
  for (var c = 0; c < cards.length; c++) {
    if (io) io.observe(cards[c]);
    else near.add(cards[c]);
  }
  root.dataset.rvPendingCount = String(cards.length);
  if (!io) pump();

  root.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('[data-rv-load-file]') : null;
    if (!btn) return;
    var card = btn.closest('.rv-file-pending');
    if (!card || card.dataset.rvLoading === '1') return;
    card.removeAttribute('data-rv-failed');
    btn.disabled = true;
    load([card]);
  });
  var list = document.querySelector('[data-rv-file-list]');
  var allBtn = list && list.querySelector('[data-rv-load-all]');
  if (allBtn) allBtn.addEventListener('click', function (ev) {
    ev.preventDefault();
    wantAll = true;
    allBtn.disabled = true;
    pump();
  });
})();
</script>`;
}
