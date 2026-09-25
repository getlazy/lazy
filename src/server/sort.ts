/**
 * Sortable table columns for the server-rendered pages.
 *
 * One convention, used by every listing page: `?sort=<field>` ascending,
 * `?sort=-<field>` descending, and a column header that is a link toggling its
 * own direction. The task list invented it; the review queue and the follow-ups
 * queue reuse it, so a `-last_active` in the URL means the same thing on every
 * page that has such a column.
 *
 * The COLUMN LIST is the source of truth for what `?sort=` accepts: a page
 * passes the same array to {@link parseSortParam} and {@link sortHeadersHtml},
 * so a header link can never point at a field the parser rejects. That is not
 * hypothetical — the task list's Turns header was a dead link for exactly that
 * reason, silently falling back to the default order with no error anywhere.
 */

import { escapeHtml } from './review-diff';

export type SortDirection = 'asc' | 'desc';

export interface SortConfig<F extends string = string> {
  field: F;
  direction: SortDirection;
}

/**
 * What a column ranks, which is all {@link orderPhrase} needs to say what the
 * arrow did: a time column's ▼ is "newest first", a count column's is "most
 * first", and a text column's is "Z to A".
 */
export type SortColumnKind = 'text' | 'time' | 'count';

/** A sortable column: the `?sort=` field name and its header label. */
export interface SortColumn<F extends string = string> {
  field: F;
  label: string;
  /** Only read for the "sorted by …" note; headers render without it. */
  kind?: SortColumnKind;
}

/**
 * Parse a `?sort=` value against the fields a page accepts.
 *
 * Anything unrecognised — a missing param, a typo, a field from another page —
 * falls back to that page's default order rather than throwing: a URL someone
 * hand-edited or a stale bookmark should still render the page.
 */
export function parseSortParam<F extends string>(
  sort: string | null | undefined,
  fields: readonly F[],
  fallback: SortConfig<F>,
): SortConfig<F> {
  if (!sort) return fallback;
  const descending = sort.startsWith('-');
  const field = descending ? sort.slice(1) : sort;
  if (!fields.includes(field as F)) return fallback;
  return { field: field as F, direction: descending ? 'desc' : 'asc' };
}

/**
 * "newest first" and friends — what the active sort actually did, in words.
 *
 * Shared so two pages cannot describe the same direction differently; the arrow
 * alone left a reviewer guessing what the rows were ranked by.
 */
export function orderPhrase(kind: SortColumnKind, direction: SortDirection): string {
  if (kind === 'time') return direction === 'desc' ? 'newest first' : 'oldest first';
  if (kind === 'count') return direction === 'desc' ? 'most first' : 'fewest first';
  return direction === 'desc' ? 'Z to A' : 'A to Z';
}

/** The `?sort=` value that a click on `field` should request next. */
export function nextSortParam<F extends string>(field: F, active: SortConfig<F>): string {
  // Clicking the active column toggles it; a new column starts descending,
  // which is what you want for every time and count column on these pages.
  if (active.field !== field) return `-${field}`;
  return active.direction === 'desc' ? field : `-${field}`;
}

/**
 * The `<th>` cells for a set of sortable columns, in order.
 *
 * `hrefFor` turns a `?sort=` value into the page's own URL, so each page keeps
 * ownership of its other query params (the task list carries `filter`).
 */
export function sortHeadersHtml<F extends string>(
  columns: readonly SortColumn<F>[],
  active: SortConfig<F>,
  hrefFor: (sortParam: string) => string,
): string {
  return columns
    .map(({ field, label }) => {
      const isActive = active.field === field;
      const indicator = isActive ? (active.direction === 'desc' ? ' ▼' : ' ▲') : '';
      const href = hrefFor(nextSortParam(field, active));
      const classes = `sort-link${isActive ? ' sort-active' : ''}`;
      return `<th><a href="${escapeHtml(href)}" class="${classes}">${escapeHtml(label)}${indicator}</a></th>`;
    })
    .join('');
}
