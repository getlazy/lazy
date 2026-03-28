/**
 * Daemon RPC handlers — execute command logic and return structured data.
 *
 * The daemon holds long-lived Storage instances per project (one per projectRoot).
 * All RPC handlers and the reconcile loop share the same instance via
 * `getOrCreateStorage()`. This makes the daemon the single writer — CLI commands
 * use RemoteStorage and never touch .storage-lock.
 *
 * Handlers must NOT:
 * - Call process.exit()
 * - Write to stdout/stderr
 * - Import CLI rendering/theme modules
 * - Call storage.close() — the daemon owns the Storage lifecycle
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

/**
 * Long-lived Storage instances keyed by project root.
 *
 * The daemon is single-threaded (Bun's event loop), so concurrent RPC calls
 * are serialized naturally — no explicit mutex is needed. Async operations
 * may interleave, but FileStorage uses file-level locking internally for
 * individual operations, so this is safe.
 */
const storageRegistry = new Map<string, Storage>();

/**
 * Get or create a long-lived Storage instance for a project.
 * The instance stays open for the lifetime of the daemon process.
 */
export async function getOrCreateStorage(projectRoot: string): Promise<Storage> {
  let storage = storageRegistry.get(projectRoot);
  if (!storage) {
    const config = loadConfig(projectRoot, { cwd: projectRoot });
    storage = await createStorage(projectRoot, {
      backend: config.storage.backend as StorageBackend,
      externalPath: config.storage.external_path || undefined,
    });
    storageRegistry.set(projectRoot, storage);
  }
  return storage;
}

/**
 * Close all long-lived Storage instances. Called on daemon shutdown.
 */
export async function closeAllStorage(): Promise<void> {
  for (const [projectRoot, storage] of storageRegistry) {
    try {
      await storage.close();
    } catch {
      // Best-effort cleanup on shutdown
    }
  }
  storageRegistry.clear();
}

/**
 * Open a fresh, short-lived Storage instance for a project.
 * Used by tests to verify data independently of the shared registry.
 * Not used by daemon handlers — they use getOrCreateStorage() instead.
 */
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
  const storage = await getOrCreateStorage(projectRoot);
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
  const storage = await getOrCreateStorage(projectRoot);
  const tasks = await storage.listTasksWithOptions({ blockedOnly: true });
  const tree = await buildTaskTree(storage, tasks, projectRoot);
  return { tree };
}

// --- Active ---

export async function handleActive(projectRoot: string) {
  const storage = await getOrCreateStorage(projectRoot);
  const tasks = await storage.listTasksWithOptions({ withSessionsOnly: true, nonTerminalOnly: true });
  const tree = await buildTaskTree(storage, tasks, projectRoot);
  return { tree };
}

// --- Show ---

export async function handleShow(projectRoot: string, params: Record<string, unknown>) {
  if (typeof params.taskId !== 'string' || !params.taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  const storage = await getOrCreateStorage(projectRoot);
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

  const storage = await getOrCreateStorage(projectRoot);
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

  const storage = await getOrCreateStorage(projectRoot);
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
  const storage = await getOrCreateStorage(projectRoot);
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
  closeTask: (s, a) => s.closeTask(a.taskId as string, a.closeReason as string, a.actor as any),
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

  const storage = await getOrCreateStorage(projectRoot);
  const result = handler(storage, args);
  // Handle both sync (getStoragePath, getTaskDir) and async methods
  return result instanceof Promise ? await result : result;
}
