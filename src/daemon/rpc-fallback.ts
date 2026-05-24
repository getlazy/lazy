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

import { tryRpc } from './client';
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
  handleRejectTask,
  handleCloseTask,
  handleSyncTask,
  handleResumeTask,
  handleGetDaemonMcpConfig,
  RpcError,
} from './rpc-handlers';
import { requireLazyRoot } from '../cli/helpers';
import type { TaskWithSession } from '../cli/commands/list';
import type { TaskShowData } from '../cli/commands/show';
import type { SearchResult } from '../storage';

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

export async function queryActiveTasks(): Promise<ListResult> {
  const rpc = await tryRpc<ListResult>('active');
  if (rpc) return rpc;

  const root = requireLazyRoot();
  return await handleActive(root) as ListResult;
}

// --- Show ---

export type ShowResult =
  | { ambiguous: false; data: TaskShowData }
  | { ambiguous: true; matches: Array<{ id: string; code: string | null; goal: string; status: string }> }
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
  const rpc = await tryRpc<Record<string, any>>('show', { taskId });
  if (rpc) return deserializeShowResult(rpc);

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
}

export async function queryDiff(params: {
  taskId: string;
  full?: boolean;
}): Promise<DiffResult> {
  const rpc = await tryRpc<DiffResult>('diff', {
    taskId: params.taskId,
    full: params.full,
  });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  try {
    return await handleDiff(root, params) as DiffResult;
  } catch (err) {
    // Convert handler errors to renderable output for the CLI
    if (err instanceof RpcError) {
      return { output: err.message };
    }
    throw err;
  }
}

// --- Wait ---

export interface WaitResult {
  task_id: string;
  status: string;
  timed_out: boolean;
  turn_count?: number;
  latest_turn?: {
    sequence: number;
    role: string;
    timestamp: number;
  };
}

export async function queryWait(params: {
  taskId: string;
  timeout?: number;
}): Promise<WaitResult> {
  const rpc = await tryRpc<WaitResult>('wait', {
    taskId: params.taskId,
    timeout: params.timeout,
  });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  try {
    return await handleWait(root, params) as WaitResult;
  } catch (err) {
    // Convert RpcError to plain Error for callers that don't know about RpcError
    if (err instanceof RpcError) {
      throw new Error(err.message);
    }
    throw err;
  }
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
}

export async function queryStartTask(params: {
  taskId: string;
  modelOverride?: string;
  agentId?: string;
  forceLocal?: boolean;
  retargetOrphan?: boolean;
  effortOverride?: string;
}): Promise<StartTaskRpcResult> {
  const rpc = await tryRpc<StartTaskRpcResult>('startTask', {
    taskId: params.taskId,
    modelOverride: params.modelOverride,
    agentId: params.agentId,
    forceLocal: params.forceLocal,
    retargetOrphan: params.retargetOrphan,
    effortOverride: params.effortOverride,
  });
  if (rpc) return rpc;

  // Test/daemon-self mode: execute directly
  const root = requireLazyRoot();
  return await handleStartTask(root, params) as StartTaskRpcResult;
}

// --- Get Daemon MCP Config ---

export interface DaemonMcpConfigResult {
  configPath: string;
}

export async function queryDaemonMcpConfig(params: {
  name?: string;
}): Promise<DaemonMcpConfigResult> {
  const rpc = await tryRpc<DaemonMcpConfigResult>('getDaemonMcpConfig', {
    name: params.name,
  });
  if (rpc) return rpc;

  // Test/daemon-self mode: execute directly
  const root = requireLazyRoot();
  return await handleGetDaemonMcpConfig(root, params) as DaemonMcpConfigResult;
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
}): Promise<AskTaskRpcResult> {
  const rpc = await tryRpc<AskTaskRpcResult>('askTask', {
    taskId: params.taskId,
    message: params.message,
    effortOverride: params.effortOverride,
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

export async function queryAcceptTask(params: {
  taskId: string;
  reason?: string;
  approvedFiles?: string[];
  acceptDirtyWorktree?: boolean;
}): Promise<AcceptTaskRpcResult> {
  const rpc = await tryRpc<AcceptTaskRpcResult>('acceptTask', {
    taskId: params.taskId,
    reason: params.reason,
    approvedFiles: params.approvedFiles,
    acceptDirtyWorktree: params.acceptDirtyWorktree,
  });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  return await handleAcceptTask(root, params) as AcceptTaskRpcResult;
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
}): Promise<RejectTaskRpcResult> {
  const rpc = await tryRpc<RejectTaskRpcResult>('rejectTask', {
    taskId: params.taskId,
    reason: params.reason,
    acceptDirtyWorktree: params.acceptDirtyWorktree,
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
}): Promise<CloseTaskRpcResult> {
  const rpc = await tryRpc<CloseTaskRpcResult>('closeTask', {
    taskId: params.taskId,
    reason: params.reason,
    acceptDirtyWorktree: params.acceptDirtyWorktree,
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
}): Promise<StopTaskRpcResult> {
  const rpc = await tryRpc<StopTaskRpcResult>('stopTask', {
    taskId: params.taskId,
    reason: params.reason,
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
}): Promise<SubmitTaskRpcResult> {
  const rpc = await tryRpc<SubmitTaskRpcResult>('submitTask', {
    taskId: params.taskId,
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
}): Promise<ResumeTaskRpcResult> {
  const rpc = await tryRpc<ResumeTaskRpcResult>('resumeTask', {
    taskId: params.taskId,
    modelOverride: params.modelOverride,
    effortOverride: params.effortOverride,
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
}): Promise<SyncTaskRpcResult> {
  const rpc = await tryRpc<SyncTaskRpcResult>('syncTask', {
    taskId: params.taskId,
  });
  if (rpc) return rpc;

  const root = requireLazyRoot();
  return await handleSyncTask(root, params) as SyncTaskRpcResult;
}
