/**
 * Cross-task raised-item listing — aggregation, filters, grouping, promotion hints.
 *
 * Surfaces (`lazy raised`, `lazy_raised_list`, `/raised`) are thin clients; this
 * module owns the "what's piling up" logic. Per-task review via `lazy_show`'s
 * `raised_items` array is separate.
 *
 * See docs/design/raised-items-unified.md.
 */

import type { Actor, RaisedItem, RaisedItemStatus, Task, TaskStatus } from '../types';
import { isTerminalStatus } from '../types';
import { groupRaisedItemsByRecurrence } from './recurrence';
import { raisedDisplayTitle, raisedSearchText } from './content';
import { buildPromotionIndex } from './promotion';
import { normalizeRaisedContent } from './title';

export type RaisedItemListSort = 'age' | 'recurrence' | 'task';

/** Default web/CLI filter: open items still awaiting a human decision. */
export type RaisedItemStateFilter = 'open' | 'all';

/** Blocking filter: gating items only, non-gating only, or both. */
export type RaisedItemBlockingFilter = 'blocking' | 'non-blocking' | 'all';

export type RaisedItemTaskStatusFilter =
  | TaskStatus
  | 'terminal'
  | 'non-terminal'
  | 'complete-only';

export interface ListRaisedItemsOptions {
  /** Filter by originating task status (or terminal / non-terminal / complete-only). */
  taskStatus?: RaisedItemTaskStatusFilter;
  /** Case-insensitive substring on the item body. */
  query?: string;
  /** Only items at least this many days old. */
  minAgeDays?: number;
  /** Only items in recurrences of at least this size (recurrence filter). */
  minRecurrenceSize?: number;
  sort?: RaisedItemListSort;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  /** When `open`, hide resolved items. Default `all` — surfaces pass `open` explicitly. */
  state?: RaisedItemStateFilter;
  /** Restrict to accept-gating (`blocking`) or non-gating items. Default `all`. */
  blocking?: RaisedItemBlockingFilter;
  /** Collapse exact duplicate bodies into one row with duplicate_count > 1. */
  collapseExactDuplicates?: boolean;
}

export interface ListedRaisedItem {
  id: string;
  task_id: string;
  task_code: string | null;
  task_goal: string;
  task_status: TaskStatus;
  content: string;
  /** TRUE when this item gates accept on its task. */
  blocking: boolean;
  /** Display title for table headings. */
  title: string;
  /** Structured proposal title when the agent filed one. */
  item_title?: string;
  /** Structured proposal fields when present. */
  explanation?: string;
  proposed_code?: string;
  proposed_prompt?: string;
  options?: string[];
  status: RaisedItemStatus;
  /** The note the human left when resolving, if any. */
  resolution: string | null;
  /**
   * Agent notes on this item (lazy_raised_item_comment). Never resolves it.
   * Empty/absent when nobody has commented yet.
   */
  comments?: Array<{
    id: string;
    content: string;
    created_at: number;
    actor: string;
  }>;
  /** When the decision was recorded; null while the item is still open. */
  resolved_at: number | null;
  /**
   * WHO decided, and WHICH PERSON when the store recorded one. The role alone
   * is what a row with nobody behind it has; the email is what lets a team see
   * which member answered, dismissed or promoted an item that gates a merge,
   * and the name is how they were called at the time.
   */
  resolved_by: Actor | null;
  resolved_by_email: string | null;
  resolved_by_name: string | null;
  /** Who last overrode the agent's blocking flag, if anyone. */
  flagged_by: Actor | null;
  flagged_by_email: string | null;
  flagged_by_name: string | null;
  /** Who undid a decision, when this open item was decided once and reopened. */
  unresolved_by: Actor | null;
  unresolved_by_email: string | null;
  unresolved_by_name: string | null;
  created_at: number;
  session_id?: string | null;
  recurrence_id: string;
  recurrence_size: number;
  /** A later task's prompt says it was promoted from this originating task (heuristic). */
  possibly_promoted: boolean;
  /** Task ids whose prompts reference promotion from this item's task (heuristic). */
  promoted_to_task_ids: string[];
  /** When the item was promoted — the backlog task created from it. */
  promoted_task_id: string | null;
  promoted_task_code: string | null;
  age_days: number;
  /** When collapseExactDuplicates grouped rows, how many records share this body. */
  duplicate_count: number;
  /** All ids sharing the collapsed body (newest representative id is `id`). */
  duplicate_ids: string[];
}

export interface ListRaisedItemsResult {
  total: number;
  /** Open blocking items in the unfiltered set — what the nav badge leads with. */
  total_open_blocking: number;
  /** Open non-blocking items in the unfiltered set. */
  total_open_non_blocking: number;
  items: ListedRaisedItem[];
  recurrences: Array<{
    recurrence_id: string;
    size: number;
    sample_content: string;
    raised_item_ids: string[];
    task_ids: string[];
  }>;
}

export interface RawRaisedItemRow {
  item: RaisedItem;
  task: Task;
}

/** Promotion statuses — an item that became a task. */
export function raisedIsPromoted(status: RaisedItemStatus): boolean {
  return status === 'promoted_peer' || status === 'promoted_subtask';
}

/** Open = still awaiting a human decision. */
export function raisedIsOpen(status: RaisedItemStatus | undefined): boolean {
  return !status || status === 'open';
}

function matchesTaskStatusFilter(task: Task, filter: RaisedItemTaskStatusFilter): boolean {
  switch (filter) {
    case 'terminal':
      return isTerminalStatus(task.status);
    case 'non-terminal':
      return !isTerminalStatus(task.status);
    case 'complete-only':
      return task.status === 'complete';
    default:
      return task.status === filter;
  }
}

function sortItems(items: ListedRaisedItem[], sort: RaisedItemListSort, order: 'asc' | 'desc'): ListedRaisedItem[] {
  const dir = order === 'asc' ? 1 : -1;
  const sorted = [...items];
  sorted.sort((a, b) => {
    let cmp = 0;
    switch (sort) {
      case 'recurrence':
        // Ascending, like every other case here — `dir` is what flips it. This
        // used to be pre-negated (`b - a`), so `order: 'desc'` returned the
        // SMALLEST recurrences first: the opposite of what the same `desc` means
        // for age and task. It orders ITEMS only; the recurrence summaries below
        // are ranked by size in groupRaisedItemsByRecurrence, which is why the summary
        // surfaces (`lazy raised -r`, MCP `recurring_only`) never showed the
        // inversion and the item surfaces did.
        cmp = a.recurrence_size - b.recurrence_size || a.created_at - b.created_at;
        break;
      case 'task':
        const codeA = a.task_code ?? a.task_id.slice(0, 8);
        const codeB = b.task_code ?? b.task_id.slice(0, 8);
        cmp = codeA.localeCompare(codeB) || a.created_at - b.created_at;
        break;
      case 'age':
      default:
        cmp = a.created_at - b.created_at;
        break;
    }
    return cmp * dir;
  });
  return sorted;
}

function collapseExactDuplicateItems(items: ListedRaisedItem[]): ListedRaisedItem[] {
  const byTaskAndBody = new Map<string, ListedRaisedItem[]>();
  for (const item of items) {
    // Per-task only — identical bodies on different tasks stay separate rows.
    // Blocking is part of the key: a blocking question and an orthogonal note
    // that happen to share a body are different decisions for the reviewer.
    const key = `${item.task_id}:${item.blocking ? 'b' : 'n'}:${normalizeRaisedContent(item.content)}`;
    const list = byTaskAndBody.get(key) ?? [];
    list.push(item);
    byTaskAndBody.set(key, list);
  }

  const collapsed: ListedRaisedItem[] = [];
  for (const group of byTaskAndBody.values()) {
    group.sort((a, b) => b.created_at - a.created_at);
    const rep = group[0]!;
    collapsed.push({
      ...rep,
      duplicate_count: group.length,
      duplicate_ids: group.map((g) => g.id),
    });
  }
  return collapsed;
}

/**
 * Build a cross-task raised-item listing from raw rows plus all tasks
 * (for promotion hints).
 */
export function buildRaisedItemsListing(
  rows: RawRaisedItemRow[],
  allTasks: Task[],
  options: ListRaisedItemsOptions = {},
): ListRaisedItemsResult {
  const now = Date.now();
  const promotions = buildPromotionIndex(allTasks);
  const taskById = new Map(allTasks.map((t) => [t.id, t]));

  const taskIdForItem = new Map<string, string>();
  for (const row of rows) {
    taskIdForItem.set(row.item.id, row.item.task_id);
  }

  const { recurrenceIdFor, recurrences } = groupRaisedItemsByRecurrence(
    rows.map((r) => ({ id: r.item.id, content: r.item.content })),
    (id) => taskIdForItem.get(id) ?? '',
  );

  const recurrenceSizeFor = new Map<string, number>();
  for (const c of recurrences) recurrenceSizeFor.set(c.recurrence_id, c.size);

  let items: ListedRaisedItem[] = rows.map(({ item, task }) => {
    const recurrence_id = recurrenceIdFor.get(item.id) ?? item.id;
    const heuristicPromotedTo = promotions.get(task.id) ?? [];
    const isPromoted = raisedIsPromoted(item.status) && Boolean(item.promoted_task_id);
    const promotedTaskId = isPromoted ? item.promoted_task_id! : null;
    const promotedTask = promotedTaskId ? taskById.get(promotedTaskId) : undefined;
    const ageMs = now - item.created_at;
    return {
      id: item.id,
      task_id: task.id,
      task_code: task.code ?? null,
      task_goal: task.goal,
      task_status: task.status,
      content: item.content,
      blocking: item.blocking,
      title: raisedDisplayTitle(item),
      ...(item.title ? { item_title: item.title } : {}),
      ...(item.explanation ? { explanation: item.explanation } : {}),
      ...(item.proposed_code ? { proposed_code: item.proposed_code } : {}),
      ...(item.proposed_prompt ? { proposed_prompt: item.proposed_prompt } : {}),
      ...(item.options?.length ? { options: item.options } : {}),
      status: item.status ?? 'open',
      resolution: item.resolution ?? null,
      ...(item.comments && item.comments.length > 0
        ? {
            comments: item.comments.map((c) => ({
              id: c.id,
              content: c.content,
              created_at: c.created_at,
              actor: c.actor,
            })),
          }
        : {}),
      resolved_at: item.resolved_at ?? null,
      resolved_by: item.resolved_by ?? null,
      resolved_by_email: item.resolved_by_email ?? null,
      resolved_by_name: item.resolved_by_name ?? null,
      flagged_by: item.flagged_by ?? null,
      flagged_by_email: item.flagged_by_email ?? null,
      flagged_by_name: item.flagged_by_name ?? null,
      unresolved_by: item.unresolved_by ?? null,
      unresolved_by_email: item.unresolved_by_email ?? null,
      unresolved_by_name: item.unresolved_by_name ?? null,
      created_at: item.created_at,
      session_id: item.session_id,
      recurrence_id,
      recurrence_size: recurrenceSizeFor.get(recurrence_id) ?? 1,
      possibly_promoted: !isPromoted && heuristicPromotedTo.length > 0,
      promoted_to_task_ids: isPromoted ? [promotedTaskId!] : heuristicPromotedTo,
      promoted_task_id: promotedTaskId,
      promoted_task_code: item.promoted_task_code ?? promotedTask?.code ?? null,
      age_days: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
      duplicate_count: 1,
      duplicate_ids: [item.id],
    };
  });

  // Badge counts describe the whole project, not the current filter — a nav
  // badge that changed with the page's own filter would be useless.
  const totalOpenBlocking = items.filter((i) => raisedIsOpen(i.status) && i.blocking).length;
  const totalOpenNonBlocking = items.filter((i) => raisedIsOpen(i.status) && !i.blocking).length;

  if ((options.state ?? 'all') === 'open') {
    items = items.filter((i) => raisedIsOpen(i.status));
  }

  const blockingFilter = options.blocking ?? 'all';
  if (blockingFilter === 'blocking') {
    items = items.filter((i) => i.blocking);
  } else if (blockingFilter === 'non-blocking') {
    items = items.filter((i) => !i.blocking);
  }

  if (options.taskStatus) {
    items = items.filter((i) => {
      const task = rows.find((r) => r.item.id === i.id)?.task;
      return task && matchesTaskStatusFilter(task, options.taskStatus!);
    });
  }

  if (options.query) {
    const q = options.query.toLowerCase();
    items = items.filter((i) => {
      const row = rows.find((r) => r.item.id === i.id);
      const haystack = row ? raisedSearchText(row.item) : i.content;
      return haystack.toLowerCase().includes(q);
    });
  }

  if (options.minAgeDays !== undefined && options.minAgeDays > 0) {
    items = items.filter((i) => i.age_days >= options.minAgeDays!);
  }

  if (options.minRecurrenceSize !== undefined && options.minRecurrenceSize > 1) {
    items = items.filter((i) => i.recurrence_size >= options.minRecurrenceSize!);
  }

  const sort = options.sort ?? 'age';
  const order = options.order ?? 'desc';
  items = sortItems(items, sort, order);

  if (options.collapseExactDuplicates) {
    items = collapseExactDuplicateItems(items);
    items = sortItems(items, sort, order);
  }

  const total = items.length;
  const offset = options.offset ?? 0;
  const limit = options.limit;
  if (limit !== undefined && limit > 0) {
    items = items.slice(offset, offset + limit);
  } else if (offset > 0) {
    items = items.slice(offset);
  }

  const visibleRecurrences = recurrences.filter((c) => {
    if (options.minRecurrenceSize && c.size < options.minRecurrenceSize) return false;
    if (options.query) {
      const q = options.query.toLowerCase();
      return c.sample_content.toLowerCase().includes(q);
    }
    return true;
  });

  return {
    total,
    total_open_blocking: totalOpenBlocking,
    total_open_non_blocking: totalOpenNonBlocking,
    items,
    recurrences: visibleRecurrences,
  };
}
