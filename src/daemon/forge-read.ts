/**
 * On-demand, READ-ONLY forge reads for agents and builders: a task's PR/MR
 * conversation (`lazy_review_comments`) and its review verdicts, mergeability
 * and CI (`lazy_review_status`).
 *
 * The daemon already holds the forge credential (auto-react and remote-sync
 * read the forge with it), so answering here puts no token in any container.
 * Three rules keep that from turning the daemon into a general forge proxy:
 *
 *  - SCOPE comes from the caller's token, never an argument. A task agent sees
 *    only its OWN task's PR/MR; the builder may name any task in the project.
 *  - The PR/MR is the one RECORDED on the task (the forge metadata written at
 *    submit/link). There is no URL, repo or number argument to redirect it.
 *  - Answers are CACHED per task and kind for {@link FORGE_READ_TTL_MS}, so a
 *    polling agent cannot burn the forge's rate limit. Only successes are
 *    cached: a refusal someone fixes (e.g. going back online) is re-asked.
 */

import { join } from 'path';
import type { Storage } from '../storage';
import type { Task } from '../types';
import type { RepositoryDriver, ReviewConversationItem, ReviewStatus } from '../remote/driver';
import { loadConfig } from '../config/loader';
import { createDriver, LocalDriver } from '../remote';
import { isOfflineMode } from '../utils/offline';

export const FORGE_READ_TTL_MS = 60_000;

export type ForgeReadKind = 'conversation' | 'status';

export type ForgeReadCaller = { kind: 'task'; taskId: string } | { kind: 'builder' };

export interface ForgeReadResult<T> {
  task: string;
  url: string | null;
  /** When the forge was actually asked — older than "now" when served from cache. */
  fetchedAt: string;
  cached: boolean;
  data: T;
}

const cache = new Map<string, { at: number; url: string | null; data: ReviewConversationItem[] | ReviewStatus }>();

/** Test seam: how many answers are held. */
export function forgeReadCacheSizeForTest(): number {
  return cache.size;
}

/** Test seam: forget every cached answer. */
export function resetForgeReadCacheForTest(): void {
  cache.clear();
}

export interface ForgeReadOptions {
  /** Builder only: which task's PR/MR. A task agent may omit it or name itself. */
  taskRef?: string;
  now?: number;
  /** Test seam: the driver to read through, skipping config, offline and factory. */
  driver?: RepositoryDriver;
}

export async function readTaskForge(
  projectRoot: string,
  storage: Storage,
  caller: ForgeReadCaller,
  kind: ForgeReadKind,
  opts: ForgeReadOptions = {},
): Promise<ForgeReadResult<ReviewConversationItem[] | ReviewStatus>> {
  const { taskRef, now = Date.now() } = opts;
  const task = await resolveTarget(storage, caller, taskRef);
  const label = task.code ?? task.id.substring(0, 8);

  const key = `${task.id}:${kind}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < FORGE_READ_TTL_MS) {
    return { task: label, url: hit.url, fetchedAt: new Date(hit.at).toISOString(), cached: true, data: hit.data };
  }
  if (hit) cache.delete(key);

  const driver = opts.driver ?? await driverFor(projectRoot, storage);
  if (!driver.hasRemoteRef(task)) {
    throw new Error(`Task ${label} has no PR/MR recorded — there is nothing on the forge to read.`);
  }
  let data: ReviewConversationItem[] | ReviewStatus;
  try {
    data = kind === 'conversation'
      ? await driver.readReviewConversation(task)
      : await driver.readReviewStatus(task);
  } catch (err) {
    throw new Error(`Could not read ${label}'s PR/MR from the forge: ${err instanceof Error ? err.message : String(err)}`);
  }
  const url = driver.getRemoteRefUrl(task);
  // Sweep expired answers on every write, so a long-running daemon holds only
  // what was read in the last TTL — not every conversation it ever fetched.
  for (const [k, v] of cache) {
    if (now - v.at >= FORGE_READ_TTL_MS) cache.delete(k);
  }
  cache.set(key, { at: now, url, data });
  return { task: label, url, fetchedAt: new Date(now).toISOString(), cached: false, data };
}

async function driverFor(projectRoot: string, storage: Storage): Promise<RepositoryDriver> {
  const config = await loadConfig(projectRoot);
  if (await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline)) {
    throw new Error('lazy is offline, so the forge cannot be read. Try again once lazy is back online.');
  }
  let driver: RepositoryDriver;
  try {
    driver = createDriver(config, { storage, lazyRoot: projectRoot });
  } catch (err) {
    throw new Error(`No forge is configured for this project: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The local driver answers hasRemoteRef() false for every task, which would
  // read as "no PR/MR recorded"; the truth is that there is no forge at all.
  if (driver instanceof LocalDriver) {
    throw new Error('This project uses the local driver: there is no forge, so no PR/MR to read.');
  }
  return driver;
}

async function resolveTarget(storage: Storage, caller: ForgeReadCaller, taskRef: string | undefined): Promise<Task> {
  if (caller.kind === 'task') {
    const own = await storage.getTask(caller.taskId);
    if (!own) throw new Error('This task token no longer resolves to a task.');
    if (taskRef) {
      const named = (await storage.resolveTask(taskRef)).task;
      if (!named || named.id !== own.id) {
        throw new Error('A task agent may read only its own task\'s PR/MR. Omit `task`.');
      }
    }
    return own;
  }
  if (!taskRef) throw new Error('`task` is required: name the task whose PR/MR to read.');
  const { task, ambiguousMatches } = await storage.resolveTask(taskRef);
  if (!task) {
    throw new Error(ambiguousMatches?.length
      ? `Task reference "${taskRef}" is ambiguous (${ambiguousMatches.length} matches).`
      : `Task not found: ${taskRef}`);
  }
  return task;
}
