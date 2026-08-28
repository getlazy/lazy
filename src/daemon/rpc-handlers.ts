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
import { randomUUID } from 'crypto';
import { RpcError } from './rpc-error';
import {
  requireString,
  requireNonBlankString,
  optionalString,
  optionalBoolean,
  optionalNumber,
  optionalStringArray,
  optionalEnum,
} from './rpc-params';
import {
  handleReviewQueue,
  handleReviewDiff,
  handleReviewComments,
  handleReviewPostComment,
  handleReviewRetryAsk,
  handleReviewWithdrawComment,
  handleReviewUnblock,
  handleReviewAccept,
  handleReviewSync,
  handleReviewViolationDecision,
} from './rpc-review';
import { loadConfig } from '../config/loader';
import { getAuthEnvVars } from '../capture/claude';
import { credentialFromEnv } from './credential-gate';
import { createStorage, type Storage, type StorageBackend } from '../storage';
import type { Task, SearchResult } from '../storage';
import type { SpanRecord } from '../tracing/types';
import { withRootSpan, contextFromTraceparent } from '../tracing';
import type { TaskTarget, Actor } from '../types';
import type { RunnerType } from '../config/types';
import { parentTaskIdOf, targetBranchOf, collectSubtreeIds, pruneTasksToDepth } from '../task-target';
import { buildTaskTree, collectActiveTasks } from '../cli/commands/list';
import { loadTaskShowData } from '../cli/commands/show';
import { isStructuredQuery, structuredSearch, buildTagHint } from '../search';
import { getDiffStat, getDiffFull, getRemoteDefaultBranch, branchExists, recoverMissingWorktreeWithFetch } from '../git/operations';
import { getNewNotesSince } from '../cli/commands/shared';
import { getWorktreePath, getBranchNameFromId, displayId, formatDate, shortId, taskRef } from '../cli/helpers';
import { readWorktreeMergeState, isMidMerge, describeMergeState } from '../git/operations';
import { pathExists } from '../utils/fs';
import { saveConversationWithoutRegression } from '../import/conversation-storage';
import { launchTask, writeDaemonMcpConfig, type StartTaskParams } from './task-launcher';
import { raceWait, normalizeWaitInputs } from './wait-race';
import { revokeBuilderMcpToken } from './mcp-tokens';
import { hasDaemonContext, getDaemonContext } from './context';
import type { ProgressEmitter } from './progress';
import { handleWatchProxyActivity } from './proxy-watch';
import { proxyBaseUrlForRunner, LOCAL_BACKEND_CREDS } from '../utils/role-target';
import { placeholderizeAuthEnv, type LaunchIdentity } from '../proxy/placeholder-env';
import { revokeBuilderCredentialGrant } from '../proxy/credential-broker';
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

// RpcError now lives in ./rpc-error so the input-validation helpers can raise
// it without importing this module. Re-exported here: every existing importer
// takes it from rpc-handlers.
export { RpcError };

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
    case 'blocked': return handleBlocked(projectRoot, params);
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
    case 'watchProxyActivity': return handleWatchProxyActivity(await resolveActivityFilterParams(params), progress);
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
    // The review surface. In-process this port is injected straight into the
    // daemon's own web handler; these commands are the same port over the wire,
    // for a client that is not the daemon (a from-source web UI, a remote one).
    case 'reviewQueue': return handleReviewQueue(projectRoot);
    case 'reviewDiff': return handleReviewDiff(projectRoot, params);
    case 'reviewComments': return handleReviewComments(projectRoot, params);
    case 'reviewPostComment': return handleReviewPostComment(projectRoot, params);
    case 'reviewRetryAsk': return handleReviewRetryAsk(projectRoot, params);
    case 'reviewWithdrawComment': return handleReviewWithdrawComment(projectRoot, params);
    case 'reviewUnblock': return handleReviewUnblock(projectRoot, params);
    case 'reviewAccept': return handleReviewAccept(projectRoot, params);
    case 'reviewSync': return handleReviewSync(projectRoot, params);
    case 'reviewViolationDecision': return handleReviewViolationDecision(projectRoot, params);
    case 'storage': return handleStorageCall(projectRoot, params);
    default: throw new RpcError(404, `Unknown RPC command: ${command}`);
  }
}

/**
 * Expand `taskId` into every attribution form that task answers to.
 *
 * WHY THIS EXISTS: proxy events are attributed from the agent's credential
 * grant, which carries the task REF it was launched with — the task's code, or
 * its short id when it has none. A caller (`lazy watch`) holds the full task id.
 * Matching one against the other found nothing, so watch printed its header and
 * then sat silent for a whole turn while the agent was demonstrably making
 * calls. Resolution belongs here rather than in the handler because storage
 * lives on this side; proxy-watch.ts importing it back would be a cycle.
 *
 * An unresolvable id is passed through untouched — an operator watching a
 * partial id, or a task the store no longer has, still gets prefix matching
 * rather than an error, because this is an observability surface.
 */
async function resolveActivityFilterParams(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const raw = params.taskId;
  if (typeof raw !== 'string' || !raw) return params;

  // Start from whatever the caller already asked for. Replacing their list with
  // ours would NARROW the subscription behind their back — a client that passed
  // both `taskIds` and a `taskId` means the union, and dropping half of it is
  // the same "watch shows nothing" failure this resolution exists to prevent.
  // A malformed `taskIds` is left untouched so the handler's own validator is
  // the one that reports it — sanitizing it here would turn a 400 into a
  // silently different filter.
  if (params.taskIds !== undefined && params.taskIds !== null) {
    if (!Array.isArray(params.taskIds) || params.taskIds.some((v) => typeof v !== 'string')) {
      return params;
    }
  }
  const existing = (Array.isArray(params.taskIds) ? params.taskIds : []) as string[];
  const forms = new Set<string>([raw, ...existing.filter((f) => f.trim().length > 0)]);
  try {
    const storage = await getOrCreateStorage();
    const { task } = await storage.resolveTask(raw);
    if (task) {
      forms.add(task.id);
      forms.add(shortId(task.id));
      forms.add(taskRef(task));
      if (task.code) forms.add(task.code);
    }
  } catch (err) {
    // Resolution is an enrichment, not a precondition: the raw form is still a
    // usable filter, and failing a watch because the store hiccuped would trade
    // a degraded view for no view at all.
    logger.debug(
      `[proxy] could not resolve task '${raw}' for activity filter: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { taskId: _dropped, ...rest } = params;
  return { ...rest, taskIds: [...forms] };
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
 *
 * Exported because the MCP `lazy_list` / `lazy_active` handlers filter by
 * subtree too. They shape their own response, but the SCOPE of a `task_id`
 * filter must be one definition: `lazy_list` used to return direct children
 * only while `lazy list <id>` returned the whole subtree, so an agent that
 * generalised from `lazy_active` (subtree on both surfaces) silently reviewed
 * a truncated tree.
 */
export async function filterToSubtree(storage: Storage, tasks: Task[], taskFilter: string): Promise<Task[]> {
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

/**
 * Read and validate the optional `levels` depth limit shared by the list /
 * blocked / active handlers. Absent means "no limit"; a non-positive or
 * non-integer value is a caller error, not something to silently clamp.
 */
function optionalLevels(params: Record<string, unknown>): number | undefined {
  const raw = params.levels;
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new RpcError(400, `'levels' must be a positive integer (1 = top level only), got '${String(raw)}'.`);
  }
  return value;
}

/**
 * Apply an optional depth limit and build the display tree. Shared by every
 * listing handler so `levels` means the same thing on all of them.
 */
async function buildTreeWithDepth(
  storage: Storage,
  tasks: Task[],
  projectRoot: string,
  levels: number | undefined,
) {
  if (levels === undefined) return buildTaskTree(storage, tasks, projectRoot);
  const { kept, hidden } = pruneTasksToDepth(tasks, levels);
  return buildTaskTree(storage, kept, projectRoot, { hiddenDescendants: hidden });
}

export async function handleList(projectRoot: string, params: Record<string, unknown>) {
  const storage = await getOrCreateStorage();
  const all = params.all === true;
  const levels = optionalLevels(params);
  let tasks = all
    ? await storage.listTasks()
    : await storage.listTasksWithOptions({ nonTerminalOnly: true });

  if (typeof params.taskFilter === 'string' && params.taskFilter) {
    tasks = await filterToSubtree(storage, tasks, params.taskFilter);
  }

  const tree = await buildTreeWithDepth(storage, tasks, projectRoot, levels);
  return { tree };
}

// --- Blocked ---

export async function handleBlocked(projectRoot: string, params: Record<string, unknown> = {}) {
  const storage = await getOrCreateStorage();
  const levels = optionalLevels(params);
  const tasks = await storage.listTasksWithOptions({ blockedOnly: true });
  const tree = await buildTreeWithDepth(storage, tasks, projectRoot, levels);
  return { tree };
}

// --- Active ---

export async function handleActive(projectRoot: string, params: Record<string, unknown> = {}) {
  const storage = await getOrCreateStorage();
  const levels = optionalLevels(params);
  let tasks = await collectActiveTasks(storage);

  // Optional subtree filter: show only the given task and its descendants.
  if (typeof params.taskFilter === 'string' && params.taskFilter) {
    tasks = await filterToSubtree(storage, tasks, params.taskFilter);
  }

  // Depth limit applies AFTER the subtree filter, so `active <task> --levels 1`
  // means "that task, no descendants" rather than one of the two silently
  // winning.
  const tree = await buildTreeWithDepth(storage, tasks, projectRoot, levels);
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
  const action = optionalEnum(params, 'action', ['get', 'set', 'reset'] as const) ?? 'get';

  if (action === 'set' || action === 'reset') {
    const key = optionalString(params, 'key') as LimitKey;
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
    // A mid-merge worktree only reaches the CLI if it is serialized here — this
    // list is explicit, so an omission silently restores the old lie that a
    // stranded task is just `blocked` (fix-sync-silent-conflict).
    mergeState: data.mergeState,
    // Same rule as mergeState: protection only reaches the CLI if it is
    // serialized here, and omitting it silently restores the old behavior
    // where a gate was invisible until accept refused.
    protection: data.protection,
    // Same rule again: the slow-lane indicator silently disappears from a
    // daemon-backed `lazy show` if this field is omitted here, even though
    // loadTaskShowData computed it correctly.
    autoResumeQueue: data.autoResumeQueue,
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

/**
 * Diff a task's branch against its integration base.
 *
 * This is the ONE implementation behind both `lazy diff` and the `lazy_diff`
 * MCP tool. MCP used to compute its own base ref, hardcoding the literal
 * 'main' for top-level tasks and for tasks whose parent session was missing —
 * so on a repo whose default branch is not `main`, or for a task targeting a
 * release branch, an agent reviewed the wrong diff and reported it
 * confidently. Do not reintroduce a second base-ref computation; add
 * parameters here instead.
 *
 * Params:
 *   taskId  — required task reference (short id or code)
 *   full    — full patch instead of a --stat summary
 *   files   — pathspecs to restrict the diff to
 *   surface — which "how to get the full diff" hint to render ('cli' default,
 *             or 'mcp' so an agent is told the tool call rather than a shell
 *             command it may not be able to run)
 */
export async function handleDiff(projectRoot: string, params: Record<string, unknown>) {
  if (typeof params.taskId !== 'string' || !params.taskId) {
    throw new RpcError(400, 'taskId is required');
  }
  const files = Array.isArray(params.files)
    ? params.files.filter((f): f is string => typeof f === 'string' && f.length > 0)
    : undefined;
  const surface = params.surface === 'mcp' ? 'mcp' : 'cli';

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

  const diffRange = useTwoDotDiff ? `${fromRef}..HEAD` : `${fromRef}...HEAD`;

  let output = '';
  if (full) {
    const diff = await getDiffFull(fromRef, 'HEAD', worktreePath, useTwoDotDiff, files);
    if (!diff && !notesDiffSection) {
      output = 'No changes.';
    } else {
      const parts: string[] = [];
      if (diff) parts.push(diff);
      if (notesDiffSection) parts.push(notesDiffSection);
      output = parts.join('\n\n');
    }
  } else {
    const stat = await getDiffStat(fromRef, 'HEAD', worktreePath, useTwoDotDiff, files);
    if (!stat && newNotes.length === 0) {
      output = 'No changes.';
    } else {
      const parts: string[] = [];
      if (stat) parts.push(stat);
      if (newNotes.length > 0) {
        parts.push(` comments | ${newNotes.length} comment(s) added`);
      }
      // The hint names a call the CALLER can actually make: a shell command for
      // the CLI, the tool call for an MCP client.
      parts.push(surface === 'mcp'
        ? `\nFor full diff: lazy_diff(task_id: "${displayId(task)}", full: true)`
        : `\nFor full diff: lazy diff ${displayId(task)} --full`);
      output = parts.join('\n');
    }
  }

  return { output, diffRange, taskId: shortId(task.id) };
}

// --- Wait ---

/**
 * Long-poll until the FIRST of one or more tasks finishes its turn — its turn
 * count increases with an agent turn, or its status changes from 'working'.
 *
 * This eliminates client-side polling — the daemon holds ONE connection and
 * races every task internally. The polling core lives in ./wait-race.ts.
 */
export async function handleWait(projectRoot: string, params: Record<string, unknown>) {
  const inputs = normalizeWaitInputs(params);
  const storage = await getOrCreateStorage();
  const result = await raceWait(storage, inputs, {
    timeoutSecs: optionalNumber(params, 'timeout'),
  });

  // Report a half-merged worktree on the winner. Computed here rather than in
  // raceWait because only the daemon knows the project root — and every wait
  // client (CLI, MCP, rpc-fallback) goes through this one handler, so they all
  // tell the same truth (fix-sync-silent-conflict).
  if (!result.timed_out) {
    try {
      const task = await storage.getTask(result.task_id);
      if (task) {
        const worktreePath = getWorktreePath(projectRoot, task);
        if (await pathExists(worktreePath)) {
          const state = await readWorktreeMergeState(worktreePath);
          if (isMidMerge(state)) {
            result.merge_state = {
              merge_in_progress: state.mergeInProgress,
              unmerged_files: state.unmergedFiles,
              summary:
                `Worktree has an unresolved merge (${describeMergeState(state)}). A sync did not ` +
                `finish — run \`lazy sync ${result.display_id}\` to complete it.`,
            };
          }
        }
      }
    } catch (err) {
      // Observational only — never fail a wait because a worktree was unreadable.
      logger.debug(`wait: could not read merge state for ${result.display_id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return result;
}

// --- Start Task ---

/**
 * The Actor union, as a runtime value.
 *
 * `params.actor as Actor` asserts to the compiler and checks nothing: an
 * unrecognized string used to flow into a turn record and be attributed to an
 * actor that does not exist. Kept next to the type so the two cannot drift
 * unnoticed — adding a member to `Actor` without adding it here makes every
 * caller using it a 400, which is loud rather than silent.
 */
const ACTORS = ['human', 'builder', 'agent', 'system', 'supervisor'] as const satisfies readonly Actor[];

export async function handleStartTask(projectRoot: string, params: Record<string, unknown>) {
  const startParams: StartTaskParams = {
    taskId: requireString(params, 'taskId'),
    modelOverride: optionalString(params, 'modelOverride'),
    agentId: optionalString(params, 'agentId'),
    forceLocal: optionalBoolean(params, 'forceLocal'),
    retargetOrphan: optionalBoolean(params, 'retargetOrphan'),
    effortOverride: optionalString(params, 'effortOverride'),
    // Not enum-checked here: resolveRunnerType owns the alias mapping and its
    // own error text ("container" → docker, etc.).
    runnerOverride: optionalString(params, 'runnerOverride') as RunnerType | undefined,
    actor: optionalEnum(params, 'actor', ACTORS),
  };

  logger.info(`Starting task ${startParams.taskId.substring(0, 8)}`);

  // Root span for the whole start request. Stitches under the caller's trace
  // when a `traceparent` was propagated (CLI → daemon); otherwise starts a new
  // trace. This is the "request received" boundary on the daemon side.
  const parentCtx = contextFromTraceparent(optionalString(params, 'traceparent'));
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
    taskId: requireString(params, 'taskId'),
    message: requireString(params, 'message'),
    modelOverride: optionalString(params, 'modelOverride'),
    approvedFiles: optionalStringArray(params, 'approvedFiles'),
    retargetOrphan: optionalBoolean(params, 'retargetOrphan'),
    notesInEditor: optionalBoolean(params, 'notesInEditor'),
    effortOverride: optionalString(params, 'effortOverride'),
    agentOverride: optionalString(params, 'agentOverride'),
    permissionMode,
    actor: optionalEnum(params, 'actor', ACTORS),
  };

  logger.info(`Unblocking task ${unblockParams.taskId.substring(0, 8)}`);
  return launchUnblockTask(projectRoot, unblockParams);
}

// --- Ask Task (read-only Q&A against the session) ---

export async function handleAskTask(projectRoot: string, params: Record<string, unknown>) {
  const askParams: AskTaskParams = {
    taskId: requireString(params, 'taskId'),
    message: requireString(params, 'message'),
    effortOverride: optionalString(params, 'effortOverride'),
    actor: optionalEnum(params, 'actor', ACTORS),
  };

  logger.info(`Asking task ${askParams.taskId.substring(0, 8)}`);
  return launchAskTask(projectRoot, askParams);
}

// --- Accept Task Preflight ---

export async function handleAcceptTaskPreflight(projectRoot: string, params: Record<string, unknown>) {
  const preflightParams: AcceptTaskPreflightParams = {
    taskId: requireString(params, 'taskId'),
    approvedFiles: optionalStringArray(params, 'approvedFiles'),
    acceptDirtyWorktree: optionalBoolean(params, 'acceptDirtyWorktree'),
  };

  return acceptTaskPreflight(projectRoot, preflightParams);
}

// --- Accept Task (Full) ---

export async function handleAcceptTask(
  projectRoot: string,
  params: Record<string, unknown>,
  progress?: ProgressEmitter,
) {
  const acceptParams: AcceptTaskParams = {
    taskId: requireString(params, 'taskId'),
    reason: optionalString(params, 'reason'),
    approvedFiles: optionalStringArray(params, 'approvedFiles'),
    acceptDirtyWorktree: optionalBoolean(params, 'acceptDirtyWorktree'),
    actor: optionalEnum(params, 'actor', ACTORS),
    callerTaskId: optionalString(params, 'callerTaskId'),
    onProgress: progress,
  };

  return acceptTask(projectRoot, acceptParams);
}

// --- Approve Task (edge-gate human approval) ---

export async function handleApproveTaskPreflight(projectRoot: string, params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');

  return approveTaskPreflight(projectRoot, { taskId });
}

export async function handleApproveTask(projectRoot: string, params: Record<string, unknown>) {
  const approveParams: ApproveTaskParams = {
    taskId: requireString(params, 'taskId'),
    // The approval token stays OPTIONAL at this boundary: approveTask decides
    // whether one is needed and produces the message that explains it.
    token: optionalString(params, 'token') as string,
  };

  return approveTask(projectRoot, approveParams);
}

// --- Reject Task ---

export async function handleRejectTask(projectRoot: string, params: Record<string, unknown>) {
  const rejectParams: RejectTaskParams = {
    taskId: requireString(params, 'taskId'),
    reason: requireString(params, 'reason'),
    acceptDirtyWorktree: optionalBoolean(params, 'acceptDirtyWorktree'),
    actor: optionalEnum(params, 'actor', ACTORS),
  };

  return rejectTask(projectRoot, rejectParams);
}

// --- Close Task ---

export async function handleCloseTask(projectRoot: string, params: Record<string, unknown>) {
  const closeParams: CloseTaskParams = {
    taskId: requireString(params, 'taskId'),
    reason: requireString(params, 'reason'),
    acceptDirtyWorktree: optionalBoolean(params, 'acceptDirtyWorktree'),
    actor: optionalEnum(params, 'actor', ACTORS),
  };

  return closeTask(projectRoot, closeParams);
}

// --- Stop Task ---

export async function handleStopTask(projectRoot: string, params: Record<string, unknown>) {
  const stopParams: StopTaskParams = {
    taskId: requireString(params, 'taskId'),
    // Stop's reason must be non-blank: it is recorded as the human turn that
    // explains why the task was halted, and "   " explains nothing.
    reason: requireNonBlankString(params, 'reason'),
    actor: optionalEnum(params, 'actor', ACTORS),
  };
  return stopTask(projectRoot, stopParams);
}

// --- Submit Task ---

export async function handleSubmitTask(projectRoot: string, params: Record<string, unknown>) {
  const submitParams: SubmitTaskParams = {
    taskId: requireString(params, 'taskId'),
    actor: optionalEnum(params, 'actor', ACTORS),
  };

  return submitTask(projectRoot, submitParams);
}

// --- Resume Task ---

export async function handleResumeTask(projectRoot: string, params: Record<string, unknown>) {
  const resumeParams: ResumeTaskParams = {
    taskId: requireString(params, 'taskId'),
    modelOverride: optionalString(params, 'modelOverride'),
    effortOverride: optionalString(params, 'effortOverride'),
    actor: optionalEnum(params, 'actor', ACTORS),
  };

  logger.info(`Resuming task ${resumeParams.taskId.substring(0, 8)}`);
  return resumeTask(projectRoot, resumeParams);
}

// --- Sync Task ---

export async function handleSyncTask(projectRoot: string, params: Record<string, unknown>) {
  const syncParams: SyncTaskParams = {
    taskId: requireString(params, 'taskId'),
    actor: optionalEnum(params, 'actor', ACTORS),
  };

  return syncTask(projectRoot, syncParams);
}

// --- Reparent Task ---

export async function handleReparentTask(projectRoot: string, params: Record<string, unknown>) {
  const reparentParams: ReparentTaskParams = {
    taskId: requireString(params, 'taskId'),
    parent: requireString(params, 'parent'),
    actor: optionalEnum(params, 'actor', ACTORS),
  };

  return reparentTask(projectRoot, reparentParams);
}

// --- Get Daemon MCP Config ---

export async function handleGetDaemonMcpConfig(projectRoot: string, params: Record<string, unknown>) {
  // Fallback label for a caller that supplied none. Random, not a clock reading:
  // the label IS the MCP identity key, so two callers landing in the same
  // millisecond would share a token and the first to revoke would take the
  // other's tools away. `lazy builder` always passes its own `builder-<id>`.
  const name = optionalString(params, 'name') || `builder-${randomUUID().split('-')[0]}`;
  // The caller's own pid, when it sent one. `lazy builder` runs on the host
  // beside the daemon, so this is a pid the daemon can test with kill(pid, 0) —
  // it is what keeps a LIVE builder's token from being evicted by the registry's
  // builder cap. Validated here because this is the external surface: a
  // nonsense pid would silently make a live session look dead (or, worse,
  // resolve to some unrelated process) instead of being refused.
  const ownerPid = optionalNumber(params, 'ownerPid');
  if (ownerPid !== undefined && (!Number.isInteger(ownerPid) || ownerPid <= 0)) {
    throw new RpcError(400, `ownerPid must be a positive integer, got ${ownerPid}`);
  }
  try {
    // Builder identity: no task id. A builder token is refused on any
    // task-scoped MCP claim, and a task token is refused on the builder
    // surface — see src/daemon/mcp-tokens.ts.
    const configPath = await writeDaemonMcpConfig(projectRoot, name, { kind: 'builder' }, { ownerPid });
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
  const name = requireString(params, 'name');
  const revoked = await revokeBuilderMcpToken(projectRoot, name);
  // The builder's placeholder credential has the same lifetime as its MCP
  // token — both are minted for one session and are worthless after it. Keyed
  // by the same session name, so the two registries stay in step.
  //
  // Independently guarded: the MCP token is already revoked by the line above,
  // and reporting THAT as failed would make the caller retry a revocation that
  // succeeded — or worse, treat a revoked token as still live. A grant that
  // outlives its session is bounded anyway (the registry cap evicts it), so a
  // loud log is the right cost here.
  try {
    await revokeBuilderCredentialGrant(projectRoot, name);
  } catch (err) {
    logger.warn(
      `[proxy] failed to revoke the builder credential grant for "${name}": ` +
      `${err instanceof Error ? err.message : err}. Its MCP token IS revoked. The stale ` +
      `grant is evicted by the registry cap; to clear it now: lazy daemon restart`,
    );
  }
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
export async function handleGetAuthEnv(projectRoot: string, params: Record<string, unknown>) {
  // SCHEMA-VALIDATE AT THE BOUNDARY (CLAUDE.md: every external surface parses
  // and confirms its inputs). `proxied` decides whether this call hands back a
  // PLACEHOLDER or the user's real credential, so it is required rather than
  // defaulted: a caller that forgets it is a caller that would silently have
  // received the real token and shipped it into a container. That is the exact
  // forgotten-argument failure this task exists to remove, so it must fail
  // loudly instead of failing open.
  if (typeof params.proxied !== 'boolean') {
    throw new Error(
      'getAuthEnv: the `proxied` parameter is required and must be a boolean. It selects ' +
      'between a placeholder credential and the real one, so there is no safe default. ' +
      'This is a lazy bug — please report it.',
    );
  }
  const proxied = params.proxied === true;
  // `selfCredentialed`: the caller's role speaks to an upstream that needs no
  // real credential (today: ollama, which ignores auth). It still wants a
  // placeholder — that grant is how the proxy authenticates the caller and
  // routes it to that role's upstream — but minting one over the user's token
  // would be both pointless and, in an ollama-only project with no Anthropic
  // credential at all, fatal. Validated as a boolean like `proxied`, but
  // optional: absent means "the normal case", which is the safe one.
  if (params.selfCredentialed !== undefined && typeof params.selfCredentialed !== 'boolean') {
    throw new Error(
      'getAuthEnv: the `selfCredentialed` parameter must be a boolean when present. ' +
      'This is a lazy bug — please report it.',
    );
  }
  const selfCredentialed = params.selfCredentialed === true;
  // Returns the bare Anthropic credential from the daemon process env. Callers
  // (resolveAuthEnvFromDaemon) wrap it for their resolved role target, layering
  // the proxy's base URL on top.
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
    proxyBaseUrl = proxyBaseUrlForRunner(config.runner.type, proxyPort, config.proxy.bind);
  }

  // A caller that only needs the address (resolveLiveProxyUrl) says so, and the
  // secret does not cross the socket at all. Same principle as
  // handleGetCredentialState: nothing that merely describes auth moves it.
  if (params.credentials === false) {
    return { authEnvVars: [] as AuthEnvVar[], ...(proxyBaseUrl ? { proxyBaseUrl } : {}) };
  }

  // A self-credentialed role never touches the daemon's own credential — which
  // is the point: the daemon may not have one, and the gate lets it start
  // anyway precisely because ollama projects do not need it.
  const real = selfCredentialed ? LOCAL_BACKEND_CREDS : getAuthEnvVars();

  // JIT CREDENTIALS: a launch whose traffic will flow through lazy's proxy gets
  // per-launch PLACEHOLDERS, and the proxy swaps the real value back in just
  // before forwarding. The client decides `proxied` — it resolved the role
  // target and is the only side that knows whether the address actually points
  // at this daemon's proxy (see resolveAuthEnvFromDaemon).
  const identity = parseLaunchIdentity(params);
  if (proxied) {
    if (!identity) {
      // Fail loud rather than fall back to the real credential: a launch path
      // that forgot its identity would otherwise quietly keep shipping the
      // user's token into a container, which is the whole thing this prevents.
      throw new Error(
        'getAuthEnv: proxied launches must identify themselves (role, label) so a ' +
        'placeholder credential can be minted for them. This is a lazy bug — please report it.',
      );
    }
    if (proxyPort) {
      return {
        authEnvVars: await placeholderizeAuthEnv(projectRoot, real, identity),
        ...(proxyBaseUrl ? { proxyBaseUrl } : {}),
      };
    }
    // No proxy bound: hand back the real credential and let the client's
    // fail-loud gate refuse the launch. Minting here would produce a
    // placeholder nothing can exchange.
  }

  // Omit proxyBaseUrl entirely when the port is not yet bound — don't send an
  // `undefined` field over the wire. The client treats its absence as a failure
  // to resolve the audit plane, not as permission to connect direct.
  return { authEnvVars: real, ...(proxyBaseUrl ? { proxyBaseUrl } : {}) };
}

interface AuthEnvVar { key: string; value: string }

/**
 * Parse the launch identity a proxied caller must send, or null if absent.
 *
 * Validated at the boundary (CLAUDE.md): the identity is what the minted grant
 * binds attribution to, so a malformed one would produce audit records naming a
 * task that does not exist. Rejected loudly rather than coerced.
 */
function parseLaunchIdentity(params: Record<string, unknown>): LaunchIdentity | null {
  const role = params.role;
  const label = params.label;
  if (role === undefined && label === undefined) return null;
  if (role !== 'agent' && role !== 'builder') {
    throw new Error(`getAuthEnv: role must be "agent" or "builder", got ${JSON.stringify(role)}`);
  }
  if (typeof label !== 'string' || label.length === 0) {
    throw new Error('getAuthEnv: label must be a non-empty string identifying the launch');
  }
  const taskId = params.taskId;
  if (taskId !== undefined && taskId !== null && typeof taskId !== 'string') {
    throw new Error(`getAuthEnv: taskId must be a string or null, got ${JSON.stringify(taskId)}`);
  }
  return { role, label, taskId: (taskId as string | null | undefined) ?? null };
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
// Exported so BUILDER_STORAGE_METHODS can be checked against it: an allowlist
// entry that names a method this map does not have would 403 on the builder
// surface and 404 on the full one, i.e. fail at runtime instead of at test time.
export const STORAGE_METHODS: Record<string, (storage: Storage, args: Record<string, unknown>) => Promise<unknown> | unknown> = {
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
    a.actor as Actor | undefined,
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
  updateTaskAgent: (s, a) => s.updateTaskAgent(a.taskId as string, a.agentId as string),
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
  updateSessionAgent: (s, a) => s.updateSessionAgent(a.sessionId as string, a.agentId as string),
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
  reserveTurnSequences: (s, a) => s.reserveTurnSequences(a.sessionId as string, a.count as number),
  beginInFlightTurn: (s, a) => s.beginInFlightTurn(a.taskId as string, a.turn as any),
  settleInFlightTurn: (s, a) => s.settleInFlightTurn(a.taskId as string, a.turnSequence as number, a.outcome as any),
  clearInFlightTurn: (s, a) => s.clearInFlightTurn(a.taskId as string, a.turnSequence as number | undefined),
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

  // Review comments (anchored, threaded diff comments)
  createReviewComment: (s, a) => s.createReviewComment(a.taskId as string, a.input as any),
  getTaskReviewComments: (s, a) => s.getTaskReviewComments(a.taskId as string),
  updateReviewComment: (s, a) => s.updateReviewComment(a.taskId as string, a.commentId as string, a.update as any),

  // Conversations
  // INVARIANT: capture never shortens a stored conversation. Enforced here, on the
  // daemon side, so EVERY client — the in-container builder capture monitor, the
  // CLI, importers — inherits it without having to remember. See
  // saveConversationWithoutRegression for why a prefix write is always wrong.
  saveConversation: async (s, a) => {
    await saveConversationWithoutRegression(s, a.conversation as any);
  },
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

  // Wait intervals
  recordWaitStart: (s, a) => s.recordWaitStart(a.start as any),
  recordWaitEnd: (s, a) => s.recordWaitEnd(a.id as string, a.endedAt as string, a.outcome as any),
  readWaitIntervals: (s, a) => s.readWaitIntervals(a.filter as any),
};

/**
 * Handle a generic Storage method call via RPC.
 *
 * Uses the daemon's long-lived Storage instance — no lock acquisition per call.
 * CLI processes never touch .storage-lock at all.
 */
export async function handleStorageCall(projectRoot: string, params: Record<string, unknown>) {
  const method = params.method;
  if (!method || typeof method !== 'string') {
    throw new RpcError(400, 'Storage RPC requires a "method" parameter');
  }

  // `args` is destructured by each STORAGE_METHODS entry, so a non-object here
  // (an array, a string) silently yields undefined for every field it reads —
  // a write with empty content instead of a rejected request.
  const rawArgs = params.args;
  if (rawArgs !== undefined && rawArgs !== null
      && (typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
    throw new RpcError(
      400,
      `Storage RPC "args" must be a JSON object, got ${Array.isArray(rawArgs) ? 'array' : typeof rawArgs}`,
    );
  }
  const args = (rawArgs as Record<string, unknown> | undefined) ?? {};

  const handler = STORAGE_METHODS[method];
  if (!handler) {
    throw new RpcError(404, `Unknown storage method: ${method}`);
  }

  const storage = await getOrCreateStorage();
  const result = handler(storage, args);
  // Handle both sync (getStoragePath, getTaskDir) and async methods
  return result instanceof Promise ? await result : result;
}

/**
 * The ONLY Storage methods a builder container may call.
 *
 * WHY A SEPARATE, TINY LIST. `/rpc/storage` above exposes the WHOLE Storage
 * interface and is therefore gated on the shared daemon token — the credential
 * that also unlocks every `/rpc/<command>` CLI pass-through. A builder
 * container does not hold that token and must not: its mounted credential is a
 * per-identity MCP token, deliberately scoped to the narrow builder tool
 * surface. Handing it the shared token so its conversation capture could write
 * would give the container (and the agent running inside it) full CLI and full
 * storage authority to fix a logging path.
 *
 * So the builder surface gets exactly what its SUPERVISOR needs and nothing
 * else: persist a captured conversation, and read/stamp its own resume intent.
 * Everything here is either a write the supervisor already performs on the
 * human's behalf or a read of state the builder owns.
 *
 * Adding an entry widens what a compromised builder container can do. Do not
 * add one to make an unrelated caller work — give that caller its own surface.
 */
export const BUILDER_STORAGE_METHODS: ReadonlySet<string> = new Set([
  // Connectivity probe + the path RemoteStorage needs for getTaskDir().
  'getStoragePath',
  // Conversation capture — the reason this surface exists.
  'saveConversation',
  // Resume-intent stamp on exit, so `lazy upgrade` can relaunch the same
  // conversation. Reads/writes only builder-resume-intents.
  'listBuilderResumeIntents',
  'saveBuilderResumeIntent',
]);

/**
 * Handle a storage call from a builder container (POST /builder/storage).
 *
 * Authentication happens in the route (a builder-kind MCP token, never the
 * shared daemon token); this is the AUTHORIZATION half — the allowlist above.
 * Dispatch deliberately delegates to handleStorageCall so the two surfaces can
 * never drift on argument validation or method semantics.
 */
export async function handleBuilderStorageCall(
  projectRoot: string,
  params: Record<string, unknown>,
) {
  const method = params.method;
  if (!method || typeof method !== 'string') {
    throw new RpcError(400, 'Builder storage call requires a "method" parameter');
  }
  if (!BUILDER_STORAGE_METHODS.has(method)) {
    throw new RpcError(
      403,
      `Storage method "${method}" is not available on the builder surface. ` +
      `A builder container may only call: ${[...BUILDER_STORAGE_METHODS].sort().join(', ')}. ` +
      `The full storage surface lives at /rpc/storage and requires the shared daemon token, ` +
      `which is deliberately not given to containers.`,
    );
  }
  return handleStorageCall(projectRoot, params);
}
