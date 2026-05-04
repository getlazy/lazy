/**
 * Daemon RPC handlers — execute command logic and return structured data.
 *
 * The daemon holds a single long-lived Storage instance for its project.
 * All RPC handlers and the reconcile loop share this instance via
 * `getOrCreateStorage()`. This makes the daemon the single writer — CLI commands
 * use RemoteStorage and never touch .storage-lock.
 *
 * Handlers must NOT:
 * - Call process.exit()
 * - Write to stdout/stderr
 * - Import CLI rendering/theme modules
 * - Call storage.close() — the daemon owns the Storage lifecycle
 * - NEVER spawn lazy CLI as a subprocess (use internal functions instead)
 *
 * CRITICAL: The daemon has direct access to storage, runners, and all task
 * lifecycle functions. Never use getLazyCommand() or spawn lazy CLI from
 * daemon code — it causes deadlocks and storage lock contention.
 */

import { existsSync } from 'fs';
import { loadConfig } from '../config/loader';
import { createStorage, type Storage, type StorageBackend } from '../storage';
import type { Task, SearchResult } from '../storage';
import { buildTaskTree } from '../cli/commands/list';
import { loadTaskShowData } from '../cli/commands/show';
import { isStructuredQuery, structuredSearch } from '../search';
import { getDiffStat, getDiffFull, getCurrentBranch, branchExists, recoverMissingWorktreeWithFetch } from '../git/operations';
import { getNewNotesSince } from '../cli/commands/shared';
import { getWorktreePath, getBranchNameFromId, displayId, formatDate } from '../cli/helpers';
import { launchTask, writeDaemonMcpConfig, type StartTaskParams } from './task-launcher';
import { launchUnblockTask, launchAskTask, rejectTask, closeTask, acceptTaskPreflight, acceptTask, syncTask, submitTask, resumeTask, type UnblockTaskParams, type AskTaskParams, type RejectTaskParams, type CloseTaskParams, type AcceptTaskPreflightParams, type AcceptTaskParams, type SyncTaskParams, type SubmitTaskParams, type ResumeTaskParams } from './task-lifecycle';
import type { Comment } from '../types';
import { logger } from '../utils/logger';

export class RpcError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Single long-lived Storage instance for the daemon's project.
 *
 * The daemon is per-project and single-threaded (Bun's event loop), so
 * concurrent RPC calls are serialized naturally — no explicit mutex is needed.
 * Async operations may interleave, but FileStorage uses file-level locking
 * internally for individual operations, so this is safe.
 */
let daemonStorage: Storage | null = null;

/** Module-level project root, set once by initDaemonStorage(). */
let daemonProjectRoot: string | null = null;

/**
 * Initialize the daemon storage module with the project root.
 * Must be called once during daemon startup before any RPC handlers run.
 */
export function initDaemonStorage(projectRoot: string): void {
  daemonProjectRoot = projectRoot;
}

/**
 * Get or create the long-lived Storage instance for the daemon's project.
 * The instance stays open for the lifetime of the daemon process.
 *
 * The daemon is the sole writer — it acquires the storage lock once at startup
 * and holds it forever. All FileStorage write operations become re-entrant
 * (increment depth counter) instead of contending for the filesystem lock.
 *
 * Requires initDaemonStorage() to have been called first.
 */
export async function getOrCreateStorage(): Promise<Storage> {
  if (!daemonProjectRoot) {
    throw new Error('Daemon storage not initialized — call initDaemonStorage() first');
  }
  if (!daemonStorage) {
    logger.debug('Initializing daemon storage...');
    const config = await loadConfig(daemonProjectRoot);
    daemonStorage = await createStorage(daemonProjectRoot, {
      backend: config.storage.backend as StorageBackend,
      externalPath: config.storage.external_path || undefined,
    });
    // Acquire storage lock once and hold forever. The daemon is the sole writer
    // (CLI uses RemoteStorage, agents run in containers with their own data dir).
    // All FileStorage.withLock() calls become re-entrant within this process.
    await (daemonStorage as any).lock?.acquire?.();
    logger.info(`Daemon storage initialized (backend: ${config.storage.backend})`);
  }
  return daemonStorage;
}

/**
 * Close the long-lived Storage instance. Called on daemon shutdown.
 */
export async function closeAllStorage(): Promise<void> {
  if (daemonStorage) {
    logger.debug('Closing daemon storage...');
    try {
      await daemonStorage.close();
      logger.debug('Daemon storage closed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Error closing daemon storage: ${msg}`);
    }
    daemonStorage = null;
  }
}

/**
 * Open a fresh, short-lived Storage instance for a project.
 * Used by tests to verify data independently of the shared instance,
 * and by the SSE catchup path. Not used by daemon RPC handlers —
 * they use getOrCreateStorage() instead.
 */
export async function openProjectStorage(projectRoot: string): Promise<Storage> {
  const config = await loadConfig(projectRoot);
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
    case 'startTask': return handleStartTask(projectRoot, params);
    case 'unblockTask': return handleUnblockTask(projectRoot, params);
    case 'askTask': return handleAskTask(projectRoot, params);
    case 'acceptTaskPreflight': return handleAcceptTaskPreflight(projectRoot, params);
    case 'acceptTask': return handleAcceptTask(projectRoot, params);
    case 'rejectTask': return handleRejectTask(projectRoot, params);
    case 'abandonTask': return handleAbandonTask(projectRoot, params);
    case 'closeTask': return handleCloseTask(projectRoot, params);
    case 'submitTask': return handleSubmitTask(projectRoot, params);
    case 'resumeTask': return handleResumeTask(projectRoot, params);
    case 'syncTask': return handleSyncTask(projectRoot, params);
    case 'getDaemonMcpConfig': return handleGetDaemonMcpConfig(projectRoot, params);
    case 'storage': return handleStorageCall(projectRoot, params);
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
  const storage = await getOrCreateStorage();
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
}

// --- Blocked ---

export async function handleBlocked(projectRoot: string) {
  const storage = await getOrCreateStorage();
  const tasks = await storage.listTasksWithOptions({ blockedOnly: true });
  const tree = await buildTaskTree(storage, tasks, projectRoot);
  return { tree };
}

// --- Active ---

export async function handleActive(projectRoot: string) {
  const storage = await getOrCreateStorage();
  const tasks = await storage.listTasksWithOptions({ withSessionsOnly: true, nonTerminalOnly: true });
  const tree = await buildTaskTree(storage, tasks, projectRoot);
  return { tree };
}

// --- Show ---

export async function handleShow(projectRoot: string, params: Record<string, unknown>) {
  if (typeof params.taskId !== 'string' || !params.taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  const storage = await getOrCreateStorage();
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
}

// --- Search ---

export async function handleSearch(projectRoot: string, params: Record<string, unknown>) {
  if (typeof params.query !== 'string' || !params.query) {
    throw new RpcError(400, 'query is required');
  }

  const storage = await getOrCreateStorage();
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

  const storage = await getOrCreateStorage();
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
    // Worktree is gone — try to recover from local or remote branch
    const branchName = sess.git_branch;
    const config = await loadConfig(projectRoot);
    try {
      const recovery = await recoverMissingWorktreeWithFetch(
        worktreePath, branchName, config.remote.git_remote, projectRoot,
      );
      if (!recovery.recovered) {
        throw new RpcError(400,
          `Worktree is gone and branch '${branchName}' not found locally or on remote.`);
      }
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError(400,
        `Failed to recover worktree: ${err instanceof Error ? err.message : err}`);
    }
  }

  const full = params.full === true;

  // Prefer three-dot diff against parent branch — excludes upstream merges.
  // Fall back to two-dot from upstream_merge_sha when parent branch doesn't exist.
  let fromRef: string;
  let useTwoDotDiff = false;

  const parentBranch = task.parent_task_id
    ? await getBranchNameFromId(task.parent_task_id, storage)
    : await getCurrentBranch(projectRoot);

  if (await branchExists(parentBranch, worktreePath)) {
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
    const diff = await getDiffFull(fromRef, 'HEAD', worktreePath, useTwoDotDiff);
    if (!diff && !notesDiffSection) {
      output = 'No changes.';
    } else {
      const parts: string[] = [];
      if (diff) parts.push(diff);
      if (notesDiffSection) parts.push(notesDiffSection);
      output = parts.join('\n\n');
    }
  } else {
    const stat = await getDiffStat(fromRef, 'HEAD', worktreePath, useTwoDotDiff);
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
  const storage = await getOrCreateStorage();
  const resolveResult = await storage.resolveTask(params.taskId);
  if (!resolveResult.task) {
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const fullTaskId = resolveResult.task.id;
  const initialStatus = resolveResult.task.status;
  const initialTurnCount = await storage.getTurnCountByTaskId(fullTaskId);

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

    // Use the shared long-lived storage instance — no lock acquisition per poll
    const task = await storage.getTask(fullTaskId);
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
    const currentTurnCount = await storage.getTurnCountByTaskId(fullTaskId);
    if (currentTurnCount > initialTurnCount) {
      // Verify the latest turn is from the agent
      const sess = await storage.getSessionByTaskId(fullTaskId);
      if (sess) {
        const turns = await storage.getSessionTurns(sess.id);
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
  }

  // Timed out
  return {
    task_id: fullTaskId,
    status: 'working',
    timed_out: true,
  };
}

// --- Start Task ---

export async function handleStartTask(projectRoot: string, params: Record<string, unknown>) {
  const startParams: StartTaskParams = {
    taskId: params.taskId as string,
    modelOverride: params.modelOverride as string | undefined,
    agentId: params.agentId as string | undefined,
    forceLocal: params.forceLocal as boolean | undefined,
    retargetOrphan: params.retargetOrphan as boolean | undefined,
    effortOverride: params.effortOverride as string | undefined,
  };

  if (!startParams.taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  logger.info(`Starting task ${startParams.taskId.substring(0, 8)}`);
  return launchTask(projectRoot, startParams);
}

// --- Unblock Task ---

export async function handleUnblockTask(projectRoot: string, params: Record<string, unknown>) {
  const rawPermissionMode = params.permissionMode;
  let permissionMode: 'plan' | 'default' | undefined;
  if (rawPermissionMode !== undefined) {
    if (rawPermissionMode !== 'plan' && rawPermissionMode !== 'default') {
      throw new RpcError(400, `Invalid permissionMode: ${String(rawPermissionMode)}. Expected 'plan' or 'default'.`);
    }
    permissionMode = rawPermissionMode;
  }

  const unblockParams: UnblockTaskParams = {
    taskId: params.taskId as string,
    message: params.message as string,
    modelOverride: params.modelOverride as string | undefined,
    approvedFiles: params.approvedFiles as string[] | undefined,
    retargetOrphan: params.retargetOrphan as boolean | undefined,
    notesInEditor: params.notesInEditor as boolean | undefined,
    effortOverride: params.effortOverride as string | undefined,
    permissionMode,
  };

  if (!unblockParams.taskId) {
    throw new RpcError(400, 'taskId is required');
  }
  if (!unblockParams.message) {
    throw new RpcError(400, 'message is required');
  }

  logger.info(`Unblocking task ${unblockParams.taskId.substring(0, 8)}`);
  return launchUnblockTask(projectRoot, unblockParams);
}

// --- Ask Task (read-only Q&A against the session) ---

export async function handleAskTask(projectRoot: string, params: Record<string, unknown>) {
  const askParams: AskTaskParams = {
    taskId: params.taskId as string,
    message: params.message as string,
    effortOverride: params.effortOverride as string | undefined,
  };

  if (!askParams.taskId) throw new RpcError(400, 'taskId is required');
  if (!askParams.message) throw new RpcError(400, 'message is required');

  logger.info(`Asking task ${askParams.taskId.substring(0, 8)}`);
  return launchAskTask(projectRoot, askParams);
}

// --- Accept Task Preflight ---

export async function handleAcceptTaskPreflight(projectRoot: string, params: Record<string, unknown>) {
  const preflightParams: AcceptTaskPreflightParams = {
    taskId: params.taskId as string,
    approvedFiles: params.approvedFiles as string[] | undefined,
    acceptDirtyWorktree: params.acceptDirtyWorktree as boolean | undefined,
  };

  if (!preflightParams.taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  return acceptTaskPreflight(projectRoot, preflightParams);
}

// --- Accept Task (Full) ---

export async function handleAcceptTask(projectRoot: string, params: Record<string, unknown>) {
  const acceptParams: AcceptTaskParams = {
    taskId: params.taskId as string,
    reason: params.reason as string | undefined,
    approvedFiles: params.approvedFiles as string[] | undefined,
    acceptDirtyWorktree: params.acceptDirtyWorktree as boolean | undefined,
  };

  if (!acceptParams.taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  return acceptTask(projectRoot, acceptParams);
}

// --- Reject Task ---

export async function handleRejectTask(projectRoot: string, params: Record<string, unknown>) {
  const rejectParams: RejectTaskParams = {
    taskId: params.taskId as string,
    reason: params.reason as string,
    acceptDirtyWorktree: params.acceptDirtyWorktree as boolean | undefined,
  };

  if (!rejectParams.taskId) {
    throw new RpcError(400, 'taskId is required');
  }
  if (!rejectParams.reason) {
    throw new RpcError(400, 'reason is required');
  }

  return rejectTask(projectRoot, rejectParams);
}

// --- Close Task ---

export async function handleCloseTask(projectRoot: string, params: Record<string, unknown>) {
  const closeParams: CloseTaskParams = {
    taskId: params.taskId as string,
    reason: params.reason as string,
    acceptDirtyWorktree: params.acceptDirtyWorktree as boolean | undefined,
  };

  if (!closeParams.taskId) {
    throw new RpcError(400, 'taskId is required');
  }
  if (!closeParams.reason) {
    throw new RpcError(400, 'reason is required');
  }

  return closeTask(projectRoot, closeParams);
}

// --- Abandon Task ---

export async function handleAbandonTask(projectRoot: string, params: Record<string, unknown>) {
  const abandonParams: CloseTaskParams = {
    taskId: params.taskId as string,
    reason: params.reason as string,
    acceptDirtyWorktree: params.acceptDirtyWorktree as boolean | undefined,
  };

  if (!abandonParams.taskId) {
    throw new RpcError(400, 'taskId is required');
  }
  if (!abandonParams.reason) {
    throw new RpcError(400, 'reason is required');
  }

  return closeTask(projectRoot, abandonParams);
}

// --- Submit Task ---

export async function handleSubmitTask(projectRoot: string, params: Record<string, unknown>) {
  const submitParams: SubmitTaskParams = {
    taskId: params.taskId as string,
  };

  if (!submitParams.taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  return submitTask(projectRoot, submitParams);
}

// --- Resume Task ---

export async function handleResumeTask(projectRoot: string, params: Record<string, unknown>) {
  const resumeParams: ResumeTaskParams = {
    taskId: params.taskId as string,
    modelOverride: params.modelOverride as string | undefined,
    effortOverride: params.effortOverride as string | undefined,
  };

  if (!resumeParams.taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  logger.info(`Resuming task ${resumeParams.taskId.substring(0, 8)}`);
  return resumeTask(projectRoot, resumeParams);
}

// --- Sync Task ---

export async function handleSyncTask(projectRoot: string, params: Record<string, unknown>) {
  const syncParams: SyncTaskParams = {
    taskId: params.taskId as string,
  };

  if (!syncParams.taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  return syncTask(projectRoot, syncParams);
}

// --- Get Daemon MCP Config ---

export async function handleGetDaemonMcpConfig(projectRoot: string, params: Record<string, unknown>) {
  const name = (params.name as string) || `builder-${Date.now()}`;
  const config = await loadConfig(projectRoot);
  try {
    const configPath = await writeDaemonMcpConfig(projectRoot, name, config.data.path);
    return { configPath };
  } catch (err) {
    // Safety net: if writeDaemonMcpConfig hits an uninitialized daemon
    // context (web bind failed on startup), surface a 503 with a clear,
    // actionable message instead of the opaque "Daemon context not
    // initialized" internal error. Post-fix, startDaemonServer refuses to
    // start without a web port, so this path should only trigger for a
    // daemon built before the fix — but we keep the safety net in case a
    // future change reintroduces a partial-startup state.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Daemon context not initialized')) {
      throw new RpcError(
        503,
        'Daemon running in degraded mode: web port not bound. ' +
        'Restart the daemon after freeing the port: lazy daemon restart',
      );
    }
    throw err;
  }
}

// --- Storage proxy ---

/**
 * All Storage methods that can be called via RPC.
 * Each entry maps the method name to a function that extracts args and calls storage.
 */
const STORAGE_METHODS: Record<string, (storage: Storage, args: Record<string, unknown>) => Promise<unknown> | unknown> = {
  // Path accessors (synchronous)
  getStoragePath: (s) => s.getStoragePath(),
  getTaskDir: (s, a) => s.getTaskDir(a.taskId as string),

  // Tasks
  createTask: (s, a) => s.createTask(
    a.goal as string,
    a.parentTaskId as string | undefined,
    a.branchedFromSha as string | undefined,
    a.code as string | undefined,
    a.type as string | undefined,
    a.agentId as string | undefined,
  ),
  getTask: (s, a) => s.getTask(a.taskId as string),
  resolveTask: (s, a) => s.resolveTask(a.input as string),
  listTasks: (s) => s.listTasks(),
  listTasksWithOptions: (s, a) => s.listTasksWithOptions(a.options as any),
  updateTaskStatus: (s, a) => s.updateTaskStatus(a.taskId as string, a.status as any, a.actor as any),
  updateTaskGoal: (s, a) => s.updateTaskGoal(a.taskId as string, a.goal as string),
  updateTaskCode: (s, a) => s.updateTaskCode(a.taskId as string, a.code as string | null),
  updateTaskParent: (s, a) => s.updateTaskParent(a.taskId as string, a.parentTaskId as string | null),
  updateTaskBranchedFromSha: (s, a) => s.updateTaskBranchedFromSha(a.taskId as string, a.sha as string),
  updateTaskModel: (s, a) => s.updateTaskModel(a.taskId as string, a.model as string),
  updateTaskType: (s, a) => s.updateTaskType(a.taskId as string, a.type as string),
  resetTaskPendingSync: (s, a) => s.resetTaskPendingSync(a.taskId as string),
  incrementTaskPendingSync: (s, a) => s.incrementTaskPendingSync(a.taskId as string),
  abandonTask: (s, a) => s.abandonTask(a.taskId as string, a.reason as string, a.actor as any),
  reopenTask: (s, a) => s.reopenTask(a.taskId as string, a.actor as any),
  updateTaskMetadata: (s, a) => s.updateTaskMetadata(a.taskId as string, a.key as string, a.value as string),
  getTaskMetadata: (s, a) => s.getTaskMetadata(a.taskId as string, a.key as string),
  updateTaskPrompt: (s, a) => s.updateTaskPrompt(a.taskId as string, a.content as string, a.sessionId as string | undefined),
  getPromptHistory: (s, a) => s.getPromptHistory(a.taskId as string),
  getPromptVersion: (s, a) => s.getPromptVersion(a.taskId as string, a.version as number),

  // Sessions
  createSession: (s, a) => s.createSession(
    a.taskId as string,
    a.agentId as string,
    a.gitBranch as string,
    a.gitStartSha as string,
    a.claudeSessionId as string | undefined,
  ),
  getSession: (s, a) => s.getSession(a.sessionId as string),
  getSessionByTaskId: (s, a) => s.getSessionByTaskId(a.taskId as string),
  listSessions: (s, a) => s.listSessions(a.taskId as string | undefined, a.activeOnly as boolean | undefined),
  endSession: (s, a) => s.endSession(a.sessionId as string, a.outcome as any),
  resetSession: (s, a) => s.resetSession(a.sessionId as string),
  updateSessionClaudeId: (s, a) => s.updateSessionClaudeId(a.sessionId as string, a.claudeSessionId as string),
  updateSessionContainerName: (s, a) => s.updateSessionContainerName(a.sessionId as string, a.containerName as string | null),
  updateSessionInteraction: (s, a) => s.updateSessionInteraction(a.sessionId as string, a.durationMs as number),
  updateSessionUsage: (s, a) => s.updateSessionUsage(a.sessionId as string, a.usage as any),
  updateSessionUpstreamMergeSha: (s, a) => s.updateSessionUpstreamMergeSha(a.sessionId as string, a.sha as string),
  recordInterrupt: (s, a) => s.recordInterrupt(a.sessionId as string, a.diagnostics as any),
  resetConsecutiveInterruptions: (s, a) => s.resetConsecutiveInterruptions(a.sessionId as string),
  setAutoResumed: (s, a) => s.setAutoResumed(a.sessionId as string, a.autoResumed as boolean),

  // Turns
  createTurn: (s, a) => s.createTurn(a.options as any),
  getSessionTurns: (s, a) => s.getSessionTurns(a.sessionId as string),
  getNextTurnSequence: (s, a) => s.getNextTurnSequence(a.sessionId as string),
  getTurnCountByTaskId: (s, a) => s.getTurnCountByTaskId(a.taskId as string),
  updateTurnViolations: (s, a) => s.updateTurnViolations(a.taskId as string, a.turnId as string, a.violations as any),

  // Commits
  createCommit: (s, a) => s.createCommit(a.sessionId as string, a.sha as string, a.message as string),
  getSessionCommits: (s, a) => s.getSessionCommits(a.sessionId as string),

  // Reviews
  createReview: (s, a) => s.createReview(a.commitId as string, a.verdict as any, a.rationale as string, a.reviewer as string),
  getCommitReviews: (s, a) => s.getCommitReviews(a.commitId as string),

  // Worktree Snapshots
  createWorktreeSnapshot: (s, a) => s.createWorktreeSnapshot(a.sessionId as string, a.turnSequence as number, a.uncommittedDiff as string, a.gitStatus as string),
  getLatestWorktreeSnapshot: (s, a) => s.getLatestWorktreeSnapshot(a.sessionId as string),
  getWorktreeSnapshotForTurn: (s, a) => s.getWorktreeSnapshotForTurn(a.sessionId as string, a.turnSequence as number),

  // Task Tree
  getChildTasks: (s, a) => s.getChildTasks(a.parentTaskId as string),
  getRootTask: (s, a) => s.getRootTask(a.taskId as string),
  getTaskAncestry: (s, a) => s.getTaskAncestry(a.taskId as string),
  getTaskTree: (s, a) => s.getTaskTree(a.rootTaskId as string),

  // Comments
  createComment: (s, a) => s.createComment(a.taskId as string, a.content as string, a.actor as any, a.source as any),
  getTaskComments: (s, a) => s.getTaskComments(a.taskId as string),

  // Hunk approvals (per-hunk reviewed state for `lazy review -i`)
  listHunkApprovals: (s, a) => s.listHunkApprovals(a.taskId as string),
  createHunkApproval: (s, a) => s.createHunkApproval(a.taskId as string, a.hunkHash as string, a.actor as any, a.lineage as any),

  // Conversations
  saveConversation: (s, a) => s.saveConversation(a.conversation as any),
  loadConversation: (s, a) => s.loadConversation(a.sessionId as string),
  listConversations: (s) => s.listConversations(),
  isConversationImported: (s, a) => s.isConversationImported(a.sessionId as string),

  // Status History
  getStatusHistory: (s, a) => s.getStatusHistory(a.taskId as string),

  // Search
  search: (s, a) => s.search(a.query as string),
};

/**
 * Handle a generic Storage method call via RPC.
 *
 * Uses the daemon's long-lived Storage instance — no lock acquisition per call.
 * CLI processes never touch .storage-lock at all.
 */
export async function handleStorageCall(projectRoot: string, params: Record<string, unknown>) {
  const method = params.method as string;
  const args = (params.args as Record<string, unknown>) ?? {};

  if (!method || typeof method !== 'string') {
    throw new RpcError(400, 'Storage RPC requires a "method" parameter');
  }

  const handler = STORAGE_METHODS[method];
  if (!handler) {
    throw new RpcError(404, `Unknown storage method: ${method}`);
  }

  const storage = await getOrCreateStorage();
  const result = handler(storage, args);
  // Handle both sync (getStoragePath, getTaskDir) and async methods
  return result instanceof Promise ? await result : result;
}
