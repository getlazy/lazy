/**
 * RPC dispatch layer — routes CLI queries through the daemon.
 *
 * In v0.11+, the daemon is required. CLI commands call these functions
 * to get structured data via daemon RPC. The only exception is test mode
 * (LAZY_TEST=1) and daemon-self mode (LAZY_IS_DAEMON=1), where tryRpc()
 * returns null and we fall back to calling handlers directly.
 *
 * This module is intentionally thin — all command logic lives in
 * rpc-handlers.ts. This file only handles:
 * 1. tryRpc → if null (test/daemon-self) → call handler with project root
 * 2. Deserialization (e.g., Map reconstruction from JSON)
 * 3. Error translation (RpcError → return types the CLI expects)
 */

import { tryRpc, RpcApplicationError } from './client';
import {
  handleList,
  handleBlocked,
  handleActive,
  handleShow,
  handleSearch,
  handleDiff,
  handleWait,
  handleStartTask,
  handleUnblockTask,
  handleAskTask,
  handleAcceptTaskPreflight,
  handleAcceptTask,
  handleApproveTaskPreflight,
  handleApproveTask,
  handleRejectTask,
  handleCloseTask,
  handleSyncTask,
  handleReparentTask,
  handleResumeTask,
  handleGetDaemonMcpConfig,
  handleRevokeDaemonMcpToken,
  handleConcurrency,
  RpcError,
} from './rpc-handlers';
import { requireLazyRoot } from '../cli/helpers';
import type { TaskWithSession } from '../cli/commands/list';
import type { TaskShowData } from '../cli/commands/show';
import type { SearchResult } from '../storage';
import type { RunnerType } from '../config/types';
import type { Actor } from '../types';
import type { ProgressEmitter } from './progress';

// --- List ---

export interface ListResult {
  tree: TaskWithSession[];
}

export async function queryTaskList(params: {
  all?: boolean;
  taskFilter?: string;
}): Promise<ListResult> {
  const rpc = await tryRpc<ListResult>('list', {
    all: params.all,
    taskFilter: params.taskFilter,
  });
  if (rpc) return rpc;

  // Test/daemon-self mode: execute directly
  const root = requireLazyRoot();
  try {
    return await handleList(root, params) as ListResult;
  } catch (err) {
    if (err instanceof RpcError && err.status === 404) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

// --- Blocked ---

export async function queryBlockedTasks(): Promise<ListResult> {
  const rpc = await tryRpc<ListResult>('blocked');
  if (rpc) return rpc;

  const root = requireLazyRoot();
  return await handleBlocked(root) as ListResult;
}

// --- Active ---

export async function queryActiveTasks(params: { taskFilter?: string } = {}): Promise<ListResult> {
  try {
    const rpc = await tryRpc<ListResult>('active', { taskFilter: params.taskFilter });
    if (rpc) return rpc;
  } catch (err) {
    // Same user-error treatment as the direct path below: an unknown or
    // ambiguous task filter gets the handler's actionable message, not a stack.
    if (err instanceof RpcApplicationError && (err.status === 404 || err.status === 400)) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const root = requireLazyRoot();
  try {
    return await handleActive(root, params) as ListResult;
  } catch (err) {
    // Unknown / ambiguous task filter is a user error, not a crash — print the
    // handler's actionable message and exit, matching queryTaskList.
    if (err instanceof RpcError && (err.status === 404 || err.status === 400)) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

// --- Show ---

export type ShowResult =
  | { ambiguous: false; data: TaskShowData }
  | {
      ambiguous: true;
      matches: Array<{
        id: string;
        code: string | null;
        goal: string;
        status: string;
        /** Session's last_interaction_at, or created_at for an unstarted task. */
        lastInteractionAt: number;
      }>;
    }
  | null; // not found

/**
 * Deserialize show handler output into ShowResult.
 * Both daemon RPC and direct handler return the same shape —
 * childSessions is a plain object that needs Map reconstruction.
 */
function deserializeShowResult(raw: Record<string, any>): ShowResult {
  if (raw.ambiguous) {
    return { ambiguous: true, matches: raw.matches };
  }
  return {
    ambiguous: false,
    data: {
      ...raw as any,
      childSessions: new Map(Object.entries(raw.childSessions || {})),
    },
  };
}

export async function queryTaskShow(taskId: string): Promise<ShowResult> {
  try {
    const rpc = await tryRpc<Record<string, any>>('show', { taskId });
    if (rpc) return deserializeShowResult(rpc);
  } catch (err) {
    // A 404 from the daemon means "no such task". Return null so the caller can
    // fall back to conversation/file resolution, matching the direct-path
    // behavior below. Without this, `lazy show <conversation-session-id>` would
    // fail with "Task not found" whenever the daemon is running, because the
    // RPC error would propagate past the CLI's conversation fallback.
    if (err instanceof RpcApplicationError && err.status === 404) return null;
    throw err;
  }

  const root = requireLazyRoot();
  try {
    const result = await handleShow(root, { taskId }) as Record<string, any>;
    return deserializeShowResult(result);
  } catch (err) {
    if (err instanceof RpcError && err.status === 404) return null;
    throw err;
  }
}

// --- Search ---

export interface SearchQueryResult {
  query: string;
  results: SearchResult[];
  /** Present only on a zero-result tag query — explains why nothing matched. */
  hint?: string;
}

export async function querySearch(params: {
  query: string;
  fuzzy?: boolean;
  types?: string[];
}): Promise<SearchQueryResult> {
  const rpc = await tryRpc<SearchQueryResult>('search', {
    query: params.query,
    fuzzy: params.fuzzy,
    types: params.types?.length ? params.types : undefined,
  });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  return await handleSearch(root, params) as SearchQueryResult;
}

// --- Diff ---

export interface DiffResult {
  output: string;
  /** The git range the diff was computed over, e.g. `main...HEAD`. */
  diffRange: string;
  /** The resolved task's canonical short id. */
  taskId: string;
}

export async function queryDiff(params: {
  taskId: string;
  full?: boolean;
  /** Restrict the diff to these pathspecs. */
  files?: string[];
  /** Which "how to get the full diff" hint to render. Default 'cli'. */
  surface?: 'cli' | 'mcp';
}): Promise<DiffResult> {
  const rpc = await tryRpc<DiffResult>('diff', {
    taskId: params.taskId,
    full: params.full,
    files: params.files?.length ? params.files : undefined,
    surface: params.surface,
  });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  // Errors PROPAGATE — they are not turned into diff output. Rendering
  // "Worktree is gone and branch X not found locally or on remote." as if it
  // were a diff exited 0 with the failure on STDOUT, so `lazy diff` looked
  // successful to every script and to the human's eye. The daemon path already
  // fails loud here (tryRpc throws RpcApplicationError); this fallback exists
  // only for test/daemon-self mode and must behave identically.
  return await handleDiff(root, params) as DiffResult;
}

// --- Wait ---

export interface WaitTaskSnapshot {
  task_id: string;
  display_id: string;
  code: string | null;
  status: string;
}

export interface WaitResult {
  task_id: string;
  /** Task code, or short id when the task has no code. */
  display_id?: string;
  status: string;
  timed_out: boolean;
  turn_count?: number;
  latest_turn?: {
    sequence: number;
    role: string;
    timestamp: number;
  };
  /** Every task waited on, with its status at return time. */
  tasks?: WaitTaskSnapshot[];
  /** Tasks still working at return time (excludes the winner). */
  pending?: WaitTaskSnapshot[];
  /**
   * Present ONLY when the winner's worktree holds an unresolved merge — a task
   * that is mid-merge must never read as a settled `blocked`
   * (fix-sync-silent-conflict).
   */
  merge_state?: { merge_in_progress: boolean; unmerged_files: string[]; summary: string };
}

/**
 * Wait for the FIRST of one or more tasks to finish its turn.
 *
 * `taskIds` races the whole set inside a SINGLE daemon request — N parallel
 * client-side waits would burn a connection per task and still leave the losers
 * to cancel.
 */
export async function queryWait(params: {
  taskId?: string;
  taskIds?: string[];
  timeout?: number;
}): Promise<WaitResult> {
  try {
    const rpc = await tryRpc<WaitResult>('wait', {
      taskId: params.taskId,
      taskIds: params.taskIds,
      timeout: params.timeout,
    });
    if (rpc) return rpc;
  } catch (err) {
    // The daemon answered with an application error. Re-shape it as an RpcError
    // so the status survives for callers that map errors onto HTTP — same
    // reasoning as the direct path below.
    if (err instanceof RpcApplicationError) {
      throw new RpcError(err.status, err.message);
    }
    throw err;
  }

  const root = requireLazyRoot();
  // INVARIANT: propagate the RpcError as-is — do NOT flatten it to a plain
  // Error. This is the in-daemon path (LAZY_IS_DAEMON=1 bypasses tryRpc), so
  // the caller is usually the daemon's own POST /mcp/:taskId/:toolName route,
  // which maps `err.status` onto the HTTP status. Flattening turned every
  // argument mistake (RpcError 400, e.g. a missing task_id) into an HTTP 500,
  // which reads as "the daemon crashed" and sends the operator down the wrong
  // path. RpcError extends Error, so callers that only read `.message` are
  // unaffected.
  return await handleWait(root, params) as WaitResult;
}

// --- Start Task ---

export interface StartTaskRpcResult {
  sessionId: string;
  containerName: string;
  worktreePath: string;
  branchName: string;
  parentBranch: string | null;
  parentDisplayId: string | null;
  runnerType: string;
  warnings: string[];
  /** Launch deferred at the concurrency cap — task is `queued`, reconciler drains it. */
  queued?: boolean;
  queueRunning?: number;
  queueLimit?: number;
}

export async function queryStartTask(params: {
  taskId: string;
  modelOverride?: string;
  agentId?: string;
  forceLocal?: boolean;
  retargetOrphan?: boolean;
  effortOverride?: string;
  runnerOverride?: RunnerType;
  actor?: Actor;
  /** W3C trace context propagated from the CLI so daemon spans stitch onto the CLI trace. */
  traceparent?: string;
}): Promise<StartTaskRpcResult> {
  const rpc = await tryRpc<StartTaskRpcResult>('startTask', {
    taskId: params.taskId,
    modelOverride: params.modelOverride,
    agentId: params.agentId,
    forceLocal: params.forceLocal,
    retargetOrphan: params.retargetOrphan,
    effortOverride: params.effortOverride,
    runnerOverride: params.runnerOverride,
    actor: params.actor,
    traceparent: params.traceparent,
  });
  if (rpc) return rpc;

  // Test/daemon-self mode: execute directly
  const root = requireLazyRoot();
  return await handleStartTask(root, params) as StartTaskRpcResult;
}

// --- Concurrency limits ---

export interface ConcurrencyLimitState {
  /** The lazy.toml value. */
  configured: number;
  /** The ephemeral daemon override, or null when none is set. */
  override: number | null;
  /** Effective cap: override if set, else configured. */
  limit: number;
  /** How many are running right now. */
  running: number;
}

export interface ConcurrencyResult {
  agents: ConcurrencyLimitState;
  builders: ConcurrencyLimitState;
}

export async function queryConcurrency(params: {
  action?: 'get' | 'set' | 'reset';
  key?: string;
  value?: number;
} = {}): Promise<ConcurrencyResult> {
  const rpc = await tryRpc<ConcurrencyResult>('concurrency', {
    action: params.action,
    key: params.key,
    value: params.value,
  });
  if (rpc) return rpc;

  // Test/daemon-self mode: execute directly
  const root = requireLazyRoot();
  return await handleConcurrency(root, params) as ConcurrencyResult;
}

// --- Get Daemon MCP Config ---

export interface DaemonMcpConfigResult {
  configPath: string;
}

export async function queryDaemonMcpConfig(params: {
  name?: string;
  /**
   * pid of the session that will own this credential — `lazy builder` passes
   * its own. The daemon uses it to keep a LIVE builder's token out of the
   * eviction path when the registry's builder cap trips (see mcp-tokens.ts).
   */
  ownerPid?: number;
}): Promise<DaemonMcpConfigResult> {
  const rpc = await tryRpc<DaemonMcpConfigResult>('getDaemonMcpConfig', {
    name: params.name,
    ownerPid: params.ownerPid,
  });
  if (rpc) return rpc;

  // Test/daemon-self mode: execute directly
  const root = requireLazyRoot();
  return await handleGetDaemonMcpConfig(root, params) as DaemonMcpConfigResult;
}

// --- Revoke Daemon MCP Token ---

export interface RevokeDaemonMcpTokenResult {
  /** How many tokens were dropped (0 when already revoked). */
  revoked: number;
}

/**
 * Revoke the token minted for a builder session. Runs in the daemon, which owns
 * the registry cache — see handleRevokeDaemonMcpToken.
 */
export async function queryRevokeDaemonMcpToken(params: {
  name: string;
}): Promise<RevokeDaemonMcpTokenResult> {
  const rpc = await tryRpc<RevokeDaemonMcpTokenResult>('revokeDaemonMcpToken', {
    name: params.name,
  });
  if (rpc) return rpc;

  // Test/daemon-self mode: execute directly
  const root = requireLazyRoot();
  return await handleRevokeDaemonMcpToken(root, params) as RevokeDaemonMcpTokenResult;
}

// --- Unblock Task ---

export interface UnblockTaskRpcResult {
  sessionId: string;
  containerName: string;
  worktreePath: string;
  branchName: string;
  turnNumber: number;
  runnerType: string;
  runnerLabel: string;
  runnerDisplayName: string;
  warnings: string[];
}

export async function queryUnblockTask(params: {
  taskId: string;
  message: string;
  modelOverride?: string;
  approvedFiles?: string[];
  retargetOrphan?: boolean;
  notesInEditor?: boolean;
  effortOverride?: string;
  permissionMode?: 'plan' | 'default';
  actor?: Actor;
}): Promise<UnblockTaskRpcResult> {
  const rpc = await tryRpc<UnblockTaskRpcResult>('unblockTask', {
    taskId: params.taskId,
    message: params.message,
    modelOverride: params.modelOverride,
    approvedFiles: params.approvedFiles,
    retargetOrphan: params.retargetOrphan,
    notesInEditor: params.notesInEditor,
    effortOverride: params.effortOverride,
    permissionMode: params.permissionMode,
    actor: params.actor,
  });
  if (rpc) return rpc;

  // Test/daemon-self mode: execute directly
  const root = requireLazyRoot();
  return await handleUnblockTask(root, params) as UnblockTaskRpcResult;
}

// --- Ask Task (read-only Q&A) ---

export interface AskTaskRpcResult {
  sessionId: string;
  turnNumber: number;
  answer: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
  warnings: string[];
  timings: {
    daemon_ms: number;
    wait_ms: number;
    agent_ms?: number;
  };
}

export async function queryAskTask(params: {
  taskId: string;
  message: string;
  effortOverride?: string;
  actor?: Actor;
}): Promise<AskTaskRpcResult> {
  const rpc = await tryRpc<AskTaskRpcResult>('askTask', {
    taskId: params.taskId,
    message: params.message,
    effortOverride: params.effortOverride,
    actor: params.actor,
  });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  return await handleAskTask(root, params) as AskTaskRpcResult;
}

// --- Accept Task Preflight ---

export interface AcceptTaskPreflightRpcResult {
  taskId: string;
  fullTaskId: string;
  displayId: string;
  worktreePath: string;
  branchName: string;
  sessionId: string;
  parentTaskId: string | null;
  mergeTargetBranch: string;
  isChildTask: boolean;
  parentDisplayId: string | null;
  taskStatus: string;
  commitCount: number;
  metadata: Record<string, string>;
  warnings: string[];
}

export async function queryAcceptTaskPreflight(params: {
  taskId: string;
  approvedFiles?: string[];
  acceptDirtyWorktree?: boolean;
}): Promise<AcceptTaskPreflightRpcResult> {
  const rpc = await tryRpc<AcceptTaskPreflightRpcResult>('acceptTaskPreflight', {
    taskId: params.taskId,
    approvedFiles: params.approvedFiles,
    acceptDirtyWorktree: params.acceptDirtyWorktree,
  });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  return await handleAcceptTaskPreflight(root, params) as AcceptTaskPreflightRpcResult;
}

// --- Accept Task (Full) ---

export interface AcceptTaskRpcResult {
  taskId: string;
  displayId: string;
  status: 'merged' | 'pending';
  reason?: string;
  prUrl?: string;
  warnings: string[];
}

/**
 * `onProgress` receives the accept's phase narration (see daemon/progress.ts).
 * Over RPC the frames arrive on the heartbeat envelope; on the in-process
 * fallback path (LAZY_TEST / LAZY_IS_DAEMON) the emitter is handed straight to
 * the handler, so the same output appears with or without a daemon.
 */
export async function queryAcceptTask(params: {
  taskId: string;
  reason?: string;
  approvedFiles?: string[];
  acceptDirtyWorktree?: boolean;
  actor?: Actor;
  callerTaskId?: string;
}, onProgress?: ProgressEmitter): Promise<AcceptTaskRpcResult> {
  const rpc = await tryRpc<AcceptTaskRpcResult>('acceptTask', {
    taskId: params.taskId,
    reason: params.reason,
    approvedFiles: params.approvedFiles,
    acceptDirtyWorktree: params.acceptDirtyWorktree,
    actor: params.actor,
    callerTaskId: params.callerTaskId,
  }, { onProgress });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  return await handleAcceptTask(root, params, onProgress) as AcceptTaskRpcResult;
}

// --- Approve Task (edge-gate human approval) ---

export interface ApproveTaskRpcResult {
  taskId: string;
  displayId: string;
  replacedPending: boolean;
}

export interface ApproveTaskPreflightRpcResult {
  enrollment: 'enrolled' | 'not-enrolled' | 'unknown';
  message: string | null;
  sourceLabel: string | null;
}

/**
 * Checks `lazy approve` runs BEFORE prompting the human for a passphrase —
 * no token is sent, so this is safe to call before anything is typed.
 */
export async function queryApproveTaskPreflight(params: {
  taskId: string;
}): Promise<ApproveTaskPreflightRpcResult> {
  const rpc = await tryRpc<ApproveTaskPreflightRpcResult>('approveTaskPreflight', {
    taskId: params.taskId,
  });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  return await handleApproveTaskPreflight(root, params) as ApproveTaskPreflightRpcResult;
}

export async function queryApproveTask(params: {
  taskId: string;
  token: string;
}): Promise<ApproveTaskRpcResult> {
  const rpc = await tryRpc<ApproveTaskRpcResult>('approveTask', {
    taskId: params.taskId,
    token: params.token,
  });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  return await handleApproveTask(root, params) as ApproveTaskRpcResult;
}

// --- Reject Task ---

export interface RejectTaskRpcResult {
  taskId: string;
  displayId: string;
  branchName: string | null;
  parentTaskId: string | null;
  warnings: string[];
}

export async function queryRejectTask(params: {
  taskId: string;
  reason: string;
  acceptDirtyWorktree?: boolean;
  actor?: Actor;
}): Promise<RejectTaskRpcResult> {
  const rpc = await tryRpc<RejectTaskRpcResult>('rejectTask', {
    taskId: params.taskId,
    reason: params.reason,
    acceptDirtyWorktree: params.acceptDirtyWorktree,
    actor: params.actor,
  });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  return await handleRejectTask(root, params) as RejectTaskRpcResult;
}

// --- Close Task ---

export interface CloseTaskRpcResult {
  taskId: string;
  displayId: string;
  branchName: string | null;
  parentTaskId: string | null;
  warnings: string[];
}

export async function queryCloseTask(params: {
  taskId: string;
  reason: string;
  acceptDirtyWorktree?: boolean;
  actor?: Actor;
}): Promise<CloseTaskRpcResult> {
  const rpc = await tryRpc<CloseTaskRpcResult>('closeTask', {
    taskId: params.taskId,
    reason: params.reason,
    acceptDirtyWorktree: params.acceptDirtyWorktree,
    actor: params.actor,
  });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  return await handleCloseTask(root, params) as CloseTaskRpcResult;
}

// --- Stop Task ---

export interface StopTaskRpcResult {
  taskId: string;
  displayId: string;
  reason: string;
}

export async function queryStopTask(params: {
  taskId: string;
  reason: string;
  actor?: Actor;
}): Promise<StopTaskRpcResult> {
  const rpc = await tryRpc<StopTaskRpcResult>('stopTask', {
    taskId: params.taskId,
    reason: params.reason,
    actor: params.actor,
  });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  const { handleStopTask } = await import('./rpc-handlers');
  return await handleStopTask(root, params) as StopTaskRpcResult;
}

// --- Submit Task ---

export interface SubmitTaskRpcResult {
  taskId: string;
  displayId: string;
  prUrl: string | null;
  warnings: string[];
}

export async function querySubmitTask(params: {
  taskId: string;
  actor?: Actor;
}): Promise<SubmitTaskRpcResult> {
  const rpc = await tryRpc<SubmitTaskRpcResult>('submitTask', {
    taskId: params.taskId,
    actor: params.actor,
  });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  const { handleSubmitTask } = await import('./rpc-handlers');
  return await handleSubmitTask(root, params) as SubmitTaskRpcResult;
}

// --- Resume Task ---

export interface ResumeTaskRpcResult {
  sessionId: string;
  containerName: string;
  worktreePath: string;
  branchName: string;
  runnerType: string;
  runnerLabel: string;
  runnerDisplayName: string;
  warnings: string[];
}

export async function queryResumeTask(params: {
  taskId: string;
  modelOverride?: string;
  effortOverride?: string;
  actor?: Actor;
}): Promise<ResumeTaskRpcResult> {
  const rpc = await tryRpc<ResumeTaskRpcResult>('resumeTask', {
    taskId: params.taskId,
    modelOverride: params.modelOverride,
    effortOverride: params.effortOverride,
    actor: params.actor,
  });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  return await handleResumeTask(root, params) as ResumeTaskRpcResult;
}

// --- Sync Task ---

export interface SyncTaskRpcResult {
  taskId: string;
  displayId: string;
  status: 'up_to_date' | 'sync_launched' | 'pending_sync';
  message: string;
  warnings: string[];
}

export async function querySyncTask(params: {
  taskId: string;
  actor?: Actor;
}): Promise<SyncTaskRpcResult> {
  const rpc = await tryRpc<SyncTaskRpcResult>('syncTask', {
    taskId: params.taskId,
    actor: params.actor,
  });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  return await handleSyncTask(root, params) as SyncTaskRpcResult;
}

// --- Reparent Task ---

export interface ReparentTaskRpcResult {
  taskId: string;
  displayId: string;
  status: 'noop' | 'reparented' | 'reparented_no_sync';
  syncStatus?: 'up_to_date' | 'sync_launched' | 'pending_sync';
  newParent: string;
  message: string;
  warnings: string[];
}

export async function queryReparentTask(params: {
  taskId: string;
  parent: string;
  actor?: Actor;
}): Promise<ReparentTaskRpcResult> {
  const rpc = await tryRpc<ReparentTaskRpcResult>('reparentTask', {
    taskId: params.taskId,
    parent: params.parent,
    actor: params.actor,
  });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  return await handleReparentTask(root, params) as ReparentTaskRpcResult;
}
