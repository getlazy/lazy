/**
 * Page-shaped answers for Lazy Teams' project page and Tasks page.
 *
 * `list` with no `shape` still builds the full tree (`buildTaskTree`): the CLI,
 * the dashboard and any older client keep that reply. Teams' two pages do not.
 * They used to ask for the tree and then keep fifteen cards, or one status
 * chip, out of thousands of tasks. Building that tree reads every task's
 * session, its whole `turns.json` (just to count), and probes liveness for
 * every non-terminal task — sequentially per task inside the tree walk. On a
 * virtualised mount that cost is N times one file read, and the payload is
 * every prompt.
 *
 * `shape: "overview"` returns the three strips the project page renders (five
 * rows each) plus the counts the nav already shows. `shape: "page"` returns
 * the rows the Tasks page renders for one view. Neither reads `turns.json`
 * except for the five needs-you cards (the only place a turn count is shown).
 * The active view also fetches a missing ancestor by id — a finished parent is
 * not in the non-terminal read — and probes liveness for every non-terminal
 * row on that view. The other views probe only a `working` row. The protected
 * marker (`[P]`) is computed for the active view only: the flat lenses do not
 * show it, and a per-row protection read on All or Open is the cost this page
 * stopped paying. Selection
 * matches `TaskListQuery` in the Rails app; when a reply carries `shaped`,
 * Teams still runs that query so a label-based sort stays the app's, and when
 * it does not (an older daemon, a test stub) Teams filters the tree itself.
 */

import type { Session, Task } from '../types';
import { remotePrUrl } from '../task/remote-pr';
import type { Storage } from '../storage/interface';
import { taskTurnFailure, type TaskTurnFailure } from '../task/turn-failure';
import { parentTaskIdOf } from '../task-target';
import { isBlockedStatus, isTerminalStatus } from '../task-state-machine';
import { mapLimit, STORE_SCAN_CONCURRENCY } from '../utils/map-limit';
import { logger } from '../utils/logger';
import { RpcError } from './rpc-error';
import type { WorkingSubstate } from '../utils/working-substate';

/** How many cards each project-page strip shows. Same cap as the Rails presenter. */
export const OVERVIEW_STRIP_LIMIT = 5;

/** The Tasks page's landing and its three other lenses. */
export const PAGE_VIEWS = ['active', 'open', 'all', 'status'] as const;
export type PageView = (typeof PAGE_VIEWS)[number];

/** Status chips. `done` is complete|abandoned; `blocked` includes conflict. */
export const PAGE_STATUSES = ['working', 'blocked', 'submitted', 'backlog', 'done'] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

export const PAGE_SORTS = ['activity', 'status', 'code', 'goal', 'agent'] as const;
export type PageSort = (typeof PAGE_SORTS)[number];

export const PAGE_DIRS = ['asc', 'desc'] as const;
export type PageDir = (typeof PAGE_DIRS)[number];

/**
 * In flight or waiting on someone. Backlog and the terminal statuses are not.
 * The same set as `TaskListQuery::ACTIVE_STATUSES`.
 */
export const ACTIVE_PAGE_STATUSES = new Set([
  'working', 'blocked', 'conflict', 'submitted', 'interrupted', 'pairing', 'merging', 'zombie',
]);

/** Column order for `sort=status`. Needs-you first. Conflict ranks with blocked. */
const STATUS_RANK: Record<string, number> = {
  blocked: 0,
  conflict: 0,
  submitted: 1,
  interrupted: 2,
  working: 3,
  pairing: 4,
  merging: 5,
  zombie: 6,
  backlog: 7,
  complete: 8,
  abandoned: 9,
};

const DEFAULT_DIR: Record<PageSort, PageDir> = {
  activity: 'desc',
  status: 'asc',
  code: 'asc',
  goal: 'asc',
  agent: 'asc',
};

/** What `list` reads for these two shapes. A test passes a fake. */
export type PageViewReads = Pick<Storage,
  'listTasks' | 'listTasksWithOptions' | 'getTask' | 'getSessionByTaskId' | 'getTurnCountByTaskId'>;

/**
 * One row of a page-shaped list. `prompt` is omitted: neither page renders it,
 * and on a large project it is most of the payload. `turnCount` is 0 except
 * on the needs-you cards, which are the only rows that show it.
 */
export interface PageListNode {
  task: Omit<Task, 'prompt'>;
  session: Session | null;
  turnCount: number;
  children: PageListNode[];
  workingSubstate?: WorkingSubstate;
  /**
   * The run is gone. On the active view that is a `working` row whose substate
   * is `not-alive`, or a parked row whose run the runtime says is not running.
   * Other views mark only the working case. A missing answer is not a crash.
   */
  crashed?: boolean;
  /** The accept-gate answer, present only when the task is gated. */
  protection?: { gated: boolean };
  /**
   * The failure a parked task's last work turn ended in, with its fix
   * (src/task/turn-failure.ts). Read off the session already loaded for the
   * row — no turns.json. Absent when the last turn did not fail.
   */
  turnFailure?: TaskTurnFailure;
}

export interface PageListParams {
  view: PageView;
  status?: PageStatus;
  sort: PageSort;
  dir: PageDir;
}

/** Liveness for one working task. A failure here must not fail the page. */
export type WorkingProbe = (task: Task, session: Session) => Promise<WorkingSubstate | null | undefined>;

/**
 * Whether a non-working row's run is gone. True only when the runtime answered
 * and the run is not running — "no such answer" is not a crash. A failure must
 * not fail the page.
 */
export type CrashedProbe = (task: Task, session: Session) => Promise<boolean>;

/**
 * Test stand-in for the protection read on the active view. `context` is the
 * one page-level load (false when protection is off); `status` is the per-row
 * gate. Production leaves this unset. The flat lenses never call either.
 */
export type ProtectionProbe = {
  context: () => Promise<boolean>;
  status: (taskId: string) => Promise<boolean>;
};

/**
 * Validate a `shape: "page"` request. Unknown values are a 400 — this is an
 * external surface, and a mistyped view must not silently become the landing.
 */
export function parsePageListParams(params: Record<string, unknown>): PageListParams {
  const view = readEnum(params, 'view', PAGE_VIEWS);
  if (!view) {
    throw new RpcError(400, `view is required when shape is 'page'. Expected one of: ${PAGE_VIEWS.join(', ')}.`);
  }
  const status = readEnum(params, 'status', PAGE_STATUSES);
  if (view === 'status' && !status) {
    throw new RpcError(400, `status is required when view is 'status'. Expected one of: ${PAGE_STATUSES.join(', ')}.`);
  }
  const sort = readEnum(params, 'sort', PAGE_SORTS) ?? 'activity';
  const dir = readEnum(params, 'dir', PAGE_DIRS) ?? DEFAULT_DIR[sort];
  return { view, status: view === 'status' ? status : undefined, sort, dir };
}

function readEnum<T extends string>(
  params: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = params[name];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    const got = typeof value === 'string' ? `'${value}'` : typeof value;
    throw new RpcError(400, `Invalid ${name}: ${got}. Expected one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

/**
 * The Tasks landing: keep a task when it is active, or when any descendant is,
 * so a backlog parent still shows as the context of the child that is running.
 * Inactive siblings are dropped. A parent that is not in `tasks` (a completed
 * one, on the non-terminal read) makes its children roots — the same rule as
 * `buildTaskTree`. The Tasks page does not leave them there: it fetches those
 * missing ancestors by id and nests under them.
 *
 * Order matches that walk: siblings stay in input order, and the result is a
 * depth-first list. Callers that need the nested reply use {@link nestTasks}.
 */
export function selectActiveTree(tasks: readonly Task[]): Task[] {
  const byParent = childrenByParent(tasks);
  const keep = new Map<string, boolean>();
  const kept = (task: Task): boolean => {
    const cached = keep.get(task.id);
    if (cached !== undefined) return cached;
    const children = byParent.get(task.id) ?? [];
    const yes = ACTIVE_PAGE_STATUSES.has(task.status) || children.some(kept);
    keep.set(task.id, yes);
    return yes;
  };
  const out: Task[] = [];
  const walk = (task: Task): void => {
    if (!kept(task)) return;
    out.push(task);
    for (const child of byParent.get(task.id) ?? []) walk(child);
  };
  for (const root of byParent.get('') ?? []) walk(root);
  return out;
}

/** The status chip, or the flat Open / All lenses. */
export function selectPageTasks(tasks: readonly Task[], params: PageListParams): Task[] {
  if (params.view === 'active') return selectActiveTree(tasks);
  if (params.view === 'all') return [...tasks];
  if (params.view === 'open') return tasks.filter((task) => !isTerminalStatus(task.status));
  switch (params.status) {
    case 'submitted':
      return tasks.filter((task) => task.status === 'submitted' || remotePrUrl(task) !== null);
    case 'done':
      return tasks.filter((task) => task.status === 'complete' || task.status === 'abandoned');
    case 'blocked':
      // Display folding: conflict is blocked plus protected files changed.
      return tasks.filter((task) => task.status === 'blocked' || task.status === 'conflict');
    default:
      return tasks.filter((task) => task.status === params.status);
  }
}

/**
 * Flat-list order. Activity is newest interaction, then completion, then
 * creation — the same clock the Tasks table calls "Last activity". The
 * tie-break is the display id, and a descending sort reverses the whole key,
 * which is what the Rails sort does.
 *
 * Agent order here is `agent_id`. The Tasks page re-sorts by the human label
 * after the reply arrives, so the two stay one rule.
 */
export function sortPageTasks(
  tasks: readonly Task[],
  sessions: ReadonlyMap<string, Session | null>,
  sort: PageSort,
  dir: PageDir,
): Task[] {
  const activity = (task: Task): number => activityAt(task, sessions.get(task.id) ?? null);
  const id = (task: Task): string => displayId(task);
  const keyed = tasks.map((task) => {
    let key: string | number;
    let tie = id(task);
    let tie2 = 0;
    if (sort === 'status') {
      key = STATUS_RANK[task.status] ?? 99;
      tie2 = activity(task);
    } else if (sort === 'code') {
      key = id(task).toLowerCase();
      tie = '';
    } else if (sort === 'goal') {
      key = task.goal.toLowerCase();
      tie = '';
    } else if (sort === 'agent') {
      key = (task.agent_id ?? '').toLowerCase();
      tie = '';
    } else {
      key = activity(task);
    }
    return { task, key, tie, tie2 };
  });
  keyed.sort((a, b) => {
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    if (a.tie2 !== b.tie2) return a.tie2 - b.tie2;
    if (a.tie < b.tie) return -1;
    if (a.tie > b.tie) return 1;
    return 0;
  });
  const ordered = keyed.map((row) => row.task);
  return dir === 'desc' ? ordered.reverse() : ordered;
}

/** The project page: three strips and the counts, not the tree. */
export async function buildOverview(storage: PageViewReads): Promise<{
  shaped: true;
  overview: {
    needsYou: PageListNode[];
    needsYouTotal: number;
    recentActivity: PageListNode[];
    recentlyMerged: PageListNode[];
    active: number;
    blocked: number;
    total: number;
  };
}> {
  const all = await storage.listTasks();
  // Abandoned tasks are on none of the strips. Everyone else may be sorted by
  // last interaction, which lives on the session — one concurrent read each,
  // and never turns.json.
  const timed = all.filter((task) => task.status !== 'abandoned');
  const sessions = await sessionsFor(storage, timed);

  const needsYouAll = all
    .filter((task) => isBlockedStatus(task.status))
    .sort((a, b) => activityAt(b, sessions.get(b.id) ?? null) - activityAt(a, sessions.get(a.id) ?? null)
      || displayId(a).localeCompare(displayId(b)));
  const recent = all
    .filter((task) => !isTerminalStatus(task.status))
    .sort((a, b) => activityAt(b, sessions.get(b.id) ?? null) - activityAt(a, sessions.get(a.id) ?? null)
      || displayId(a).localeCompare(displayId(b)));
  const merged = all
    .filter((task) => task.status === 'complete')
    .sort((a, b) => activityAt(b, sessions.get(b.id) ?? null) - activityAt(a, sessions.get(a.id) ?? null)
      || displayId(a).localeCompare(displayId(b)));

  const needsYouTasks = needsYouAll.slice(0, OVERVIEW_STRIP_LIMIT);
  // The needs-you card is the one list row that shows a turn count. Reading
  // turns.json for every other task was the expensive half of the old tree.
  const turnCounts = await turnCountsFor(storage, needsYouTasks);

  return {
    shaped: true,
    overview: {
      needsYou: needsYouTasks.map((task) => listNode(task, sessions.get(task.id) ?? null, turnCounts.get(task.id) ?? 0)),
      needsYouTotal: needsYouAll.length,
      recentActivity: recent.slice(0, OVERVIEW_STRIP_LIMIT).map((task) =>
        listNode(task, sessions.get(task.id) ?? null, 0)),
      recentlyMerged: merged.slice(0, OVERVIEW_STRIP_LIMIT).map((task) =>
        listNode(task, sessions.get(task.id) ?? null, 0)),
      active: all.filter((task) => task.status === 'working').length,
      blocked: all.filter((task) => isBlockedStatus(task.status)).length,
      total: all.length,
    },
  };
}

/**
 * The Tasks page for one view. The active landing comes back nested; every
 * other view is a flat list of roots (the table does not indent those).
 */
export async function buildTasksPage(
  storage: PageViewReads,
  projectRoot: string,
  params: PageListParams,
  opts?: { probe?: WorkingProbe; crashedProbe?: CrashedProbe; protection?: ProtectionProbe },
): Promise<{ shaped: true; tree: PageListNode[] }> {
  // Done and All are the views that show finished work. Every other view is
  // answered from the non-terminal read, which is the smaller file set.
  const tasks = params.view === 'all' || params.status === 'done'
    ? await storage.listTasks()
    : await storage.listTasksWithOptions({ nonTerminalOnly: true });
  let selected = selectPageTasks(tasks, params);
  // A finished parent is not in that read. Fetch it by id — and its parent,
  // and so on — so the child stays nested. Unrelated finished tasks are never
  // opened. One wave per level of the chain, each wave bounded.
  if (params.view === 'active') {
    const ancestors = await fetchContextAncestors(storage, selected);
    selected = orderWithAncestors(selected, ancestors);
  }
  const sessions = await sessionsFor(storage, selected);
  if (params.view !== 'active') {
    selected = sortPageTasks(selected, sessions, params.sort, params.dir);
  }
  const liveness = await livenessFor(projectRoot, selected, sessions, params.view, opts);
  const tree = params.view === 'active'
    ? nestTasks(selected, sessions, liveness.substates, liveness.crashed)
    : selected.map((task) => listNode(
        task, sessions.get(task.id) ?? null, 0, [], liveness.substates.get(task.id),
        liveness.crashed.has(task.id),
      ));
  // Crashed on a working row is the substate probe (not-alive). On every other
  // non-terminal row of the active view it is the run probe.
  markCrashedFromSubstate(tree);
  // [P] is drawn only on the Active tree. All, Open, and the status chips are
  // a flat table, so they do not load a protection context or ask the gate
  // once per row.
  if (params.view === 'active') {
    await attachProtection(projectRoot, storage, tree, opts?.protection);
  }
  return { shaped: true, tree };
}

/**
 * Ancestors of `kept` that the non-terminal read did not contain. Each kept
 * task's parent chain is walked by id, de-duplicated, and read with `getTask`.
 * A missing id, or a read that throws, stops that chain; the child stays a root
 * rather than the page failing. Cost is the chains, not the finished tasks
 * that are nobody's parent.
 */
export async function fetchContextAncestors(
  storage: Pick<PageViewReads, 'getTask'>,
  kept: readonly Task[],
): Promise<Task[]> {
  const have = new Set(kept.map((task) => task.id));
  const found: Task[] = [];
  let pending = new Set<string>();
  for (const task of kept) {
    const parent = parentTaskIdOf(task);
    if (parent && !have.has(parent)) pending.add(parent);
  }
  while (pending.size > 0) {
    const batch = [...pending];
    pending = new Set();
    const rows = await mapLimit(batch, STORE_SCAN_CONCURRENCY, async (id) => {
      try {
        return await storage.getTask(id);
      } catch (err) {
        logger.debug(
          `Tasks page: could not read ancestor ${id}: ${err instanceof Error ? err.message : err}`,
        );
        return null;
      }
    });
    for (const task of rows) {
      if (!task || have.has(task.id)) continue;
      have.add(task.id);
      found.push(task);
      const parent = parentTaskIdOf(task);
      if (parent && !have.has(parent)) pending.add(parent);
    }
  }
  return found;
}

/**
 * Parent before child, with each fetched ancestor inserted where its first
 * kept descendant already sat. Other roots keep their order.
 */
function orderWithAncestors(kept: readonly Task[], ancestors: readonly Task[]): Task[] {
  const byId = new Map<string, Task>();
  for (const task of ancestors) byId.set(task.id, task);
  for (const task of kept) byId.set(task.id, task);
  const ordered: Task[] = [];
  const placed = new Set<string>();
  const place = (task: Task, trail: Set<string>): void => {
    if (placed.has(task.id) || trail.has(task.id)) return;
    trail.add(task.id);
    const parentId = parentTaskIdOf(task);
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) place(parent, trail);
    if (!placed.has(task.id)) {
      placed.add(task.id);
      ordered.push(task);
    }
  };
  for (const task of kept) place(task, new Set());
  return ordered;
}

function childrenByParent(tasks: readonly Task[]): Map<string, Task[]> {
  const ids = new Set(tasks.map((task) => task.id));
  const map = new Map<string, Task[]>();
  for (const task of tasks) {
    const parent = parentTaskIdOf(task);
    const key = parent && ids.has(parent) ? parent : '';
    const list = map.get(key);
    if (list) list.push(task);
    else map.set(key, [task]);
  }
  return map;
}

function nestTasks(
  kept: readonly Task[],
  sessions: ReadonlyMap<string, Session | null>,
  substates: ReadonlyMap<string, WorkingSubstate>,
  crashed: ReadonlySet<string>,
): PageListNode[] {
  const nodes = new Map<string, PageListNode>();
  for (const task of kept) {
    nodes.set(task.id, listNode(
      task, sessions.get(task.id) ?? null, 0, [], substates.get(task.id), crashed.has(task.id),
    ));
  }
  const roots: PageListNode[] = [];
  for (const task of kept) {
    const node = nodes.get(task.id)!;
    const parentId = parentTaskIdOf(task);
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

async function sessionsFor(
  storage: PageViewReads,
  tasks: readonly Task[],
): Promise<Map<string, Session | null>> {
  const rows = await mapLimit(tasks, STORE_SCAN_CONCURRENCY, (task) => storage.getSessionByTaskId(task.id));
  const map = new Map<string, Session | null>();
  tasks.forEach((task, index) => map.set(task.id, rows[index] ?? null));
  return map;
}

async function turnCountsFor(
  storage: PageViewReads,
  tasks: readonly Task[],
): Promise<Map<string, number>> {
  const rows = await mapLimit(tasks, STORE_SCAN_CONCURRENCY, (task) => storage.getTurnCountByTaskId(task.id));
  const map = new Map<string, number>();
  tasks.forEach((task, index) => map.set(task.id, rows[index] ?? 0));
  return map;
}

/**
 * Working substate is a tooltip on a working task's badge. The active view
 * also asks, for every other non-terminal row that has a session, whether that
 * run is gone — the CLI's `[CRASHED]` on a parked task. A finished context
 * parent is not asked: its container having exited is the normal end, not a
 * crash. Other views do not ask. A probe that throws, or a runner we cannot
 * build, leaves the badge as the plain status word.
 */
async function livenessFor(
  projectRoot: string,
  tasks: readonly Task[],
  sessions: ReadonlyMap<string, Session | null>,
  view: PageView,
  opts: { probe?: WorkingProbe; crashedProbe?: CrashedProbe } | undefined,
): Promise<{ substates: Map<string, WorkingSubstate>; crashed: Set<string> }> {
  const substates = new Map<string, WorkingSubstate>();
  const crashed = new Set<string>();
  const working = tasks.filter((task) => task.status === 'working' && sessions.get(task.id));
  // Parked, submitted, backlog context — any non-terminal row that is not the
  // working probe. Finished context parents are excluded on purpose.
  const parked = view === 'active'
    ? tasks.filter((task) => task.status !== 'working' && !isTerminalStatus(task.status) && sessions.get(task.id))
    : [];
  if (working.length === 0 && parked.length === 0) return { substates, crashed };
  const ask = working.length > 0 ? (opts?.probe ?? await defaultProbe(projectRoot)) : null;
  const crashedAsk = parked.length > 0 ? (opts?.crashedProbe ?? await defaultCrashedProbe(projectRoot)) : null;
  await mapLimit([...working, ...parked], STORE_SCAN_CONCURRENCY, async (task) => {
    const session = sessions.get(task.id);
    if (!session) return;
    try {
      if (task.status === 'working') {
        const substate = ask ? await ask(task, session) : null;
        if (substate) substates.set(task.id, substate);
        if (substate?.kind === 'not-alive') crashed.add(task.id);
        return;
      }
      if (crashedAsk && await crashedAsk(task, session)) crashed.add(task.id);
    } catch (err) {
      logger.debug(`Task ${task.id}: liveness unavailable for the tasks page: ${err instanceof Error ? err.message : err}`);
    }
  });
  return { substates, crashed };
}

/**
 * The CLI's crash check for a row that is not `working`: the run named by the
 * session, and it is a crash only when the runtime says that run is not
 * running. A missing answer is not a crash.
 */
async function defaultCrashedProbe(projectRoot: string): Promise<CrashedProbe | null> {
  try {
    const { createRunner } = await import('../runner');
    const { taskRef } = await import('../task/identity');
    const runner = await createRunner(projectRoot);
    return async (task, session) => {
      const name = session.container_name ?? runner.runNameForTask(taskRef(task));
      const info = await runner.getRunInfo(name);
      return info !== null && !info.running;
    };
  } catch (err) {
    logger.debug(`Tasks page: parked-run probe unavailable: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function defaultProbe(projectRoot: string): Promise<WorkingProbe | null> {
  try {
    const { createRunner } = await import('../runner');
    const { probeWorkingRun } = await import('../utils/working-run');
    const runner = await createRunner(projectRoot);
    return async (task, session) => {
      const probed = await probeWorkingRun(projectRoot, task, session, runner);
      return probed.substate;
    };
  } catch (err) {
    logger.debug(`Tasks page: working substate probe unavailable: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * A working run the probe already called `not-alive` is a crash. Unknown
 * liveness comes back as no substate, so it is not marked. Parked rows are
 * marked from the run probe, which lands on the node before this walk.
 */
function markCrashedFromSubstate(nodes: readonly PageListNode[]): void {
  for (const node of nodes) {
    // A working row's crash is decided with its substate. This pass catches a
    // node whose flag was set on the way in, and a child built before the set
    // was applied. It does not invent a crash the probe did not report.
    if (node.workingSubstate?.kind === 'not-alive') node.crashed = true;
    markCrashedFromSubstate(node.children);
  }
}

/**
 * The test probe, with the same failure rule as the real read: a throw leaves
 * the marker off and does not fail the page.
 */
async function applyProtectionProbe(nodes: readonly PageListNode[], probe: ProtectionProbe): Promise<void> {
  try {
    // False means protection is off — do not ask the gate once per row.
    if (!await probe.context()) return;
    await mapLimit(nodes, STORE_SCAN_CONCURRENCY, async (node) => {
      try {
        if (await probe.status(node.task.id)) node.protection = { gated: true };
      } catch (err) {
        logger.debug(
          `Task ${node.task.id}: protection marker unavailable for the tasks page: ` +
          `${err instanceof Error ? err.message : err}`,
        );
      }
    });
  } catch (err) {
    logger.debug(
      `Tasks page: protection markers unavailable: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * `[P]` is `protection.gated`, the same bit the unshaped tree sends. One
 * context load, then one status per row on the active view. A project with
 * protection off, or a storage that cannot answer (a test fake), leaves the
 * field off — the page must still render. `probe` replaces both reads in tests.
 */
async function attachProtection(
  projectRoot: string,
  storage: PageViewReads,
  nodes: readonly PageListNode[],
  probe?: ProtectionProbe,
): Promise<void> {
  const flat = flattenNodes(nodes);
  if (flat.length === 0) return;
  if (probe) {
    await applyProtectionProbe(flat, probe);
    return;
  }
  try {
    const { loadConfig } = await import('../config');
    const { loadProtectionContext, contextIsInert, protectionStatusForTask } = await import('../protection/status');
    const config = await loadConfig(projectRoot);
    const ctx = await loadProtectionContext(storage as Storage, config, projectRoot);
    if (contextIsInert(ctx)) return;
    await mapLimit(flat, STORE_SCAN_CONCURRENCY, async (node) => {
      try {
        const status = await protectionStatusForTask(storage as Storage, ctx, node.task as Task, {
          hasBranch: Boolean(node.session?.git_branch),
        });
        if (status.gated) node.protection = { gated: true };
      } catch (err) {
        logger.debug(
          `Task ${node.task.id}: protection marker unavailable for the tasks page: ` +
          `${err instanceof Error ? err.message : err}`,
        );
      }
    });
  } catch (err) {
    // A listing must never fail over an advisory marker. Tests pass a fake
    // storage and a root with no config; both land here.
    logger.debug(
      `Tasks page: protection markers unavailable: ${err instanceof Error ? err.message : err}`,
    );
  }
}

function flattenNodes(nodes: readonly PageListNode[]): PageListNode[] {
  const out: PageListNode[] = [];
  for (const node of nodes) {
    out.push(node);
    out.push(...flattenNodes(node.children));
  }
  return out;
}

function listNode(
  task: Task,
  session: Session | null,
  turnCount: number,
  children: PageListNode[] = [],
  workingSubstate?: WorkingSubstate,
  crashed = false,
): PageListNode {
  const { prompt: _prompt, ...rest } = task;
  const node: PageListNode = { task: rest, session, turnCount, children };
  if (workingSubstate) node.workingSubstate = workingSubstate;
  if (crashed) node.crashed = true;
  const turnFailure = taskTurnFailure(task, session);
  if (turnFailure) node.turnFailure = turnFailure;
  return node;
}

function activityAt(task: Task, session: Session | null): number {
  return session?.last_interaction_at ?? task.completed_at ?? task.created_at;
}

function displayId(task: Task): string {
  return task.code && task.code.length > 0 ? task.code : task.id.slice(0, 8);
}
