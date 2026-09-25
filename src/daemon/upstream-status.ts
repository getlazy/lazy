/**
 * No-network answer to "is this task behind its parent, and would sync conflict?"
 *
 * One RPC, reused by the Landing header, Current review, `lazy show`, and
 * MCP `lazy_show`. Resolution goes through `resolveUpstreamMergeRef` with
 * `refreshRemote: false` — the same no-fetch rule as a rendered diff
 * (`src/task-diff-base.ts`). A stale remote-tracking ref is acceptable; the
 * UI says "as of last fetch".
 *
 * Cached in-process by (task HEAD, upstream HEAD) so a tab switch does not
 * redo the merge-tree. The cache key IS the invalidation.
 */

import { createDriver } from '../remote';
import { resolveUpstreamMergeRef } from '../remote/upstream-ref';
import { mergeConflictPreview } from '../git/operations';
import { loadConfig } from '../config/loader';
import { getWorktreePath, displayId, getBranchNameFromId } from '../task/identity';
import { integrationBranchOf, parentTaskIdOf } from '../task-target';
import { getRemoteDefaultBranch } from '../git/operations';
import { runGit } from '../utils/git';
import { pathExists } from '../utils/fs';
import { getOrCreateStorage } from './rpc-handlers';
import { RpcError } from './rpc-error';
import { logger } from '../utils/logger';
import { pinnedBaseOf } from '../task/base-pin';

export type TaskUpstreamStatus =
  | {
      kind: 'ok';
      behind: number;
      ahead: number;
      wouldConflict: boolean;
      conflictFiles: string[];
      upstreamRef: string;
      parentLabel: string;
      computedAt: string;
      asOfLastFetch: boolean;
      /** Full SHA the task is pinned to (lazy clone --same-base), or null. */
      pinnedTo: string | null;
    }
  | {
      kind: 'unknown';
      reason: string;
      computedAt: string;
      /** Set when the task is pinned (lazy clone --same-base), so the pin shows even here. */
      pinnedTo?: string | null;
    };

const cache = new Map<string, TaskUpstreamStatus>();
const CACHE_CAP = 64;

function cacheGet(key: string): TaskUpstreamStatus | undefined {
  return cache.get(key);
}

function cacheSet(key: string, value: TaskUpstreamStatus): void {
  if (cache.size >= CACHE_CAP && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

/** Test seam — the cache is otherwise process-lifetime. */
export function clearUpstreamStatusCache(): void {
  cache.clear();
}

async function shaOf(ref: string, cwd: string): Promise<string | null> {
  const result = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

async function leftRightCount(
  ours: string,
  theirs: string,
  cwd: string,
): Promise<{ ahead: number; behind: number }> {
  // `ours...theirs`: left = commits on ours not in theirs (ahead),
  // right = commits on theirs not in ours (behind).
  const result = await runGit(
    ['rev-list', '--left-right', '--count', `${ours}...${theirs}`],
    { cwd },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git rev-list --left-right --count ${ours}...${theirs} failed: ${result.stderr || 'unknown error'}`,
    );
  }
  const [ahead, behind] = result.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10));
  if (Number.isNaN(ahead) || Number.isNaN(behind)) {
    throw new Error(
      `git rev-list --left-right --count returned unexpected output: ${JSON.stringify(result.stdout)}`,
    );
  }
  return { ahead, behind };
}

export async function getTaskUpstreamStatus(
  projectRoot: string,
  taskId: string,
): Promise<TaskUpstreamStatus> {
  const status = await computeTaskUpstreamStatus(projectRoot, taskId);
  if (status.kind === 'unknown') {
    // A pinned clone in backlog has no worktree yet — the pin is still news.
    const storage = await getOrCreateStorage();
    const task = (await storage.resolveTask(taskId)).task;
    const pinnedTo = task ? pinnedBaseOf(task) : null;
    if (pinnedTo) return { ...status, pinnedTo };
  }
  return status;
}

async function computeTaskUpstreamStatus(
  projectRoot: string,
  taskId: string,
): Promise<TaskUpstreamStatus> {
  const computedAt = new Date().toISOString();
  const storage = await getOrCreateStorage();
  const resolved = await storage.resolveTask(taskId);
  if (!resolved.task) {
    throw new RpcError(404, `Task not found: ${taskId}`);
  }
  const task = resolved.task;
  const session = await storage.getSessionByTaskId(task.id);
  if (!session) {
    return { kind: 'unknown', reason: 'Task has no session yet.', computedAt };
  }

  const worktreePath = getWorktreePath(projectRoot, task);
  if (!(await pathExists(worktreePath))) {
    return { kind: 'unknown', reason: 'Task has no worktree.', computedAt };
  }

  const config = await loadConfig(projectRoot);
  const parentId = parentTaskIdOf(task);
  const parentLabel = parentId
    ? await getBranchNameFromId(parentId, storage)
    : (integrationBranchOf(task)
      ?? await getRemoteDefaultBranch(projectRoot, config.remote.git_remote));

  let upstreamRef: string;
  try {
    const resolution = await resolveUpstreamMergeRef(
      createDriver(config),
      parentLabel,
      worktreePath,
      { remoteName: config.remote.git_remote, refreshRemote: false },
    );
    upstreamRef = resolution.ref;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: 'unknown', reason: `Could not resolve upstream ref: ${detail}`, computedAt };
  }

  const taskHead = await shaOf('HEAD', worktreePath);
  const upstreamHead = await shaOf(upstreamRef, worktreePath);
  if (!taskHead) {
    return { kind: 'unknown', reason: 'Task HEAD does not resolve.', computedAt };
  }
  if (!upstreamHead) {
    return {
      kind: 'unknown',
      reason: `Upstream ref '${upstreamRef}' does not resolve (as of last fetch).`,
      computedAt,
    };
  }

  const cacheKey = `${task.id}:${taskHead}:${upstreamHead}:${pinnedBaseOf(task) ?? ''}`;
  const hit = cacheGet(cacheKey);
  if (hit) return hit;

  try {
    const { ahead, behind } = await leftRightCount('HEAD', upstreamRef, worktreePath);
    let wouldConflict = false;
    let conflictFiles: string[] = [];
    if (behind > 0) {
      const preview = await mergeConflictPreview('HEAD', upstreamRef, worktreePath);
      wouldConflict = preview.wouldConflict;
      conflictFiles = preview.files;
    }
    const status: TaskUpstreamStatus = {
      kind: 'ok',
      pinnedTo: pinnedBaseOf(task),
      behind,
      ahead,
      wouldConflict,
      conflictFiles,
      upstreamRef,
      parentLabel,
      computedAt,
      asOfLastFetch: true,
    };
    cacheSet(cacheKey, status);
    return status;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.debug(`getTaskUpstreamStatus ${displayId(task)}: ${detail}`);
    return { kind: 'unknown', reason: detail, computedAt };
  }
}

/**
 * One line, same wording on CLI, MCP and the web header.
 *
 *   Upstream: up to date with main
 *   Upstream: behind 3, would merge cleanly
 *   Upstream: behind 3, would conflict (2 files)
 *   Upstream: pinned to 1a2b3c4d5e6f, 3 behind main (no automatic sync)
 *   Upstream: unknown (no worktree)
 */
export function formatUpstreamStatusLine(status: TaskUpstreamStatus): string {
  if (status.kind === 'unknown') {
    if (status.pinnedTo) return `Upstream: pinned to ${status.pinnedTo.substring(0, 12)} (no automatic sync; lazy sync lifts the pin) — ${status.reason}`;
    return `Upstream: unknown (${status.reason})`;
  }
  if (status.pinnedTo) {
    return `Upstream: ${pinnedPhrase(status)}`;
  }
  if (status.behind === 0) {
    return `Upstream: up to date with ${status.parentLabel}`;
  }
  const conflict = status.wouldConflict
    ? `would conflict (${status.conflictFiles.length || '?'} file${status.conflictFiles.length === 1 ? '' : 's'})`
    : 'would merge cleanly';
  return `Upstream: behind ${status.behind}, ${conflict}`;
}

/** The sentence the Landing header renders, including the parent name. */
export function formatUpstreamStatusHtmlLine(status: TaskUpstreamStatus): string {
  if (status.kind === 'unknown') {
    if (status.pinnedTo) return `Pinned to ${status.pinnedTo.substring(0, 12)} (no automatic sync; lazy sync lifts the pin) — ${status.reason}`;
    return `Unknown: ${status.reason}`;
  }
  if (status.pinnedTo) {
    const phrase = pinnedPhrase(status);
    return phrase.charAt(0).toUpperCase() + phrase.slice(1);
  }
  if (status.behind === 0) {
    const ahead = status.ahead > 0 ? ` · ${status.ahead} ahead` : '';
    return `Up to date with ${status.parentLabel}${ahead}`;
  }
  if (status.wouldConflict) {
    const named = status.conflictFiles.slice(0, 5);
    const extra = status.conflictFiles.length > 5
      ? ` +${status.conflictFiles.length - 5} more`
      : '';
    const files = named.length ? ` in: ${named.join(', ')}${extra}` : '';
    return `Behind ${status.parentLabel} by ${status.behind} — sync would CONFLICT${files}`;
  }
  return `Behind ${status.parentLabel} by ${status.behind} commits — sync will merge cleanly`;
}

/**
 * A pinned task (lazy clone --same-base) is behind its parent ON PURPOSE, so it
 * says so instead of inviting a sync: "pinned to <sha>, N behind <parent>".
 */
function pinnedPhrase(status: Extract<TaskUpstreamStatus, { kind: 'ok' }>): string {
  const sha = (status.pinnedTo ?? '').substring(0, 12);
  const behind = status.behind === 0
    ? `up to date with ${status.parentLabel}`
    : `${status.behind} behind ${status.parentLabel}`;
  return `pinned to ${sha}, ${behind} (no automatic sync; lazy sync lifts the pin)`;
}
