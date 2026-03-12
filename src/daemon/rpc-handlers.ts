/**
 * Daemon RPC handlers — execute command logic and return structured data.
 *
 * Each handler opens project storage, executes queries, and returns
 * JSON-serializable data. The CLI owns all formatting/rendering.
 *
 * Handlers must NOT:
 * - Call process.exit()
 * - Write to stdout/stderr
 * - Import CLI rendering/theme modules
 */

import { existsSync } from 'fs';
import { loadConfig } from '../config/loader';
import { createStorage, type Storage, type StorageBackend } from '../storage';
import type { Task, SearchResult } from '../storage';
import { buildTaskTree } from '../cli/commands/list';
import { loadTaskShowData } from '../cli/commands/show';
import { isStructuredQuery, structuredSearch } from '../search';
import { getDiffStat, getDiffFull, getCurrentBranch, branchExists } from '../git/operations';
import { getNewNotesSince } from '../cli/commands/shared';
import { getWorktreePath, getBranchNameFromId, displayId, formatDate } from '../cli/helpers';
import type { Comment } from '../types';

export class RpcError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function openProjectStorage(projectRoot: string): Promise<Storage> {
  // Pass projectRoot as cwd so config resolution starts from the correct
  // project directory, not the daemon's own cwd (which may be a different project).
  const config = loadConfig(projectRoot, { cwd: projectRoot });
  return createStorage(projectRoot, {
    backend: config.storage.backend as StorageBackend,
    externalPath: config.storage.external_path || undefined,
  });
}

/**
 * Dispatch an RPC request to the appropriate handler.
 */
export async function handleRpc(
  command: string,
  projectRoot: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (!existsSync(projectRoot)) {
    throw new RpcError(400, `Project root does not exist: ${projectRoot}`);
  }

  switch (command) {
    case 'list': return handleList(projectRoot, params);
    case 'blocked': return handleBlocked(projectRoot);
    case 'active': return handleActive(projectRoot);
    case 'show': return handleShow(projectRoot, params);
    case 'search': return handleSearch(projectRoot, params);
    case 'diff': return handleDiff(projectRoot, params);
    case 'wait': return handleWait(projectRoot, params);
    default: throw new RpcError(404, `Unknown RPC command: ${command}`);
  }
}

// --- List ---

function collectDescendants(taskId: string, allTasks: Task[]): Set<string> {
  const descendants = new Set<string>();
  descendants.add(taskId);
  const children = allTasks.filter(t => t.parent_task_id === taskId);
  for (const child of children) {
    for (const id of collectDescendants(child.id, allTasks)) {
      descendants.add(id);
    }
  }
  return descendants;
}

export async function handleList(projectRoot: string, params: Record<string, unknown>) {
  const storage = await openProjectStorage(projectRoot);
  try {
    const all = params.all === true;
    let tasks = all
      ? await storage.listTasks()
      : await storage.listTasksWithOptions({ nonTerminalOnly: true });

    if (typeof params.taskFilter === 'string' && params.taskFilter) {
      const result = await storage.resolveTask(params.taskFilter);
      if (result.task) {
        const allowedIds = collectDescendants(result.task.id, tasks);
        tasks = tasks.filter(t => allowedIds.has(t.id));
      } else {
        throw new RpcError(404, `Task not found: ${params.taskFilter}`);
      }
    }

    const tree = await buildTaskTree(storage, tasks, projectRoot);
    return { tree };
  } finally {
    await storage.close();
  }
}

// --- Blocked ---

export async function handleBlocked(projectRoot: string) {
  const storage = await openProjectStorage(projectRoot);
  try {
    const tasks = await storage.listTasksWithOptions({ blockedOnly: true });
    const tree = await buildTaskTree(storage, tasks, projectRoot);
    return { tree };
  } finally {
    await storage.close();
  }
}

// --- Active ---

export async function handleActive(projectRoot: string) {
  const storage = await openProjectStorage(projectRoot);
  try {
    const tasks = await storage.listTasksWithOptions({ withSessionsOnly: true, nonTerminalOnly: true });
    const tree = await buildTaskTree(storage, tasks, projectRoot);
    return { tree };
  } finally {
    await storage.close();
  }
}

// --- Show ---

export async function handleShow(projectRoot: string, params: Record<string, unknown>) {
  if (typeof params.taskId !== 'string' || !params.taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  const storage = await openProjectStorage(projectRoot);
  try {
    const result = await storage.resolveTask(params.taskId);
    if (!result.task) {
      if (result.ambiguousMatches?.length) {
        // Return ambiguous matches so CLI can handle disambiguation
        return {
          ambiguous: true,
          matches: result.ambiguousMatches.map(t => ({
            id: t.id, code: t.code, goal: t.goal, status: t.status,
          })),
        };
      }
      throw new RpcError(404, `Task not found: ${params.taskId}`);
    }

    const data = await loadTaskShowData(storage, result.task, projectRoot);
    // Serialize TaskShowData — convert Map to plain object
    return {
      task: data.task,
      session: data.session,
      turns: data.turns,
      commits: data.commits,
      comments: data.comments,
      children: data.children,
      childSessions: Object.fromEntries(data.childSessions.entries()),
      proposals: data.proposals,
      parent: data.parent,
      retryStatus: data.retryStatus,
      orphanStatus: data.orphanStatus,
    };
  } finally {
    await storage.close();
  }
}

// --- Search ---

export async function handleSearch(projectRoot: string, params: Record<string, unknown>) {
  if (typeof params.query !== 'string' || !params.query) {
    throw new RpcError(400, 'query is required');
  }

  const storage = await openProjectStorage(projectRoot);
  try {
    const query = params.query;
    const fuzzy = params.fuzzy === true;

    let results: SearchResult[];

    if (fuzzy) {
      // Dynamic import to avoid loading fuse.js until needed
      const { getAllSearchableContent, fuzzySearch } = await import('../cli/commands/search-data');
      const items = await getAllSearchableContent(storage);
      results = fuzzySearch(items, query);
    } else if (isStructuredQuery(query)) {
      results = await structuredSearch(storage, query);
    } else {
      results = await storage.search(query);
    }

    // Apply type filters
    if (Array.isArray(params.types) && params.types.length > 0) {
      const typeSet = new Set(params.types);
      results = results.filter(r => typeSet.has(r.entity_type));
    }

    return { query, results };
  } finally {
    await storage.close();
  }
}

// --- Diff ---

/**
 * Render comments as a virtual unified diff section.
 */
function renderNotesDiff(comments: Comment[]): string {
  if (comments.length === 0) return '';

  const lines: string[] = [];
  lines.push('diff --lazy a/comments b/comments');
  lines.push('--- /dev/null');
  lines.push('+++ b/comments');

  const commentLines: string[] = [];
  for (const comment of comments) {
    commentLines.push(`[${formatDate(comment.created_at)}]`);
    const contentLines = comment.content.split('\n');
    commentLines.push(...contentLines);
    commentLines.push('');
  }

  lines.push(`@@ -0,0 +1,${commentLines.length} @@`);
  for (const line of commentLines) {
    lines.push(`+${line}`);
  }

  return lines.join('\n');
}

export async function handleDiff(projectRoot: string, params: Record<string, unknown>) {
  if (typeof params.taskId !== 'string' || !params.taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  const storage = await openProjectStorage(projectRoot);
  try {
    const result = await storage.resolveTask(params.taskId);
    if (!result.task) {
      throw new RpcError(404, `Task not found: ${params.taskId}`);
    }
    const task = result.task;

    const sess = await storage.getSessionByTaskId(task.id);
    if (!sess) {
      throw new RpcError(400, `Task ${displayId(task)} has no session`);
    }

    const worktreePath = getWorktreePath(projectRoot, task);
    if (!existsSync(worktreePath)) {
      throw new RpcError(400, `Worktree not found: ${worktreePath}`);
    }

    const full = params.full === true;

    // Prefer three-dot diff against parent branch — excludes upstream merges.
    // Fall back to two-dot from upstream_merge_sha when parent branch doesn't exist.
    let fromRef: string;
    let useTwoDotDiff = false;

    const parentBranch = task.parent_task_id
      ? await getBranchNameFromId(task.parent_task_id, storage)
      : getCurrentBranch(projectRoot);

    if (branchExists(parentBranch, worktreePath)) {
      fromRef = parentBranch;
      useTwoDotDiff = false;
    } else if (sess.upstream_merge_sha) {
      fromRef = sess.upstream_merge_sha;
      useTwoDotDiff = true;
    } else {
      fromRef = parentBranch;
      useTwoDotDiff = false;
    }

    // Find notes since last agent turn
    let noteCutoff: number | null = null;
    const turns = await storage.getSessionTurns(sess.id);
    const lastAgentTurn = turns.filter(t => t.role === 'agent').pop();
    if (lastAgentTurn) {
      noteCutoff = lastAgentTurn.timestamp;
    }

    const allNotes = await storage.getTaskComments(task.id);
    const newNotes = noteCutoff ? getNewNotesSince(allNotes, noteCutoff) : allNotes;
    const notesDiffSection = renderNotesDiff(newNotes);

    let output = '';
    if (full) {
      const diff = getDiffFull(fromRef, 'HEAD', worktreePath, useTwoDotDiff);
      if (!diff && !notesDiffSection) {
        output = 'No changes.';
      } else {
        const parts: string[] = [];
        if (diff) parts.push(diff);
        if (notesDiffSection) parts.push(notesDiffSection);
        output = parts.join('\n\n');
      }
    } else {
      const stat = getDiffStat(fromRef, 'HEAD', worktreePath, useTwoDotDiff);
      if (!stat && newNotes.length === 0) {
        output = 'No changes.';
      } else {
        const parts: string[] = [];
        if (stat) parts.push(stat);
        if (newNotes.length > 0) {
          parts.push(` comments | ${newNotes.length} comment(s) added`);
        }
        parts.push(`\nFor full diff: lazy diff ${displayId(task)} --full`);
        output = parts.join('\n');
      }
    }

    return { output };
  } finally {
    await storage.close();
  }
}

// --- Wait ---

const WAIT_POLL_INTERVAL_MS = 1500;
const WAIT_MAX_TIMEOUT_S = 600;

/**
 * Long-poll until a task's turn count increases with an agent turn,
 * or the task status changes from 'working'.
 *
 * This eliminates client-side polling — the daemon holds the connection
 * and checks storage internally.
 */
export async function handleWait(projectRoot: string, params: Record<string, unknown>) {
  if (typeof params.taskId !== 'string' || !params.taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  const timeoutSecs = Math.min(
    typeof params.timeout === 'number' ? params.timeout : WAIT_MAX_TIMEOUT_S,
    WAIT_MAX_TIMEOUT_S,
  );

  // Resolve task and capture initial state
  const storage = await openProjectStorage(projectRoot);
  let fullTaskId: string;
  let initialTurnCount: number;
  let initialStatus: string;
  try {
    const result = await storage.resolveTask(params.taskId);
    if (!result.task) {
      throw new RpcError(404, `Task not found: ${params.taskId}`);
    }
    fullTaskId = result.task.id;
    initialStatus = result.task.status;
    initialTurnCount = await storage.getTurnCountByTaskId(fullTaskId);
  } finally {
    await storage.close();
  }

  // If task is already not working, return immediately
  if (initialStatus !== 'working') {
    return {
      task_id: fullTaskId,
      status: initialStatus,
      timed_out: false,
    };
  }

  const deadline = Date.now() + timeoutSecs * 1000;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));

    // Open storage fresh each poll to release locks between checks
    const pollStorage = await openProjectStorage(projectRoot);
    try {
      const task = await pollStorage.getTask(fullTaskId);
      if (!task) {
        throw new RpcError(404, `Task disappeared: ${params.taskId}`);
      }

      // Status changed from working — done
      if (task.status !== 'working') {
        return {
          task_id: fullTaskId,
          status: task.status,
          timed_out: false,
        };
      }

      // Check if turn count increased with an agent turn
      const currentTurnCount = await pollStorage.getTurnCountByTaskId(fullTaskId);
      if (currentTurnCount > initialTurnCount) {
        // Verify the latest turn is from the agent
        const sess = await pollStorage.getSessionByTaskId(fullTaskId);
        if (sess) {
          const turns = await pollStorage.getSessionTurns(sess.id);
          const latestTurn = turns[turns.length - 1];
          if (latestTurn && latestTurn.role === 'agent') {
            return {
              task_id: fullTaskId,
              status: task.status,
              turn_count: currentTurnCount,
              latest_turn: {
                sequence: latestTurn.sequence,
                role: latestTurn.role,
                timestamp: latestTurn.timestamp,
              },
              timed_out: false,
            };
          }
        }
      }
    } finally {
      await pollStorage.close();
    }
  }

  // Timed out
  return {
    task_id: fullTaskId,
    status: 'working',
    timed_out: true,
  };
}
