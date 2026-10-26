/**
 * Restart a task's services after every WORK turn, so they are fresh when a
 * person looks (engineer, 2026-10-14).
 *
 * WHEN: the reconciler calls this from the end of a work turn (`start` /
 * `unblock` command), after the supervisor has handed the turn back (its
 * response is written) and before the task parks for a human. Never for an
 * ask, a review or a sync, and never while the agent's turn is still running —
 * it keys on the park, as every automatic daemon action does.
 *
 * WHAT: only when the project has a Start services command. Stop runs once
 * (the project's Stop services command, then the process group is ended —
 * the `services` tmux session itself stays open, so anyone attached to it
 * stays attached and sees "restarted after turn N");
 * a failed stop is logged and the start runs anyway. Start runs once, through
 * the same `runStartServices` Run services uses — with the same short settle
 * check and no waiting on ports. A failed start is a WARNING recorded on the
 * task, never an error state: the task parks exactly as it would have.
 *
 * DEFAULT (a two-way door): restart whenever a Start command is configured,
 * even if the services were not running before the turn — "always there when
 * you look" needs that.
 *
 * It starts no agent turn and writes no comment: the outcome is task metadata
 * (`services_restart`), which `show` and `servePorts` answer as
 * `servicesRestart`.
 */

import type { Storage } from '../storage';
import type { Session, Task } from '../types';
import { logger } from '../utils/logger';
import { readableFailure, runStartServices, stopStartServices, taskContainerTarget, type ServeRunDeps } from './serve-run';
import { ensureTaskContainer } from './task-container';
import { resolveProjectStartServicesCmd } from '../serve/start-cmd';
import { displayId } from '../task/identity';
import { createRunner } from '../runner';

import { SERVICES_RESTART_KEY, type ServicesRestartRecord, type ServicesRestartStep } from '../task/services-restart-record';

export { SERVICES_RESTART_KEY, parseServicesRestart, servicesRestartOf } from '../task/services-restart-record';
export type { ServicesRestartRecord, ServicesRestartStep } from '../task/services-restart-record';

export type ServicesRestartDeps = ServeRunDeps;

/**
 * Which work turn's restart has been CLAIMED: `{ turn: "<session>:<agent turn seq>" }`,
 * written before the restart starts. Claim-first is what makes a restart happen at
 * most once per turn across reconciler passes AND daemon restarts: a claim whose
 * restart is not in flight in this process (it finished, or a previous daemon died
 * mid-restart) means "proceed to park", never "restart again".
 */
export const SERVICES_RESTART_TURN_KEY = 'services_restart_turn';

/** Restarts this process is running, by task id. */
const inFlight = new Map<string, Promise<void>>();

/** Is a post-turn restart running for this task in this process? The reconciler skips such a task. */
export function servicesRestartInFlight(taskId: string): boolean {
  return inFlight.has(taskId);
}

/** Resolves when every restart now in flight has finished (tests, shutdown). */
export async function servicesRestartsSettled(): Promise<void> {
  await Promise.all([...inFlight.values()]);
}

function claimedTurn(task: Task): string | null {
  const raw = task.metadata?.[SERVICES_RESTART_TURN_KEY];
  if (!raw) return null;
  try {
    const turn = (JSON.parse(raw) as { turn?: unknown }).turn;
    return typeof turn === 'string' ? turn : null;
  } catch (err) {
    logger.debug(`${SERVICES_RESTART_TURN_KEY} metadata is not JSON: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Has this work turn's restart already been claimed (run, running, or died with a daemon)? */
export function servicesRestartClaimedFor(task: Task, turnKey: string): boolean {
  return claimedTurn(task) === turnKey;
}

/**
 * Decide, for a work turn that has ended, whether the task may park now.
 *
 *   - `proceed`: nothing to restart (no Start command), or this turn's restart was
 *     already claimed and is not running here — park.
 *   - `wait`: a restart for this turn is running in the background (just started
 *     here, or still going) — do NOT park yet; a later reconciler pass parks it
 *     once it finishes.
 *
 * The restart itself never runs on the caller's await: the reconciler handles
 * tasks one after another, and one task's slow Start must not delay every other
 * task's park or resume.
 */
export async function servicesRestartGate(
  storage: Storage,
  projectRoot: string,
  task: Task,
  session: Session | null,
  turnKey: string,
  deps: ServicesRestartDeps = servicesRestartDefaults,
): Promise<'proceed' | 'wait'> {
  if (inFlight.has(task.id)) return 'wait';
  if (servicesRestartClaimedFor(task, turnKey)) return 'proceed';
  // Never able to keep a turn from parking: a failed lookup or claim write is
  // logged and the task parks without a restart.
  try {
    const command = await (deps.resolveCmd ?? resolveProjectStartServicesCmd)(storage, projectRoot);
    if (!command) return 'proceed';
    // A runner with no container (host-process) has nowhere to run services:
    // decided here, with no subprocess, so such a task parks on this pass
    // instead of claiming and waiting a tick for a restart that never runs.
    if (!deps.containerTarget) {
      const runner = await createRunner(projectRoot, session?.runner_type ?? task.runner_type ?? undefined);
      if (!runner.usesSandbox()) return 'proceed';
    }
    await storage.updateTaskMetadata(task.id, SERVICES_RESTART_TURN_KEY, JSON.stringify({ turn: turnKey, claimed_at: new Date().toISOString() }));
  } catch (err) {
    logger.warn(`Task ${displayId(task)}: services not restarted after the turn (parking without it): ${err instanceof Error ? err.message : String(err)}`);
    return 'proceed';
  }
  const run = restartServicesAfterWorkTurn(storage, projectRoot, task, session, deps, turnKey.split(':').pop())
    .then(() => undefined)
    .finally(() => { inFlight.delete(task.id); });
  inFlight.set(task.id, run);
  return 'wait';
}

/**
 * The deps the reconciler's call uses: empty (the real container and exec) in
 * the daemon. The reconciler passes none, so a test that drives a turn's end
 * through `handleCompletedResponses` stands in for the container here — the
 * same in-process injection ServeRunDeps gives every serve-run caller.
 */
export const servicesRestartDefaults: ServicesRestartDeps = {};

/**
 * Stop then start the task's services once. Returns the record written, or
 * null when nothing ran (no Start command, or the task has no running task
 * container — host-process tasks have no services environment). Never throws:
 * a restart must not be able to keep a turn from parking.
 */
export async function restartServicesAfterWorkTurn(
  storage: Storage,
  projectRoot: string,
  task: Task,
  session: Session | null,
  deps: ServicesRestartDeps = servicesRestartDefaults,
  /** The agent turn this restart follows, for the line the session prints. */
  afterTurn?: string,
): Promise<ServicesRestartRecord | null> {
  try {
    const command = await (deps.resolveCmd ?? resolveProjectStartServicesCmd)(storage, projectRoot);
    if (!command) return null;
    // The container the turn ran in. None (host-process runner, or it is gone)
    // means there is no environment to restart services in; bringing one up
    // just for this would be a launch nobody asked for.
    const target = await (deps.containerTarget ?? taskContainerTarget)(projectRoot, task, session);
    if (!target) return null;

    const runDeps: ServeRunDeps = { ...deps, getStorage: async () => storage, containerTarget: async () => target,
      // Resolved above: the turn's own container or nothing. The start step must
      // not launch a replacement for a parked task if it vanished meanwhile.
      ensureContainer: (root, params) => (deps.ensureContainer ?? ensureTaskContainer)(root, { ...params, neverLaunch: true }),
    };
    const stop: ServicesRestartStep = { ok: true };
    try {
      // The session stays open: the start below restarts the command IN it,
      // so a terminal attached to the services is not thrown out by a turn.
      await stopStartServices(projectRoot, { taskId: task.id }, { ...runDeps, keepSession: true });
    } catch (err) {
      stop.ok = false;
      stop.error = readableFailure(err);
      logger.warn(`Task ${displayId(task)}: stopping services after the turn failed (starting them anyway): ${stop.error}`);
    }
    const start: ServicesRestartStep = { ok: true };
    try {
      await runStartServices(projectRoot, { taskId: task.id }, {
        ...runDeps,
        startBanner: `restarted after ${afterTurn && /^\d+$/.test(afterTurn) ? `turn ${afterTurn}` : 'the agent\'s turn'}`,
      });
    } catch (err) {
      start.ok = false;
      // Not readableFailure: it joins lines, and the output tail is the point.
      start.error = err instanceof Error ? err.message : String(err);
      logger.warn(`Task ${displayId(task)}: starting services after the turn failed: ${start.error}`);
    }
    const record: ServicesRestartRecord = {
      at: new Date((deps.now ?? Date.now)()).toISOString(),
      command,
      stop,
      start,
      warning: start.ok ? null : `Start services failed after the turn: ${start.error}`,
    };
    await storage.updateTaskMetadata(task.id, SERVICES_RESTART_KEY, JSON.stringify(record));
    return record;
  } catch (err) {
    logger.warn(`Task ${displayId(task)}: services were not restarted after the turn: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
