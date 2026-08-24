import { join } from 'path';
import { requireLazyRoot, requireStorage, displayId, buildDisplayIdMap, formatDate, formatDuration, formatTokenUsage, parseFlags, taskRef, resolveTaskOrExit } from '../helpers';
import type { Task, Session, Storage } from '../../storage';

import { protocolDir as getProtocolDir, readStatus } from '../../protocol';
import { createRunner } from '../../runner';
import { theme } from '../theme';
import { queryTaskList, queryBlockedTasks, queryActiveTasks } from '../../daemon/rpc-fallback';
import { parentTaskIdOf, collectSubtreeIds, pruneTasksToDepth } from '../../task-target';
import { normalizeTag } from '../../utils/tags';
import { computeWorkingSubstate, renderWorkingStatus, type WorkingSubstate } from '../../utils/working-substate';
import { orderQueuedTasks } from '../../daemon/concurrency';
import { loadConfig } from '../../config/loader';
import { logger } from '../../utils/logger';
import { listSlowLaneQueue, getLastProjectAutoResumeAt } from '../../daemon/auto-resume-queue';
import { describeExpiry } from '../../utils/local-day';
import {
  loadProtectionContext,
  contextIsInert,
  protectionStatusForTask,
  protectionMarkers,
  PROTECTION_MARKER_LEGEND,
  type TaskProtectionStatus,
} from '../../protection/status';

export interface TaskWithSession {
  task: Task;
  session: Session | null;
  turnCount: number;
  children: TaskWithSession[];
  retryCount?: number;
  crashed?: boolean;
  /**
   * Derived working substate (agent / harness:<phase> / not-alive) for `working`
   * tasks. Observational only — never changes task state. Undefined for
   * non-working tasks or when no substate can be derived.
   */
  workingSubstate?: WorkingSubstate;
  /**
   * 1-based drain position for a `queued` task (highest priority / oldest first),
   * with the total queued count. Undefined for non-queued tasks. Computed against
   * ALL queued tasks in the project, so it is correct in any filtered view.
   */
  queuePosition?: { position: number; total: number };
  /**
   * Read-only protection status, present only when the project protects
   * anything. Undefined in a stock project so nothing is computed and nothing
   * is rendered — list output stays byte-for-byte what it was.
   */
  protection?: TaskProtectionStatus;
  /**
   * Slow-lane auto-resume queue position (src/daemon/auto-resume-queue.ts),
   * present only for `interrupted` tasks whose fast-lane circuit breaker has
   * tripped and are now waiting for a round-robin retry. Undefined otherwise —
   * including when daemon.auto_resume is off, since nothing is queued then.
   */
  autoResume?: { attempts: number; maxAttempts: number; nextEligibleAt: number };
  /**
   * How many descendants of this task were elided by a `--levels` limit.
   * Present only on the deepest visible rows of a depth-limited listing, so a
   * truncated view always says what it is not showing. Undefined otherwise.
   */
  hiddenDescendants?: number;
}

export async function buildTaskTree(
  storage: Storage,
  tasks: Task[],
  lazyRoot: string,
  opts: { hiddenDescendants?: Map<string, number> } = {},
): Promise<TaskWithSession[]> {
  const runner = await createRunner(lazyRoot);
  const taskMap = new Map<string, TaskWithSession>();

  // Protection facts resolved ONCE for the whole listing: one config read, one
  // default-branch lookup, one resolve per protected entry — not N of each. An
  // inert context (nothing protected anywhere) skips the per-task work below.
  let protectionCtx = null as Awaited<ReturnType<typeof loadProtectionContext>> | null;
  const config = await loadConfig(lazyRoot);
  try {
    const ctx = await loadProtectionContext(storage, config, lazyRoot);
    if (!contextIsInert(ctx)) protectionCtx = ctx;
  } catch (err) {
    // A listing must never fail over an advisory marker.
    logger.debug(`Protection markers unavailable for this listing: ${err instanceof Error ? err.message : err}`);
  }

  // Slow-lane auto-resume queue positions, computed once against ALL tasks
  // (same reasoning as queuePos below — the queue's round-robin order is a
  // project-wide fact, not scoped to this view). Skipped entirely when
  // nothing is interrupted or auto_resume is off, so a stock listing pays
  // nothing extra.
  const autoResumeMap = new Map<string, { attempts: number; maxAttempts: number; nextEligibleAt: number }>();
  if (config.daemon.auto_resume && tasks.some(t => t.status === 'interrupted')) {
    try {
      const now = Date.now();
      const queue = await listSlowLaneQueue(storage, config, now);
      const dataDir = join(lazyRoot, config.data.path);
      const lastProjectAttempt = await getLastProjectAutoResumeAt(dataDir);
      const gapMs = config.daemon.auto_resume_gap_minutes * 60_000;
      const gapEligibleAt = lastProjectAttempt === null ? now : lastProjectAttempt + gapMs;
      queue.forEach((entry, i) => {
        const nextEligibleAt = Math.max(entry.intervalEligibleAt, i === 0 ? gapEligibleAt : 0);
        autoResumeMap.set(entry.task.id, { attempts: entry.attempts, maxAttempts: entry.maxAttempts, nextEligibleAt });
      });
    } catch (err) {
      // Observational only — never fail a listing over queue visibility.
      logger.debug(`Slow-lane queue unavailable for this listing: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Drain-order positions for queued tasks, computed once against ALL queued
  // tasks in the project (not just this view) so "#N of M" is globally correct.
  const queuePos = new Map<string, { position: number; total: number }>();
  if (tasks.some(t => t.status === 'queued')) {
    const allQueued = await storage.listTasksWithOptions({ queuedOnly: true });
    const ordered = orderQueuedTasks(allQueued);
    ordered.forEach((t, i) => queuePos.set(t.id, { position: i + 1, total: ordered.length }));
  }

  // Create nodes for all tasks
  for (const task of tasks) {
    const session = await storage.getSessionByTaskId(task.id);
    let retryCount: number | undefined;
    let crashed = false;
    let isAlive = false;
    let workingSubstate: WorkingSubstate | undefined;

    // Probe run liveness for non-terminal tasks. One runner call feeds both the
    // crashed indicator and the working-substate derivation.
    if (session && !['complete', 'abandoned'].includes(task.status)) {
      const tRef = taskRef(task);
      const cn = session.container_name ?? runner.runNameForTask(tRef);
      const info = await runner.getRunInfo(cn);
      if (info && !info.running) {
        crashed = true;
      }
      isAlive = info?.running === true;
    }

    if (task.status === 'working' && session) {
      const protoDir = getProtocolDir(task.id);

      // Derive the working substate (agent / harness:<phase> / not-alive) from
      // status.json + liveness — the single shared derivation used by every
      // read surface.
      workingSubstate = (await computeWorkingSubstate(protoDir, isAlive)) ?? undefined;

      // Retry count (when retrying) is surfaced separately alongside the substate.
      const status = readStatus(protoDir);
      if (status?.phase === 'retrying' && status.retryCount !== undefined) {
        retryCount = status.retryCount;
      }
    }

    let protection: TaskProtectionStatus | undefined;
    if (protectionCtx) {
      try {
        protection = await protectionStatusForTask(storage, protectionCtx, task, {
          hasBranch: Boolean(session?.git_branch),
        });
      } catch (err) {
        logger.debug(`Task ${task.id}: could not resolve protection status: ${err instanceof Error ? err.message : err}`);
      }
    }

    taskMap.set(task.id, {
      task,
      session,
      turnCount: await storage.getTurnCountByTaskId(task.id),
      children: [],
      retryCount,
      crashed,
      workingSubstate,
      queuePosition: task.status === 'queued' ? queuePos.get(task.id) : undefined,
      protection,
      autoResume: autoResumeMap.get(task.id),
      hiddenDescendants: opts.hiddenDescendants?.get(task.id),
    });
  }

  // Build tree structure
  const roots: TaskWithSession[] = [];
  for (const node of taskMap.values()) {
    const parentId = parentTaskIdOf(node.task);
    if (parentId) {
      const parent = taskMap.get(parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        // Parent not in filtered list, treat as root
        roots.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Sort TaskWithSession nodes by last_interaction_at DESC (most recently active first).
 * Tasks with no session sort to the bottom. Stable sort: equal values fall back to created_at DESC.
 */
export function sortByLastActive(nodes: TaskWithSession[]): void {
  nodes.sort((a, b) => {
    const aTime = a.session?.last_interaction_at ?? null;
    const bTime = b.session?.last_interaction_at ?? null;
    if (aTime === null && bTime === null) return b.task.created_at - a.task.created_at;
    if (aTime === null) return 1;
    if (bTime === null) return -1;
    return (bTime - aTime) || (b.task.created_at - a.task.created_at);
  });
}

function formatTurnCount(turnCount: number): string {
  if (turnCount === 0) return '-';
  return String(turnCount);
}

/** Count tasks with crashed containers across a tree. */
export function countCrashed(nodes: TaskWithSession[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.crashed) count++;
    count += countCrashed(node.children);
  }
  return count;
}

/** Print a footnote if any tasks have crashed containers. */
export function printCrashedFootnote(crashedCount: number): void {
  if (crashedCount > 0) {
    console.log('');
    console.log(theme.warning(
      `${crashedCount} task(s) have crashed containers. Run \`lazy doctor\` for details and auto-resume.`
    ));
  }
}

export function printTaskTree(node: TaskWithSession, prefix: string = '', isLast: boolean = true, depth: number = 0): void {
  const task = node.task;
  const sess = node.session;

  // Determine status display
  let status: string;
  if (sess) {
    status = sess.outcome ?? (sess.ended_at ? 'ended' : task.status);
  } else {
    status = task.status;
  }

  // For working tasks, decorate the status with the derived substate
  // (working(agent) / working(harness:<phase>) / working(not-alive)) so a busy
  // post-turn check is distinguishable from a hung or dead supervisor.
  const isNotAlive = node.workingSubstate?.kind === 'not-alive';
  if (task.status === 'working' && status === 'working' && node.workingSubstate) {
    status = renderWorkingStatus(node.workingSubstate);
  }

  // Queued tasks: show drain position ("queued #2 of 3") and priority so a
  // glance at list/active reveals which tasks are waiting and in what order.
  if (task.status === 'queued') {
    if (node.queuePosition) {
      status = `queued #${node.queuePosition.position} of ${node.queuePosition.total}`;
    }
    if (task.priority !== 'normal') {
      status = `${status} (${task.priority})`;
    }
  }

  // Add retry count to status if retrying — unless the substate label already
  // carries it (working(harness:retrying attempt N: ...)), which would otherwise
  // print the same number twice on one line.
  const substateHasRetry =
    node.workingSubstate?.kind === 'harness' && node.workingSubstate.phase === 'retrying';
  if (node.retryCount !== undefined && node.retryCount > 0 && !substateHasRetry) {
    status = `${status} (retry ${node.retryCount})`;
  }

  // Indicate auto-resumed tasks
  if (sess?.auto_resumed && task.status === 'working') {
    status = `${status} (auto)`;
  }

  // Add crashed indicator — but not when the working substate already conveys
  // not-alive (the same dead-run fact), to avoid a redundant double signal.
  if (node.crashed && !isNotAlive) {
    status = `${status} [CRASHED]`;
  }

  // Indicate user-stopped interrupted tasks (parallel to [CRASHED]).
  // [STOPPED] means the reconciler will NOT auto-resume; a manual
  // resume/unblock is required.
  if (task.status === 'interrupted' && sess?.user_stopped) {
    status = `${status} [STOPPED]`;
  }

  // Indicate a task queued on the slow-lane auto-resume round-robin
  // (src/daemon/auto-resume-queue.ts) — the fast lane gave up, but the task
  // isn't abandoned: it'll be retried again, on its own schedule.
  if (node.autoResume) {
    const { attempts, maxAttempts, nextEligibleAt } = node.autoResume;
    const eta = nextEligibleAt <= Date.now() ? 'now' : describeExpiry(new Date(nextEligibleAt));
    status = `${status} [auto-resume ${eta} (attempt ${attempts + 1}/${maxAttempts})]`;
  }

  // Add auto-react paused indicator
  if (task.metadata?.auto_react_paused === 'true') {
    status = `${status} [AUTO-REACT PAUSED]`;
  }

  // Tree drawing characters
  const connector = depth === 0 ? '' : (isLast ? '└─ ' : '├─ ');
  const childPrefix = depth === 0 ? '' : (isLast ? '   ' : '│  ');

  // Format session info
  const lastInteraction = sess?.last_interaction_at ? formatDate(sess.last_interaction_at) : '-';
  const duration = sess ? formatDuration(sess.total_duration_ms) : '-';
  const turns = formatTurnCount(node.turnCount);
  const tokens = formatTokenUsage(sess?.total_usage ?? null);

  // Print task row
  const code = displayId(task);
  const model = task.model ?? '-';
  const taskType = task.type ?? 'task';
  const goal = task.goal.length > 30
    ? task.goal.substring(0, 28) + '..'
    : task.goal;
  const goalWithTags = goalCell(node, goal);

  const codeWithPrefix = `${prefix}${connector}${code}`;
  const fitsOnOneLine = codeWithPrefix.length <= 20;

  if (fitsOnOneLine) {
    // Code fits in CODE column — single line
    console.log(
      `${prefix}${connector}${theme.pad(theme.taskId(code), 20 - prefix.length - connector.length)} ${theme.pad(theme.status(status), 12)} ${theme.pad(theme.model(model), 8)} ${theme.pad(taskType, 10)} ${turns.padEnd(8)} ${theme.pad(theme.timestamp(lastInteraction), 18)} ${theme.pad(theme.duration(duration), 10)} ${theme.pad(theme.duration(tokens), 14)} ${goalWithTags}`
    );
  } else {
    // Code too wide — code on first line, data on second
    console.log(`${prefix}${connector}${theme.taskId(code)}`);
    const dataPrefix = prefix + childPrefix;
    const dataPad = Math.max(0, 20 - dataPrefix.length);
    console.log(
      `${dataPrefix}${' '.repeat(dataPad)} ${theme.pad(theme.status(status), 12)} ${theme.pad(theme.model(model), 8)} ${theme.pad(taskType, 10)} ${turns.padEnd(8)} ${theme.pad(theme.timestamp(lastInteraction), 18)} ${theme.pad(theme.duration(duration), 10)} ${theme.pad(theme.duration(tokens), 14)} ${goalWithTags}`
    );
  }

  // Print children
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const isChildLast = i === node.children.length - 1;
    printTaskTree(child, prefix + childPrefix, isChildLast, depth + 1);
  }
}

export async function commandList(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'all', takesValue: false },
    { name: 'flat', takesValue: false },
    { name: 'tree', takesValue: false },
    { name: 'ids-only', takesValue: false },
    { name: 'tag', takesValue: true },
    { name: 'levels', takesValue: true },
  ], 'list');

  const idsOnly = parsed.flags.get('ids-only') === true;
  const showAll = parsed.flags.get('all') === true;
  let showTree = parsed.flags.get('tree') === true || parsed.flags.get('flat') !== true;
  const tagFilter = normalizeFilterTag(parsed.flags.get('tag') as string | undefined);
  const levels = parseLevels(parsed.flags.get('levels'), 'list');

  let { tree } = await queryTaskList({
    all: showAll,
    taskFilter: parsed.positional[0] || undefined,
    levels,
  });

  // Counted before any tag filter flattens the tree, so the footnote reports
  // everything the depth limit dropped rather than only the tagged part of it.
  const hiddenCount = countHidden(tree);

  // A tag filter selects tasks across the hierarchy, so it renders as a flat
  // list of matches (a partial tree would be misleading).
  if (tagFilter) {
    tree = filterTreeByTag(tree, tagFilter);
    showTree = false;
  }

  renderListOutput(tree, { idsOnly, showTree, showAll, levels, hiddenCount });
}

/** Normalize a --tag filter value; returns undefined when no filter was given. */
function normalizeFilterTag(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const normalized = normalizeTag(raw);
  return normalized || undefined;
}

/**
 * Flatten a task tree and keep only tasks carrying `tag`, each returned as a
 * flat (childless) node. Used by `--tag` filtering in list/blocked so the
 * result is an unambiguous set of matches rather than a pruned hierarchy.
 */
function filterTreeByTag(tree: TaskWithSession[], tag: string): TaskWithSession[] {
  return flattenTree(tree)
    .filter(node => node.task.tags?.includes(tag))
    .map(node => ({ ...node, children: [] }));
}

/**
 * The GOAL cell: protection markers, the goal, then tags.
 *
 * Markers live in the LAST column on purpose. Every other column is a padded
 * fixed width that scripts slice by offset, so a new column — or a marker in an
 * existing one — would shift them all. Here the addition is purely additive:
 * a project with nothing protected renders exactly what it always did.
 */
function goalCell(node: TaskWithSession, goal: string): string {
  const markers = node.protection ? protectionMarkers(node.protection) : '';
  const prefix = markers ? `${theme.warning(markers)} ` : '';
  // Elision note last: a depth-limited listing must never look complete.
  const hidden = node.hiddenDescendants
    ? ` ${theme.warning(`(+${node.hiddenDescendants} hidden)`)}`
    : '';
  return `${prefix}${goal}${tagSuffix(node.task)}${hidden}`;
}

/** Total descendants elided by a `--levels` limit across a rendered tree. */
function countHidden(nodes: TaskWithSession[]): number {
  return nodes.reduce((sum, n) => sum + (n.hiddenDescendants ?? 0) + countHidden(n.children), 0);
}

/**
 * Footnote naming what a `--levels` limit left out. Printed whenever anything
 * was elided, so the per-row "(+N hidden)" markers are never the only signal
 * (they are easy to miss at the end of a long goal column).
 */
function printDepthFootnote(hidden: number, levels: number | undefined): void {
  if (levels === undefined || hidden === 0) return;
  console.log('');
  console.log(theme.warning(
    `${hidden} descendant task(s) hidden below --levels ${levels}. ` +
    `Re-run with a larger --levels (or without it) to see them.`
  ));
}

/**
 * Validate a `--levels` value from the command line.
 *
 * 1-based on purpose: `--levels 1` shows only the top level. A 0-based
 * `--depth 0` would read as "nothing" just as easily as "roots only", and a
 * listing flag whose most useful value is ambiguous is a trap.
 */
function parseLevels(raw: unknown, command: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < 1) {
    console.error(
      `--levels must be a positive integer (got '${String(raw)}'). ` +
      `--levels 1 shows only top-level tasks, --levels 2 adds their children. ` +
      `Run \`lazy ${command} --help\` for usage.`
    );
    process.exit(1);
  }
  return value;
}

/** True when any node in the tree renders a protection marker. */
function hasProtectionMarkers(nodes: TaskWithSession[]): boolean {
  return nodes.some(n => (n.protection ? protectionMarkers(n.protection) !== '' : false) || hasProtectionMarkers(n.children));
}

/** Print the marker legend when a listing actually showed one. */
function printProtectionLegend(tree: TaskWithSession[]): void {
  if (!hasProtectionMarkers(tree)) return;
  console.log('');
  console.log(theme.separator(PROTECTION_MARKER_LEGEND));
}

/** Render a task's tags as a " #a #b" suffix (empty string when untagged). */
function tagSuffix(task: Task): string {
  if (!task.tags || task.tags.length === 0) return '';
  return ' ' + task.tags.map(t => theme.tag('#' + t)).join(' ');
}

/** Shared rendering for list command — used by both daemon and direct paths. */
function renderListOutput(
  tree: TaskWithSession[],
  opts: { idsOnly: boolean; showTree: boolean; showAll: boolean; levels?: number; hiddenCount?: number },
): void {
  // Machine-readable output for shell completion
  if (opts.idsOnly) {
    const allNodes = flattenTree(tree);
    for (const node of allNodes) {
      console.log(displayId(node.task));
    }
    return;
  }

  if (tree.length === 0) {
    console.log(opts.showAll
      ? 'No tasks. Create one with: lazy start --goal "..."'
      : 'No active tasks. Use --all to see all tasks.');
    return;
  }

  if (opts.showTree) {
    console.log(`${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ${theme.header('TYPE'.padEnd(10))} ${theme.header('TURNS'.padEnd(8))} ${theme.header('LAST ACTIVE'.padEnd(18))} ${theme.header('DURATION'.padEnd(10))} ${theme.header('TOKENS IN/OUT'.padEnd(14))} ${theme.header('GOAL')}`);
    console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(18)} ${'─'.repeat(10)} ${'─'.repeat(14)} ${'─'.repeat(30)}`));

    for (const rootNode of tree) {
      printTaskTree(rootNode);
    }
  } else {
    // Flat list
    const nodes = flattenTree(tree);
    const parentDisplayId = buildDisplayIdMap(nodes.map(n => n.task));
    console.log(`${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ${theme.header('TYPE'.padEnd(10))} ${theme.header('PARENT'.padEnd(18))} ${theme.header('CREATED'.padEnd(18))} ${theme.header('GOAL')}`);
    console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(18)} ${'─'.repeat(18)} ${'─'.repeat(30)}`));

    for (const node of nodes) {
      const task = node.task;
      const parentId = parentTaskIdOf(task);
      const parent = parentId ? theme.taskId(parentDisplayId(parentId)) : '-';
      const code = displayId(task);
      const model = task.model ?? '-';
      const taskType = task.type ?? 'task';
      console.log(
        `${theme.pad(theme.taskId(code), 20)} ${theme.pad(theme.status(flatStatusText(node)), 12)} ${theme.pad(theme.model(model), 8)} ${theme.pad(taskType, 10)} ${theme.pad(parent, 18)} ${theme.pad(theme.timestamp(formatDate(task.created_at)), 18)} ${goalCell(node, task.goal)}`
      );
    }
  }

  printProtectionLegend(tree);
  printDepthFootnote(opts.hiddenCount ?? countHidden(tree), opts.levels);
  printCrashedFootnote(countCrashed(tree));
}

/**
 * Status text for a node in flat views: plain task status, decorated with the
 * working substate for `working` tasks so flat views match the tree view.
 */
function flatStatusText(node: TaskWithSession): string {
  if (node.task.status === 'working' && node.workingSubstate) {
    return renderWorkingStatus(node.workingSubstate);
  }
  // Queued: drain position + non-default priority, matching the tree view.
  if (node.task.status === 'queued' && node.queuePosition) {
    const base = `queued #${node.queuePosition.position}/${node.queuePosition.total}`;
    return node.task.priority !== 'normal' ? `${base} (${node.task.priority})` : base;
  }
  return node.task.status;
}

/** Flatten a TaskWithSession tree into a flat array, depth-first. */
function flattenTree(nodes: TaskWithSession[]): TaskWithSession[] {
  const result: TaskWithSession[] = [];
  for (const node of nodes) {
    result.push(node);
    result.push(...flattenTree(node.children));
  }
  return result;
}

/**
 * The task set the `active` views show: non-terminal tasks with a session, plus
 * queued tasks. Queued tasks have no session yet (they were gated before session
 * creation), so `withSessionsOnly` misses them — but they ARE in flight and
 * belong in the active view so a queued backlog is diagnosable.
 *
 * Shared by the daemon `active` RPC handler and the CLI's follow loop so both
 * views always agree on what "active" means.
 */
export async function collectActiveTasks(storage: Storage): Promise<Task[]> {
  const active = await storage.listTasksWithOptions({ withSessionsOnly: true, nonTerminalOnly: true });
  const queued = await storage.listTasksWithOptions({ queuedOnly: true });
  const seen = new Set(active.map(t => t.id));
  return [...active, ...queued.filter(t => !seen.has(t.id))];
}

export async function commandActive(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'flat', takesValue: false },
    { name: 'tree', takesValue: false },
    { name: 'follow', aliases: ['f'], takesValue: false },
    { name: 'ids-only', takesValue: false },
    { name: 'levels', takesValue: true },
  ], 'active');

  const idsOnly = parsed.flags.get('ids-only') === true;
  const showTree = parsed.flags.get('tree') === true || parsed.flags.get('flat') !== true;
  const follow = parsed.flags.get('follow') === true;
  const taskFilter = parsed.positional[0] || undefined;
  const levels = parseLevels(parsed.flags.get('levels'), 'active');

  // --follow needs continuous reconciliation with open storage — can't use RPC
  if (follow) {
    const root = requireLazyRoot();
    const storage = await requireStorage();
    try {
      // Resolve the subtree filter ONCE, before the poll loop: resolution can
      // prompt on an ambiguous code, and re-resolving every 3s would both
      // re-prompt and repeat the work for an answer that cannot change.
      let subtreeRootId: string | undefined;
      let filterLabel: string | undefined;
      if (taskFilter) {
        const task = await resolveTaskOrExit(storage, taskFilter);
        subtreeRootId = task.id;
        filterLabel = displayId(task);
      }

      const pollIntervalMs = 3000;
      let done = false;
      while (!done) {
        process.stdout.write('\x1B[2J\x1B[H');
        let tasks = await collectActiveTasks(storage);
        if (subtreeRootId) {
          const allowedIds = collectSubtreeIds(subtreeRootId, await storage.listTasks());
          tasks = tasks.filter(t => allowedIds.has(t.id));
        }
        if (tasks.length === 0) {
          console.log(emptyActiveMessage(filterLabel));
          done = true;
        } else {
          // Depth limit applied to the same task set the tree is built from, so
          // the live view counts levels exactly like the one-shot view.
          let hiddenDescendants: Map<string, number> | undefined;
          if (levels !== undefined) {
            const pruned = pruneTasksToDepth(tasks, levels);
            tasks = pruned.kept;
            hiddenDescendants = pruned.hidden;
          }
          const tree = await buildTaskTree(storage, tasks, root, { hiddenDescendants });
          renderActiveOutput(tree, { idsOnly, showTree, filterLabel, levels });
          console.log(`\n(following — press Ctrl+C to stop, polling every ${pollIntervalMs / 1000}s)`);
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
      }
    } finally {
      await storage.close();
    }
    return;
  }

  const { tree } = await queryActiveTasks({ taskFilter, levels });
  renderActiveOutput(tree, { idsOnly, showTree, filterLabel: taskFilter, levels });
}

/**
 * Empty-state text for the active views. A filtered view says which subtree was
 * empty — "no active tasks" alone would read as "nothing is running anywhere".
 */
function emptyActiveMessage(filterLabel: string | undefined): string {
  return filterLabel
    ? `No active tasks in ${filterLabel} (task and its descendants).`
    : 'No active tasks.';
}

/** Shared rendering for active command. */
function renderActiveOutput(
  tree: TaskWithSession[],
  opts: { idsOnly: boolean; showTree: boolean; filterLabel?: string; levels?: number },
): void {
  if (opts.idsOnly) {
    const allNodes = flattenTree(tree);
    for (const node of allNodes) {
      console.log(displayId(node.task));
    }
    return;
  }

  if (tree.length === 0) {
    console.log(emptyActiveMessage(opts.filterLabel));
    return;
  }

  if (opts.showTree) {
    console.log(`${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ${theme.header('TYPE'.padEnd(10))} ${theme.header('TURNS'.padEnd(8))} ${theme.header('LAST ACTIVE'.padEnd(18))} ${theme.header('DURATION'.padEnd(10))} ${theme.header('COST'.padEnd(10))} ${theme.header('GOAL')}`);
    console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(18)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(30)}`));

    for (const rootNode of tree) {
      printTaskTree(rootNode);
    }
  } else {
    const nodes = flattenTree(tree);
    const parentDisplayId = buildDisplayIdMap(nodes.map(n => n.task));
    console.log(`${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ${theme.header('TYPE'.padEnd(10))} ${theme.header('PARENT'.padEnd(18))} ${theme.header('CREATED'.padEnd(18))} ${theme.header('GOAL')}`);
    console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(18)} ${'─'.repeat(18)} ${'─'.repeat(30)}`));

    for (const node of nodes) {
      const task = node.task;
      const parentId = parentTaskIdOf(task);
      const parent = parentId ? theme.taskId(parentDisplayId(parentId)) : '-';
      const code = displayId(task);
      const model = task.model ?? '-';
      const taskType = task.type ?? 'task';
      console.log(
        `${theme.pad(theme.taskId(code), 20)} ${theme.pad(theme.status(flatStatusText(node)), 12)} ${theme.pad(theme.model(model), 8)} ${theme.pad(taskType, 10)} ${theme.pad(parent, 18)} ${theme.pad(theme.timestamp(formatDate(task.created_at)), 18)} ${goalCell(node, task.goal)}`
      );
    }
  }

  printProtectionLegend(tree);
  printDepthFootnote(countHidden(tree), opts.levels);
  printCrashedFootnote(countCrashed(tree));
}

export async function commandBlocked(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'flat', takesValue: false },
    { name: 'tree', takesValue: false },
    { name: 'tag', takesValue: true },
    { name: 'levels', takesValue: true },
  ], 'blocked');

  let showTree = parsed.flags.get('tree') === true || parsed.flags.get('flat') !== true;
  const tagFilter = normalizeFilterTag(parsed.flags.get('tag') as string | undefined);
  const levels = parseLevels(parsed.flags.get('levels'), 'blocked');

  let { tree } = await queryBlockedTasks({ levels });
  sortByLastActive(tree);

  // Counted before any tag filter flattens the tree (see commandList).
  const hiddenCount = countHidden(tree);

  // Tag filter → flat list of matches (see filterTreeByTag / commandList).
  if (tagFilter) {
    tree = filterTreeByTag(tree, tagFilter);
    showTree = false;
  }

  renderBlockedOutput(tree, showTree, { levels, hiddenCount });
}

/** Shared rendering for blocked command. */
function renderBlockedOutput(
  tree: TaskWithSession[],
  showTree: boolean,
  opts: { levels?: number; hiddenCount?: number } = {},
): void {
  if (tree.length === 0) {
    console.log('No blocked tasks.');
    return;
  }

  if (showTree) {
    console.log(`${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ${theme.header('TYPE'.padEnd(10))} ${theme.header('TURNS'.padEnd(8))} ${theme.header('LAST ACTIVE'.padEnd(18))} ${theme.header('DURATION'.padEnd(10))} ${theme.header('TOKENS IN/OUT'.padEnd(14))} ${theme.header('GOAL')}`);
    console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(18)} ${'─'.repeat(10)} ${'─'.repeat(14)} ${'─'.repeat(30)}`));

    for (const rootNode of tree) {
      printTaskTree(rootNode);
    }
  } else {
    const flatNodes = flattenTree(tree);
    const parentDisplayId = buildDisplayIdMap(flatNodes.map(n => n.task));
    console.log(`${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ${theme.header('TYPE'.padEnd(10))} ${theme.header('PARENT'.padEnd(18))} ${theme.header('CREATED'.padEnd(18))} ${theme.header('GOAL')}`);
    console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(18)} ${'─'.repeat(18)} ${'─'.repeat(30)}`));

    for (const node of flatNodes) {
      const task = node.task;
      const parentId = parentTaskIdOf(task);
      const parent = parentId ? theme.taskId(parentDisplayId(parentId)) : '-';
      const code = displayId(task);
      const model = task.model ?? '-';
      const taskType = task.type ?? 'task';
      console.log(
        `${theme.pad(theme.taskId(code), 20)} ${theme.pad(theme.status(flatStatusText(node)), 12)} ${theme.pad(theme.model(model), 8)} ${theme.pad(taskType, 10)} ${theme.pad(parent, 18)} ${theme.pad(theme.timestamp(formatDate(task.created_at)), 18)} ${goalCell(node, task.goal)}`
      );
    }
  }

  printProtectionLegend(tree);
  printDepthFootnote(opts.hiddenCount ?? countHidden(tree), opts.levels);
  printCrashedFootnote(countCrashed(tree));
}

export function listUsage(): void {
  console.log(`Usage: lazy list [<task_id>] [--all] [--flat] [--tag <tag>] [--levels <n>]

List all non-terminal tasks (working + blocked + interrupted).

Arguments:
  <task_id>   Optional task ID or code to filter - shows only that task and its descendants

Options:
  --all          Show all tasks including completed/abandoned/closed
  --flat         Show flat list instead of tree structure
  --tree         Show tree structure (default)
  --tag <tag>    Show only tasks carrying this tag (flat list of matches)
  --levels <n>   Show only the first <n> levels of the hierarchy (1-based:
                 1 = top-level tasks only, 2 = those plus their children).
                 Levels are counted from the rows this listing shows, so with
                 a <task_id> filter that task is level 1. Tasks hidden by the
                 limit are counted as "(+N hidden)" on their parent's row.
  --ids-only     Output only task IDs, one per line (for shell completion)

The tree view shows child tasks indented under their parents. Tags are shown
after each task's goal.

Examples:
  lazy list                  # All non-terminal tasks in tree view
  lazy list release-v05      # Only release-v05 task and its descendants
  lazy list --levels 1       # Top-level tasks only, with hidden-child counts
  lazy list release-v05 --levels 2 # That task and its direct children
  lazy list --all            # All tasks including terminal states
  lazy list --tag onboarding # Non-terminal tasks tagged 'onboarding'
  lazy list --all --tag infra # All tasks (incl. terminal) tagged 'infra'`);
}

export function activeUsage(): void {
  console.log(`Usage: lazy active [<task_id>] [--flat] [--levels <n>] [--follow | -f]

List all non-terminal tasks (working + blocked + interrupted).

Arguments:
  <task_id>   Optional task ID or code - shows only that task's subtree
              (the task itself and all its descendants)

Options:
  --flat         Show flat list instead of tree structure
  --tree         Show tree structure (default)
  --levels <n>   Show only the first <n> levels of the hierarchy (1-based:
                 1 = top-level tasks only, 2 = those plus their children).
                 Levels are counted from the rows this listing shows, so with
                 a <task_id> filter that task is level 1. Tasks hidden by the
                 limit are counted as "(+N hidden)" on their parent's row.
  --follow, -f   Poll and refresh the display (press Ctrl+C to stop)
  --ids-only     Output only task IDs, one per line (for shell completion)

The tree view shows child tasks indented under their parents.

Examples:
  lazy active                # All active tasks in tree view
  lazy active --levels 1     # Only top-level active tasks (+N hidden per row)
  lazy active release-v020 --levels 2 # That release and its direct children
  lazy active --flat         # Active tasks in flat list
  lazy active --follow       # Live-updating active tasks view
  lazy active release-v020 -f # Live view of one release's subtree`);
}

export function blockedUsage(): void {
  console.log(`Usage: lazy blocked [--flat] [--tag <tag>] [--levels <n>]

List blocked tasks (waiting for user input).

Options:
  --flat         Show flat list instead of tree structure
  --tree         Show tree structure (default)
  --tag <tag>    Show only blocked tasks carrying this tag (flat list of matches)
  --levels <n>   Show only the first <n> levels of the hierarchy (1-based:
                 1 = top-level blocked tasks only, 2 = those plus their
                 children). Levels are counted from the rows this listing
                 shows; tasks hidden by the limit are counted as "(+N hidden)"
                 on their parent's row.

The tree view shows child tasks indented under their parents. Tags are shown
after each task's goal.

Examples:
  lazy blocked                 # Blocked tasks in tree view
  lazy blocked --levels 1      # Only top-level blocked tasks
  lazy blocked --flat          # Blocked tasks in flat list
  lazy blocked --tag onboarding # Blocked tasks tagged 'onboarding'`);
}
