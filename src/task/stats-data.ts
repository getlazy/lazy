/**
 * Loading the records a Stats readout is derived from — one task, or a task and
 * every descendant.
 *
 * ONE LOADER, because there are three surfaces. The web Stats tab renders it,
 * the `taskStats` RPC serves it to a client that is not the daemon (Lazy Teams),
 * and the CLI's `stats tools --subtree` folds the same subtree together. What
 * "including all descendants" means — which tasks, how their wall clocks
 * combine, whose tool records are folded together — is a business rule, so it
 * is answered here rather than three times over.
 *
 * The derivation itself stays pure in `src/task/stats.ts`; this module only
 * decides what to read.
 */

import type { Storage } from '../storage/interface';
import type { Task } from '../types';
import type { ProxyAuditRecord, TaskToolStatsRecord } from '../storage/types';
import { loadConfig } from '../config/loader';
import { readAuditRecords } from '../proxy/audit-log';
import { logger } from '../utils/logger';
import { join } from 'path';
import {
  buildSubtreeStats,
  buildTaskStats,
  type StatsScope,
  type TaskStats,
  type TaskStatsPart,
} from './stats';

/**
 * Hard cap on audit records a Stats readout reads. The whole log is bounded by
 * construction at 8 MiB, and `readAuditRecords` stops walking segments once the
 * limit is met — so this is a ceiling on parse cost, not a page of results
 * hiding a slow query.
 */
export const STATS_AUDIT_RECORD_LIMIT = 20000;

export interface TaskStatsResult {
  stats: TaskStats;
  /** The scope actually used — `task` when a subtree was asked for but is empty. */
  scope: StatsScope;
  /**
   * Descendants the task HAS, whatever scope was rendered. The toggle needs
   * this in both views: a task-scoped readout still has to say what folding in
   * the subtree would add.
   */
  descendantCount: number;
}

/**
 * Every descendant of `rootId`, at every depth, newest-parent-first per level.
 *
 * Walked through `getChildTasks`, which FileStorage answers from its task index
 * — O(subtree) file reads rather than the whole-store scan `collectSubtreeIds`
 * needs to be given. Cycle-safe the same way `countDescendants` is: a corrupt
 * parent link is visited once, not forever.
 */
export async function collectDescendantTasks(storage: Storage, rootId: string): Promise<Task[]> {
  const seen = new Set<string>([rootId]);
  const out: Task[] = [];
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of await storage.getChildTasks(current)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

/** Session, turns, commits and status history for one task. */
export async function loadStatsPart(storage: Storage, task: Task): Promise<TaskStatsPart> {
  const session = await storage.getSessionByTaskId(task.id);
  const [turns, commits, statusHistory] = await Promise.all([
    session ? storage.getSessionTurns(session.id) : Promise.resolve([]),
    session ? storage.getSessionCommits(session.id) : Promise.resolve([]),
    storage.getStatusHistory(task.id),
  ]);
  return { task, session, turns, commits, statusHistory };
}

/**
 * Each task's durable tool-stats record, by task id.
 *
 * A task with none is mapped to null — it ran before lazy kept them, or its
 * traffic never went through the proxy. That is a real answer the surfaces
 * state as such, never as "this task called no tools". A read that throws is
 * treated the same way: statistics must not take a page or an RPC down.
 */
export async function loadToolStatsRecords(
  storage: Storage,
  taskIds: string[],
): Promise<Map<string, TaskToolStatsRecord | null>> {
  const entries = await Promise.all(
    taskIds.map(async (id) => {
      try {
        return [id, await storage.getToolStats(id)] as const;
      } catch (err) {
        logger.debug(`tool stats for ${id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
        return [id, null] as const;
      }
    }),
  );
  return new Map(entries);
}

/**
 * The proxy audit trail, or null when it could not be read.
 *
 * Disposable telemetry: an unreadable log must never take a page or an RPC
 * down, and `null` is rendered as "not read", never as "no tools were called".
 *
 * NOT read by {@link loadTaskStats} any more — the per-tool table comes from
 * the durable records above, which do not expire, so opening the Stats tab no
 * longer parses the trail at all. Kept for a caller that asks a WINDOWED
 * question, where only the trail can answer; `lazy stats tools --since` reads
 * it through `readAuditRecords` directly because its `--limit` is the user's.
 */
export async function readStatsAuditRecords(projectRoot: string): Promise<ProxyAuditRecord[] | null> {
  try {
    const config = await loadConfig(projectRoot);
    return await readAuditRecords(join(projectRoot, config.data.path), {
      limit: STATS_AUDIT_RECORD_LIMIT,
    });
  } catch (err) {
    logger.debug(`proxy audit for stats: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export interface LoadTaskStatsOptions {
  scope: StatsScope;
  /**
   * The root task's own records, when the caller already has them. The web
   * route loads a task's session, turns and commits for every tab, so without
   * this the Stats tab would read them a second time.
   */
  root?: TaskStatsPart;
  now?: number;
  turnChartLimit?: number;
}

/**
 * Build a task's stats in the requested scope.
 *
 * A `subtree` scope over a task with no descendants falls back to `task`: the
 * two readouts would be identical, and claiming a rollup happened when nothing
 * was folded in is the kind of small lie this whole tab exists not to tell.
 */
export async function loadTaskStats(
  storage: Storage,
  task: Task,
  options: LoadTaskStatsOptions,
): Promise<TaskStatsResult> {
  const root = options.root ?? (await loadStatsPart(storage, task));

  if (options.scope === 'subtree') {
    const descendants = await collectDescendantTasks(storage, task.id);
    if (descendants.length > 0) {
      const parts = await Promise.all(descendants.map((d) => loadStatsPart(storage, d)));
      return {
        stats: buildSubtreeStats({
          root,
          descendants: parts,
          toolStatsRecords: await loadToolStatsRecords(storage, [
            task.id,
            ...descendants.map((d) => d.id),
          ]),
          now: options.now,
          turnChartLimit: options.turnChartLimit,
        }),
        scope: 'subtree',
        descendantCount: descendants.length,
      };
    }
  }

  // The task-scoped view reads only its DIRECT children's histories — they are
  // what the waiting-on-subtasks overlap is derived from — and takes the
  // descendant count off the index rather than walking the tree to find it. The
  // count is only there for the toggle, and walking for it would make the
  // narrow view cost as much as the wide one.
  const directChildren = await storage.getChildTasks(task.id);
  const childHistories = new Map(
    await Promise.all(
      directChildren.map(
        async (child) => [child.id, await storage.getStatusHistory(child.id)] as const,
      ),
    ),
  );
  const counts = await storage.countDescendants([task.id]);
  return {
    stats: buildTaskStats({
      ...root,
      childHistories: childHistories.size > 0 ? childHistories : undefined,
      toolStatsRecord: (await loadToolStatsRecords(storage, [task.id])).get(task.id) ?? null,
      now: options.now,
      turnChartLimit: options.turnChartLimit,
    }),
    scope: 'task',
    descendantCount: counts[task.id] ?? 0,
  };
}
