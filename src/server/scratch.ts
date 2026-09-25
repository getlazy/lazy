/**
 * Builder scratch — the web half of `lazy scratch list` / `show`.
 *
 * Files builders left in `$LAZY_SCRATCH_DIR`, as CAPTURED into the project
 * store. This page never reads the live directory: the store is the source, and
 * the rules — session grouping, why a file has no body, how a scratch search is
 * phrased — come from src/builder/scratch-view.ts, the same functions Lazy Teams
 * reaches over RPC.
 *
 * Read-only. Removal stays `lazy scratch rm`. No-JS by construction: search is a
 * GET form and the raw view is a link.
 */

import type { ScratchFileEntry, ScratchSessionGroup, ScratchSearchHit } from '../builder/scratch-view';
import { formatBytes } from '../builder/scratch-limits';
import { formatDate } from '../utils/format';
import { layoutHtml } from './templates';
import { escapeHtml } from './review-diff';
import { renderMarkdown } from './markdown';

const INTRO =
  'Documents builders left in their scratch dir — accept messages, analyses, hand-off notes, reports — ' +
  'as captured into the project store. Read-only here; remove one with <code>lazy scratch rm &lt;path&gt;</code>.';

export function scratchFileHref(path: string, raw = false): string {
  return `/scratch/file?path=${encodeURIComponent(path)}${raw ? '&raw=1' : ''}`;
}

function searchFormHtml(query: string): string {
  return `<form class="conv-search" method="get" action="/scratch" id="scratch-search">
    <input class="input" type="text" name="q" value="${escapeHtml(query)}"
           placeholder="Text within scratch files" aria-label="Search scratch">
    <button class="btn btn-sm btn-primary" type="submit">Search</button>
    ${query ? '<a class="btn btn-sm" href="/scratch">Clear</a>' : ''}
  </form>`;
}

function stateCell(f: ScratchFileEntry): string {
  return f.skipped
    ? `<span class="tag tag-warning scratch-skipped" title="${escapeHtml(f.skippedReason ?? '')}">name only</span> <span class="text-muted">${escapeHtml(f.skippedReason ?? '')}</span>`
    : '<span class="text-muted">stored</span>';
}

function fileRowHtml(f: ScratchFileEntry): string {
  return `<tr class="scratch-row" data-path="${escapeHtml(f.path)}">
    <td class="wrap"><a href="${escapeHtml(scratchFileHref(f.path))}">${escapeHtml(f.path)}</a></td>
    <td>${escapeHtml(formatBytes(f.size))}</td>
    <td>${escapeHtml(formatDate(f.updated_at))}</td>
    <td class="wrap">${stateCell(f)}</td>
  </tr>`;
}

function sessionHeading(sessionId: string | null): string {
  if (!sessionId) return 'Session not recorded';
  return `Builder session <a href="/conversations/${escapeHtml(encodeURIComponent(sessionId))}"><code>${escapeHtml(sessionId.substring(0, 8))}</code></a>`;
}

export function scratchIndexHtml(groups: ScratchSessionGroup[]): string {
  const total = groups.reduce((n, g) => n + g.files.length, 0);
  const body = total === 0
    ? `<div class="empty-state" id="scratch-empty">No captured builder scratch files yet. Builders write into <code>$LAZY_SCRATCH_DIR</code>; capture them now with <code>lazy scratch sync</code>.</div>`
    : `<p class="text-muted" id="scratch-summary">${total} file${total === 1 ? '' : 's'} in ${groups.length} session group${groups.length === 1 ? '' : 's'}.</p>
       ${groups.map((g) => `<section class="detail-section scratch-group">
         <h2>${sessionHeading(g.session_id)}</h2>
         <table class="table scratch-table">
           <thead><tr><th>Path</th><th>Size</th><th>Captured</th><th>State</th></tr></thead>
           <tbody>${g.files.map(fileRowHtml).join('\n')}</tbody>
         </table>
       </section>`).join('\n')}`;

  return layoutHtml('Builder scratch', `
    <h1>Builder scratch</h1>
    <p class="text-muted conv-intro">${INTRO}</p>
    ${searchFormHtml('')}
    ${body}
  `);
}

export function scratchSearchHtml(query: string, hits: ScratchSearchHit[], error?: string): string {
  let results: string;
  if (error) {
    results = `<div class="msg-notice msg-notice-error" id="scratch-error">${escapeHtml(error)}</div>`;
  } else if (hits.length === 0) {
    results = `<div class="empty-state" id="scratch-no-hits">No scratch file mentions &ldquo;${escapeHtml(query)}&rdquo;.</div>`;
  } else {
    results = `<p class="text-muted">${hits.length} file${hits.length === 1 ? '' : 's'} match.</p>
      <ul class="scratch-hits" id="scratch-hits">${hits.map((h) => `<li class="scratch-hit">
        <a href="${escapeHtml(scratchFileHref(h.path))}">${escapeHtml(h.path)}</a>
        ${h.file?.skipped ? ` <span class="tag tag-warning">name only</span>` : ''}
        <div class="text-muted wrap">${escapeHtml(h.match_context)}</div>
      </li>`).join('\n')}</ul>`;
  }
  return layoutHtml('Builder scratch — search', `
    <div class="breadcrumb"><a href="/scratch">Builder scratch</a> &rsaquo; Search</div>
    <h1>Builder scratch</h1>
    ${searchFormHtml(query)}
    ${results}
  `);
}

export function scratchFileHtml(file: ScratchFileEntry & { content: string | null }, raw: boolean): string {
  const meta = [
    escapeHtml(formatBytes(file.size)),
    `captured ${escapeHtml(formatDate(file.updated_at))}`,
    `by ${escapeHtml(file.updated_by)}`,
    file.session_id
      ? `session <a href="/conversations/${escapeHtml(encodeURIComponent(file.session_id))}"><code>${escapeHtml(file.session_id.substring(0, 8))}</code></a>`
      : 'session not recorded',
  ].join(' · ');

  let body: string;
  if (file.skipped || file.content === null) {
    // The record is the answer: say why there is no body, never show an empty one.
    body = `<div class="msg-notice" id="scratch-name-only">
      <strong>Recorded by name only.</strong> ${escapeHtml(file.skippedReason ?? '')}
      Its content is not in the store; it is still readable in the live scratch dir (<code>lazy scratch path</code>).
    </div>`;
  } else {
    // Only markdown has two views; anything else is shown raw with no toggle.
    const markdown = /\.(md|markdown)$/i.test(file.path);
    const toggle = !markdown
      ? ''
      : raw
        ? `<a class="btn btn-sm" href="${escapeHtml(scratchFileHref(file.path))}" id="scratch-rendered-link">Rendered</a>`
        : `<a class="btn btn-sm" href="${escapeHtml(scratchFileHref(file.path, true))}" id="scratch-raw-link">Raw</a>`;
    const content = raw || !markdown
      ? `<pre class="scratch-raw" id="scratch-raw">${escapeHtml(file.content)}</pre>`
      : `<div class="turn-content" id="scratch-rendered">${renderMarkdown(file.content)}</div>`;
    body = `${toggle ? `<div class="action-links">${toggle}</div>` : ''}
      <div class="detail-section" id="scratch-body">${content}</div>`;
  }

  return layoutHtml(file.path, `
    <div class="breadcrumb"><a href="/scratch">Builder scratch</a> &rsaquo; File</div>
    <h1 class="wrap">${escapeHtml(file.path)}</h1>
    <div class="msg-meta" id="scratch-meta">${meta}</div>
    ${body}
  `);
}

/** Section listing scratch files a system message mentions, each linked. */
export function scratchMentionsHtml(paths: string[]): string {
  if (paths.length === 0) return '';
  return `<div class="detail-section" id="message-scratch-links">
    <h2>Scratch files mentioned</h2>
    <ul>${paths.map((p) => `<li><a href="${escapeHtml(scratchFileHref(p))}">${escapeHtml(p)}</a></li>`).join('')}</ul>
  </div>`;
}
