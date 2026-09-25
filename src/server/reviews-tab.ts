/**
 * Reviews tab — successful formal agent reviews for a task.
 *
 * Failed / unparsed reviews are omitted (they never counted). Each row links
 * to the review turn and to the Raises it filed. Issues live on the Raised
 * tab; this list is provenance only.
 *
 * Escaping comes from `./escape`, which imports nothing — so this module stays
 * free of the mermaid-heavy review-diff import graph (unit tests can load it
 * without node_modules) without keeping a second escaper of its own. The local
 * copy it used to keep had already drifted: it left `'` raw.
 */

import type { ReviewTurnLike } from '../review/success';
import { buildShowReviews, type ShowReview } from '../task/show-sections';
import { escapeHtml } from './escape';

function formatWhen(ts: number | undefined): string {
  if (!ts) return 'unknown time';
  try {
    return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  } catch {
    return 'unknown time';
  }
}

/**
 * The timestamp as whole tokens — date, time, zone — each unbreakable.
 *
 * At phone width the column is too narrow for one line, and a cell left to
 * wrap on its own broke the date at its hyphens (`2026-09-` / `12`). The
 * tokens are what a reader scans, so the line breaks go between them.
 */
function whenHtml(ts: number | undefined): string {
  return formatWhen(ts)
    .split(' ')
    .map((part) => `<span class="lz-reviews-when-part">${escapeHtml(part)}</span>`)
    .join(' ');
}

function shortRaiseId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * How many reviews the tab will list — the strip's badge.
 *
 * Derived from the same `buildShowReviews` the body renders, so the count on
 * the tab and the rows under it can never disagree.
 */
export function reviewsTabCount(turns: ReviewTurnLike[]): number {
  return buildShowReviews(turns).length;
}

/**
 * Body of the Reviews tab: newest successful review first.
 */
export function reviewsTabHtml(
  taskId: string,
  turns: ReviewTurnLike[],
): string {
  // The same list the `show` RPC serves remote clients under `reviews` — this
  // tab and Lazy Teams' Reviews list read one answer, not two predicates.
  const reviews = buildShowReviews(turns);
  if (reviews.length === 0) {
    return `<section class="lz-reviews-tab" id="lz-reviews">
      <p class="rv-hint">No formal reviews yet. Use <strong>Review</strong> on the Summary tab to run one. Failed or unparsed reviews do not appear here.</p>
    </section>`;
  }

  const rows = reviews.map((r) => reviewRowHtml(taskId, r)).join('');
  // The colgroup, not the content, decides the proportions: `When` holds a full
  // timestamp on one line, `Verdict` is free text that WRAPS instead of
  // reserving width for the longest one ever written, and the space that frees
  // up goes to `Raises`, the only cell whose content grows.
  return `<section class="lz-reviews-tab" id="lz-reviews">
    <table class="table lz-reviews-table">
      <colgroup>
        <col class="lz-reviews-col-when">
        <col class="lz-reviews-col-verdict">
        <col class="lz-reviews-col-raises">
        <col class="lz-reviews-col-links">
      </colgroup>
      <thead>
        <tr>
          <th>When</th>
          <th>Verdict</th>
          <th>Raises</th>
          <th>Links</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function reviewRowHtml(taskId: string, review: ShowReview): string {
  const { sequence, raised_item_ids: ids, verdict } = review;
  const createdAt = review.created_at ?? undefined;
  const raiseCount = ids.length;
  const raiseCell = raiseCount === 0
    ? '<span class="lz-reviews-none">none</span>'
    : `<a href="/tasks/${escapeHtml(taskId)}/raised">${raiseCount}</a>`;
  const raiseLinks = ids.length === 0
    ? ''
    : `<span class="lz-reviews-raise-ids">${ids.map((id) =>
      `<a href="/raised/${escapeHtml(id)}" title="${escapeHtml(id)}">${escapeHtml(shortRaiseId(id))}</a>`,
    ).join(' · ')}</span>`;
  const turnHref = `/tasks/${escapeHtml(taskId)}/turns/${sequence}`;
  return `<tr>
    <td class="lz-reviews-when" title="${escapeHtml(formatWhen(createdAt))}">${whenHtml(createdAt)}</td>
    <td class="lz-reviews-verdict wrap" title="${escapeHtml(verdict)}">${escapeHtml(verdict)}</td>
    <td class="lz-reviews-raises wrap">${raiseCell}${raiseLinks ? ` ${raiseLinks}` : ''}</td>
    <td class="lz-reviews-links"><a href="${turnHref}">turn #${sequence}</a></td>
  </tr>`;
}
