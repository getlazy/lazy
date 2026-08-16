/**
 * Reap the previous daemon generation's children, at startup.
 *
 * WHAT THIS IS
 * ------------
 * A daemon restart invalidates every child the previous daemon launched: the
 * audit proxy runs in-process and its port is OS-assigned, and no child ever
 * re-reads `ANTHROPIC_BASE_URL` (see src/daemon/generation.ts). Task-agent
 * containers and builder containers cannot notice this for themselves — the
 * detection would have to run inside the very process whose API access just
 * died, and a container has no terminal to explain itself to. So the NEW daemon
 * does it for them, once, on the way up.
 *
 * WHY THE NEW DAEMON AND NOT THE OLD ONE
 * --------------------------------------
 * The old daemon's clean-shutdown path already stops task supervisors, but it
 * only covers a clean shutdown: `kill -9`, an OOM, a crash or a hard reboot all
 * leave the children running and pointed at a dead port. And it never stopped
 * builders at all. Doing the work on the way UP covers every one of those
 * uniformly, because it does not depend on the previous process running any
 * code at all.
 *
 * WHAT MAKES IT SAFE TO STOP THINGS
 * ---------------------------------
 * "Everything alive now is from the previous generation" is true only while
 * nothing can reach this daemon — and the reap itself runs later, on the first
 * reconcile tick, by which time the socket is up and a human may well have
 * started something. So the two are split:
 *
 *  - {@link snapshotPreviousGenerationChildren} enumerates the runs BEFORE the
 *    daemon binds its listeners. That set, and only that set, is eligible.
 *  - {@link reapPreviousGenerationChildren} stops exactly the names in the
 *    snapshot. A run launched after the snapshot cannot be in it, so a task the
 *    human started during startup is never killed by the reap.
 *
 * Two residual imprecisions, both benign and both deliberate:
 *
 *  - A snapshotted run may have exited on its own before the reap. Stopping a
 *    run that is already gone is a no-op.
 *  - A snapshotted NAME could in principle be re-used by a new run, since run
 *    names are derived from the task's short id. It cannot happen in practice:
 *    the task owning that name is still `working` while its supervisor lives,
 *    and a launch for a task already working is refused.
 *
 * If the snapshot could not be taken, NOTHING is reaped. Reaping without
 * evidence is how a healthy child gets killed, and a missed reap costs only the
 * next restart.
 *
 * WHAT EACH CHILD GETS
 * --------------------
 * The same courtesy `lazy upgrade` already gave builders — a grace period, a
 * clean SIGTERM (never SIGKILL), durable resume intent, and a line saying what
 * happened:
 *
 *  - **Task agents** are stopped with a grace period and moved to `interrupted`
 *    with an honest reason, which the reconciler auto-resumes (see
 *    `interruptForDaemonRestart` in src/utils/reconcile.ts).
 *  - **Builders** get a durable resume intent stamped `reason: 'daemon-restart'`
 *    and are stopped with a grace period; the host-side relaunch wrapper
 *    (src/builder/relaunch.ts) sees the intent and resumes the session in place.
 *
 * Pair sessions are NOT handled here. They are host processes that own a human's
 * terminal, so they supervise themselves and resume in place — see
 * src/supervisor/interactive.ts. Reaping them from here would kill an interactive
 * session with no way to bring it back.
 */

import { loadConfig } from '../config/loader';
import { createRunner } from '../runner';
import type { Runner, RunnerType } from '../runner/types';
import type { Storage } from '../storage/interface';
import { logger } from '../utils/logger';
import { interruptForDaemonRestart } from '../utils/reconcile';

/**
 * Seconds a stopped child gets to shut down cleanly before the runner escalates.
 *
 * Matches `BUILDER_STOP_GRACE_SECONDS` in `lazy upgrade` — the same courtesy,
 * fired on a different trigger. Stops run in parallel, so the whole reap costs
 * one grace period, not one per child.
 */
export const RESTART_STOP_GRACE_SECONDS = 10;

export interface ReapResult {
  /** Task short ids whose supervisor was stopped and marked interrupted. */
  tasks: string[];
  /** Builder ids (short, without the `lazy-builder-` prefix) that were stopped. */
  builders: string[];
}

/** Runs observed on ONE runner type at snapshot time. */
export interface RunnerGenerationSnapshot {
  runnerType: RunnerType;
  /** Every run name the runner reported (builders included — filtered later). */
  runNames: string[];
  /** Builder run names (`lazy-builder-*`) for this project. */
  builderRunNames: string[];
}

/** The set of children that existed before this daemon could launch anything. */
export interface PreviousGenerationSnapshot {
  takenAt: string;
  runners: RunnerGenerationSnapshot[];
}

/**
 * The only capability the snapshot needs from a runner: read the world.
 *
 * Narrowed on purpose. The snapshot has to run before the daemon has bound its
 * proxy, so a runner constructed at that moment has no live proxy address
 * stamped on it — which would be a real hazard if anything LAUNCHED with it.
 * Typing the snapshot against discovery alone makes "this runner never launches
 * anything" structural rather than a promise in a comment, and the reap builds
 * its own, fully-resolved runners later.
 */
type RunDiscoverer = Pick<Runner, 'discoverRunningRuns' | 'discoverProjectBuilderRuns'>;

/**
 * Every runner type this project's children could be running on.
 *
 * Runs are discovered PER RUNNER TYPE — a docker runner cannot see host
 * processes and vice versa — and tasks may carry a per-task runner override, so
 * the configured default alone is not enough. Same reasoning as the daemon's
 * shutdown sweep.
 */
async function runnerTypesInUse(projectRoot: string, storage: Storage): Promise<Set<RunnerType>> {
  const config = await loadConfig(projectRoot);
  const types = new Set<RunnerType>([config.runner.type]);
  try {
    for (const session of await storage.listSessions(undefined, true)) {
      if (session.runner_type) types.add(session.runner_type);
    }
  } catch (err) {
    // Not fatal: the configured default still covers the common case. Surface
    // it so a storage problem here is visible rather than silently narrowing
    // the sweep.
    logger.debug(`Restart reap: could not list sessions for runner discovery: ${err instanceof Error ? err.message : err}`);
  }
  return types;
}

/**
 * Does this run name belong to a task in THIS project's storage?
 *
 * Returns both ids: the run name carries the SHORT id, while the status
 * transition downstream wants the full one.
 */
async function ownedTask(storage: Storage, runName: string): Promise<{ shortId: string; taskId: string } | null> {
  const shortId = runName.replace(/^lazy-/, '');
  if (!shortId) return null;
  try {
    const task = await storage.getTask(shortId);
    return task ? { shortId, taskId: task.id } : null;
  } catch {
    // Not in this project's storage — belongs to another project. Never touch
    // another project's containers.
    return null;
  }
}

/**
 * Enumerate every child that exists right now, per runner type.
 *
 * MUST be called before the daemon binds its listeners — that is the whole
 * point. Everything running at this instant belongs to the previous generation,
 * because nothing can have asked this daemon to launch anything yet.
 *
 * Returns `null` if the snapshot could not be taken at all, which the reap
 * treats as "reap nothing". A partial snapshot (one runner type readable, another
 * not) is returned as far as it got: the unreadable runner's children are simply
 * not eligible, which is the safe direction.
 */
export async function snapshotPreviousGenerationChildren(
  projectRoot: string,
  storage: Storage,
): Promise<PreviousGenerationSnapshot | null> {
  let types: Set<RunnerType>;
  try {
    types = await runnerTypesInUse(projectRoot, storage);
  } catch (err) {
    logger.warn(`Daemon restart: could not determine runner types for snapshot: ${err instanceof Error ? err.message : err}`);
    return null;
  }

  const runners: RunnerGenerationSnapshot[] = [];
  for (const runnerType of types) {
    let discoverer: RunDiscoverer;
    try {
      // Discovery-only by type: see RunDiscoverer. Nothing is launched from
      // this runner and it is not retained past this function.
      discoverer = await createRunner(projectRoot, runnerType);
    } catch (err) {
      logger.debug(`Daemon restart: skipping runner ${runnerType} for snapshot: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    let runNames: string[] = [];
    let builderRunNames: string[] = [];
    try {
      runNames = await discoverer.discoverRunningRuns();
    } catch (err) {
      logger.warn(`Daemon restart: could not enumerate runs on ${runnerType}: ${err instanceof Error ? err.message : err}`);
    }
    try {
      builderRunNames = await discoverer.discoverProjectBuilderRuns(projectRoot);
    } catch (err) {
      logger.warn(`Daemon restart: could not enumerate builders on ${runnerType}: ${err instanceof Error ? err.message : err}`);
    }
    runners.push({ runnerType, runNames, builderRunNames });
  }

  return { takenAt: new Date().toISOString(), runners };
}

/**
 * Stop this project's previous-generation task supervisors on ONE runner and mark
 * their tasks interrupted. Exported for tests, which inject a fake Runner.
 *
 * `runNames` comes from the pre-listen snapshot — this function never asks the
 * runner what is alive NOW, because by the time it runs the answer includes runs
 * this daemon launched.
 */
export async function reapTaskAgents(
  runner: Runner,
  storage: Storage,
  projectRoot: string,
  runNames: string[],
): Promise<string[]> {
  const names = runNames;
  const owned: Array<{ shortId: string; taskId: string }> = [];
  for (const name of names) {
    // Builder containers also match `lazy-*`; they are handled separately
    // (different stop semantics, different resume path).
    if (name.startsWith('lazy-builder-')) continue;
    const task = await ownedTask(storage, name);
    if (task) owned.push(task);
  }
  if (owned.length === 0) return [];

  const stopped = await Promise.all(owned.map(async entry => {
    const runName = `lazy-${entry.shortId}`;
    try {
      logger.info(`Daemon restart: stopping task supervisor ${runner.runDisplayName(runName)}...`);
      await runner.stopRun(runName, { gracefulTimeoutSeconds: RESTART_STOP_GRACE_SECONDS });
      return entry;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Daemon restart: could not stop supervisor ${runName}: ${msg}`);
      return null;
    }
  }));

  // Status transitions are sequential and after every stop: they write task
  // state and can trigger an auto-resume launch, which must not race a stop
  // that is still in flight.
  const interrupted: string[] = [];
  for (const entry of stopped) {
    if (!entry) continue;
    try {
      if (await interruptForDaemonRestart(storage, entry.taskId, projectRoot)) {
        interrupted.push(entry.shortId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Daemon restart: could not mark task ${entry.shortId} interrupted: ${msg}`);
    }
  }
  return interrupted;
}

/**
 * Stop this project's previous-generation builders on ONE runner, leaving a
 * durable resume intent behind. Exported for tests, which inject a fake Runner.
 *
 * `builderRunNames` comes from the pre-listen snapshot, for the same reason as
 * {@link reapTaskAgents}.
 */
export async function reapBuilders(
  runner: Runner,
  storage: Storage,
  projectRoot: string,
  builderRunNames: string[],
): Promise<string[]> {
  const names = builderRunNames;
  if (names.length === 0) return [];

  const results = await Promise.all(names.map(async name => {
    // Canonical intent key is the SHORT builder id, as `lazy upgrade` writes it.
    const builderId = name.replace(/^lazy-builder-/, '');
    if (!builderId) return null;
    try {
      // Intent FIRST, stop second: the host-side wrapper unblocks the moment
      // the container dies and immediately looks for an intent. Writing it
      // afterwards would race, and a missed intent means a live session that
      // silently does not come back.
      await storage.saveBuilderResumeIntent({
        builderId,
        projectRoot,
        createdAt: new Date().toISOString(),
        reason: 'daemon-restart',
      });
      logger.info(`Daemon restart: stopping builder ${runner.runDisplayName(name)}...`);
      await runner.stopRun(name, { gracefulTimeoutSeconds: RESTART_STOP_GRACE_SECONDS });
      return builderId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Daemon restart: could not stop builder ${name}: ${msg}`);
      return null;
    }
  }));

  return results.filter((id): id is string => id !== null);
}

/**
 * Stop everything named in the pre-listen snapshot.
 *
 * Best-effort and never throws: a daemon that cannot reach its runner still
 * has to start. Every failure is logged with the child it applies to.
 *
 * The runners built here are the real thing — they launch (an auto-resume can
 * follow an interrupt) and so they carry this generation's proxy target. The
 * snapshot's discovery-only runners are long gone by now.
 */
export async function reapPreviousGenerationChildren(
  projectRoot: string,
  storage: Storage,
  snapshot: PreviousGenerationSnapshot,
): Promise<ReapResult> {
  const result: ReapResult = { tasks: [], builders: [] };

  for (const entry of snapshot.runners) {
    const { runnerType, runNames, builderRunNames } = entry;
    if (runNames.length === 0 && builderRunNames.length === 0) continue;

    let runner: Runner;
    try {
      runner = await createRunner(projectRoot, runnerType);
    } catch (err) {
      // A configured-but-unavailable runner (docker not installed, say) has no
      // runs to stop.
      logger.debug(`Daemon restart: skipping runner ${runnerType}: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    try {
      result.tasks.push(...await reapTaskAgents(runner, storage, projectRoot, runNames));
    } catch (err) {
      logger.warn(`Daemon restart: task supervisor sweep failed on ${runnerType}: ${err instanceof Error ? err.message : err}`);
    }
    try {
      result.builders.push(...await reapBuilders(runner, storage, projectRoot, builderRunNames));
    } catch (err) {
      logger.warn(`Daemon restart: builder sweep failed on ${runnerType}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (result.tasks.length > 0 || result.builders.length > 0) {
    logger.info(
      `Daemon restart: stopped ${result.tasks.length} task supervisor(s) and ` +
      `${result.builders.length} builder(s) launched by the previous daemon; ` +
      'each resumes against this one.'
    );
  }
  return result;
}
