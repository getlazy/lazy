/**
 * The raised-items triage queue — web half of `lazy raised`.
 *
 * One page for both halves of what used to be two entities: blocking items
 * (questions and decisions about a task's own scope or diff, which gate accept)
 * and non-blocking ones (yesterday's follow-ups — orthogonal proposals and
 * FYIs, which never gate). The `blocking` flag is a column and a filter, not a
 * separate queue: see docs/design/raised-items-unified.md.
 *
 * `/followups` still lands here — the old path redirects rather than 404s, so
 * bookmarks and links in old task prompts keep working for a release.
 *
 * Shares the inbox table layout vocabulary with src/server/messages.ts.
 */

import type {
  RaisedItemListSort,
  RaisedItemBlockingFilter,
  ListedRaisedItem,
  ListRaisedItemsOptions,
  ListRaisedItemsResult,
} from '../raised';
import { findSimilarRaisedItems } from '../raised/similar';
import { taskPath, taskPathByTaskId, type TaskCodeTables } from './task-urls';
import { layoutHtml } from './templates';
import { renderMarkdown, type RenderMarkdownOptions } from './markdown';
import { escapeHtml } from './review-diff';
import {
  orderPhrase,
  parseSortParam,
  sortHeadersHtml,
  type SortColumn,
  type SortColumnKind,
  type SortConfig,
} from './sort';
import { raisedDecideFormHtml, raisedDecideScript } from './raised-decide';
import { shortId } from '../task/identity';
import { defaultPromotedGoalFromRaised } from '../raised/promote-task';
import { raisedDisplayBody } from '../raised/content';
import { raisedItemProseFile } from '../review/prose-anchor';
import {
  raisedDecisionBadgeHtml,
  raisedGateBadgeHtml,
  raisedIdLineHtml,
  raisedIdentifierLineHtml,
} from './raised-badges';
import { raisedDecisionVocabulary, raisedGateVocabulary } from '../raised/vocabulary';
import { attributionLabel } from '../actor-ref';
import type { RaisedItemStatus } from '../types';

function formatDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function statusBadge(status: string): string {
  const tone = status === 'complete' ? 'tag-neutral' : 'tag-accent';
  return `<span class="tag ${tone}">${escapeHtml(status)}</span>`;
}

/** Glyph + word for a counts line — prose, so the glyph rides along. */
function gateCount(blocking: boolean): string {
  const gate = raisedGateVocabulary(blocking);
  return `${escapeHtml(gate.emoji)} ${escapeHtml(gate.label)}`;
}

/**
 * The one thing the flag means, said the same way everywhere: blocking items
 * hold up accept, the rest do not.
 *
 * Both badges come from src/server/raised-badges.ts now — this page, the review
 * summary and the task-page cards used to render three different spellings of
 * the same two facts, and the decision badge echoed the raw stored status
 * (`promoted_subtask`) at a reader who has never seen the enum.
 */
export function blockingBadge(blocking: boolean): string {
  return raisedGateBadgeHtml(blocking);
}

/** What was decided, as a badge — the unified status vocabulary, unabridged. */
function decisionBadge(
  status: RaisedItemStatus,
  promotedTaskId?: string | null,
  promotedTaskCode?: string | null,
  duplicatedCodes?: ReadonlySet<string>,
): string {
  return raisedDecisionBadgeHtml(status, { promotedTaskId, promotedTaskCode, duplicatedCodes });
}

/**
 * The queue's sortable columns, in render order — and the complete set of
 * fields `?sort=` accepts on `/raised`.
 *
 * One array drives the headers and the parser, so a header link can never point
 * at a field the parser rejects (see src/server/sort.ts). `age` ranks on when
 * the item was recorded, so it is a TIME column: ▼ is newest first, exactly as
 * the review queue's Last activity column means it.
 */
const RAISED_COLUMNS = [
  { field: 'title', label: 'Title', kind: 'text' },
  { field: 'blocking', label: 'Gate', kind: 'text' },
  { field: 'age', label: 'Age', kind: 'time' },
  { field: 'recurrence', label: 'Recurrence', kind: 'count' },
  { field: 'task', label: 'Task', kind: 'text' },
  { field: 'status', label: 'Status', kind: 'text' },
  { field: 'decision', label: 'Decision', kind: 'text' },
] as const satisfies readonly (SortColumn & { kind: SortColumnKind })[];

export type RaisedSortField = (typeof RAISED_COLUMNS)[number]['field'];

const RAISED_SORT_FIELDS: readonly RaisedSortField[] = RAISED_COLUMNS.map((c) => c.field);

/** Newest first — the order `listRaisedItems` itself defaults to. */
export const DEFAULT_RAISED_SORT: SortConfig<RaisedSortField> = {
  field: 'age',
  direction: 'desc',
};

/**
 * The default order for a view, which is not the same for every filter: the
 * Recurring-only view exists to answer "what keeps coming back", so it ranks by
 * recurrence size, biggest first — matching the recurrence summaries `lazy raised -r`
 * prints, which `groupRaisedItemsByRecurrence` ranks by size. The task list gives its
 * blocked filter a different fallback for the same reason.
 */
export function defaultRaisedSort(recurringOnly: boolean): SortConfig<RaisedSortField> {
  return recurringOnly ? { field: 'recurrence', direction: 'desc' } : DEFAULT_RAISED_SORT;
}

/** Parse `/raised?sort=…`, falling back to {@link defaultRaisedSort}. */
export function parseRaisedSort(
  sort: string | null,
  options: { recurringOnly?: boolean } = {},
): SortConfig<RaisedSortField> {
  return parseSortParam(sort, RAISED_SORT_FIELDS, defaultRaisedSort(options.recurringOnly ?? false));
}

/**
 * Which of the listing service's three orderings each column uses — `null`
 * where the service has none and this page ranks the rows itself.
 *
 * `listRaisedItems` orders by age (when it was recorded), recurrence size, and
 * originating task code. It has no ordering for the display title, the
 * blocking flag, the originating task's STATUS, or the DECISION, so those four
 * — and only those four — are ranked here, after the listing comes back. That
 * is correct only because this page asks for the whole listing with no
 * limit/offset: re-ordering a page the service had already truncated would rank
 * the wrong rows. Ordering that the service does own stays there — the page
 * never re-implements a comparator, so the arrow cannot disagree with the rows.
 *
 * A Record over the column list, so a new column cannot be added without
 * deciding which side of that line it falls on.
 */
const SERVICE_SORT_FOR: Record<RaisedSortField, RaisedItemListSort | null> = {
  title: null,
  blocking: null,
  age: 'age',
  recurrence: 'recurrence',
  task: 'task',
  status: null,
  decision: null,
};

/**
 * The `sort`/`order` options that put the service's own listing in this order.
 *
 * A column the service cannot rank still asks for the default (newest first):
 * {@link orderRaisedForDisplay} sorts stably, so rows that tie on status or
 * decision stay in newest-first order underneath.
 */
export function raisedListSort(
  sort: SortConfig<RaisedSortField>,
): { sort: RaisedItemListSort; order: 'asc' | 'desc' } {
  const service = SERVICE_SORT_FOR[sort.field];
  if (!service) return { sort: 'age', order: 'desc' };
  return { sort: service, order: sort.direction };
}

/** The text a page-ranked column compares on. */
function displayKeyFor(item: ListedRaisedItem, field: RaisedSortField): string {
  switch (field) {
    case 'title':
      return item.title.toLowerCase();
    case 'blocking':
      // Ascending puts blocking first, which is the order that matters: what
      // holds up a merge is what a reviewer came here to clear.
      return item.blocking ? '0' : '1';
    case 'status':
      return item.task_status;
    case 'decision':
      return item.status;
    default:
      return '';
  }
}

/**
 * Order rows for display, for the columns the service cannot rank.
 *
 * Everything else arrives already ordered and is returned untouched. Status and
 * decision rank alphabetically, which is what their ▲/▼ claims — grouping is
 * the point of sorting a categorical column, and "undecided first" already has
 * a control of its own in the Needs attention filter.
 */
export function orderRaisedForDisplay(
  items: ListedRaisedItem[],
  sort: SortConfig<RaisedSortField>,
): ListedRaisedItem[] {
  if (SERVICE_SORT_FOR[sort.field] !== null) return items;
  const dir = sort.direction === 'desc' ? -1 : 1;
  // Array#sort is stable, so equal keys keep the service's newest-first order.
  return [...items].sort(
    (a, b) => displayKeyFor(a, sort.field).localeCompare(displayKeyFor(b, sort.field)) * dir,
  );
}

function recurrenceSectionHtml(result: ListRaisedItemsResult, taskCodes?: TaskCodeTables): string {
  const recurring = result.recurrences.filter((c) => c.size > 1);
  if (recurring.length === 0) return '';

  const rowsHtml = recurring.map((c) => {
    const preview = escapeHtml(c.sample_content.replace(/\s+/g, ' ').trim().slice(0, 100));
    const tasksHtml = c.task_ids.map((id) => taskCodes
      ? `<a href="${escapeHtml(taskPathByTaskId(taskCodes, id))}">${escapeHtml(taskCodes.codeOf.get(id) ?? shortId(id))}</a>`
      : `<a href="/tasks/${escapeHtml(id)}">${escapeHtml(shortId(id))}</a>`).join(', ');
    return `<tr>
      <td><strong>${c.size}</strong></td>
      <td class="wrap">${preview}${c.sample_content.length > 100 ? '…' : ''}</td>
      <td>${tasksHtml}</td>
    </tr>`;
  }).join('\n');

  return `
    <div class="detail-section">
      <h2>Recurring items</h2>
      <p class="text-muted">Near-duplicates grouped by shared vocabulary (significant words + Jaccard ≥ 0.55).</p>
      <table class="table msg-table">
        <thead><tr><th>Count</th><th>Sample</th><th>Tasks</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
}

/** One inbox row — singleton or representative of a multi-task recurrence. */
interface RaisedDisplayRow {
  item: ListedRaisedItem;
  /** When set, this row represents a recurrence spanning multiple tasks. */
  recurrenceTaskIds?: string[];
}

/** Collapse multi-member recurrences to one table row; singletons stay as-is. */
function displayRowsForInbox(result: ListRaisedItemsResult): RaisedDisplayRow[] {
  const recurrenceById = new Map(result.recurrences.map((c) => [c.recurrence_id, c]));
  const seenMultiRecurrences = new Set<string>();
  const rows: RaisedDisplayRow[] = [];

  for (const item of result.items) {
    if (item.recurrence_size <= 1) {
      rows.push({ item });
      continue;
    }
    if (seenMultiRecurrences.has(item.recurrence_id)) continue;
    seenMultiRecurrences.add(item.recurrence_id);
    const recurrence = recurrenceById.get(item.recurrence_id);
    rows.push({
      item,
      recurrenceTaskIds: recurrence?.task_ids ?? [item.task_id],
    });
  }
  return rows;
}

/**
 * Everything the page's URL says: which rows, in which order.
 *
 * The one place `/raised` links are built, so the filter buttons and the column
 * headers cannot disagree about what the other half of the query string is —
 * the filters carry the sort, and the sort carries the filters.
 */
export interface RaisedView {
  state: 'open' | 'all';
  /** Gate filter: blocking only, non-blocking only, or both. */
  blocking: RaisedItemBlockingFilter;
  /** The single task-status filter this page offers, when it is on. */
  status?: 'complete-only';
  recurringOnly: boolean;
  sort: SortConfig<RaisedSortField>;
}

/**
 * Everything `/raised` asks the listing service for, built from the view.
 *
 * It sets no `limit`/`offset`, and that is load-bearing rather than incidental:
 * {@link orderRaisedForDisplay} ranks title/blocking/status/decision AFTER the
 * listing comes back, which is only correct on the WHOLE listing — re-ordering
 * a page the service had already truncated would rank the wrong rows and leave
 * the header arrow pointing at an order the table is not in. Constructing the
 * options here rather than inline in the route is what lets a test pin that
 * (test/unit/server-sort.test.ts) instead of a comment asking the next reader
 * to remember it. Paging this page therefore has a prerequisite: teach
 * `listRaisedItems` to order by those columns first, and delete them from the
 * page-side branch of {@link SERVICE_SORT_FOR}.
 */
export function raisedListOptions(view: RaisedView): ListRaisedItemsOptions {
  return {
    taskStatus: view.status,
    minRecurrenceSize: view.recurringOnly ? 2 : undefined,
    ...raisedListSort(view.sort),
    state: view.state,
    blocking: view.blocking,
    collapseExactDuplicates: true,
  };
}

/** Is this the order the view would render with no `?sort=` at all? */
function isDefaultSort(view: RaisedView): boolean {
  const fallback = defaultRaisedSort(view.recurringOnly);
  return view.sort.field === fallback.field && view.sort.direction === fallback.direction;
}

/**
 * A `/raised` URL for a view.
 *
 * `sortChosen` says whether the order is the reader's own doing rather than
 * whichever default the page they are on happens to use. A chosen order rides
 * along; a default one is left out of the URL, so a filter link from a
 * default-ordered page lands on the TARGET view's own default — which for
 * Recurring is recurrence size, the whole point of that view. This is the task
 * list's rule on a page whose default varies by filter.
 */
function raisedHref(view: RaisedView, sortChosen: boolean): string {
  const params = new URLSearchParams();
  if (view.state === 'all') params.set('all', '1');
  if (view.blocking !== 'all') params.set('gate', view.blocking);
  if (view.status) params.set('status', view.status);
  if (view.recurringOnly) params.set('recurring', '1');
  if (sortChosen && !isDefaultSort(view)) {
    params.set('sort', `${view.sort.direction === 'desc' ? '-' : ''}${view.sort.field}`);
  }
  const qs = params.toString();
  return qs ? `/raised?${qs}` : '/raised';
}

function filterBar(view: RaisedView): string {
  const { state, blocking, status, recurringOnly } = view;
  // An order the reader picked survives a filter change; one they merely landed
  // on does not follow them into a view that ranks differently by default.
  const chosen = !isDefaultSort(view);
  const mk = (label: string, target: RaisedView, active: boolean) =>
    `<a href="${escapeHtml(raisedHref(target, chosen))}" class="btn btn-sm${active ? ' active' : ''}">${escapeHtml(label)}</a>`;
  const unfiltered = !status && !recurringOnly && blocking === 'all';
  return `<div class="filter-bar">
    ${mk('Needs attention', { ...view, state: 'open', blocking: 'all', status: undefined, recurringOnly: false }, state === 'open' && unfiltered)}
    ${mk('All', { ...view, state: 'all', blocking: 'all', status: undefined, recurringOnly: false }, state === 'all' && unfiltered)}
    ${/* Labelled from the shared vocabulary, so the filter you click and the
        badge you then see in the Gate column are the same two words. */''}
    ${mk(raisedGateVocabulary(true).label, { ...view, blocking: 'blocking', status: undefined, recurringOnly: false }, blocking === 'blocking')}
    ${mk(raisedGateVocabulary(false).label, { ...view, blocking: 'non-blocking', status: undefined, recurringOnly: false }, blocking === 'non-blocking')}
    ${mk('Finished tasks', { ...view, status: 'complete-only', recurringOnly: false }, status === 'complete-only')}
    ${mk('Recurring only', { ...view, status: undefined, recurringOnly: true }, recurringOnly)}
  </div>`;
}

export function raisedInboxHtml(
  result: ListRaisedItemsResult,
  options: {
    state?: 'open' | 'all';
    blocking?: RaisedItemBlockingFilter;
    status?: 'complete-only';
    recurringOnly?: boolean;
    sort?: SortConfig<RaisedSortField>;
    /** Code lookup tables, for cluster rows that hold only task ids. */
    taskCodes?: TaskCodeTables;
  },
): string {
  const recurringOnly = options.recurringOnly ?? false;
  const view: RaisedView = {
    state: options.state ?? 'open',
    blocking: options.blocking ?? 'all',
    status: options.status,
    recurringOnly,
    // The route parses `?sort=` (it needs it to ask the service for that order);
    // a caller that gives none gets the order the service defaults to anyway.
    sort: options.sort ?? defaultRaisedSort(recurringOnly),
  };

  if (result.total === 0) {
    return layoutHtml('Raised items', `
      <h1>Raised items</h1>
      ${filterBar(view)}
      <div class="empty-state">No raised items match this filter.</div>
      <p class="text-muted">Agents raise items on tasks. Blocking ones — questions and decisions about that task's own scope or diff — hold up accept until they are decided; the rest are proposals and FYIs that never gate. Per-task items remain on each task page.</p>
    `);
  }

  const ordered = { ...result, items: orderRaisedForDisplay(result.items, view.sort) };
  const displayRows = displayRowsForInbox(ordered);
  const rows = displayRows.map((row) => raisedRowHtml(row, options.taskCodes)).join('\n');
  const groupedNote = displayRows.length < result.total
    ? ` (${displayRows.length} grouped row${displayRows.length === 1 ? '' : 's'})`
    : '';

  const activeColumn = RAISED_COLUMNS.find((c) => c.field === view.sort.field)!;
  const orderNote = `Sorted by <strong>${escapeHtml(activeColumn.label.toLowerCase())}</strong>, ${orderPhrase(activeColumn.kind, view.sort.direction)} — click a column to re-sort.`;
  const headers = sortHeadersHtml(RAISED_COLUMNS, view.sort, (sortParam) => {
    // Round-trip through the parser so a header link carries a field this page
    // accepts, in the same spelling the route will read back. A click IS a
    // choice, hence `true` — though clicking back to the view's default still
    // yields the bare URL rather than pinning the default into it.
    const target = parseRaisedSort(sortParam, { recurringOnly });
    return raisedHref({ ...view, sort: target }, true);
  });

  return layoutHtml('Raised items', `
    <h1>Raised items</h1>
    ${filterBar(view)}
    <p class="text-muted">${result.total} raised item(s)${groupedNote} — ${gateCount(true)}: ${result.total_open_blocking} open, ${gateCount(false)}: ${result.total_open_non_blocking} open across the project. Exact duplicate bodies on one task collapse to one row; near-duplicates across tasks group below and in the table.</p>
    <p class="text-muted">${orderNote}</p>
    ${recurrenceSectionHtml(result, options.taskCodes)}
    <table class="table msg-table">
      <thead><tr>${headers}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `);
}

function raisedRowHtml(row: RaisedDisplayRow, taskCodes?: TaskCodeTables): string {
  const { item, recurrenceTaskIds } = row;
  const taskLinksHtml = (recurrenceTaskIds && recurrenceTaskIds.length > 1
    ? recurrenceTaskIds
    : [item.task_id]
  ).map((id) => {
    const label = id === item.task_id
      ? (item.task_code ?? shortId(id))
      : (taskCodes?.codeOf.get(id) ?? shortId(id));
    const href = id === item.task_id
      ? taskPath({ id, code: item.task_code }, taskCodes?.duplicated)
      : taskCodes
        ? taskPathByTaskId(taskCodes, id)
        : `/tasks/${escapeHtml(id)}`;
    return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  }).join(', ');
  const recurrenceBadge = recurrenceTaskIds && recurrenceTaskIds.length > 1
    ? `<span class="tag tag-accent" title="${recurrenceTaskIds.length} tasks in this recurrence">recurring ×${recurrenceTaskIds.length}</span>`
    : '';
  // Falls back to the WORD, exactly as the decision badge does: a task with no
  // code yet is still worth pointing at, and an 8-hex prefix of its id is not
  // what anyone would point at it with.
  const promoted = item.promoted_task_id
    ? `<span class="tag tag-accent" title="Promoted to a task">→ ${escapeHtml(item.promoted_task_code || 'task')}</span>`
    : item.possibly_promoted
      ? `<span class="tag tag-warning" title="A task prompt references promotion from this task">promoted?</span>`
      : '';
  // The tooltip used to list 8-hex prefixes — unreadable AND unusable. Say what
  // the number means; the ids live on the item's own panel, in full.
  const dup = item.duplicate_count > 1
    ? `<span class="tag" title="${item.duplicate_count} records on this task share this body">×${item.duplicate_count}</span>`
    : '';
  return `<tr data-blocking="${item.blocking ? '1' : '0'}">
    <td class="wrap"><a href="/raised/${escapeHtml(item.id)}">${escapeHtml(item.title)}</a> ${promoted} ${dup} ${recurrenceBadge}</td>
    <td>${blockingBadge(item.blocking)}</td>
    <td>${item.age_days}d</td>
    <td>${item.recurrence_size}</td>
    <td>${taskLinksHtml}</td>
    <td>${statusBadge(item.task_status)}</td>
    <td>${decisionBadge(item.status, item.promoted_task_id, item.promoted_task_code, taskCodes?.duplicated)}${decidedByTag(item)}</td>
  </tr>`;
}

/**
 * The person who decided, beside the decision badge in a table cell.
 *
 * The PERSON only, deliberately (the role is passed as null): every decision in
 * a single-user install was made by `human`, and a column repeating that word
 * on every row says nothing.
 * A team's rows differ from each other, which is the whole reason to show it.
 */
function decidedByTag(item: ListedRaisedItem): string {
  const who = attributionLabel(null, item.resolved_by_email, item.resolved_by_name);
  if (!who) return '';
  return ` <span class="text-muted">by ${escapeHtml(who)}</span>`;
}

/** The flag toggle — the reviewer's last word on what the agent chose. */
function blockingToggleHtml(item: ListedRaisedItem): string {
  const target = item.blocking ? 'false' : 'true';
  // Names the state you are switching TO, in the vocabulary's words — the
  // button said "Make non-blocking" under a badge reading "⚠️ FYI". The posted
  // VALUE is untouched: `blocking=true|false` is the contract, this is display.
  const label = `Make this ${raisedGateVocabulary(!item.blocking).label}`;
  // A third hand-written copy of the same two facts lived here. From the
  // vocabulary, so the toggle describes the flag the badge above it shows.
  const hint = raisedGateVocabulary(item.blocking).hint;
  // Absent means nobody has overridden the agent — the sentence above already
  // says the flag is the agent's, so there is nothing extra to name.
  const flaggedBy = attributionLabel(item.flagged_by, item.flagged_by_email, item.flagged_by_name);
  const flaggedLine = flaggedBy
    ? `<p class="text-muted">Last changed by ${escapeHtml(flaggedBy)}.</p>`
    : '';
  return `<div class="detail-section">
      <h2>Gate</h2>
      <p class="text-muted">${escapeHtml(hint)} The agent chose the flag; you have the last word.</p>
      ${flaggedLine}
      <form class="rv-raised-blocking" method="post" action="/raised/${escapeHtml(item.id)}/blocking">
        <input type="hidden" name="blocking" value="${target}">
        <button type="submit">${escapeHtml(label)}</button>
      </form>
    </div>`;
}

/**
 * Panel body for one raised item — dialog fragment and permalink content.
 *
 * Used as `GET /raised/:id?fragment=1` (dialog fetch) and as the pre-filled
 * body when `/raised/:id` renders the task's Raised tab with the dialog open.
 * The decide form stays here, not on the list.
 */
export function raisedPanelHtml(
  item: ListedRaisedItem,
  similar: ListedRaisedItem[],
  options?: {
    decideError?: string;
    markdown?: RenderMarkdownOptions;
    /** Code tables, so every task link here falls back to the id when the code is shared by more than one task. */
    taskCodes?: TaskCodeTables;
  },
): string {
  const taskLabel = item.task_code ?? shortId(item.task_id);
  const decideError = options?.decideError
    ? `<p class="text-error">${escapeHtml(options.decideError)}</p>`
    : '';
  const isOpen = item.status === 'open';
  // Built from the vocabulary, not hand-written beside it. The literals here
  // used to call a ⚠️ FYI item "Non-blocking" one paragraph under its own badge
  // — the badge and the prose disagreeing about the same flag, which is the
  // report this whole change answers, reproduced inside the fix for it.
  const gate = raisedGateVocabulary(item.blocking);
  const gateSentence = `${gate.phrase}. ${gate.hint}`;
  const decideSectionHtml = isOpen
    ? `<div class="detail-section">
      <h2>Decide</h2>
      ${reopenedByLine(item)}
      <p class="text-muted">${escapeHtml(gateSentence)} Respond quotes the item back to the agent; acknowledge = seen, maybe later; dismiss = seen, won't pursue; promote = a task that never auto-starts. Prompt comes from the agent proposal when present.</p>
      ${decideError}
      ${raisedDecideFormHtml({
        action: `/raised/${item.id}/decide`,
        id: item.id,
        blocking: item.blocking,
        // Prefill from title (structured proposal) or first sentence (legacy),
        // so the card shows the goal the reviewer is about to get.
        defaultGoal: defaultPromotedGoalFromRaised({
          content: item.content,
          ...(item.item_title ? { title: item.item_title } : {}),
        }),
        defaultCode: item.proposed_code ?? undefined,
        variant: 'card',
      })}
    </div>
    ${raisedDecideScript()}`
    : `<div class="detail-section">
      <h2>Decision</h2>
      <p>${decisionSentenceHtml(item, options?.taskCodes?.duplicated)}</p>
      ${decidedByLine(item)}
      ${item.resolution ? `<p class="text-muted">Note: ${escapeHtml(item.resolution)}</p>` : ''}
      ${decideError}
    </div>`;
  const optionsSection = item.options?.length
    ? `<div class="detail-section">
      <h2>Options the agent offered</h2>
      <ul class="raised-options">${item.options.map((o) => `<li>${escapeHtml(o)}</li>`).join('')}</ul>
    </div>`
    : '';
  const commentsSection = item.comments?.length
    ? `<div class="detail-section">
      <h2>Agent comments</h2>
      <ul class="raised-comments">${item.comments.map((c) =>
        `<li><span class="text-muted">${escapeHtml(c.actor)} · ${escapeHtml(formatDate(c.created_at))}</span>` +
        `<div class="turn-content">${renderMarkdown(c.content, options?.markdown)}</div></li>`
      ).join('')}</ul>
    </div>`
    : '';
  const similarRows = similar.length === 0
    ? '<p class="text-muted">No similar raised items found.</p>'
    : `<ul class="followup-similar-list">${similar.map((s) => {
      const label = s.task_code ?? shortId(s.task_id);
      return `<li><a href="/raised/${escapeHtml(s.id)}">${escapeHtml(s.title)}</a>` +
        ` <span class="text-muted">(${escapeHtml(label)}, ${s.age_days}d)</span></li>`;
    }).join('')}</ul>`;

  return `<article class="lz-raised-panel" data-raised-id="${escapeHtml(item.id)}">
    <h1>${escapeHtml(item.title)}</h1>
    <div class="msg-meta">
      ${raisedGateBadgeHtml(item.blocking, 'full')}
      ${raisedDecisionBadgeHtml(item.status, {
        promotedTaskId: item.promoted_task_id,
        promotedTaskCode: item.promoted_task_code,
        width: 'full',
        duplicatedCodes: options?.taskCodes?.duplicated,
      })}
      · task <a href="${taskPath({ id: item.task_id, code: item.task_code }, options?.taskCodes?.duplicated)}">${escapeHtml(taskLabel)}</a>
      · ${statusBadge(item.task_status)}
      · ${escapeHtml(formatDate(item.created_at))}
      · recurrence size ${item.recurrence_size}
    </div>
    <div class="detail-section">
      <div class="turn-content" data-rv-prose="${escapeHtml(raisedItemProseFile(item.id))}">${renderMarkdown(raisedDisplayBody({
        content: item.content,
        ...(item.item_title ? { title: item.item_title } : {}),
        ...(item.explanation ? { explanation: item.explanation } : {}),
      }), options?.markdown)}</div>
    </div>
    ${optionsSection}
    ${commentsSection}
    ${decideSectionHtml}
    ${blockingToggleHtml(item)}
    ${provenanceSection(item, options?.taskCodes?.duplicated)}
    <div class="detail-section">
      <h2>Similar raised items</h2>
      ${similarRows}
    </div>
  </article>`;
}

/**
 * @deprecated Permalink `/raised/:id` now renders the Raised tab with a dialog.
 * Kept only so a caller that still wants a standalone page can wrap the panel.
 */
export function raisedDetailHtml(
  item: ListedRaisedItem,
  similar: ListedRaisedItem[],
  options?: { decideError?: string; markdown?: RenderMarkdownOptions },
): string {
  return layoutHtml(item.title, `
    <div class="breadcrumb"><a href="/raised">Raised items</a> &rsaquo; Item</div>
    ${raisedPanelHtml(item, similar, options)}
  `);
}

/**
 * "Decided by <who>, <when>" — the attribution line under a decision.
 *
 * A raised-item decision is the one review act that gates a merge, so WHO made
 * it is part of the record, not metadata: on a team the difference between "a
 * human dismissed this" and "Ada dismissed this" is the whole question. The
 * words come from {@link attributionLabel}, which every surface shares, and it
 * falls back to the role alone when the store recorded no person to name.
 */
export function decidedByLine(item: ListedRaisedItem): string {
  const who = attributionLabel(item.resolved_by, item.resolved_by_email, item.resolved_by_name);
  if (!who) return '';
  const when = item.resolved_at ? `, ${formatDate(item.resolved_at)}` : '';
  return `<p class="text-muted">Decided by ${escapeHtml(who)}${escapeHtml(when)}.</p>`;
}

/** "Reopened by <who>" — shown on an open item whose decision was undone. */
export function reopenedByLine(item: ListedRaisedItem): string {
  const who = attributionLabel(item.unresolved_by, item.unresolved_by_email, item.unresolved_by_name);
  return who ? `<p class="text-muted">Reopened by ${escapeHtml(who)}.</p>` : '';
}

/**
 * What was decided, in a sentence, with the promoted task linked when there is
 * one.
 *
 * The words come from the vocabulary; only the LINK is assembled here, because
 * a link is the one thing a words-and-tones module has no business holding.
 * This used to be a second hand-written copy of all five labels, free to drift
 * from the badge sitting directly above it.
 */
function decisionSentenceHtml(item: ListedRaisedItem, duplicated?: ReadonlySet<string>): string {
  const decision = raisedDecisionVocabulary(item.status);
  if (item.promoted_task_id && (item.status === 'promoted_subtask' || item.status === 'promoted_peer')) {
    const label = item.promoted_task_code || 'the task it became';
    const link = `<a href="${taskPath({ id: item.promoted_task_id, code: item.promoted_task_code ?? null }, duplicated)}">${escapeHtml(label)}</a>`;
    return `${decision.phrase} — ${link}. ${decision.hint}`;
  }
  return `${decision.phrase}. ${decision.hint}`;
}

/**
 * Where the item came from: the task and the agent run that raised it, plus the
 * task it became. Provenance is why a reader can judge a raised item at all.
 */
function provenanceSection(item: ListedRaisedItem, duplicated?: ReadonlySet<string>): string {
  const taskLabel = item.task_code ?? shortId(item.task_id);
  const rows: string[] = [
    `<li>Raised on task <a href="${taskPath({ id: item.task_id, code: item.task_code }, duplicated)}">${escapeHtml(taskLabel)}</a> — ${escapeHtml(item.task_goal)}</li>`,
    `<li>Task status: ${statusBadge(item.task_status)}</li>`,
    `<li>Raised ${escapeHtml(formatDate(item.created_at))} (${item.age_days}d ago)</li>`,
  ];
  // NO session line. It rendered `Session 3bc4fb1e` — a truncation that was too
  // short to read and too short to paste — and the first attempt to fix it
  // relabelled the value as an argument to `lazy conversation show`, a command
  // that does not exist (the verb is `conversations`). Spelled correctly it
  // still would not work: `lazy conversations show` resolves a STORED
  // CONVERSATION by its captured Claude Code session UUID, while this field is
  // the lazy TASK SESSION that surfaced the item — a different id, which lazy's
  // own Session keeps in a separate `agent_session_id`. No command takes this
  // value, so by the rule in raisedIdentifierLineHtml it does not belong on the
  // page. If a surface ever needs to name the run that raised an item, the
  // honest form is a LINK to that session, not an id printed at a reader.
  if (item.promoted_task_id) {
    // A fourth `shortId` fallback lived here, and the extended fixture is what
    // found it: same rule as the badge and the row tag — the task's CODE, or
    // the word, never a prefix of its id.
    const label = item.promoted_task_code || 'the task it became';
    rows.push(`<li>Promoted to <a href="${taskPath({ id: item.promoted_task_id, code: item.promoted_task_code ?? null }, duplicated)}">${escapeHtml(label)}</a></li>`);
  } else if (item.possibly_promoted) {
    rows.push(`<li class="text-muted">A later task's prompt references promotion from this task — it may already be covered.</li>`);
  }
  // The id, spelled out ONCE on the whole surface and at the bottom of the one
  // panel someone opens to act on this item. Every row that used to lead with a
  // short hex now leads with what the item IS; whoever needs the argument to
  // `lazy accept`'s raised-resolution flags finds it here, in full, labelled.
  rows.push(raisedIdLineHtml(item.id));
  return `<div class="detail-section">
      <h2>Provenance</h2>
      <ul class="followup-provenance">${rows.join('')}</ul>
    </div>`;
}

/** Build the similar-items list for a detail page from a full listing. */
export function similarRaisedForDetail(
  item: ListedRaisedItem,
  allItems: ListedRaisedItem[],
): ListedRaisedItem[] {
  return findSimilarRaisedItems(item, allItems).map((s) => s.item);
}
