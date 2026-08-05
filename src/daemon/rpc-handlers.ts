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
import { getAuthEnvVars } from '../capture/claude';
import { credentialFromEnv } from './credential-gate';
import { createStorage, type Storage, type StorageBackend } from '../storage';
import type { Task, SearchResult } from '../storage';
import type { SpanRecord } from '../tracing/types';
import { withRootSpan, contextFromTraceparent } from '../tracing';
import type { TaskTarget, Actor } from '../types';
import type { RunnerType } from '../config/types';
import { parentTaskIdOf, targetBranchOf, collectSubtreeIds } from '../task-target';
import { buildTaskTree, collectActiveTasks } from '../cli/commands/list';
import { loadTaskShowData } from '../cli/commands/show';
import { isStructuredQuery, structuredSearch, buildTagHint } from '../search';
import { getDiffStat, getDiffFull, getRemoteDefaultBranch, branchExists, recoverMissingWorktreeWithFetch } from '../git/operations';
import { getNewNotesSince } from '../cli/commands/shared';
import { getWorktreePath, getBranchNameFromId, displayId, formatDate, shortId } from '../cli/helpers';
import { launchTask, writeDaemonMcpConfig, type StartTaskParams } from './task-launcher';
import { revokeBuilderMcpToken } from './mcp-tokens';
import { hasDaemonContext, getDaemonContext } from './context';
import type { ProgressEmitter } from './progress';
import { proxyBaseUrlForRunner } from '../utils/role-target';
import { launchUnblockTask, launchAskTask, rejectTask, closeTask, stopTask, acceptTaskPreflight, acceptTask, approveTaskPreflight, approveTask, syncTask, reparentTask, submitTask, resumeTask, type UnblockTaskParams, type AskTaskParams, type RejectTaskParams, type CloseTaskParams, type StopTaskParams, type AcceptTaskPreflightParams, type AcceptTaskParams, type ApproveTaskParams, type SyncTaskParams, type ReparentTaskParams, type SubmitTaskParams, type ResumeTaskParams } from './task-lifecycle';
import type { Comment } from '../types';
import { logger } from '../utils/logger';
import { createRunner } from '../runner';
import {
  countActiveAgents,
  effectiveAgentLimit,
  effectiveBuilderLimit,
  getLimitOverride,
  setLimitOverride,
  LIMIT_KEYS,
  type LimitKey,
} from './concurrency';

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

/**
 * In-flight initialization promise. Memoized so concurrent first-callers (e.g.
 * the web handler, the proxy, and a reconcile tick all racing at startup) share
 * ONE createStorage()+lock.acquire() instead of each spinning up its own Storage
 * instance and contending for the filesystem lock. Without this, the proxy path
 * would initialize a second Storage that fights the daemon's own for the lock —
 * the single-writer violation behind the "Failed to acquire storage lock"
 * startup crash. Reset to null on failure so a later tick can retry.
 */
let daemonStorageInit: Promise<Storage> | null = null;

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
  if (daemonStorage) return daemonStorage;
  // Memoize the in-flight init so concurrent first-callers share ONE Storage
  // instance (see daemonStorageInit above). The check-then-await in the old code
  // let two racing callers both pass `!daemonStorage` and each create their own.
  if (!daemonStorageInit) {
    const root = daemonProjectRoot;
    daemonStorageInit = (async () => {
      logger.debug('Initializing daemon storage...');
      const config = await loadConfig(root);
      const storage = await createStorage(root, {
        backend: config.storage.backend as StorageBackend,
        externalPath: config.storage.external_path || undefined,
      });
      // Acquire storage lock once and hold forever. The daemon is the sole writer
      // (CLI uses RemoteStorage, agents run in containers with their own data dir).
      // All FileStorage.withLock() calls become re-entrant within this process.
      await (storage as any).lock?.acquire?.();
      daemonStorage = storage;
      // debug, not info: this is internal storage-lifecycle chatter. In the daemon
      // it's captured in the debug-level file log. Under the LAZY_TEST in-process
      // fallback (see requireStorage) this runs INSIDE the CLI process, where an
      // info-level line would print to the command's stdout and corrupt machine-
      // readable output (e.g. `lazy show --json`). Production CLIs never reach here
      // — they use RemoteStorage — so demoting it costs the daemon nothing.
      logger.debug(`Daemon storage initialized (backend: ${config.storage.backend})`);
      return storage;
    })().catch((err) => {
      // Clear the memo so a later caller (e.g. the next reconcile tick, once a
      // contending lock holder releases) can retry — but surface THIS failure.
      daemonStorageInit = null;
      throw err;
    });
  }
  return daemonStorageInit;
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
  // Clear the init memo too, so a subsequent start (e.g. a teardown/retry in the
  // same process during tests) re-initializes cleanly instead of returning a
  // closed instance.
  daemonStorageInit = null;
}

/**
 * Open a fresh, short-lived Storage instance for a project.
 * Used by tests to verify data independently of the shared instance.
 * Not used by daemon RPC handlers — they use getOrCreateStorage() instead.
 */
export async function openProjectStorage(projectRoot: string): Promise<Storage> {
  // Resolve config relative to projectRoot, NOT the ambient process.cwd().
  // loadConfig defaults its search to process.cwd(); a caller running from a
  // different directory (e.g. an in-process test whose cwd is the dev repo, or
  // any tool invoked outside the target project) would otherwise pick up the
  // WRONG project's lazy.toml — resolving external_path to a foreign storage
  // path. This function takes an explicit root, so config must follow it.
  const config = await loadConfig(projectRoot, { cwd: projectRoot });
  return createStorage(projectRoot, {
    backend: config.storage.backend as StorageBackend,
    externalPath: config.storage.external_path || undefined,
  });
}

/**
 * Dispatch an RPC request to the appropriate handler.
 *
 * `progress` is the caller's phase-narration sink (see ./progress.ts). Only
 * long, multi-phase commands use it; everything else ignores it, which is why
 * it is threaded rather than made part of `params` — it is a live callback into
 * the response stream, not a serializable request field.
 */
export async function handleRpc(
  command: string,
  projectRoot: string,
  params: Record<string, unknown>,
  progress?: ProgressEmitter,
): Promise<unknown> {
  if (!existsSync(projectRoot)) {
    throw new RpcError(400, `Project root does not exist: ${projectRoot}`);
  }

  switch (command) {
    case 'list': return handleList(projectRoot, params);
    case 'blocked': return handleBlocked(projectRoot);
    case 'active': return handleActive(projectRoot, params);
    case 'show': return handleShow(projectRoot, params);
    case 'search': return handleSearch(projectRoot, params);
    case 'diff': return handleDiff(projectRoot, params);
    case 'wait': return handleWait(projectRoot, params);
    case 'startTask': return handleStartTask(projectRoot, params);
    case 'unblockTask': return handleUnblockTask(projectRoot, params);
    case 'askTask': return handleAskTask(projectRoot, params);
    case 'acceptTaskPreflight': return handleAcceptTaskPreflight(projectRoot, params);
    case 'acceptTask': return handleAcceptTask(projectRoot, params, progress);
    case 'approveTaskPreflight': return handleApproveTaskPreflight(projectRoot, params);
    case 'approveTask': return handleApproveTask(projectRoot, params);
    case 'rejectTask': return handleRejectTask(projectRoot, params);
    case 'closeTask': return handleCloseTask(projectRoot, params);
    case 'stopTask': return handleStopTask(projectRoot, params);
    case 'submitTask': return handleSubmitTask(projectRoot, params);
    case 'resumeTask': return handleResumeTask(projectRoot, params);
    case 'syncTask': return handleSyncTask(projectRoot, params);
    case 'reparentTask': return handleReparentTask(projectRoot, params);
    case 'concurrency': return handleConcurrency(projectRoot, params);
    case 'getDaemonMcpConfig': return handleGetDaemonMcpConfig(projectRoot, params);
    case 'revokeDaemonMcpToken': return handleRevokeDaemonMcpToken(projectRoot, params);
    case 'getAuthEnv': return handleGetAuthEnv(projectRoot, params);
    case 'getCredentialState': return handleGetCredentialState(projectRoot, params);
    case 'storage': return handleStorageCall(projectRoot, params);
    default: throw new RpcError(404, `Unknown RPC command: ${command}`);
  }
}

// --- List ---

/**
 * Restrict `tasks` to the subtree rooted at the task `taskFilter` resolves to
 * (the task itself plus every descendant). The subtree is computed against ALL
 * tasks so a terminal task in the middle of the hierarchy can't hide its still
 * non-terminal descendants from a filtered view.
 *
 * Throws a 404 when nothing matches, and a 400 listing the candidates when the
 * input is ambiguous — the caller sees the same actionable guidance the CLI
 * gives for any other task reference.
 */
async function filterToSubtree(storage: Storage, tasks: Task[], taskFilter: string): Promise<Task[]> {
  const result = await storage.resolveTask(taskFilter);
  if (!result.task) {
    if (result.ambiguousMatches && result.ambiguousMatches.length > 0) {
      const options = result.ambiguousMatches
        .map(t => `  ${shortId(t.id)}  ${t.status.padEnd(12)}  ${t.goal}`)
        .join('\n');
      throw new RpcError(400, `Multiple tasks match '${taskFilter}'. Use the ID to disambiguate:\n${options}`);
    }
    throw new RpcError(404, `Task not found: ${taskFilter}`);
  }

  const allowedIds = collectSubtreeIds(result.task.id, await storage.listTasks());
  return tasks.filter(t => allowedIds.has(t.id));
}

export async function handleList(projectRoot: string, params: Record<string, unknown>) {
  const storage = await getOrCreateStorage();
  const all = params.all === true;
  let tasks = all
    ? await storage.listTasks()
    : await storage.listTasksWithOptions({ nonTerminalOnly: true });

  if (typeof params.taskFilter === 'string' && params.taskFilter) {
    tasks = await filterToSubtree(storage, tasks, params.taskFilter);
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

export async function handleActive(projectRoot: string, params: Record<string, unknown> = {}) {
  const storage = await getOrCreateStorage();
  let tasks = await collectActiveTasks(storage);

  // Optional subtree filter: show only the given task and its descendants.
  if (typeof params.taskFilter === 'string' && params.taskFilter) {
    tasks = await filterToSubtree(storage, tasks, params.taskFilter);
  }

  const tree = await buildTaskTree(storage, tasks, projectRoot);
  return { tree };
}

// --- Concurrency limits (get / set / reset ephemeral overrides) ---

/**
 * Report and (optionally) mutate the daemon's concurrency caps.
 *
 * `action`:
 *   - 'get' (default): report both caps — configured value, ephemeral override,
 *     effective limit, and current running count.
 *   - 'set':   set an ephemeral override for `params.key` to `params.value`.
 *   - 'reset': clear the ephemeral override for `params.key`.
 *
 * Overrides live only in this daemon process (lost on restart) — this handler
 * NEVER writes lazy.toml. See src/daemon/concurrency.ts.
 */
export async function handleConcurrency(projectRoot: string, params: Record<string, unknown>) {
  const action = (params.action as string) ?? 'get';

  if (action === 'set' || action === 'reset') {
    const key = params.key as LimitKey;
    if (!LIMIT_KEYS.includes(key)) {
      throw new RpcError(400, `Unknown limit key '${String(params.key)}'. Valid keys: ${LIMIT_KEYS.join(', ')}.`);
    }
    if (action === 'reset') {
      setLimitOverride(key, undefined);
    } else {
      const value = Number(params.value);
      if (!Number.isInteger(value) || value < 1) {
        throw new RpcError(400, `Value must be a positive integer, got '${String(params.value)}'.`);
      }
      setLimitOverride(key, value);
    }
  } else if (action !== 'get') {
    throw new RpcError(400, `Unknown concurrency action '${action}'. Valid: get, set, reset.`);
  }

  const config = await loadConfig(projectRoot);
  const storage = await getOrCreateStorage();
  const agentRunning = await countActiveAgents(storage);

  // Builder containers launch client-side and have no storage entity — count the
  // live ones via the runner. If the runner is unavailable (e.g. Docker down),
  // the count is unknown; report 0 so `config get` still works rather than
  // failing the whole call (the caller is asking about limits, not launching).
  let builderRunning = 0;
  try {
    const runner = await createRunner(projectRoot);
    builderRunning = (await runner.discoverProjectBuilderRuns(projectRoot)).length;
  } catch (err) {
    logger.debug(`Concurrency: could not count builders: ${err instanceof Error ? err.message : err}`);
  }

  return {
    agents: {
      configured: config.limits.max_concurrent_agents,
      override: getLimitOverride('max_concurrent_agents') ?? null,
      limit: effectiveAgentLimit(config),
      running: agentRunning,
    },
    builders: {
      configured: config.limits.max_concurrent_builders,
      override: getLimitOverride('max_concurrent_builders') ?? null,
      limit: effectiveBuilderLimit(config),
      running: builderRunning,
    },
  };
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
      // Return ambiguous matches so CLI can handle disambiguation.
      // last_interaction_at is part of the payload because it is what actually
      // tells the two apart for a human ("the one I was working on this
      // morning") — the same field resolveTaskOrExit shows for every other
      // command. Falls back to created_at for a task that was never started.
      const matches = [];
      for (const t of result.ambiguousMatches) {
        const session = await storage.getSessionByTaskId(t.id);
        matches.push({
          id: t.id,
          code: t.code,
          goal: t.goal,
          status: t.status,
          lastInteractionAt: session?.last_interaction_at ?? t.created_at,
        });
      }
      return { ambiguous: true, matches };
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
    journal: data.journal,
    followUps: data.followUps,
    statusHistory: data.statusHistory,
    tagHistory: data.tagHistory,
    children: data.children,
    childSessions: Object.fromEntries(data.childSessions.entries()),
    parent: data.parent,
    retryStatus: data.retryStatus,
    orphanStatus: data.orphanStatus,
    autoReactStatus: data.autoReactStatus,
    supervisorStatus: data.supervisorStatus,
    workingSubstate: data.workingSubstate,
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

  // A tag query that matches nothing is indistinguishable from a typo, a
  // never-applied tag, or an unquoted multi-word value — say which it is.
  // Structured queries only: the fuzzy and regex paths never parse `tag:`.
  let hint: string | null = null;
  if (results.length === 0 && !fuzzy && isStructuredQuery(query)) {
    hint = await buildTagHint(storage, query);
  }

  return { query, results, ...(hint ? { hint } : {}) };
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

  const parentId = parentTaskIdOf(task);
  // Top-level task: derive the diff base from the task's own integration
  // target — NOT from whatever branch the user currently has checked out.
  // Adopting the current branch here would compute diff stats against an
  // unrelated tip and silently mis-report what the task changed. Fall back
  // to the repo default only when the task target is the unresolved sentinel.
  const diffConfig = await loadConfig(projectRoot);
  const parentBranch = parentId
    ? await getBranchNameFromId(parentId, storage)
    : (targetBranchOf(task) ?? await getRemoteDefaultBranch(projectRoot, diffConfig.remote.git_remote));

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

  // A task that was never started has nothing to wait for and never will —
  // say so, instead of reporting "now backlog" and a bare non-zero exit. The
  // CLI gave this guidance before `lazy wait` became a thin RPC wrapper.
  const waitSession = await storage.getSessionByTaskId(fullTaskId);
  if (!waitSession) {
    const ref = displayId(resolveResult.task);
    throw new RpcError(400, `Task ${ref} has no session. Start it with: lazy start ${ref}`);
  }

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
    runnerOverride: params.runnerOverride as RunnerType | undefined,
    actor: params.actor as Actor | undefined,
  };

  if (!startParams.taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  logger.info(`Starting task ${startParams.taskId.substring(0, 8)}`);

  // Root span for the whole start request. Stitches under the caller's trace
  // when a `traceparent` was propagated (CLI → daemon); otherwise starts a new
  // trace. This is the "request received" boundary on the daemon side.
  const parentCtx = contextFromTraceparent(params.traceparent as string | undefined);
  return withRootSpan('lazy.start', parentCtx, {
    'lazy.command': 'start',
    'lazy.task_id': startParams.taskId,
  }, () => launchTask(projectRoot, startParams));
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
    actor: params.actor as Actor | undefined,
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
    actor: params.actor as Actor | undefined,
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

export async function handleAcceptTask(
  projectRoot: string,
  params: Record<string, unknown>,
  progress?: ProgressEmitter,
) {
  const acceptParams: AcceptTaskParams = {
    taskId: params.taskId as string,
    reason: params.reason as string | undefined,
    approvedFiles: params.approvedFiles as string[] | undefined,
    acceptDirtyWorktree: params.acceptDirtyWorktree as boolean | undefined,
    actor: params.actor as Actor | undefined,
    callerTaskId: params.callerTaskId as string | undefined,
    onProgress: progress,
  };

  if (!acceptParams.taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  return acceptTask(projectRoot, acceptParams);
}

// --- Approve Task (edge-gate human approval) ---

export async function handleApproveTaskPreflight(projectRoot: string, params: Record<string, unknown>) {
  const taskId = params.taskId as string;
  if (!taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  return approveTaskPreflight(projectRoot, { taskId });
}

export async function handleApproveTask(projectRoot: string, params: Record<string, unknown>) {
  const approveParams: ApproveTaskParams = {
    taskId: params.taskId as string,
    token: params.token as string,
  };

  if (!approveParams.taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  return approveTask(projectRoot, approveParams);
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

// --- Stop Task ---

export async function handleStopTask(projectRoot: string, params: Record<string, unknown>) {
  const stopParams: StopTaskParams = {
    taskId: params.taskId as string,
    reason: params.reason as string,
    actor: params.actor as Actor | undefined,
  };
  if (!stopParams.taskId) {
    throw new RpcError(400, 'taskId is required');
  }
  if (!stopParams.reason || !stopParams.reason.trim()) {
    throw new RpcError(400, 'reason is required');
  }
  return stopTask(projectRoot, stopParams);
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
    actor: params.actor as Actor | undefined,
  };

  if (!syncParams.taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  return syncTask(projectRoot, syncParams);
}

// --- Reparent Task ---

export async function handleReparentTask(projectRoot: string, params: Record<string, unknown>) {
  const reparentParams: ReparentTaskParams = {
    taskId: params.taskId as string,
    parent: params.parent as string,
  };

  if (!reparentParams.taskId) {
    throw new RpcError(400, 'taskId is required');
  }
  if (!reparentParams.parent) {
    throw new RpcError(400, 'parent is required');
  }

  return reparentTask(projectRoot, reparentParams);
}

// --- Get Daemon MCP Config ---

export async function handleGetDaemonMcpConfig(projectRoot: string, params: Record<string, unknown>) {
  const name = (params.name as string) || `builder-${Date.now()}`;
  try {
    // Builder identity: no task id. A builder token is refused on any
    // task-scoped MCP claim, and a task token is refused on the builder
    // surface — see src/daemon/mcp-tokens.ts.
    const configPath = await writeDaemonMcpConfig(projectRoot, name, { kind: 'builder' });
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

/**
 * Revoke the MCP token minted for one builder session.
 *
 * The counterpart to handleGetDaemonMcpConfig: `lazy builder` asks for a config
 * before launching the builder container and calls this once the builder
 * supervisor has exited. Revocation MUST happen in the daemon process rather
 * than by editing the registry file from the CLI — the daemon caches the
 * registry in memory and only re-reads it on a token MISS, so a file edited
 * behind its back would leave the revoked token still accepted.
 */
export async function handleRevokeDaemonMcpToken(projectRoot: string, params: Record<string, unknown>) {
  const name = params.name as string;
  if (!name) {
    throw new RpcError(400, 'name is required');
  }
  const revoked = await revokeBuilderMcpToken(projectRoot, name);
  return { revoked };
}

// --- Get Auth Env ---

/**
 * Return the model auth credential from the DAEMON's environment.
 *
 * The daemon is the single owner of credentials (see credential-gate.ts): it
 * refuses to start without one, so by the time it can answer this RPC it is
 * guaranteed to hold a usable token (or be Ollama-backed, which needs none).
 *
 * Client-side launch paths that spawn their OWN containers — notably
 * `lazy builder`, which the CLI client launches directly rather than through
 * the daemon — must source the credential here instead of from their own
 * `process.env`. The user's interactive shell legitimately has no credential
 * in daemon-only-env deployments; reading the client env would wrongly fail
 * with "Authentication required".
 *
 * Secrets hygiene: the value crosses the local, token-authenticated unix
 * socket only and is never logged.
 */
export async function handleGetAuthEnv(projectRoot: string, _params: Record<string, unknown>) {
  // Returns the bare Anthropic credential from the daemon process env. Callers
  // (resolveAuthEnvFromDaemon) wrap it for their resolved role target — e.g. a
  // proxy target layers its base URL on top. Ollama-backed roles need no
  // credential and derive their dummy env client-side without this RPC.
  //
  // Reads the daemon process env. Throws an actionable error if absent, but the
  // credential gate makes that practically unreachable for a running daemon.
  //
  // Also returns the daemon's live proxy base URL (with the actual bound port)
  // when the proxy is running, so a CLI-client launch (e.g. `lazy builder`) can
  // fill in a `backend = "proxy"` role that omitted `endpoint` — the client has
  // no daemon context of its own to read the OS-assigned port from.
  let proxyBaseUrl: string | undefined;
  const proxyPort = hasDaemonContext() ? getDaemonContext().proxyPort : undefined;
  if (proxyPort) {
    const config = await loadConfig(projectRoot, { cwd: projectRoot });
    if (config.proxy) {
      proxyBaseUrl = proxyBaseUrlForRunner(config.runner.type, proxyPort, config.proxy.bind);
    }
  }
  // Omit proxyBaseUrl entirely when absent (no proxy) — don't send an `undefined`
  // field over the wire, and keep the shape stable for callers that don't proxy.
  return { authEnvVars: getAuthEnvVars(), ...(proxyBaseUrl ? { proxyBaseUrl } : {}) };
}

// --- Get Credential State ---

/**
 * Report WHETHER the daemon holds a model credential, and from which env var —
 * never the credential itself.
 *
 * Diagnostics (`lazy doctor`) need to answer "does lazy have a credential?",
 * and the only environment that matters is the DAEMON's: it is the single owner
 * (credential-gate.ts) and every agent it launches inherits its env. Reading
 * the CLI's own `process.env` answers a different question and gets it wrong in
 * both directions — a daemon-only-env deployment reads as "not authenticated"
 * while everything works, and a stale token in the user's shell reads as
 * healthy auth the daemon does not have.
 *
 * Deliberately NOT `getAuthEnv`: that ships the actual token to the client,
 * which is correct for a launch that must inject it and wrong for a report that
 * only needs a boolean and a label. Nothing that merely describes auth should
 * move the secret.
 *
 * PRESENCE, NOT VALIDITY — same contract as the gate. "Upstream accepts this
 * credential" is a separate question answered from the audit trail (see
 * `checkCredentialAccepted` in doctor).
 */
export async function handleGetCredentialState(projectRoot: string, _params: Record<string, unknown>) {
  const config = await loadConfig(projectRoot, { cwd: projectRoot });
  const source = credentialFromEnv();
  return {
    present: source !== null,
    // The env var NAME (e.g. CLAUDE_CODE_OAUTH_TOKEN), never its value.
    source,
    // Ollama-backed setups talk to a local model with dummy credentials, so
    // "no Anthropic token" is healthy rather than a finding — same carve-out
    // the credential gate makes.
    ollama: config.ollama.enabled,
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
  updateTaskTarget: (s, a) => s.updateTaskTarget(a.taskId as string, a.target as TaskTarget),
  updateTaskBranchedFromSha: (s, a) => s.updateTaskBranchedFromSha(a.taskId as string, a.sha as string),
  updateTaskModel: (s, a) => s.updateTaskModel(a.taskId as string, a.model as string),
  updateTaskRunnerType: (s, a) => s.updateTaskRunnerType(a.taskId as string, a.runnerType as RunnerType | null),
  updateTaskType: (s, a) => s.updateTaskType(a.taskId as string, a.type as string),
  updateTaskPriority: (s, a) => s.updateTaskPriority(a.taskId as string, a.priority as string),
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
  updateSessionRunnerType: (s, a) => s.updateSessionRunnerType(a.sessionId as string, a.runnerType as RunnerType | null),
  updateSessionInteraction: (s, a) => s.updateSessionInteraction(a.sessionId as string, a.durationMs as number),
  updateSessionUsage: (s, a) => s.updateSessionUsage(a.sessionId as string, a.usage as any),
  updateSessionUpstreamMergeSha: (s, a) => s.updateSessionUpstreamMergeSha(a.sessionId as string, a.sha as string),
  recordInterrupt: (s, a) => s.recordInterrupt(a.sessionId as string, a.diagnostics as any),
  resetConsecutiveInterruptions: (s, a) => s.resetConsecutiveInterruptions(a.sessionId as string),
  setAutoResumed: (s, a) => s.setAutoResumed(a.sessionId as string, a.autoResumed as boolean),
  setUserStopped: (s, a) => s.setUserStopped(a.sessionId as string, a.userStopped as boolean),

  // Turns
  createTurn: (s, a) => s.createTurn(a.options as any),
  getSessionTurns: (s, a) => s.getSessionTurns(a.sessionId as string),
  getNextTurnSequence: (s, a) => s.getNextTurnSequence(a.sessionId as string),
  getTurnCountByTaskId: (s, a) => s.getTurnCountByTaskId(a.taskId as string),
  updateTurnViolations: (s, a) => s.updateTurnViolations(a.taskId as string, a.turnId as string, a.violations as any),
  markFeedbackConsumed: (s, a) => s.markFeedbackConsumed(a.sessionId as string),

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

  // Journal (append-only, prompt-immune side channel — never wired into prompt assembly)
  appendJournalEntry: (s, a) => s.appendJournalEntry(a.taskId as string, a.content as string, a.actor as any),
  getTaskJournal: (s, a) => s.getTaskJournal(a.taskId as string),

  // Follow-ups (task-level orthogonal-work discoveries)
  createFollowUp: (s, a) => s.createFollowUp(a.taskId as string, a.content as string, a.sessionId as string | null),
  getTaskFollowUps: (s, a) => s.getTaskFollowUps(a.taskId as string),

  // Hunk approvals (per-hunk reviewed state for `lazy review -i`)
  listHunkApprovals: (s, a) => s.listHunkApprovals(a.taskId as string),
  createHunkApproval: (s, a) => s.createHunkApproval(a.taskId as string, a.hunkHash as string, a.actor as any, a.lineage as any),

  // Conversations
  saveConversation: (s, a) => s.saveConversation(a.conversation as any),
  loadConversation: (s, a) => s.loadConversation(a.sessionId as string),
  listConversations: (s) => s.listConversations(),
  isConversationImported: (s, a) => s.isConversationImported(a.sessionId as string),
  deleteConversation: (s, a) => s.deleteConversation(a.sessionId as string),

  // Agent session logs (raw Claude Code JSONL)
  saveAgentSessionLog: (s, a) => s.saveAgentSessionLog(a.taskId as string, a.sessionId as string, a.content as string),
  getAgentSessionLog: (s, a) => s.getAgentSessionLog(a.taskId as string),

  // Builder resume intents (durable upgrade↔builder handshake)
  saveBuilderResumeIntent: (s, a) => s.saveBuilderResumeIntent(a.intent as any),
  takeBuilderResumeIntent: (s, a) => s.takeBuilderResumeIntent(a.builderId as string),
  listBuilderResumeIntents: (s, a) => s.listBuilderResumeIntents(a.projectRoot as string | undefined),

  // Tags
  addTaskTag: (s, a) => s.addTaskTag(a.taskId as string, a.tag as string, a.actor as any),
  removeTaskTag: (s, a) => s.removeTaskTag(a.taskId as string, a.tag as string, a.actor as any),
  getTagHistory: (s, a) => s.getTagHistory(a.taskId as string),

  // Memory (lazy-owned shared knowledge; append-only, actor-attributed history)
  saveMemory: (s, a) => s.saveMemory(a.input as any, a.actor as any),
  getMemory: (s, a) => s.getMemory(a.name as string),
  listMemories: (s, a) => s.listMemories(a.options as any),
  deleteMemory: (s, a) => s.deleteMemory(a.name as string, a.actor as any),
  getMemoryHistory: (s, a) => s.getMemoryHistory(a.name as string | undefined),

  // Memory compact (derived; regenerated from the records, never from itself)
  saveMemoryCompact: (s, a) => s.saveMemoryCompact(a.input as any, a.actor as any),
  getMemoryCompact: (s) => s.getMemoryCompact(),
  clearMemoryCompact: (s) => s.clearMemoryCompact(),

  // Status History
  getStatusHistory: (s, a) => s.getStatusHistory(a.taskId as string),

  // Search
  search: (s, a) => s.search(a.query as string),

  // Tracing
  appendTraceSpans: (s, a) => s.appendTraceSpans(a.spans as SpanRecord[]),
  readTraceSpans: (s, a) => s.readTraceSpans(a.sinceMs as number | undefined),
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
