/**
 * Which run speaks for a `working` task right now, and is it alive?
 *
 * ONE answer for two readers that used to ask the question differently:
 *
 *   - the reconciler, which decides whether a turn is still running or has died
 *     (`src/utils/reconcile.ts`), and
 *   - every read surface that renders the derived working substate
 *     (`src/utils/working-substate.ts` — `lazy list` / `show` / `status`,
 *     `lazy_list` / `lazy_active` / `lazy_show`).
 *
 * They disagreed in three ways, and each one produced a task that SAID
 * `working(not-alive)` for minutes while the reconciler — correctly — left it
 * running (field report 2026-09-24: "at least 4 tasks are just sitting there
 * saying working(not-alive) for at least 5 minutes"):
 *
 *   1. AN IN-FLIGHT REVIEW RUNS SOMEWHERE ELSE. A review launches its own
 *      run (`lazy-review-<ref>`) with its own mailbox (`<taskId>-review`) and is
 *      never stamped on the session; the claim on the task names that run. The
 *      read surfaces probed the WORK run and read the WORK mailbox, so a live
 *      reviewer on a task whose work container was gone (a daemon restart reaps
 *      them all) rendered as dead for its whole run — and real reviews take
 *      five to eight minutes.
 *   2. THE RUNNER. The reconciler probes the runner the session actually ran on
 *      (`session.runner_type`, set by a per-task runner override); the read
 *      surfaces probed the project's configured runner, where that run does not
 *      exist.
 *   3. THE PROBE. The reconciler asks `isRunning`; the read surfaces asked
 *      `getRunInfo().running`, which on the host-process runner is a bare
 *      `kill(pid, 0)` that a zombie answers.
 *
 * The rule now: a LIVE claim that names a run is the run that speaks for the
 * task (its runner, its run name, its mailbox); otherwise the work run on the
 * session's runner does. Liveness is always `runner.isRunning`, and a run the
 * daemon is still STARTING (`launchInFlight`, which the reconciler also skips)
 * renders `launching`. A read surface that renders `not-alive` is therefore
 * naming a run the reconciler will act on once the 30s startup grace is past —
 * never one it is (rightly) still waiting for.
 */

import type { Runner, RunInfo, RunnerType } from '../runner/types';
import { createRunner } from '../runner';
import type { InFlightTurn, Session, Task } from '../types';
import type { Storage } from '../storage/interface';
import { isInFlightLive } from '../daemon/in-flight-turn';
import { protocolDir, reviewProtocolDir } from '../protocol/io';
import { taskRef } from '../task/identity';
import { computeWorkingSubstate, type WorkingSubstate } from './working-substate';
import { launchInFlight } from '../runner/launch-in-flight';

export interface WorkingRun {
  /** The runner that owns the run — the one to probe, stop and remove it on. */
  runner: Runner;
  /** The run's name on that runner (container name or pid-file name). */
  runName: string;
  /** The mailbox that run reads its command from and writes its status to. */
  protoDir: string;
  /** The live claim the run belongs to, when it is a claimed ask/review run. */
  claim: InFlightTurn | null;
}

/**
 * Builds the runner for a type other than the default one. A seam only:
 * production always uses `createRunner`; a test passes fakes to prove WHICH
 * runner a resolution probes.
 */
export type RunnerFactory = (type: RunnerType) => Promise<Runner>;

const runnerFactory = (lazyRoot: string): RunnerFactory => (type) => createRunner(lazyRoot, type);

/**
 * The WORK run of a task: the session's own runner (falling back to
 * `defaultRunner` for a session that recorded none, or recorded the same type)
 * and the session's container name (falling back to the runner's name for the
 * task). The reconciler's crash handling reads exactly this.
 */
export async function resolveWorkRun(
  lazyRoot: string,
  task: Task,
  session: Pick<Session, 'container_name' | 'runner_type'>,
  defaultRunner: Runner,
  runnerOf: RunnerFactory = runnerFactory(lazyRoot),
): Promise<WorkingRun> {
  const runner = session.runner_type && session.runner_type !== defaultRunner.type
    ? await runnerOf(session.runner_type)
    : defaultRunner;
  return {
    runner,
    runName: session.container_name ?? runner.runNameForTask(taskRef(task)),
    protoDir: protocolDir(task.id),
    claim: null,
  };
}

/**
 * The run that speaks for a `working` task: the claimed run of a live ask/review
 * claim that has one, otherwise the work run ({@link resolveWorkRun}).
 *
 * A live claim with NO run name yet is a launch in progress (the name is
 * stamped only once the launch returns), so there is no run to probe: the
 * answer falls back to the work run, which is exactly as alive as that launch.
 */
export async function resolveWorkingRun(
  lazyRoot: string,
  task: Task,
  session: Pick<Session, 'container_name' | 'runner_type'>,
  defaultRunner: Runner,
  runnerOf: RunnerFactory = runnerFactory(lazyRoot),
): Promise<WorkingRun> {
  const claim = task.in_flight_turn ?? null;
  if (claim && claim.run_name && isInFlightLive(claim)) {
    const runner = claim.runner_type && claim.runner_type !== defaultRunner.type
      ? await runnerOf(claim.runner_type)
      : defaultRunner;
    return {
      runner,
      runName: claim.run_name,
      protoDir: claim.owner === 'review' ? reviewProtocolDir(task.id) : protocolDir(task.id),
      claim,
    };
  }
  return resolveWorkRun(lazyRoot, task, session, defaultRunner, runnerOf);
}

/**
 * The derived working substate of a `working` task, probed the way the
 * reconciler probes it: the run {@link resolveWorkingRun} names, asked
 * `isRunning` on its own runner, with status/response read from that run's
 * mailbox and the daemon's waits/progress from the task's.
 *
 * Caller contract: only for tasks whose status is `working`. Throws when the
 * runner cannot be constructed or probed — every caller degrades to a plain
 * `working` rather than guessing alive or dead.
 */
export async function computeTaskWorkingSubstate(
  lazyRoot: string,
  task: Task,
  session: Pick<Session, 'container_name' | 'runner_type'>,
  defaultRunner: Runner,
): Promise<WorkingSubstate | null> {
  return (await probeWorkingRun(lazyRoot, task, session, defaultRunner)).substate;
}

/** What {@link probeWorkingRun} found about the run that speaks for a task. */
export interface WorkingRunProbe {
  run: WorkingRun;
  /** `runner.isRunning`; also false when the runtime did not answer. */
  alive: boolean;
  /** Null when liveness is unknown — every surface then shows a plain `working`. */
  substate: WorkingSubstate | null;
  /**
   * Set, with the reason, when the runtime did not answer the lookup at all (a
   * busy Docker timing out). Such a run is "liveness unknown", NEVER
   * `not-alive`: nothing confirmed it dead. (The reconciler's own ACTION on a
   * dead run still keys on `isRunning` alone; this only describes liveness.)
   */
  livenessUnknown?: string;
  /**
   * The runtime's answer about the run when it gave one through
   * `probeRunInfo` (null = no such run). Undefined on a runner without that
   * probe; a caller needing the exit time then asks `getRunInfo` itself.
   */
  info?: RunInfo | null;
}

/**
 * {@link computeTaskWorkingSubstate}, also handing back the run it probed and
 * the liveness answer, for a caller with more to say about that run (the task
 * tree's crashed marker, `lazy daemon health`).
 *
 * A runner that can tell "no such run" from "did not answer" (`probeRunInfo`)
 * is asked that first, so read surfaces and health agree on `not-alive` vs
 * "liveness unknown".
 */
export async function probeWorkingRun(
  lazyRoot: string,
  task: Task,
  session: Pick<Session, 'container_name' | 'runner_type'>,
  defaultRunner: Runner,
  runnerOf?: RunnerFactory,
): Promise<WorkingRunProbe> {
  const run = await resolveWorkingRun(lazyRoot, task, session, defaultRunner, runnerOf);
  // Liveness is `isRunning`; the probe only classifies a FALSE (one extra
  // lookup, and only for a run that looks dead): did the runtime answer, and
  // does its answer agree?
  const alive = await run.runner.isRunning(run.runName);
  let info: RunInfo | null | undefined;
  if (!alive && run.runner.probeRunInfo) {
    const answer = await run.runner.probeRunInfo(run.runName);
    if (answer.kind === 'no-answer') {
      return { run, alive: false, substate: null, livenessUnknown: answer.reason };
    }
    if (answer.info?.running === true) {
      return {
        run, alive: false, substate: null,
        livenessUnknown: 'runtime answers disagreed: the run inspects as running but was not listed as running',
      };
    }
    info = answer.info;
  }
  const substate = await computeWorkingSubstate(run.protoDir, alive, {
    taskProtoDir: protocolDir(task.id),
    launching: !alive && launchInFlight(run.runName, task.id),
  });
  return { run, alive, substate, info };
}

/**
 * {@link computeTaskWorkingSubstate} for a surface that holds only a task id and
 * re-reads it on every refresh (the watch headers): null unless the task is
 * `working` with a session, since the substate means nothing otherwise.
 */
export async function readTaskWorkingSubstate(
  lazyRoot: string,
  storage: Storage,
  taskId: string,
  defaultRunner: Runner,
): Promise<WorkingSubstate | null> {
  const task = await storage.getTask(taskId);
  if (!task || task.status !== 'working') return null;
  const session = await storage.getSessionByTaskId(taskId);
  if (!session) return null;
  return computeTaskWorkingSubstate(lazyRoot, task, session, defaultRunner);
}
