/**
 * Per-region freshness keys and per-tab update policy for the live task page.
 *
 * WHY REGIONS AND NOT ONE TOKEN
 * The first live-status island compared a single token built from the header
 * fields (status, display status, progress, turn count, last activity). A loop
 * task that stays `working` while it creates and accepts subtasks never moves
 * any of those, so the Subtasks tab never refreshed — the reader had to reload
 * the page by hand. And when the token DID move, the island deleted every
 * cached tab body, which yanked a reader out of the middle of Changes because
 * an unrelated child was accepted.
 *
 * Separating the two questions fixes both: a REGION key says what changed, and
 * a TAB policy says how that tab is allowed to show it.
 *
 * WHY THE MAPS LIVE HERE AND ARE STAMPED INTO THE DOM
 * `taskTabStripHtml` stamps each tab's regions and policy onto its link
 * (`data-lz-tab-regions`, `data-lz-tab-policy`). The client island reads them
 * off the DOM and knows nothing about which tabs exist. Adding a tab is
 * therefore: add a slug, add a row to each map below, done — the island is not
 * touched. Concurrent work under this release adds Comments, Journal and review
 * regions to the same page; they register the same way.
 *
 * Keys are plain joins, never digests: unit and e2e tests assert key equality
 * and inequality directly, and the payload is a few hundred bytes.
 */

import type { TaskTabId } from './task-tabs';

/**
 * A named slice of task state the page can notice moving.
 *
 * `header` is what the old single token covered. The rest are the things it
 * was blind to.
 */
export const TASK_LIVE_REGION_IDS = [
  'header',
  'subtasks',
  'turns',
  'comments',
  'journal',
  'raised',
  'reviews',
  'changes',
  'commits',
] as const;

export type TaskLiveRegionId = (typeof TASK_LIVE_REGION_IDS)[number];

/**
 * How a tab body is allowed to be brought up to date.
 *
 * - `morph`  — patch the existing DOM in place by node identity. Scroll,
 *              focus, open `<details>` and text selection all survive.
 * - `append` — same morph, plus scroll anchoring: these tabs are timelines
 *              where new items land at the top (newest-first), so the reader's
 *              viewport is pinned to a surviving item rather than shoved down.
 * - `pill`   — never swapped. A non-modal "updated — reload" affordance; the
 *              reader chooses when. Changes and Current review carry a diff the
 *              reader is working through and a draft they are typing.
 * - `never`  — not touched at all. Shell and Verify host live terminals; a
 *              swap would kill the session.
 */
export type TaskTabUpdatePolicy = 'morph' | 'append' | 'pill' | 'never';

/** Which regions make each tab's body stale. Empty = this tab never goes stale. */
export const TASK_TAB_REGIONS: Readonly<Record<TaskTabId, readonly TaskLiveRegionId[]>> = {
  // The rollup counts children; the working preview and findings come from turns.
  landing: ['header', 'subtasks', 'turns', 'raised', 'reviews'],
  // The map over the diff. Its units are child tasks and its range is the
  // branch, so it goes stale on exactly what Changes does plus subtasks.
  regions: ['changes', 'subtasks'],
  changes: ['changes', 'commits'],
  verify: [],
  // Comments and journal still fold into the turn chunks here, even though
  // each also has a tab of its own.
  turns: ['turns', 'comments', 'journal', 'commits'],
  commits: ['commits'],
  reviews: ['reviews'],
  subtasks: ['subtasks'],
  raised: ['raised'],
  comments: ['comments'],
  journal: ['journal'],
  // Derived from status history (the task's and its children's) plus turns
  // and commits.
  stats: ['header', 'subtasks', 'turns', 'commits'],
  shell: [],
  services: [],
  review: ['header', 'raised', 'turns', 'changes'],
};

export const TASK_TAB_POLICY: Readonly<Record<TaskTabId, TaskTabUpdatePolicy>> = {
  landing: 'morph',
  // Same family as Changes: a reviewer reads the carve deliberately, and
  // recarving in the background would put the cover computation on a
  // three-second poll. They get the offer and choose.
  regions: 'pill',
  changes: 'pill',
  verify: 'never',
  turns: 'append',
  commits: 'append',
  reviews: 'morph',
  subtasks: 'morph',
  raised: 'morph',
  // Lists of note cards (comments also change in place while unseen, which
  // their key carries). Each carries a composer, so the morph's
  // form-value preservation and the interaction guard are load-bearing here:
  // a half-typed comment must survive a refresh.
  comments: 'append',
  journal: 'append',
  // An insight surface read on purpose, and the most expensive body on the
  // page (status history per child, plus the audit trail). Pill, not morph —
  // re-deriving it in the background on a hub would be the whole cost of the
  // tab paid by someone who is only looking at it.
  stats: 'pill',
  shell: 'never',
  services: 'never',
  review: 'pill',
};

/** Minimal shapes — the key builder needs identity and status, never bodies. */
export interface LiveRegionChild {
  id: string;
  status: string;
}

export interface LiveRegionTurn {
  id: string;
  sequence: number;
  review?: unknown;
}

export interface LiveRegionRecord {
  id: string;
  /** Comments only: an in-place edit (of a comment the agent has not seen)
   *  changes neither the count nor the last id, so the key must see it. */
  edited_at?: number;
}

export interface LiveRegionRaised {
  id: string;
  status: string;
}

export interface LiveRegionCommit {
  sha: string;
}

export interface TaskLiveRegionInput {
  /** Pre-built by `buildLiveStatusToken` — the header's own compare key. */
  headerKey: string;
  children: LiveRegionChild[];
  turns: LiveRegionTurn[];
  comments: LiveRegionRecord[];
  journal: LiveRegionRecord[];
  raised: LiveRegionRaised[];
  commits: LiveRegionCommit[];
  /** Task branch HEAD sha, or null when the branch does not exist yet. */
  headSha: string | null;
}

/** `n:<id>=<status>,…` — order-independent because the caller's order is stable. */
function idStatusKey(items: { id: string; status: string }[]): string {
  return `${items.length}:${items.map((i) => `${i.id.slice(0, 8)}=${i.status}`).join(',')}`;
}

/** `n:<last id>` — enough for an append-only list. */
function countLastKey(items: { id: string }[]): string {
  const last = items[items.length - 1];
  return `${items.length}:${last ? last.id.slice(0, 12) : ''}`;
}

/**
 * One freshness key per region.
 *
 * Every value is a short plain string safe to put in a JSON attribute: ids are
 * truncated and statuses are the closed status vocabulary, so nothing here can
 * carry a quote, a newline or user prose.
 */
export function buildLiveRegionKeys(
  input: TaskLiveRegionInput,
): Record<TaskLiveRegionId, string> {
  const reviewTurns = input.turns.filter((t) => t.review != null);
  return {
    header: input.headerKey,
    subtasks: idStatusKey(input.children),
    turns: countLastKey(input.turns),
    comments: `${countLastKey(input.comments)}:${Math.max(0, ...input.comments.map((c) => c.edited_at ?? 0))}`,
    journal: countLastKey(input.journal),
    raised: idStatusKey(input.raised),
    reviews: `${reviewTurns.length}:${reviewTurns.map((t) => t.sequence).join(',')}`,
    changes: input.headSha ? input.headSha.slice(0, 12) : '',
    commits: `${input.commits.length}:${input.commits[input.commits.length - 1]?.sha.slice(0, 12) ?? ''}`,
  };
}

/**
 * The single compare token, kept as the join of every region key.
 *
 * The page still stamps it and the poller still short-circuits on it, so the
 * common "nothing moved" tick is one string compare. It is now sensitive to
 * everything the regions are — which is the bug fix.
 */
export function liveKeysToken(keys: Record<TaskLiveRegionId, string>): string {
  return TASK_LIVE_REGION_IDS.map((id) => `${id}=${keys[id]}`).join('|');
}

/** Region ids whose key differs between two key sets. */
export function changedRegions(
  before: Partial<Record<TaskLiveRegionId, string>>,
  after: Record<TaskLiveRegionId, string>,
): TaskLiveRegionId[] {
  return TASK_LIVE_REGION_IDS.filter((id) => (before[id] ?? '') !== after[id]);
}
