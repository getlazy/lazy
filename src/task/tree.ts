/**
 * The task tree, with each node's live facts resolved.
 *
 * `buildTaskTree` is what answers "what is going on in this project" — run
 * liveness, working substate, retry counts, protection markers, the slow-lane
 * auto-resume queue — and it is read by every listing surface: the daemon's
 * `list` and `active` RPCs (and through them the web UI and Teams), and the
 * CLI's own tree output. Only the RENDERING of a node is a CLI concern, so the
 * printing stays in `src/cli/commands/list.ts` and the derivation lives here.
 */

import { join } from 'path';
import { taskRef } from './identity';
import type { Task, Session, Storage } from '../storage';
import { protocolDir as getProtocolDir, readStatus } from '../protocol';
import { createRunner } from '../runner';
import { parentTaskIdOf } from '../task-target';
import type { WorkingSubstate } from '../utils/working-substate';
import { probeWorkingRun } from '../utils/working-run';
import { loadConfig } from '../config/loader';
import { logger } from '../utils/logger';
import { listSlowLaneQueue, getLastProjectAutoResumeAt } from '../daemon/auto-resume-queue';
import {
  loadProtectionContext,
  contextIsInert,
  protectionStatusForTask,
  type TaskProtectionStatus,
} from '../protection/status';

export interface TaskWithSession {
  task: Task;
  session: Session | null;
  turnCount: number;
  children: TaskWithSession[];
  retryCount?: number;
  crashed?: boolean;
  /**
   * Derived working substate (agent / harness:<phase> / not-alive) for `working`
   * tasks. Observational only — never changes task state. Undefined for
   * non-working tasks or when no substate can be derived.
   */
  workingSubstate?: WorkingSubstate;
  /**
   * Read-only protection status, present only when the project protects
   * anything. Undefined in a stock project so nothing is computed and nothing
   * is rendered — list output stays byte-for-byte what it was.
   */
  protection?: TaskProtectionStatus;
  /**
   * Slow-lane auto-resume queue position (src/daemon/auto-resume-queue.ts),
   * present only for `interrupted` tasks whose fast-lane circuit breaker has
   * tripped and are now waiting for a round-robin retry. Undefined otherwise —
   * including when daemon.auto_resume is off, since nothing is queued then.
   */
  autoResume?: { attempts: number; maxAttempts: number; nextEligibleAt: number };
  /**
   * How many descendants of this task were elided by a `--levels` limit.
   * Present only on the deepest visible rows of a depth-limited listing, so a
   * truncated view always says what it is not showing. Undefined otherwise.
   */
  hiddenDescendants?: number;
}

export async function buildTaskTree(
  storage: Storage,
  tasks: Task[],
  lazyRoot: string,
  opts: { hiddenDescendants?: Map<string, number> } = {},
): Promise<TaskWithSession[]> {
  const runner = await createRunner(lazyRoot);
  const taskMap = new Map<string, TaskWithSession>();

  // Protection facts resolved ONCE for the whole listing: one config read, one
  // default-branch lookup, one resolve per protected entry — not N of each. An
  // inert context (nothing protected anywhere) skips the per-task work below.
  let protectionCtx = null as Awaited<ReturnType<typeof loadProtectionContext>> | null;
  const config = await loadConfig(lazyRoot);
  try {
    const ctx = await loadProtectionContext(storage, config, lazyRoot);
    if (!contextIsInert(ctx)) protectionCtx = ctx;
  } catch (err) {
    // A listing must never fail over an advisory marker.
    logger.debug(`Protection markers unavailable for this listing: ${err instanceof Error ? err.message : err}`);
  }

  // Slow-lane auto-resume queue positions, computed once against ALL tasks
  // (the queue's round-robin order is a project-wide fact, not scoped to this
  // view). Skipped entirely when nothing is interrupted or auto_resume is off,
  // so a stock listing pays nothing extra.
  const autoResumeMap = new Map<string, { attempts: number; maxAttempts: number; nextEligibleAt: number }>();
  if (config.daemon.auto_resume && tasks.some(t => t.status === 'interrupted')) {
    try {
      const now = Date.now();
      const queue = await listSlowLaneQueue(storage, config, now);
      const dataDir = join(lazyRoot, config.data.path);
      const lastProjectAttempt = await getLastProjectAutoResumeAt(dataDir);
      const gapMs = config.daemon.auto_resume_gap_minutes * 60_000;
      const gapEligibleAt = lastProjectAttempt === null ? now : lastProjectAttempt + gapMs;
      queue.forEach((entry, i) => {
        const nextEligibleAt = Math.max(entry.intervalEligibleAt, i === 0 ? gapEligibleAt : 0);
        autoResumeMap.set(entry.task.id, { attempts: entry.attempts, maxAttempts: entry.maxAttempts, nextEligibleAt });
      });
    } catch (err) {
      // Observational only — never fail a listing over queue visibility.
      logger.debug(`Slow-lane queue unavailable for this listing: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Create nodes for all tasks
  for (const task of tasks) {
    const session = await storage.getSessionByTaskId(task.id);
    let retryCount: number | undefined;
    let crashed = false;
    let workingSubstate: WorkingSubstate | undefined;

    // Probe run liveness for non-terminal tasks.
    //
    // A WORKING task is probed through the one resolution the reconciler uses
    // (src/utils/working-run.ts): the run that speaks for the task right now —
    // a live review's own run, else the work run on the session's runner —
    // asked `isRunning`. Probing the work run on the project runner instead
    // rendered a live reviewer as working(not-alive) [CRASHED] for its whole run.
    if (session && task.status === 'working') {
      const protoDir = getProtocolDir(task.id);
      try {
        // Derive the working substate (agent / harness:<phase> / not-alive) from
        // status.json + liveness — the single shared derivation used by every
        // read surface.
        const probe = await probeWorkingRun(lazyRoot, task, session, runner);
        workingSubstate = probe.substate ?? undefined;
        // Unknown liveness (the runtime did not answer) is never a crash.
        const info = probe.alive || probe.livenessUnknown !== undefined
          ? null
          : probe.info !== undefined ? probe.info : await probe.run.runner.getRunInfo(probe.run.runName);
        crashed = info !== null && !info.running;
      } catch (err) {
        logger.debug(`Task ${task.id}: could not derive working substate: ${err instanceof Error ? err.message : err}`);
      }

      // Retry count (when retrying) is surfaced separately alongside the substate.
      const status = readStatus(protoDir);
      if (status?.phase === 'retrying' && status.retryCount !== undefined) {
        retryCount = status.retryCount;
      }
    } else if (session && !['complete', 'abandoned'].includes(task.status)) {
      const cn = session.container_name ?? runner.runNameForTask(taskRef(task));
      const info = await runner.getRunInfo(cn);
      if (info && !info.running) {
        crashed = true;
      }
    }

    let protection: TaskProtectionStatus | undefined;
    if (protectionCtx) {
      try {
        protection = await protectionStatusForTask(storage, protectionCtx, task, {
          hasBranch: Boolean(session?.git_branch),
        });
      } catch (err) {
        logger.debug(`Task ${task.id}: could not resolve protection status: ${err instanceof Error ? err.message : err}`);
      }
    }

    taskMap.set(task.id, {
      task,
      session,
      turnCount: await storage.getTurnCountByTaskId(task.id),
      children: [],
      retryCount,
      crashed,
      workingSubstate,
      protection,
      autoResume: autoResumeMap.get(task.id),
      hiddenDescendants: opts.hiddenDescendants?.get(task.id),
    });
  }

  // Build tree structure
  const roots: TaskWithSession[] = [];
  for (const node of taskMap.values()) {
    const parentId = parentTaskIdOf(node.task);
    if (parentId) {
      const parent = taskMap.get(parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        // Parent not in filtered list, treat as root
        roots.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * The task set the `active` views show: non-terminal tasks with a session.
 *
 * Shared by the daemon `active` RPC handler and the CLI's follow loop so both
 * views always agree on what "active" means.
 */
export async function collectActiveTasks(storage: Storage): Promise<Task[]> {
  return storage.listTasksWithOptions({ withSessionsOnly: true, nonTerminalOnly: true });
}
