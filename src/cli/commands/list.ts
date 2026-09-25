import { join } from 'path';
import { formatDate, formatDuration } from '../../utils/format';
import { displayId, buildDisplayIdMap } from '../../task/identity';
import { requireLazyRoot, requireStorage, parseFlags, resolveTaskOrExit } from '../helpers';
import type { Task } from '../../storage';
import { buildTaskTree, collectActiveTasks, type TaskWithSession } from '../../task/tree';
import { theme } from '../../render/theme';
import { queryTaskList, queryBlockedTasks, queryActiveTasks } from '../../daemon/rpc-fallback';
import { parentTaskIdOf, collectSubtreeIds, pruneTasksToDepth } from '../../task-target';
import { normalizeTag } from '../../utils/tags';
import { renderWorkingStatus } from '../../utils/working-substate';
import { describeExpiry } from '../../utils/local-day';
import {
  protectionMarkers,
  PROTECTION_MARKER_LEGEND,
} from '../../protection/status';
import { isLinkedTask } from '../../task/linked';
import { isStoppedParked } from '../../task/user-stop';

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

/** Fixed width for the AGENT column — fits the longest registered agent id. */
const TASK_LIST_AGENT_COL_WIDTH = 12;

/** Bare agent id for listing rows (always shown, including the project default). */
function taskListAgentLabel(task: Task): string {
  return task.agent_id || '-';
}

/** Tree-view column headers shared by list, active, blocked, and loop. */
export function printTaskListTreeHeader(): void {
  console.log(
    `${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ` +
    `${theme.header('TYPE'.padEnd(10))} ${theme.header('TURNS'.padEnd(8))} ${theme.header('LAST ACTIVE'.padEnd(18))} ` +
    `${theme.header('DURATION'.padEnd(10))} ${theme.header('AGENT'.padEnd(TASK_LIST_AGENT_COL_WIDTH))} ${theme.header('GOAL')}`,
  );
  console.log(theme.separator(
    `${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(8)} ` +
    `${'─'.repeat(18)} ${'─'.repeat(10)} ${'─'.repeat(TASK_LIST_AGENT_COL_WIDTH)} ${'─'.repeat(30)}`,
  ));
}

/** Flat-view column headers shared by list, active, and blocked. */
function printTaskListFlatHeader(): void {
  console.log(
    `${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ` +
    `${theme.header('AGENT'.padEnd(TASK_LIST_AGENT_COL_WIDTH))} ${theme.header('TYPE'.padEnd(10))} ` +
    `${theme.header('PARENT'.padEnd(18))} ${theme.header('CREATED'.padEnd(18))} ${theme.header('GOAL')}`,
  );
  console.log(theme.separator(
    `${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(TASK_LIST_AGENT_COL_WIDTH)} ` +
    `${'─'.repeat(10)} ${'─'.repeat(18)} ${'─'.repeat(18)} ${'─'.repeat(30)}`,
  ));
}

/** Format the fixed-width data columns for a tree-view row (excludes CODE/connector). */
function formatTaskListTreeDataCells(node: TaskWithSession, status: string): string {
  const task = node.task;
  const sess = node.session;
  const lastInteraction = sess?.last_interaction_at ? formatDate(sess.last_interaction_at) : '-';
  const duration = sess ? formatDuration(sess.total_duration_ms) : '-';
  const turns = formatTurnCount(node.turnCount);
  const model = task.model ?? '-';
  const taskType = task.type ?? 'task';
  const agent = taskListAgentLabel(task);

  return (
    `${theme.pad(theme.status(status), 12)} ${theme.pad(theme.model(model), 8)} ${theme.pad(taskType, 10)} ` +
    `${turns.padEnd(8)} ${theme.pad(theme.timestamp(lastInteraction), 18)} ${theme.pad(theme.duration(duration), 10)} ` +
    `${theme.pad(agent, TASK_LIST_AGENT_COL_WIDTH)}`
  );
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
      // Doctor reports these and never resumes any of them on its own. It does
      // not promise more than that here: this count is "the run is gone",
      // whatever status the task holds, and only the INTERRUPTED subset is
      // resumable at all (`lazy doctor --resume-interrupted-tasks`).
      `${crashedCount} task(s) have crashed containers. Run \`lazy doctor\` for details.`
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

  // Indicate user-stopped tasks (parallel to [CRASHED]). [STOPPED] means the
  // reconciler will NOT auto-resume; a manual resume/unblock is required. A
  // stop parks the task `blocked` (or `conflict` with pending file
  // violations), indistinguishable from a finished turn without this marker;
  // `interrupted` covers sessions stopped before that change. Not `working`:
  // a builder unblock leaves the flag set until that turn completes.
  // The rule is shared with lazy_list's `stopped` field (isStoppedParked).
  if (isStoppedParked(task.status, sess)) {
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
  const code = displayId(task);
  const goal = task.goal.length > 30
    ? task.goal.substring(0, 28) + '..'
    : task.goal;
  const goalWithTags = goalCell(node, goal);

  const codeWithPrefix = `${prefix}${connector}${code}`;
  const fitsOnOneLine = codeWithPrefix.length <= 20;
  const dataCells = formatTaskListTreeDataCells(node, status);

  if (fitsOnOneLine) {
    // Code fits in CODE column — single line
    console.log(
      `${prefix}${connector}${theme.pad(theme.taskId(code), 20 - prefix.length - connector.length)} ${dataCells} ${goalWithTags}`,
    );
  } else {
    // Code too wide — code on first line, data on second
    console.log(`${prefix}${connector}${theme.taskId(code)}`);
    const dataPrefix = prefix + childPrefix;
    const dataPad = Math.max(0, 20 - dataPrefix.length);
    console.log(`${dataPrefix}${' '.repeat(dataPad)} ${dataCells} ${goalWithTags}`);
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
  const linked = isLinkedTask(node.task) ? ` ${theme.label('[linked]')}` : '';
  // Elision note last: a depth-limited listing must never look complete.
  const hidden = node.hiddenDescendants
    ? ` ${theme.warning(`(+${node.hiddenDescendants} hidden)`)}`
    : '';
  return `${prefix}${goal}${linked}${tagSuffix(node.task)}${hidden}`;
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
    printTaskListTreeHeader();

    for (const rootNode of tree) {
      printTaskTree(rootNode);
    }
  } else {
    // Flat list
    const nodes = flattenTree(tree);
    const parentDisplayId = buildDisplayIdMap(nodes.map(n => n.task));
    printTaskListFlatHeader();

    for (const node of nodes) {
      console.log(formatTaskListFlatRow(node, parentDisplayId));
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
  return node.task.status;
}

/** Format one flat-list row (shared by list, active, and blocked). */
function formatTaskListFlatRow(
  node: TaskWithSession,
  parentDisplayId: ReturnType<typeof buildDisplayIdMap>,
): string {
  const task = node.task;
  const parentId = parentTaskIdOf(task);
  const parent = parentId ? theme.taskId(parentDisplayId(parentId)) : '-';
  const code = displayId(task);
  const model = task.model ?? '-';
  const taskType = task.type ?? 'task';
  const agent = taskListAgentLabel(task);

  return (
    `${theme.pad(theme.taskId(code), 20)} ${theme.pad(theme.status(flatStatusText(node)), 12)} ` +
    `${theme.pad(theme.model(model), 8)} ${theme.pad(agent, TASK_LIST_AGENT_COL_WIDTH)} ${theme.pad(taskType, 10)} ` +
    `${theme.pad(parent, 18)} ${theme.pad(theme.timestamp(formatDate(task.created_at)), 18)} ${goalCell(node, task.goal)}`
  );
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
    printTaskListTreeHeader();

    for (const rootNode of tree) {
      printTaskTree(rootNode);
    }
  } else {
    const nodes = flattenTree(tree);
    const parentDisplayId = buildDisplayIdMap(nodes.map(n => n.task));
    printTaskListFlatHeader();

    for (const node of nodes) {
      console.log(formatTaskListFlatRow(node, parentDisplayId));
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
    printTaskListTreeHeader();

    for (const rootNode of tree) {
      printTaskTree(rootNode);
    }
  } else {
    const flatNodes = flattenTree(tree);
    const parentDisplayId = buildDisplayIdMap(flatNodes.map(n => n.task));
    printTaskListFlatHeader();

    for (const node of flatNodes) {
      console.log(formatTaskListFlatRow(node, parentDisplayId));
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
