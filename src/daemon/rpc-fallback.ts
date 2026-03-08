/**
 * RPC fallback layer — encapsulates daemon-vs-direct execution.
 *
 * CLI commands call these functions to get structured data.
 * Each function tries the daemon RPC first, then falls back to
 * calling the handler directly (same code the daemon runs).
 * The caller never knows which path ran.
 *
 * This module is intentionally thin — all command logic lives in
 * rpc-handlers.ts. This file only handles:
 * 1. tryRpc → if null → call handler with project root
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
