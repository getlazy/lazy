import { requireLazyRoot, requireStorage, shortId, displayId, buildDisplayIdMap, formatDate, formatDuration, formatTokenUsage, parseFlags, taskRef, resolveTaskOrExit } from '../helpers';
import type { Task, Session, Storage } from '../../storage';
import { reconcileTasks } from '../../utils/reconcile';
import { protocolDir as getProtocolDir, readStatus } from '../../protocol';
import { createRunner } from '../../runner';
import { getDataDir } from '../init';
import { theme } from '../theme';

export interface TaskWithSession {
  task: Task;
  session: Session | null;
  turnCount: number;
  children: TaskWithSession[];
  retryCount?: number;
  crashed?: boolean;
}

export async function buildTaskTree(storage: Storage, tasks: Task[], lazyRoot: string): Promise<TaskWithSession[]> {
  const runner = createRunner(lazyRoot);
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
    if (session && !['complete', 'abandoned', 'closed'].includes(task.status)) {
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
    if (node.task.parent_task_id) {
      const parent = taskMap.get(node.task.parent_task_id);
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
function sortByLastActive(nodes: TaskWithSession[]): void {
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
function countCrashed(nodes: TaskWithSession[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.crashed) count++;
    count += countCrashed(node.children);
  }
  return count;
}

/** Print a footnote if any tasks have crashed containers. */
function printCrashedFootnote(crashedCount: number): void {
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

/**
 * Recursively collect all descendant task IDs for a given task.
 */
function collectDescendants(taskId: string, allTasks: Task[]): Set<string> {
  const descendants = new Set<string>();
  descendants.add(taskId);

  // Find all direct children
  const children = allTasks.filter(t => t.parent_task_id === taskId);

  // Recursively add descendants of each child
  for (const child of children) {
    const childDescendants = collectDescendants(child.id, allTasks);
    for (const id of childDescendants) {
      descendants.add(id);
    }
  }

  return descendants;
}

export async function commandList(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'all', takesValue: false },
    { name: 'flat', takesValue: false },
    { name: 'tree', takesValue: false },
    { name: 'ids-only', takesValue: false },
  ], 'list');

  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    const idsOnly = parsed.flags.get('ids-only') === true;
    const showAll = parsed.flags.get('all') === true;
    const showTree = parsed.flags.get('tree') === true || parsed.flags.get('flat') !== true;

    // Get tasks - default to non-terminal (working + blocked + interrupted)
    let tasks = showAll
      ? await storage.listTasks()
      : await storage.listTasksWithOptions({ nonTerminalOnly: true });

    // If a task ID/code is provided, filter to show only that task and its descendants
    if (parsed.positional.length > 0) {
      const taskInput = parsed.positional[0];
      const targetTask = await resolveTaskOrExit(storage, taskInput);

      // Collect all descendant IDs (including the target task itself)
      const allowedIds = collectDescendants(targetTask.id, tasks);

      // Filter tasks to only include the target and its descendants
      tasks = tasks.filter(t => allowedIds.has(t.id));
    }

    // Machine-readable output for shell completion
    if (idsOnly) {
      for (const task of tasks) {
        console.log(displayId(task));
      }
      return;
    }

    if (tasks.length === 0) {
      console.log(showAll
        ? 'No tasks. Create one with: lazy start --goal "..."'
        : 'No active tasks. Use --all to see all tasks.');
      return;
    }

    // Build tree (used for both display and crash detection)
    const tree = await buildTaskTree(storage, tasks, root);
    const crashedCount = countCrashed(tree);

    if (showTree) {
      console.log(`${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ${theme.header('TYPE'.padEnd(10))} ${theme.header('TURNS'.padEnd(8))} ${theme.header('LAST ACTIVE'.padEnd(18))} ${theme.header('DURATION'.padEnd(10))} ${theme.header('TOKENS IN/OUT'.padEnd(14))} ${theme.header('GOAL')}`);
      console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(18)} ${'─'.repeat(10)} ${'─'.repeat(14)} ${'─'.repeat(30)}`));

      for (const rootNode of tree) {
        printTaskTree(rootNode);
      }
    } else {
      // Flat list
      const parentDisplayId = buildDisplayIdMap(tasks);
      console.log(`${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ${theme.header('TYPE'.padEnd(10))} ${theme.header('PARENT'.padEnd(18))} ${theme.header('CREATED'.padEnd(18))} ${theme.header('GOAL')}`);
      console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(18)} ${'─'.repeat(18)} ${'─'.repeat(30)}`));

      for (const task of tasks) {
        const parent = task.parent_task_id ? theme.taskId(parentDisplayId(task.parent_task_id)) : '-';
        const code = displayId(task);
        const model = task.model ?? '-';
        const taskType = task.type ?? 'task';
        console.log(
          `${theme.pad(theme.taskId(code), 20)} ${theme.pad(theme.status(task.status), 12)} ${theme.pad(theme.model(model), 8)} ${theme.pad(taskType, 10)} ${theme.pad(parent, 18)} ${theme.pad(theme.timestamp(formatDate(task.created_at)), 18)} ${task.goal}`
        );
      }
    }

    printCrashedFootnote(crashedCount);
  } finally {
    await storage.close();
  }
}

export async function commandActive(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'flat', takesValue: false },
    { name: 'tree', takesValue: false },
    { name: 'follow', aliases: ['f'], takesValue: false },
    { name: 'ids-only', takesValue: false },
  ], 'active');

  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    const idsOnly = parsed.flags.get('ids-only') === true;
    const showTree = parsed.flags.get('tree') === true || parsed.flags.get('flat') !== true;
    const follow = parsed.flags.get('follow') === true;
    const pollIntervalMs = 3000;

    // Machine-readable output for shell completion
    if (idsOnly) {
      const tasks = await storage.listTasksWithOptions({ withSessionsOnly: true, nonTerminalOnly: true });
      for (const task of tasks) {
        console.log(displayId(task));
      }
      return;
    }

    const renderOnce = async (): Promise<boolean> => {
      // Get active tasks (non-terminal tasks with sessions)
      const tasks = await storage.listTasksWithOptions({ withSessionsOnly: true, nonTerminalOnly: true });

      if (tasks.length === 0) {
        console.log('No active tasks.');
        return true; // Stop polling
      }

      // Build tree for both display modes (includes crash detection)
      const tree = await buildTaskTree(storage, tasks, root);

      if (showTree) {
        console.log(`${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ${theme.header('TYPE'.padEnd(10))} ${theme.header('TURNS'.padEnd(8))} ${theme.header('LAST ACTIVE'.padEnd(18))} ${theme.header('DURATION'.padEnd(10))} ${theme.header('COST'.padEnd(10))} ${theme.header('GOAL')}`);
        console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(18)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(30)}`));

        for (const rootNode of tree) {
          printTaskTree(rootNode);
        }
      } else {
        const parentDisplayId = buildDisplayIdMap(tasks);
        console.log(`${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ${theme.header('TYPE'.padEnd(10))} ${theme.header('PARENT'.padEnd(18))} ${theme.header('CREATED'.padEnd(18))} ${theme.header('GOAL')}`);
        console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(18)} ${'─'.repeat(18)} ${'─'.repeat(30)}`));

        for (const task of tasks) {
          const parent = task.parent_task_id ? theme.taskId(parentDisplayId(task.parent_task_id)) : '-';
          const code = displayId(task);
          const model = task.model ?? '-';
          const taskType = task.type ?? 'task';
          console.log(
            `${theme.pad(theme.taskId(code), 20)} ${theme.pad(theme.status(task.status), 12)} ${theme.pad(theme.model(model), 8)} ${theme.pad(taskType, 10)} ${theme.pad(parent, 18)} ${theme.pad(theme.timestamp(formatDate(task.created_at)), 18)} ${task.goal}`
          );
        }
      }

      printCrashedFootnote(countCrashed(tree));
      return false;
    };

    if (follow) {
      let done = false;
      while (!done) {
        process.stdout.write('\x1B[2J\x1B[H');
        // Reconcile on each poll iteration in follow mode
        await reconcileTasks(storage, root);
        done = await renderOnce();
        if (!done) {
          console.log(`\n(following — press Ctrl+C to stop, polling every ${pollIntervalMs / 1000}s)`);
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
      }
    } else {
      await renderOnce();
    }
  } finally {
    await storage.close();
  }
}

export async function commandBlocked(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'flat', takesValue: false },
    { name: 'tree', takesValue: false },
  ], 'blocked');

  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    const showTree = parsed.flags.get('tree') === true || parsed.flags.get('flat') !== true;

    // Get blocked tasks (blocked status only - waiting for user)
    const tasks = await storage.listTasksWithOptions({ blockedOnly: true });

    if (tasks.length === 0) {
      console.log('No blocked tasks.');
      return;
    }

    // Build tree for both display and crash detection
    const tree = await buildTaskTree(storage, tasks, root);

    // Sort roots by last_interaction_at DESC (most recently active first)
    // Tasks with no session sort to the bottom
    sortByLastActive(tree);

    if (showTree) {
      console.log(`${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ${theme.header('TYPE'.padEnd(10))} ${theme.header('TURNS'.padEnd(8))} ${theme.header('LAST ACTIVE'.padEnd(18))} ${theme.header('DURATION'.padEnd(10))} ${theme.header('TOKENS IN/OUT'.padEnd(14))} ${theme.header('GOAL')}`);
      console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(18)} ${'─'.repeat(10)} ${'─'.repeat(14)} ${'─'.repeat(30)}`));

      for (const rootNode of tree) {
        printTaskTree(rootNode);
      }
    } else {
      // Flat list - sort by session last_interaction_at
      // (tree is already built and sorted above, extract flat task list)
      const flatNodes: TaskWithSession[] = [];
      const collectFlat = (nodes: TaskWithSession[]) => {
        for (const node of nodes) {
          flatNodes.push(node);
          collectFlat(node.children);
        }
      };
      collectFlat(tree);

      const parentDisplayId = buildDisplayIdMap(flatNodes.map(n => n.task));
      console.log(`${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ${theme.header('TYPE'.padEnd(10))} ${theme.header('PARENT'.padEnd(18))} ${theme.header('CREATED'.padEnd(18))} ${theme.header('GOAL')}`);
      console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(18)} ${'─'.repeat(18)} ${'─'.repeat(30)}`));

      for (const { task } of flatNodes) {
        const parent = task.parent_task_id ? theme.taskId(parentDisplayId(task.parent_task_id)) : '-';
        const code = displayId(task);
        const model = task.model ?? '-';
        const taskType = task.type ?? 'task';
        console.log(
          `${theme.pad(theme.taskId(code), 20)} ${theme.pad(theme.status(task.status), 12)} ${theme.pad(theme.model(model), 8)} ${theme.pad(taskType, 10)} ${theme.pad(parent, 18)} ${theme.pad(theme.timestamp(formatDate(task.created_at)), 18)} ${task.goal}`
        );
      }
    }

    printCrashedFootnote(countCrashed(tree));
  } finally {
    await storage.close();
  }
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
