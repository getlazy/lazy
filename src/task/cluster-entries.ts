/**
 * Reading the clusters out of a store, and putting them in the order a reader
 * wants them.
 *
 * Two clients now ask the same question — the dashboard's `/clusters` page and
 * the `clusters` RPC a remote client (Lazy Teams) reads — so the read, the sort
 * and the "how many are still open" count live here rather than in either one.
 * The PROGRESS is still `clusterProgressOf` (./cluster-progress.ts) and is derived
 * from the children on every read; nothing here stores or recounts anything.
 */

import type { Storage, Task } from '../storage';
import { isClusterTask, isTerminalStatus } from '../types';

/** One cluster with the children its progress is derived from. */
export interface ClusterEntry {
  task: Task;
  children: Task[];
}

/**
 * Every `cluster` task with its direct children.
 *
 * Children are read per cluster rather than by scanning the whole store: a
 * project has few clusters, and `getChildTasks` is an index lookup. They are read
 * in FULL, including terminal ones — a k-of-n whose denominator came from a
 * non-terminal listing would count nothing that had already landed.
 */
export async function listClusterEntries(storage: Storage): Promise<ClusterEntry[]> {
  const clusters = (await storage.listTasks()).filter((t) => isClusterTask(t));
  return Promise.all(
    clusters.map(async (task) => ({ task, children: await storage.getChildTasks(task.id) })),
  );
}

/**
 * Clusters in reading order: the ones still running come first (they are what a
 * clusters listing is for), each group newest-first. A finished cluster stays
 * listed — its k-of-n is the record of what it did.
 */
export function sortClusterEntries(entries: readonly ClusterEntry[]): ClusterEntry[] {
  return [...entries].sort((a, b) => {
    const aDone = isTerminalStatus(a.task.status) ? 1 : 0;
    const bDone = isTerminalStatus(b.task.status) ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    return b.task.created_at - a.task.created_at;
  });
}

/** How many clusters are still live — the nav badge's number. */
export function activeClusterCount(tasks: readonly Task[]): number {
  return tasks.filter((t) => !isTerminalStatus(t.status)).length;
}
