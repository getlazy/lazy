/**
 * Multi-task wait: race a SET of tasks and return as soon as the FIRST one
 * finishes its turn.
 *
 * Why this lives in its own module: the daemon holds ONE heartbeat-framed
 * request open for the whole race and polls every target internally. Doing the
 * race client-side (N parallel `wait` requests) would burn one connection per
 * task and still leave the client to cancel the losers — see the heartbeat
 * framing notes in src/daemon/heartbeat.ts.
 *
 * The polling core takes a storage-shaped dependency so it can be unit-tested
 * without a daemon.
 */

import { RpcError } from './rpc-handlers';
import { displayId } from '../cli/helpers';
import type { Task } from '../types';

export const WAIT_POLL_INTERVAL_MS = 1500;
export const WAIT_MAX_TIMEOUT_S = 600;

/** The slice of Storage the wait race needs. */
export interface WaitStorage {
  resolveTask(input: string): Promise<{ task: Task | null; ambiguousMatches?: Task[] }>;
  getTask(id: string): Promise<Task | null>;
  getSessionByTaskId(id: string): Promise<{ id: string } | null>;
  getTurnCountByTaskId(id: string): Promise<number>;
  getSessionTurns(sessionId: string): Promise<Array<{ sequence: number; role: string; timestamp: number }>>;
}

/** Current state of one task in the race. */
export interface WaitTaskSnapshot {
  task_id: string;
  display_id: string;
  code: string | null;
  status: string;
}

export interface WaitRaceResult {
  /** The task that finished (or, on timeout, the first task that was waited on). */
  task_id: string;
  display_id: string;
  status: string;
  timed_out: boolean;
  turn_count?: number;
  latest_turn?: { sequence: number; role: string; timestamp: number };
  /** Every task that was waited on, with its status at return time. */
  tasks: WaitTaskSnapshot[];
  /** Tasks still working at return time (excludes the winner). */
  pending: WaitTaskSnapshot[];
  /**
   * Set ONLY when the winner's worktree holds an unresolved merge.
   *
   * INVARIANT (fix-sync-silent-conflict): wait must not report a mid-merge task
   * as a settled `blocked`. That is precisely what happened during the v0.20
   * release accept — the wait looked normal and the stranded merge only surfaced
   * much later, as a misleading "uncommitted changes" refusal from accept.
   */
  merge_state?: { merge_in_progress: boolean; unmerged_files: string[]; summary: string };
}

export interface WaitRaceOptions {
  timeoutSecs?: number;
  pollIntervalMs?: number;
}

interface WaitTarget {
  id: string;
  display: string;
  code: string | null;
  initialTurnCount: number;
  status: string;
}

/**
 * Normalize the RPC/CLI wait params into a list of task references.
 *
 * Accepts `taskId` (a single string — the original shape, still supported for
 * back-compat) and/or `taskIds` (an array). Duplicates are deduped later, once
 * references are resolved to canonical ids.
 */
export function normalizeWaitInputs(params: Record<string, unknown>): string[] {
  const inputs: string[] = [];

  const push = (value: unknown, field: string) => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new RpcError(400, `${field} must be a non-empty task reference`);
    }
    inputs.push(value.trim());
  };

  if (Array.isArray(params.taskIds)) {
    for (const value of params.taskIds) push(value, 'taskIds[]');
  } else if (params.taskIds !== undefined) {
    throw new RpcError(400, 'taskIds must be an array of task references');
  }

  if (Array.isArray(params.taskId)) {
    for (const value of params.taskId) push(value, 'taskId[]');
  } else if (params.taskId !== undefined) {
    push(params.taskId, 'taskId');
  }

  if (inputs.length === 0) {
    throw new RpcError(400, 'taskId is required');
  }

  return inputs;
}

function snapshot(target: WaitTarget, status: string): WaitTaskSnapshot {
  return { task_id: target.id, display_id: target.display, code: target.code, status };
}

/**
 * Resolve every reference up front.
 *
 * INVARIANT: one bad reference fails the WHOLE call, naming it. Silently racing
 * the valid subset would leave the caller waiting on fewer tasks than it asked
 * for, with no way to tell.
 */
async function resolveTargets(storage: WaitStorage, inputs: string[]): Promise<WaitTarget[]> {
  const resolvedTasks: Task[] = [];
  const seen = new Set<string>();

  // Pass 1: every reference must name a real task. An unresolvable reference is
  // reported before any "not started yet" complaint — a typo is the more likely
  // and more confusing failure of the two.
  for (const input of inputs) {
    const resolved = await storage.resolveTask(input);
    if (!resolved.task) {
      throw new RpcError(404, `Task not found: ${input}`);
    }
    // Dedupe on the canonical id, so `lazy wait abc1 abc1` and
    // `lazy wait abc12345 my-code` (same task) each poll it once.
    if (seen.has(resolved.task.id)) continue;
    seen.add(resolved.task.id);
    resolvedTasks.push(resolved.task);
  }

  // Pass 2: capture each target's starting state.
  const targets: WaitTarget[] = [];
  for (const task of resolvedTasks) {
    // A task that was never started has nothing to wait for and never will —
    // say so, instead of reporting "now backlog" and a bare non-zero exit. The
    // CLI gave this guidance before `lazy wait` became a thin RPC wrapper.
    const session = await storage.getSessionByTaskId(task.id);
    if (!session) {
      const ref = displayId(task);
      throw new RpcError(400, `Task ${ref} has no session. Start it with: lazy start ${ref}`);
    }

    targets.push({
      id: task.id,
      display: displayId(task),
      code: task.code ?? null,
      initialTurnCount: await storage.getTurnCountByTaskId(task.id),
      status: task.status,
    });
  }

  return targets;
}

/** Re-read every target's status so the reported set is current, not stale. */
async function currentSnapshots(
  storage: WaitStorage,
  targets: WaitTarget[],
  known: Map<string, string>,
): Promise<WaitTaskSnapshot[]> {
  const out: WaitTaskSnapshot[] = [];
  for (const target of targets) {
    const cached = known.get(target.id);
    if (cached !== undefined) {
      out.push(snapshot(target, cached));
      continue;
    }
    const task = await storage.getTask(target.id);
    out.push(snapshot(target, task?.status ?? 'unknown'));
  }
  return out;
}

function buildResult(
  winner: WaitTarget,
  winnerStatus: string,
  tasks: WaitTaskSnapshot[],
  extra: Partial<WaitRaceResult>,
): WaitRaceResult {
  return {
    task_id: winner.id,
    display_id: winner.display,
    status: winnerStatus,
    timed_out: false,
    ...extra,
    tasks,
    pending: tasks.filter(t => t.task_id !== winner.id && t.status === 'working'),
  };
}

/**
 * Poll a set of tasks until the FIRST one leaves 'working' or records a new
 * agent turn, or the timeout expires.
 */
export async function raceWait(
  storage: WaitStorage,
  inputs: string[],
  options: WaitRaceOptions = {},
): Promise<WaitRaceResult> {
  const timeoutSecs = Math.min(options.timeoutSecs ?? WAIT_MAX_TIMEOUT_S, WAIT_MAX_TIMEOUT_S);
  const pollIntervalMs = options.pollIntervalMs ?? WAIT_POLL_INTERVAL_MS;

  const targets = await resolveTargets(storage, inputs);

  // A task that is already not working wins immediately — same early return as
  // the original single-task wait.
  const alreadyDone = targets.find(t => t.status !== 'working');
  if (alreadyDone) {
    const known = new Map(targets.map(t => [t.id, t.status]));
    const tasks = await currentSnapshots(storage, targets, known);
    return buildResult(alreadyDone, alreadyDone.status, tasks, {});
  }

  const deadline = Date.now() + timeoutSecs * 1000;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

    // Statuses observed during THIS sweep, so the reported set reflects the
    // moment the winner fired rather than a second round of reads.
    const observed = new Map<string, string>();

    for (const target of targets) {
      // Use the shared long-lived storage instance — no lock acquisition per poll
      const task = await storage.getTask(target.id);
      if (!task) {
        throw new RpcError(404, `Task disappeared: ${target.display}`);
      }
      observed.set(target.id, task.status);

      // Status changed from working — done
      if (task.status !== 'working') {
        const tasks = await currentSnapshots(storage, targets, observed);
        return buildResult(target, task.status, tasks, {});
      }

      // Check if turn count increased with an agent turn
      const currentTurnCount = await storage.getTurnCountByTaskId(target.id);
      if (currentTurnCount > target.initialTurnCount) {
        // Verify the latest turn is from the agent
        const sess = await storage.getSessionByTaskId(target.id);
        if (sess) {
          const turns = await storage.getSessionTurns(sess.id);
          const latestTurn = turns[turns.length - 1];
          if (latestTurn && latestTurn.role === 'agent') {
            const tasks = await currentSnapshots(storage, targets, observed);
            return buildResult(target, task.status, tasks, {
              turn_count: currentTurnCount,
              latest_turn: {
                sequence: latestTurn.sequence,
                role: latestTurn.role,
                timestamp: latestTurn.timestamp,
              },
            });
          }
        }
      }
    }
  }

  // Timed out — every task is still working. `task_id` stays the first task so
  // the single-task response shape is unchanged; `tasks` is authoritative.
  const tasks = await currentSnapshots(storage, targets, new Map());
  return {
    task_id: targets[0].id,
    display_id: targets[0].display,
    status: 'working',
    timed_out: true,
    tasks,
    pending: tasks.filter(t => t.status === 'working'),
  };
}
