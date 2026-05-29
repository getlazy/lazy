import { requireLazyRoot, requireStorage, displayId, buildDisplayIdMap, formatDate, formatDuration, formatTokenUsage, parseFlags, taskRef } from '../helpers';
import type { Task, Session, Storage } from '../../storage';

import { protocolDir as getProtocolDir, readStatus } from '../../protocol';
import { createRunner } from '../../runner';
import { getDataDir } from '../init';
import { theme } from '../theme';
import { queryTaskList, queryBlockedTasks, queryActiveTasks } from '../../daemon/rpc-fallback';
import { parentTaskIdOf } from '../../task-target';

export interface TaskWithSession {
  task: Task;
  session: Session | null;
  turnCount: number;
  children: TaskWithSession[];
  retryCount?: number;
  crashed?: boolean;
}

export async function buildTaskTree(storage: Storage, tasks: Task[], lazyRoot: string): Promise<TaskWithSession[]> {
  const runner = await createRunner(lazyRoot);
  const taskMap = new Map<string, TaskWithSession>();

  // Create nodes for all tasks
  for (const task of tasks) {
    const session = await storage.getSessionByTaskId(task.id);
    let retryCount: number | undefined;
    let crashed = false;

    // Check if task is in retry state
    if (task.status === 'working' && session) {
      const protoDir = getProtocolDir(task.id);
      const status = readStatus(protoDir);
      if (status?.phase === 'retrying' && status.retryCount !== undefined) {
        retryCount = status.retryCount;
      }
    }

    // Check for crashed run (non-terminal tasks with dead runs)
    if (session && !['complete', 'abandoned'].includes(task.status)) {
      const tRef = taskRef(task);
      const cn = session.container_name ?? runner.runNameForTask(tRef);
      const info = runner.getRunInfo(cn);
      if (info && !info.running) {
        crashed = true;
      }
    }

    taskMap.set(task.id, {
      task,
      session,
      turnCount: await storage.getTurnCountByTaskId(task.id),
      children: [],
      retryCount,
      crashed,
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

  // Add retry count to status if retrying
  if (node.retryCount !== undefined && node.retryCount > 0) {
    status = `${status} (retry ${node.retryCount})`;
  }

  // Indicate auto-resumed tasks
  if (sess?.auto_resumed && task.status === 'working') {
    status = `${status} (auto)`;
  }

  // Add crashed indicator
  if (node.crashed) {
    status = `${status} [CRASHED]`;
  }

  // Indicate user-stopped interrupted tasks (parallel to [CRASHED]).
  // [STOPPED] means the reconciler will NOT auto-resume; a manual
  // resume/unblock is required.
  if (task.status === 'interrupted' && sess?.user_stopped) {
    status = `${status} [STOPPED]`;
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

  const codeWithPrefix = `${prefix}${connector}${code}`;
  const fitsOnOneLine = codeWithPrefix.length <= 20;

  if (fitsOnOneLine) {
    // Code fits in CODE column — single line
    console.log(
      `${prefix}${connector}${theme.pad(theme.taskId(code), 20 - prefix.length - connector.length)} ${theme.pad(theme.status(status), 12)} ${theme.pad(theme.model(model), 8)} ${theme.pad(taskType, 10)} ${turns.padEnd(8)} ${theme.pad(theme.timestamp(lastInteraction), 18)} ${theme.pad(theme.duration(duration), 10)} ${theme.pad(theme.duration(tokens), 14)} ${goal}`
    );
  } else {
    // Code too wide — code on first line, data on second
    console.log(`${prefix}${connector}${theme.taskId(code)}`);
    const dataPrefix = prefix + childPrefix;
    const dataPad = Math.max(0, 20 - dataPrefix.length);
    console.log(
      `${dataPrefix}${' '.repeat(dataPad)} ${theme.pad(theme.status(status), 12)} ${theme.pad(theme.model(model), 8)} ${theme.pad(taskType, 10)} ${turns.padEnd(8)} ${theme.pad(theme.timestamp(lastInteraction), 18)} ${theme.pad(theme.duration(duration), 10)} ${theme.pad(theme.duration(tokens), 14)} ${goal}`
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
  ], 'list');

  const idsOnly = parsed.flags.get('ids-only') === true;
  const showAll = parsed.flags.get('all') === true;
  const showTree = parsed.flags.get('tree') === true || parsed.flags.get('flat') !== true;

  const { tree } = await queryTaskList({
    all: showAll,
    taskFilter: parsed.positional[0] || undefined,
  });
  renderListOutput(tree, { idsOnly, showTree, showAll });
}

/** Shared rendering for list command — used by both daemon and direct paths. */
function renderListOutput(
  tree: TaskWithSession[],
  opts: { idsOnly: boolean; showTree: boolean; showAll: boolean },
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
    const tasks = flattenTree(tree).map(n => n.task);
    const parentDisplayId = buildDisplayIdMap(tasks);
    console.log(`${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ${theme.header('TYPE'.padEnd(10))} ${theme.header('PARENT'.padEnd(18))} ${theme.header('CREATED'.padEnd(18))} ${theme.header('GOAL')}`);
    console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(18)} ${'─'.repeat(18)} ${'─'.repeat(30)}`));

    for (const task of tasks) {
      const parentId = parentTaskIdOf(task);
      const parent = parentId ? theme.taskId(parentDisplayId(parentId)) : '-';
      const code = displayId(task);
      const model = task.model ?? '-';
      const taskType = task.type ?? 'task';
      console.log(
        `${theme.pad(theme.taskId(code), 20)} ${theme.pad(theme.status(task.status), 12)} ${theme.pad(theme.model(model), 8)} ${theme.pad(taskType, 10)} ${theme.pad(parent, 18)} ${theme.pad(theme.timestamp(formatDate(task.created_at)), 18)} ${task.goal}`
      );
    }
  }

  printCrashedFootnote(countCrashed(tree));
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
  ], 'active');

  const idsOnly = parsed.flags.get('ids-only') === true;
  const showTree = parsed.flags.get('tree') === true || parsed.flags.get('flat') !== true;
  const follow = parsed.flags.get('follow') === true;

  // --follow needs continuous reconciliation with open storage — can't use RPC
  if (follow) {
    const root = requireLazyRoot();
    const storage = await requireStorage();
    try {
      const pollIntervalMs = 3000;
      let done = false;
      while (!done) {
        process.stdout.write('\x1B[2J\x1B[H');
        const tasks = await storage.listTasksWithOptions({ withSessionsOnly: true, nonTerminalOnly: true });
        if (tasks.length === 0) {
          console.log('No active tasks.');
          done = true;
        } else {
          const tree = await buildTaskTree(storage, tasks, root);
          renderActiveOutput(tree, { idsOnly, showTree });
          console.log(`\n(following — press Ctrl+C to stop, polling every ${pollIntervalMs / 1000}s)`);
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
      }
    } finally {
      await storage.close();
    }
    return;
  }

  const { tree } = await queryActiveTasks();
  renderActiveOutput(tree, { idsOnly, showTree });
}

/** Shared rendering for active command. */
function renderActiveOutput(
  tree: TaskWithSession[],
  opts: { idsOnly: boolean; showTree: boolean },
): void {
  if (opts.idsOnly) {
    const allNodes = flattenTree(tree);
    for (const node of allNodes) {
      console.log(displayId(node.task));
    }
    return;
  }

  if (tree.length === 0) {
    console.log('No active tasks.');
    return;
  }

  if (opts.showTree) {
    console.log(`${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ${theme.header('TYPE'.padEnd(10))} ${theme.header('TURNS'.padEnd(8))} ${theme.header('LAST ACTIVE'.padEnd(18))} ${theme.header('DURATION'.padEnd(10))} ${theme.header('COST'.padEnd(10))} ${theme.header('GOAL')}`);
    console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(18)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(30)}`));

    for (const rootNode of tree) {
      printTaskTree(rootNode);
    }
  } else {
    const tasks = flattenTree(tree).map(n => n.task);
    const parentDisplayId = buildDisplayIdMap(tasks);
    console.log(`${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ${theme.header('TYPE'.padEnd(10))} ${theme.header('PARENT'.padEnd(18))} ${theme.header('CREATED'.padEnd(18))} ${theme.header('GOAL')}`);
    console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(18)} ${'─'.repeat(18)} ${'─'.repeat(30)}`));

    for (const task of tasks) {
      const parentId = parentTaskIdOf(task);
      const parent = parentId ? theme.taskId(parentDisplayId(parentId)) : '-';
      const code = displayId(task);
      const model = task.model ?? '-';
      const taskType = task.type ?? 'task';
      console.log(
        `${theme.pad(theme.taskId(code), 20)} ${theme.pad(theme.status(task.status), 12)} ${theme.pad(theme.model(model), 8)} ${theme.pad(taskType, 10)} ${theme.pad(parent, 18)} ${theme.pad(theme.timestamp(formatDate(task.created_at)), 18)} ${task.goal}`
      );
    }
  }

  printCrashedFootnote(countCrashed(tree));
}

export async function commandBlocked(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'flat', takesValue: false },
    { name: 'tree', takesValue: false },
  ], 'blocked');

  const showTree = parsed.flags.get('tree') === true || parsed.flags.get('flat') !== true;

  const { tree } = await queryBlockedTasks();
  sortByLastActive(tree);
  renderBlockedOutput(tree, showTree);
}

/** Shared rendering for blocked command. */
function renderBlockedOutput(tree: TaskWithSession[], showTree: boolean): void {
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

    for (const { task } of flatNodes) {
      const parentId = parentTaskIdOf(task);
      const parent = parentId ? theme.taskId(parentDisplayId(parentId)) : '-';
      const code = displayId(task);
      const model = task.model ?? '-';
      const taskType = task.type ?? 'task';
      console.log(
        `${theme.pad(theme.taskId(code), 20)} ${theme.pad(theme.status(task.status), 12)} ${theme.pad(theme.model(model), 8)} ${theme.pad(taskType, 10)} ${theme.pad(parent, 18)} ${theme.pad(theme.timestamp(formatDate(task.created_at)), 18)} ${task.goal}`
      );
    }
  }

  printCrashedFootnote(countCrashed(tree));
}

export function listUsage(): void {
  console.log(`Usage: lazy list [<task_id>] [--all] [--flat]

List all non-terminal tasks (working + blocked + interrupted).

Arguments:
  <task_id>   Optional task ID or code to filter - shows only that task and its descendants

Options:
  --all       Show all tasks including completed/abandoned/closed
  --flat      Show flat list instead of tree structure
  --tree      Show tree structure (default)
  --ids-only  Output only task IDs, one per line (for shell completion)

The tree view shows child tasks indented under their parents.

Examples:
  lazy list                  # All non-terminal tasks in tree view
  lazy list release-v05      # Only release-v05 task and its descendants
  lazy list --all            # All tasks including terminal states
  lazy list abc123de --all   # Task abc123de and descendants, including terminal states`);
}

export function activeUsage(): void {
  console.log(`Usage: lazy active [--flat] [--follow | -f]

List all non-terminal tasks (working + blocked + interrupted).

Options:
  --flat         Show flat list instead of tree structure
  --tree         Show tree structure (default)
  --follow, -f   Poll and refresh the display (press Ctrl+C to stop)
  --ids-only     Output only task IDs, one per line (for shell completion)

The tree view shows child tasks indented under their parents.

Examples:
  lazy active                # All active tasks in tree view
  lazy active --flat         # Active tasks in flat list
  lazy active --follow       # Live-updating active tasks view`);
}

export function blockedUsage(): void {
  console.log(`Usage: lazy blocked [--flat]

List blocked tasks (waiting for user input).

Options:
  --flat    Show flat list instead of tree structure
  --tree    Show tree structure (default)

The tree view shows child tasks indented under their parents.

Examples:
  lazy blocked           # Blocked tasks in tree view
  lazy blocked --flat    # Blocked tasks in flat list`);
}
