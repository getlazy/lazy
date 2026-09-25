/**
 * Poll-based state reconciliation for async task execution.
 *
 * When tasks are in 'working' status, this module checks the supervisor's
 * protocol state to determine if the agent has finished, crashed, or is still running.
 *
 * The supervisor writes response.json when a turn completes. Reconciliation
 * reads this response and transitions the task to 'blocked' or 'interrupted'.
 *
 * Called automatically by list/blocked commands before displaying results.
 */

import { join } from 'path';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import type { Storage } from '../storage';
import { TERMINAL_STATUSES, isClusterTask } from '../types';
import { isBlockedStatus } from '../task-state-machine';
import type { TokenUsage, AgentTokenUsage, Task, Session, InFlightTurn, TurnOwner, FinalClaim, Turn } from '../types';
import type { RunnerType } from '../config/types';
import { toTurnUsage, rollUpSessionUsage } from './usage-recording';
import { createRunner } from '../runner';
import type { Runner } from '../runner';
import {
  protocolDir as getProtocolDir, reviewProtocolDir, readResponse, readStatus, hasResponse, hasCommand, consumeResponse, clearStatus,
  removeProtocolDir, listSupersededResponses, consumeSupersededResponse,
} from '../protocol';
import type { CommandId, CompletedResponse, ErrorResponse, WorktreeRecovery, AgentHandoffEntry, SupervisedKind, FinalDeclaration } from '../protocol';
import { completedResponses, responseCommandId } from '../protocol';
import { hasUncommittedChanges, getUncommittedDiff, getCurrentSha, getAcceptTagCommit } from '../git/operations';
import { recordSessionCommits, scanSessionCommits } from '../task/session-commits';
import { launchSettingsFromResponse } from './turns';
import { parkTaskPaused } from './paused-status';
import { consumeSyncRestoreStatus } from '../task/sync-restore-status';
import { checkLock, readLock, removeLock } from './lock';
import { launchInFlight } from '../runner/launch-in-flight';
import { resolveWorkRun } from './working-run';
import { checkPairingLock, removePairingLock } from './pairing-lock';
import { logger } from './logger';
import { REVIEW_REASK_HEADING } from '../review/verdict';
import {
  formatReviewReport,
  parseReviewReport,
  reviewReportIsUnparsed,
} from '../review/parse-report';
import { shortId as shortIdHelper, taskRef, taskRefFromId, getWorktreePathForRef } from '../task/identity';
import { taskBranchFor, DEFAULT_BRANCH_PREFIX } from '../git/branch-prefix';
import { autoResumeTask, exitCodeToReason, MAX_CONSECUTIVE_INTERRUPTIONS } from './auto-resume';
import { shouldAutoReact, recordAutoReact } from '../daemon/auto-react-budget';
import { isUserStopped } from '../task/user-stop';
import { releaseTurnCredential } from '../daemon/turn-credentials';
import { createAgentTurn, createRecoveredAgentTurn, sessionTurnOwner, turnChannelActor } from '../daemon/turn-owner';
import { systemActor } from '../identity/system-identity';
import type { AutoReactTrigger } from '../daemon/auto-react-budget';
import { resetSlowLaneState, getLastProjectAutoResumeAt, recordProjectAutoResume } from '../daemon/auto-resume-queue';
import { sweepStrandedMerging, sweepAcceptFollowThrough } from '../daemon/stranded-merge';
import { taskTurnInFlight, isInFlightLive, expiredSyncRestore, claimMadeByThisProcess } from '../daemon/in-flight-turn';
import { reviewContainerNameForTask } from '../capture/claude';
import { settleInFlightTurnFromProtocol, abandonDeadClaimedTurn } from '../daemon/task-lifecycle';
import { collectRunDiagnostics } from '../daemon/supervisor-wait';
import { loadConfig } from '../config/loader';
import { usagePauseHold } from '../daemon/usage-pause';
import { runGit } from './git';
import { reparentChildren, formatReparentWarning } from '../task/orphan';
import { readAgentReportFromSessionLog } from '../import/recover-agent-report';
import { ACTIVE_HARNESS_PHASES } from './working-substate';
import { runRecordedSweep, RECONCILE_LOOP } from '../daemon/health-registry';
import {
  isWatchdogKill,
  watchdogTurnLines,
  watchdogInterruptReason,
  WATCHDOG_TURN_HEADING,
} from './watchdog-turn';

/**
 * Grace period in milliseconds for newly-working tasks.
 * When a task transitions to 'working', we skip reconciliation for this duration
 * to give the container time to start up. This prevents a race where the reconciler
 * sees a working task with no running container and marks it interrupted before
 * the container finishes launching.
 *
 * In test mode, we set this to 0 to allow tests to run quickly without waiting.
 *
 * Also read by `lazy daemon health`, which must not report a task stuck while
 * the reconciler is still, correctly, waiting for its container.
 */
// Evaluated at call time (not module load) so that LAZY_TEST=1 set after import takes effect.
export function getWorkingGracePeriodMs(): number {
  return process.env.LAZY_TEST === '1' ? 0 : 30000; // 30 seconds (0 in tests)
}

/**
 * The phases that mean the supervisor is still running post-work machinery for
 * a turn. Defined in `src/utils/working-substate.ts` — the leaf module that owns
 * the phase vocabulary — so the daemon's launch paths can read the same set
 * without pulling in the reconciler. Re-exported here because this is where
 * stranded-completion recovery reads it, and where its invariant test looks.
 */
export { ACTIVE_HARNESS_PHASES };


/**
 * Decide whether the stored agent_session_id should be replaced with the one
 * the agent reported in the just-completed turn response.
 *
 * Rules:
 *  - Empty/missing reported ID (e.g. sync-only turns with no agent call): skip.
 *  - Reported ID matches what's stored: no-op.
 *  - Otherwise (first turn with no stored ID, OR Claude Code rotated the session
 *    ID via auto-compact / --resume fallback / cross-machine drift): update.
 *
 * Exported for unit testing.
 */
/**
 * Reconciler gate for `lazy stop`: when a session was explicitly stopped by a
 * user (or builder), the reconciler must NOT auto-resume it. A crash-interrupted
 * session (user_stopped !== true) continues through auto-resume as usual.
 *
 * The rule itself lives in `src/task/user-stop.ts` — every path that could
 * start a turn nobody asked for reads it from there. This name stays as the
 * reconciler's spelling of it: `maybeAutoResume` calls it and returns early
 * when it returns true. Manual `lazy resume` / `lazy unblock` clears the flag
 * via `resetConsecutiveInterruptions`, re-arming auto-resume.
 */
export { isUserStopped as shouldSkipAutoResumeForUserStop };

export function shouldReconcileAgentSessionId(
  storedId: string | null,
  reportedId: string | undefined,
): boolean {
  if (!reportedId) return false;
  return reportedId !== storedId;
}

function shortId(id: string): string {
  return id.substring(0, 8);
}

// TERMINAL_STATUSES imported from ../types

/**
 * Yield to the event loop so pending HTTP requests and microtasks get served.
 * Used between reconcile steps for cooperative scheduling.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/** The primary sweep's per-task failures, gathered so the sweep's health record carries them. */
class WorkingTaskFailures extends Error {
  constructor(failures: string[]) {
    super(`${failures.length} working task(s) could not be reconciled — ${failures.join('; ')}`);
    this.name = 'WorkingTaskFailures';
  }
}

/**
 * Reconcile all tasks in 'working' status, plus:
 * - Process stale responses for interrupted tasks (race condition fix)
 * - Clean up orphaned containers for terminal-state tasks
 *
 * For each working task:
 * 1. If supervisor has written response.json -> parse response, record turn, transition to 'blocked'
 * 2. If container is still running and no response -> leave as 'working'
 * 3. If container stopped without response -> check status.json for context, transition to 'interrupted'
 * 4. If no container and no response -> transition to 'interrupted'
 */
export async function reconcileTasks(
  storage: Storage,
  lazyRoot: string,
): Promise<void> {
  const runner = await createRunner(lazyRoot);
  // Every sweep below records its outcome for `lazy daemon health`
  // (src/daemon/health-registry.ts) and keeps its own log line: the recording
  // is what lets a sweep that fails on every tick be SEEN, where the log line
  // alone only helps someone who already knows to look for it.
  const sweep = (name: string, fn: () => Promise<unknown>, onError: (err: unknown) => void) =>
    runRecordedSweep(lazyRoot, RECONCILE_LOOP, name, fn, onError);
  const describe = (err: unknown) => (err instanceof Error ? err.message : err);

    // Primary sweep: reconcile working tasks. One task failing must not stop
    // the rest, so each is caught on its own; the sweep as a whole records the
    // failures, so a task the reconciler cannot move shows up in health.
    await sweep('working-tasks', async () => {
      const workingTasks = await storage.listTasksWithOptions({ workingOnly: true });
      const failures: string[] = [];
      for (const task of workingTasks) {
        try {
          await reconcileTask(storage, task.id, lazyRoot, runner);
        } catch (err) {
          logger.debug(`Failed to reconcile task ${shortId(task.id)}: ${describe(err)}`);
          failures.push(`${shortId(task.id)}: ${describe(err)}`);
        }
        // Yield to event loop between tasks so pending HTTP requests get served
        await yieldToEventLoop();
      }
      if (failures.length > 0) {
        throw new WorkingTaskFailures(failures);
      }
    }, (err) => {
      // A task that keeps failing is already logged per task at debug above, and
      // the sweep's health record carries it; warning here too would repeat it
      // every tick for as long as it lasts. Only a failure to LIST the working
      // tasks is new, and it is the one that stops the whole sweep.
      if (err instanceof WorkingTaskFailures) return;
      logger.warn(`Sweep working tasks failed: ${describe(err)}`);
    });

    // Sweep 2: recover turns whose response a later command displaced.
    // Runs before the other response sweeps so a recovered turn is recorded
    // ahead of whatever the current turn produces — it happened first.
    await sweep('superseded-responses', () => sweepSupersededResponses(storage, lazyRoot), (err) => {
      logger.warn(`Sweep superseded responses failed: ${describe(err)}`);
    });

    // Sweep 3: process stale responses for interrupted tasks
    // This handles the race where the supervisor writes a new response AFTER
    // reconciliation already moved the task to interrupted.
    await sweep('interrupted-responses', () => sweepInterruptedResponses(storage, lazyRoot), (err) => {
      logger.warn(`Sweep interrupted responses failed: ${describe(err)}`);
    });

    // Sweep 3b: resume tasks stranded in `interrupted` by a daemon that is gone.
    // Runs after the stale-response sweep above, which can legitimately move a
    // task out of `interrupted` when its turn did finish after all.
    await sweep('stranded-interrupted', () => resumeStrandedInterruptedTasks(storage, lazyRoot), (err) => {
      logger.warn(`Resume stranded interrupted tasks failed: ${describe(err)}`);
    });

    // Sweep 3c: finalize a completed turn a PAUSED task is sitting on.
    // The primary sweep above reads response.json only for `working` tasks, so a
    // task that reached blocked/conflict/submitted while its agent was still
    // running loses that turn outright. Independent net, same shape as sweep 3.
    await sweep('paused-responses', () => sweepPausedResponses(storage, lazyRoot), (err) => {
      logger.warn(`Sweep paused responses failed: ${describe(err)}`);
    });

    // Sweep 3d: settle or abandon an ask/review claim held by a task that is not
    // `working`. The primary sweep cannot see those, and the claim suppresses
    // every automatic launch — including the auto-review retry — while it stands.
    await sweep('paused-sync-claims', () => sweepPausedSyncClaims(storage, lazyRoot), (err) => {
      logger.warn(`Sweep paused sync claims failed: ${describe(err)}`);
    });

    // Sweep 4: clean up orphaned runs for terminal-state tasks
    // This catches containers/processes that survived a failed cleanup during accept/close/reject.
    await sweep('terminal-containers', () => sweepTerminalContainers(storage, lazyRoot, runner), (err) => {
      logger.warn(`Sweep terminal containers failed: ${describe(err)}`);
    });

    // Sweep 5: detect tasks whose branch was already merged into their target
    // This catches the zombie scenario where accept squash-merged the branch
    // but crashed before updating session/task metadata.
    await sweep('merged-branches', () => sweepMergedBranches(storage, lazyRoot), (err) => {
      logger.warn(`Sweep merged branches failed: ${describe(err)}`);
    });

    // Sweep 5b: retry `[Subtask accepted]` parent comments that accept/remote
    // complete failed to land (createComment miss or crash after status flip).
    await sweep('parent-accept-notify', async () => {
      const { sweepPendingParentAcceptNotifies } = await import('../task/notify-parent-accepted');
      const n = await sweepPendingParentAcceptNotifies(storage, lazyRoot);
      if (n > 0) {
        logger.info(`Sweep parent-accept-notify: delivered ${n} missed parent comment(s)`);
      }
    }, (err) => {
      logger.warn(`Sweep parent-accept-notify failed: ${describe(err)}`);
    });

    // Sweep 5c: retry `[Subtask added]` / `[Subtask removed]` parent comments
    // whose write failed when the subtask was created, reparented or closed.
    await sweep('parent-child-notify', async () => {
      const { sweepPendingParentChildNotifies } = await import('../task/notify-parent-children');
      const n = await sweepPendingParentChildNotifies(storage);
      if (n > 0) {
        logger.info(`Sweep parent-child-notify: delivered ${n} missed parent comment(s)`);
      }
    }, (err) => {
      logger.warn(`Sweep parent-child-notify failed: ${describe(err)}`);
    });

    // Sweep 6: recover stale pairing states
    // If a task is in 'pairing' state but the pairing process has exited,
    // transition it back to 'blocked'. This handles: terminal closed,
    // machine rebooted, process killed.
    await sweep('stale-pairing', () => sweepStalePairing(storage, lazyRoot), (err) => {
      logger.warn(`Sweep stale pairing failed: ${describe(err)}`);
    });

    // Sweep 7: recover backlog tasks that actually have committed work.
    // The durable proof of work is the task's git branch — sessions and
    // worktrees are local on-disk state that doesn't travel between machines.
    // If a `backlog` task's branch has commits beyond its base, real work
    // exists and the task belongs in `blocked` so it surfaces in
    // `lazy blocked` and downstream commands can act on it.
    await sweep('backlog-with-commits', () => recoverBacklogWithCommits(storage, lazyRoot), (err) => {
      logger.warn(`Recover backlog with commits failed: ${describe(err)}`);
    });

    // Sweep 8: recover tasks stranded in `working` whose turn was never finalized.
    // Defense-in-depth for the primary working sweep above (reconcileTask). If
    // reconcileTask was skipped (transient worktree lock) or threw for a task, a
    // task whose agent finished and committed real work can sit in `working`
    // forever — turns/commits unpersisted, no blocked transition, no notification.
    // This independent net re-checks run liveness and backfills the
    // committed work to `blocked`. It re-reads current git/task state, so it
    // survives daemon restarts (mirrors recoverBacklogWithCommits).
    await sweep('stranded-working', () => recoverStrandedWorkingTasks(storage, lazyRoot, runner), (err) => {
      logger.warn(`Recover stranded working tasks failed: ${describe(err)}`);
    });

    // Sweep 9: finish tasks stranded in `merging` by an accept that died.
    // `merging` is stamped by the accept orchestration and only that
    // orchestration clears it, so a daemon killed mid-accept leaves the task
    // there with nothing else able to finish it. The human already said accept,
    // so a marked task is RESUMED (never restored to `blocked`). Running here means it also runs shortly after
    // daemon startup, which is exactly when a killed accept is discovered.
    // See src/daemon/stranded-merge.ts for why this never touches a live merge
    // or a legitimately forge-pending one.
    await sweep('stranded-merging', () => sweepStrandedMerging(storage, lazyRoot), (err) => {
      logger.warn(`Recover stranded merging tasks failed: ${describe(err)}`);
    });

    // Sweep 9b: retry post-accept follow-through (fast-forward, parent push,
    // accept tag, reparent, cleanup) on accepted tasks that still owe it. The
    // merge is an accept's commit point; everything after it is retried here
    // until done, and never moves the task out of `complete`.
    await sweep('accept-follow-through', () => sweepAcceptFollowThrough(storage, lazyRoot), (err) => {
      logger.warn(`Post-accept follow-through sweep failed: ${describe(err)}`);
    });

    // NOTE (remove-reaper-cap-sweep): there is deliberately no idle-container
    // reaper and no queued-task drain here. A blocked task keeps its warm
    // supervisor container until the task reaches a terminal state (accept /
    // reject / close clean it up), and `lazy start` always launches immediately
    // — there is no agent concurrency cap and no queue.
}

/**
 * Per-claim record of when its run was FIRST observed gone, keyed
 * `<taskId>:<turnSequence>`.
 *
 * A death grace, spelled across ticks. The supervisor legitimately writes
 * `response.json` and THEN exits, so "run gone" and "answer present" is the
 * normal successful ending observed in either order; requiring two consecutive
 * sightings (a tick apart) lets the settle above win that race. Process-local
 * and disposable: losing it on a restart costs one extra tick of patience,
 * never a wrong abandonment.
 */
const claimedRunGoneSince = new Map<string, number>();

/** How long a claimed turn's run must be continuously gone before it is abandoned. */
const CLAIMED_RUN_DEATH_GRACE_MS = 10_000;

/** How long a stale reviewer/agent gets to exit on SIGTERM before it is killed. */
const PREVIOUS_GENERATION_STOP_GRACE_SECONDS = 5;

/**
 * The runner a previous daemon's claimed run lives on.
 *
 * The claim's own `runner_type` when the launch stamped one; otherwise the
 * runner the launch was built from — ask and review both call
 * `createRunner(projectRoot, task.runner_type)` (src/daemon/task-lifecycle.ts)
 * — and only then the session's. The session records the runner of the last
 * WORK turn, which differs from the task's after a per-task runner override
 * (`lazy edit --runner`); probing an unstamped reviewer there reads "not
 * running" and leaves the very run this exists to stop alive.
 *
 * Exported for unit testing.
 */
export function previousGenerationRunnerType(
  record: Pick<InFlightTurn, 'runner_type'>,
  task: Pick<Task, 'runner_type'>,
  session: Pick<Session, 'runner_type'>,
): RunnerType | undefined {
  return record.runner_type ?? task.runner_type ?? session.runner_type ?? undefined;
}

/**
 * End an ask/review claim that a PREVIOUS daemon process made.
 *
 * Its turn cannot finish, whatever state it is in:
 *
 *  - STAMPED with a run name: the run was launched by that daemon and pointed
 *    at its proxy address, which died with it (src/daemon/generation.ts). The
 *    restart reaper and the shutdown sweep stop every task agent for exactly
 *    that reason — but they find runs by the WORK run's name
 *    (src/runner/run-ownership.ts), and a review runs in its own
 *    (`reviewContainerNameForTask`), so a reviewer survived both, alive and
 *    stamped, answering `isRunning` for a turn that would never answer.
 *  - UNSTAMPED: the name is written by the claiming process once its launch
 *    returns, and a launch is process-local (src/runner/launch-in-flight.ts). A
 *    daemon that died mid-launch left a claim nothing will ever stamp.
 *
 * Either way the claim used to be waited on for the 24h backstop
 * (IN_FLIGHT_ASYNC_BACKSTOP_MS), holding the task in `working` and every
 * automatic launch with it. The run is probed by its DETERMINISTIC name when
 * the claim has none — a launch can have started the run without living to
 * stamp it — stopped and removed if found, and the turn abandoned through the
 * same ending a dead run gets.
 */
async function abandonPreviousGenerationClaim(
  storage: Storage,
  task: Task,
  session: Session,
  record: InFlightTurn,
  lazyRoot: string,
): Promise<true> {
  const taskShortId = shortId(task.id);
  const who = record.owner === 'review' ? 'reviewer' : 'agent';
  const runnerType = previousGenerationRunnerType(record, task, session);
  const runName = record.run_name ?? (record.owner === 'review'
    ? reviewContainerNameForTask(taskRef(task))
    : null);

  let stopped = false;
  try {
    const runner = await createRunner(lazyRoot, runnerType);
    const name = runName ?? session.container_name ?? runner.runNameForTask(taskRef(task));
    if (await runner.isRunning(name)) {
      await runner.stopRun(name, { gracefulTimeoutSeconds: PREVIOUS_GENERATION_STOP_GRACE_SECONDS });
      stopped = true;
    }
    if (await runner.runExists(name)) await runner.removeRun(name);
  } catch (err) {
    // The abandonment still goes ahead: the turn cannot finish either way, and
    // a run left behind is the smaller harm next to a task held for a day.
    logger.warn(
      `Task ${taskShortId}: could not stop the ${who} run left by the previous daemon: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const claimedAt = new Date(record.started_at).toISOString();
  logger.warn(
    `Task ${taskShortId}: the ${record.owner} claimed at ${claimedAt} was made by a previous daemon ` +
    `(restarted since) — ${stopped ? `stopped its run '${runName ?? 'work run'}' and ` : ''}` +
    `abandoning the turn, restoring '${record.restore_status}'`,
  );
  const detail = record.run_name
    ? `The daemon that launched this ${who} restarted, which cut the ${who}'s run '${record.run_name}' ` +
      `off from the model (its proxy connection died with that daemon), so it could never report. ` +
      `${stopped ? 'The run was stopped. ' : ''}Run the ${record.owner} again if it is still wanted.`
    : `The ${who} was never started: the daemon that claimed this turn restarted or stopped before ` +
      `its launch finished, so nothing was left to run it. Run the ${record.owner} again if it is still wanted.`;
  await abandonDeadClaimedTurn(storage, task, record, detail);
  return true;
}

/**
 * Abandon an asynchronous ask/review whose run has vanished without answering.
 *
 * Returns true when the turn was ended here (the caller must then stop
 * reconciling this task — its status is already restored).
 *
 * WHY LIVENESS AND NOT A DEADLINE. Ask and review have no ceiling: a reviewer
 * on a large diff is allowed to think for as long as it keeps making progress,
 * and the supervisor's own watchdog is what bounds a hung one. That leaves
 * exactly one way for such a turn to end with nothing written — its run dying —
 * and nobody but this tick to notice, because the RPC caller returned the
 * moment the turn started. Before this existed, that case left the task in
 * `working` with a claim naming an answer nothing would ever write.
 *
 * The probe is skipped entirely until `run_name` is stamped, which happens
 * only after the launch returns: the absence of a run name IS the startup
 * grace, so a tick landing mid-launch can never mistake a run that has not
 * started for one that died.
 *
 * INVARIANT: both the grace and the probe belong to the process that made the
 * claim. A claim another process made — a previous daemon, stamped or not — can
 * never finish, and is ended at once by {@link abandonPreviousGenerationClaim}
 * rather than waited on for the 24-hour backstop.
 */
async function abandonIfRunIsGone(
  storage: Storage,
  task: Task,
  session: Session,
  record: InFlightTurn,
  lazyRoot: string,
): Promise<boolean> {
  if (record.owner !== 'ask' && record.owner !== 'review') return false;
  if (!claimMadeByThisProcess(record)) {
    return abandonPreviousGenerationClaim(storage, task, session, record, lazyRoot);
  }
  const runName = record.run_name;
  if (!runName) return false;

  const key = `${task.id}:${record.turn_sequence}`;
  let alive = true;
  let claimRunner: Runner | null = null;
  try {
    claimRunner = await createRunner(lazyRoot, record.runner_type ?? undefined);
    alive = await claimRunner.isRunning(runName);
  } catch (err) {
    // A probe that cannot answer is not a death — fall back to patience, the
    // same rule waitForSupervisorAnswer uses. Never manufacture an abort.
    logger.debug(
      `Task ${shortId(task.id)}: liveness probe for ${record.owner} run '${runName}' failed: ` +
      `${err instanceof Error ? err.message : String(err)}. Assuming still alive.`,
    );
    alive = true;
  }

  if (alive) {
    claimedRunGoneSince.delete(key);
    return false;
  }

  const now = Date.now();
  const since = claimedRunGoneSince.get(key);
  if (since === undefined) {
    claimedRunGoneSince.set(key, now);
    return false;
  }
  if (now - since < CLAIMED_RUN_DEATH_GRACE_MS) return false;
  claimedRunGoneSince.delete(key);

  const who = record.owner === 'review' ? 'reviewer' : 'agent';
  logger.warn(
    `Task ${shortId(task.id)}: the ${record.owner} run '${runName}' is gone and never answered — ` +
    `abandoning the turn and restoring '${record.restore_status}'`,
  );
  // Best-effort post-mortem (exit code + log tail) so the abandonment turn says
  // something a human can act on, not just "it is gone".
  const diagnostics = claimRunner
    ? await collectRunDiagnostics(claimRunner, runName).catch(() => null)
    : null;
  await abandonDeadClaimedTurn(
    storage, task, record,
    `The ${who} run '${runName}' is no longer ` +
    `running and never reported${diagnostics ? ` (${diagnostics})` : ''}.`,
  );
  return true;
}

/**
 * Reconcile one task, then release its turn credential if the turn is over.
 *
 * This is the one place the daemon observes a turn's process ending — by
 * response, by crash, or by a vanished container — so it is where a team-mode
 * task's placeholder stops resolving. The container keeps the now-orphaned
 * placeholder in its env on purpose: anything it sends after its turn is over
 * gets a 401 instead of continuing to spend that user's identity. No-op for
 * every single-user install, which never binds one.
 */
async function reconcileTask(storage: Storage, taskId: string, lazyRoot: string, runner: Runner): Promise<void> {
  await reconcileTaskInner(storage, taskId, lazyRoot, runner);
  const after = await storage.getTask(taskId);
  if (!after || after.status !== 'working') {
    await releaseTurnCredential(lazyRoot, taskId);
  }
}

async function reconcileTaskInner(storage: Storage, taskId: string, lazyRoot: string, runner: Runner): Promise<void> {
  const session = await storage.getSessionByTaskId(taskId);
  if (!session) return;

  const task = await storage.getTask(taskId);
  if (!task) return;
  const tRef = taskRef(task);
  const taskShortId = shortId(taskId);

  // Monitor on the runner the session actually ran on. docker vs host discover
  // runs differently (container names vs PID files), so a host task monitored by
  // a docker-configured reconciler would be misread as crashed. Falls back to
  // the global runner for legacy/no-override sessions (runner_type null).
  // The SAME resolution every read surface renders the substate from
  // (src/utils/working-run.ts), so `working(not-alive)` names exactly what
  // this function acts on.
  const workRun = await resolveWorkRun(lazyRoot, task, session, runner);
  const taskRunner = workRun.runner;

  // A synchronous daemon turn (ask / review / wrap-up) in flight?
  //
  // INVARIANT: the reconciler never PARKS a task whose turn has a waiter. The
  // worktree lock cannot express this — `checkLock` is re-entrant on pid and
  // the reconcile loop shares the daemon process that holds the lock, so a
  // synchronous turn's claim is invisible here. Parking such a turn consumed
  // the pre-accept response out from under the accept that was waiting for it
  // and let a later tick reap the container, leaving the RPC caller polling
  // for a deleted file until its budget expired.
  //
  // The reconciler stays the SINGLE READER of `response.json`, so it does not
  // skip the task — it settles the response against the in-flight record and
  // hands the outcome to the waiter through storage. See
  // src/daemon/in-flight-turn.ts for the record, and
  // settleInFlightTurnFromProtocol for the variants (an ask records the
  // turn and restores the pre-ask status instead of parking; a review does
  // the same; a legacy pre_accept record is abandoned — that turn is
  // retired, and its mechanical gate waits claimlessly at accept).
  const inFlight = task.in_flight_turn ?? null;
  if (isInFlightLive(inFlight)) {
    const verdict = await settleInFlightTurnFromProtocol(
      storage, task, session, inFlight!, getWorktreePathForRef(lazyRoot, tRef), lazyRoot,
    );
    if (verdict === 'none') {
      // Nothing written yet. For an ASYNCHRONOUS ask/review there is no RPC
      // caller watching liveness any more, so this tick is the only thing that
      // can tell "still thinking" from "died without answering" — and the
      // second case is precisely the stranding this task exists to end.
      if (await abandonIfRunIsGone(storage, task, session, inFlight!, lazyRoot)) return;
    }
    if (verdict !== 'foreign') {
      logger.debug(`Task ${taskShortId}: ${inFlight!.owner} turn in flight (${verdict}), leaving it to run`);
      return;
    }
    // 'foreign' — the response is some OTHER command's turn. The waiter has
    // been told to abort; the turn itself is ordinary work, so fall through and
    // reconcile it normally rather than leaving it in the slot.
    logger.info(`Task ${taskShortId}: response did not answer the in-flight ${inFlight!.owner} turn — reconciling it as an ordinary turn`);
  }

  // Expired ask/review with no live waiter: restore, never interrupt.
  // After expires_at, isInFlightLive is false, so the block above does not
  // run. Falling through would treat a working task with no container as a
  // crash → interrupted → maybeAutoResume launches a WORK turn.
  const expiredSync = expiredSyncRestore(inFlight);
  if (expiredSync) {
    const expiredProto = getProtocolDir(taskId);
    if (readResponse(expiredProto)) {
      const verdict = await settleInFlightTurnFromProtocol(
        storage, task, session, expiredSync, getWorktreePathForRef(lazyRoot, tRef), lazyRoot,
      );
      if (verdict !== 'foreign') {
        logger.debug(`Task ${taskShortId}: expired ${expiredSync.owner} turn settled late (${verdict})`);
        return;
      }
    }
    logger.warn(
      `Task ${taskShortId}: expired ${expiredSync.owner} turn with no answer — ` +
      `restoring ${expiredSync.restore_status} (not interrupting; auto-resume would launch a work turn)`,
    );
    if (task.status === 'working') {
      await storage.updateTaskStatus(taskId, expiredSync.restore_status, await systemActor(lazyRoot));
    }
    await storage.clearInFlightTurn(taskId, expiredSync.turn_sequence);
    return;
  }

  // Skip tasks that are being actively worked on by another process (e.g., lazy start/unblock)
  const worktreePath = getWorktreePathForRef(lazyRoot, tRef);
  if (await checkLock(worktreePath)) {
    logger.debug(`Task ${taskShortId}: worktree locked by another process, skipping reconciliation`);
    return;
  }

  // Skip tasks that are locked for pairing (human is working interactively)
  if (checkPairingLock(worktreePath)) {
    logger.debug(`Task ${taskShortId}: locked for pairing, skipping reconciliation`);
    return;
  }

  const containerName = workRun.runName;

  // A launch THIS process is still performing — resolving or building the
  // image, then starting the run. Nothing below can be right about a run that
  // has not started: no response is expected yet, and "no container" is the
  // launch in progress, not a death. The worktree lock does not cover this
  // (re-entrant on pid, and the launch runs in this process), and the grace
  // period is 30 s against an image build that takes minutes on a fresh host.
  if (launchInFlight(containerName, taskId)) {
    logger.debug(`Task ${taskShortId}: launch still in progress in this process, skipping reconciliation`);
    return;
  }

  // Step 1: Check if supervisor has written a response
  const protoDir = getProtocolDir(taskId);
  const response = readResponse(protoDir);

  // If there's a response file, process it immediately (no grace period applies).
  // The grace period only matters when there's NO response yet - we want to give
  // the container time to start before checking if it's running.
  if (response) {
    if (response.status === 'completed') {
      logger.info(`Task ${taskShortId} finished turn, transitioning to blocked`);
      await handleCompletedResponses(storage, taskId, session, completedResponses(response), worktreePath, protoDir, lazyRoot, responseCommandId(response));

      // Note: push and PR operations moved out of reconciler.
      // Read commands (list, show, blocked, active) should be fast and local.
      // Push happens in: lazy start (publish), lazy sync (explicit), lazy accept (merge flow).
      return;
    } else {
      // Error response — record as an agent error turn so crash details are visible
      logger.info(`Task ${taskShortId} crashed (phase: ${response.phase}): ${response.error}`);
      await handleErrorResponse(storage, taskId, session, response, protoDir, lazyRoot);
      return;
    }
  }

  // Step 2: No response yet — apply grace period before checking container status.
  // Skip tasks that just transitioned to 'working' to give the container time to start.
  // This prevents a race where reconciliation runs before the container is fully launched
  // and incorrectly marks the task as interrupted.
  if (session.last_interaction_at) {
    const lastInteractionTime = new Date(session.last_interaction_at).getTime();
    const now = Date.now();
    const timeSinceTransition = now - lastInteractionTime;

    if (timeSinceTransition >= 0 && timeSinceTransition < getWorkingGracePeriodMs()) {
      logger.debug(`Task ${taskShortId}: within grace period (${Math.round(timeSinceTransition / 1000)}s), skipping reconciliation`);
      return;
    }
  }

  // Step 3: Grace period expired — check if run is still alive.
  // INVARIANT: a live run means the turn may still be finalizing (the agent has
  // stopped, but post_turn_check / post_turn_sync / pushback still run before the
  // supervisor writes response.json). We must NOT recover here — only
  // the supervisor's response.json finalizes a turn. Stranded recovery is for
  // when that response will NEVER come, i.e. the run is dead (handled below).
  if (await taskRunner.isRunning(containerName)) {
    logger.debug(`Task ${taskShortId}: run ${containerName} still running, no response yet`);
    return; // Still working
  }

  // The run is not alive and there is no response. Before declaring the turn
  // interrupted, check whether the agent actually finished: a stranded completion
  // (supervisor died at finalize) leaves real committed work on the branch with no
  // response. Recover those to 'blocked' with commits backfilled instead of
  // interrupting — interrupting would re-run the agent and lose the completion.
  if (await recoverStrandedCompletion(storage, task, session, worktreePath, protoDir, lazyRoot)) {
    await storage.updateSessionContainerName(session.id, null);
    if (await taskRunner.runExists(containerName)) {
      await taskRunner.removeRun(containerName);
    }
    return;
  }

  // Step 4: Run not active and no response — check status.json for context
  if (await taskRunner.runExists(containerName)) {
    const exitCode = await taskRunner.getRunExitCode(containerName);
    const logs = await taskRunner.getRunLogs(containerName, 50);
    const status = readStatus(protoDir);
    const reason = exitCodeToReason(exitCode);

    logger.info(`Task ${taskShortId} crashed: run stopped (exit: ${exitCode}, phase: ${status?.phase ?? 'unknown'})`);

    // Run stopped without writing response — interrupted.
    // The crash turn goes in FIRST: `session.interrupt_reason` alone is not a
    // visible record (no turn list can render it), and this is one of the two
    // ways a turn can die leaving nothing behind (fix-empty-failed-turn).
    await recordUnreportedCrashTurn(storage, session.id, taskShortId, {
      reason,
      exitCode,
      phase: status?.phase,
      logs,
    }, lazyRoot);
    await storage.updateTaskStatus(taskId, 'interrupted', await systemActor(lazyRoot));
    await storage.recordInterrupt(session.id, { reason, exit_code: exitCode, logs });
    await storage.updateSessionContainerName(session.id, null);
    clearStatus(protoDir);
    await taskRunner.removeRun(containerName);

    // Auto-resume if circuit breaker allows
    await maybeAutoResume(storage, taskId, session.id, lazyRoot);
    return;
  }

  // Step 5: No run found at all — interrupted
  logger.info(`Task ${taskShortId} crashed: run disappeared (no container found)`);
  // See Step 4 — the turn must leave a record in the turns list, not only an
  // interrupt reason on the session (fix-empty-failed-turn).
  await recordUnreportedCrashTurn(storage, session.id, taskShortId, {
    reason: 'Container disappeared (no exit code)',
    exitCode: null,
    phase: readStatus(protoDir)?.phase,
    logs: null,
  }, lazyRoot);
  await storage.updateTaskStatus(taskId, 'interrupted', await systemActor(lazyRoot));
  await storage.recordInterrupt(session.id, {
    reason: 'Container disappeared (no exit code)',
    exit_code: null,
    logs: null,
  });
  await storage.updateSessionContainerName(session.id, null);
  clearStatus(protoDir);

  // Auto-resume if circuit breaker allows
  await maybeAutoResume(storage, taskId, session.id, lazyRoot);
}

/**
 * Interrupt a working task whose supervisor was stopped because the DAEMON
 * restarted, and resume it against the new daemon.
 *
 * Called by the restart reaper (src/daemon/restart-reaper.ts) after it has
 * stopped the previous generation's run. It exists rather than letting the
 * ordinary crash path handle it because two of that path's answers would be
 * wrong here:
 *
 *  - The RECORDED REASON. Step 4 turns an exit code into "container exited with
 *    …", which blames the agent for something lazy did to it. `lazy show` should
 *    say the daemon restarted.
 *  - The CIRCUIT BREAKER. Consecutive interruptions exist to stop a task that
 *    keeps crashing from being resumed forever. A daemon restart is not the task
 *    crashing, and at MAX_CONSECUTIVE_INTERRUPTIONS = 3 an ordinary upgrade
 *    cycle could exhaust a task's budget and strand it. So the counter is reset
 *    rather than incremented.
 *
 * Everything else is the same as the crash path — same statuses, same protocol
 * cleanup, same auto-resume, same budget and concurrency gates — because the
 * recovery itself is identical: the turn is gone, the branch is intact, run it
 * again. The one thing NOT carried over is the crash path's response/log
 * capture: there is no exit code or container log worth attributing here, which
 * is the whole reason this function exists.
 */
export async function interruptForDaemonRestart(
  storage: Storage,
  taskId: string,
  lazyRoot: string,
  opts?: {
    /**
     * `stop` is the same event seen from the other side: the daemon that is
     * going away stops the supervisor itself (see the shutdown sweep in
     * src/daemon/server.ts) and records the interrupt on its way out. It must
     * NOT auto-resume — there is no daemon left to supervise the new turn.
     * Instead the next daemon's stranded-interrupt sweep picks the task up, so
     * the recovery is the same either way, just one process later.
     */
    trigger?: 'restart' | 'stop';
  },
): Promise<boolean> {
  const trigger = opts?.trigger ?? 'restart';
  const taskShortId = shortId(taskId);
  const session = await storage.getSessionByTaskId(taskId);
  if (!session) return false;

  const task = await storage.getTask(taskId);
  if (!task || task.status !== 'working') return false;

  // INVARIANT: a task that is `working` only because an ask or review is
  // VISITING it is never interrupted here. `interrupted` is auto-resumed as a
  // WORK turn, which would set the implementer running on a task nobody asked
  // to resume — and the visit's claim, left on an interrupted task, was then
  // cleared without restoring the status it found. The claim decides how the
  // visit ends: the reconciler abandons a claim another daemon made and puts
  // back `restore_status` (abandonPreviousGenerationClaim).
  const claim = task.in_flight_turn ?? null;
  if (claim && isInFlightLive(claim) && (claim.owner === 'ask' || claim.owner === 'review')) {
    logger.info(
      `Task ${taskShortId}: ${claim.owner} in flight — not interrupting; the reconciler ends it and ` +
      `restores '${claim.restore_status}'`,
    );
    return false;
  }

  await storage.updateTaskStatus(taskId, 'interrupted', await systemActor(lazyRoot));
  await storage.recordInterrupt(session.id, {
    reason: trigger === 'stop'
      ? 'Stopped by lazy: the daemon stopped, which invalidated this turn’s ' +
        'connection to the audit proxy. Resuming when the daemon is running again.'
      : 'Stopped by lazy: the daemon restarted, which invalidated this turn’s ' +
        'connection to the audit proxy. Resuming against the new daemon.',
    exit_code: null,
    logs: null,
  });
  // Not the task's fault — see the doc comment. Skipped when the session is
  // user-stopped: resetConsecutiveInterruptions also clears `user_stopped`
  // (that is how manual resume re-arms auto-resume), and a daemon restart must
  // never undo a human's `lazy stop`.
  if (!isUserStopped(session)) {
    await storage.resetConsecutiveInterruptions(session.id);
    await resetSlowLaneState(storage, taskId);
  }
  await storage.updateSessionContainerName(session.id, null);

  // The dead supervisor's last status line describes a turn that no longer
  // exists. Left behind it is read as live progress by anything polling the
  // protocol dir, and the resumed turn writes over it only once it gets going.
  // Same clear the crash path does.
  clearStatus(getProtocolDir(taskId));

  if (trigger === 'stop') {
    logger.info(`Task ${taskShortId}: interrupted by daemon stop, resumes when a daemon runs again`);
    return true;
  }

  logger.info(`Task ${taskShortId}: interrupted by daemon restart, resuming against the new daemon`);
  await maybeAutoResume(storage, taskId, session.id, lazyRoot);
  return true;
}

/**
 * Interrupt a working task whose supervisor the daemon stopped on its way out.
 *
 * Same event as {@link interruptForDaemonRestart}, recorded by the departing
 * daemon instead of the arriving one, and without the resume — see the
 * `trigger` option there.
 */
export async function interruptForDaemonStop(
  storage: Storage,
  taskId: string,
  lazyRoot: string,
): Promise<boolean> {
  return interruptForDaemonRestart(storage, taskId, lazyRoot, { trigger: 'stop' });
}

/**
 * Check circuit breaker, auto-react budget, and auto-resume an interrupted task if allowed.
 * Re-reads the session to get the updated consecutive_interruptions count.
 *
 * @param trigger - The auto-react trigger type (defaults to 'crash' for interrupt recovery).
 */
async function maybeAutoResume(
  storage: Storage,
  taskId: string,
  sessionId: string,
  lazyRoot: string,
  trigger: AutoReactTrigger = 'crash',
): Promise<void> {
  const taskShortId = shortId(taskId);

  // Re-read session to get updated consecutive_interruptions from recordInterrupt
  const session = await storage.getSessionByTaskId(taskId);
  if (!session) return;

  // Don't auto-resume if session has ended
  if (session.ended_at) {
    logger.debug(`Task ${taskShortId}: session ended, skipping auto-resume`);
    return;
  }

  // INVARIANT: A user-initiated `lazy stop` must NOT be undone by the reconciler.
  // Crash-interrupted sessions (user_stopped=false) continue through auto-resume
  // as before; only an explicit human/builder stop sets this flag, and it is
  // cleared by manual resume/unblock (resetConsecutiveInterruptions).
  if (isUserStopped(session)) {
    logger.debug(`Task ${taskShortId}: user-stopped, skipping auto-resume`);
    return;
  }

  // Circuit breaker: stop auto-resuming on this fast lane after too many
  // consecutive interruptions. The task isn't abandoned — it falls to the
  // slow-lane round-robin queue (src/daemon/auto-resume-queue.ts), which
  // retries it on daemon.auto_resume_interval_minutes up to
  // daemon.auto_resume_max_attempts.
  if (session.consecutive_interruptions >= MAX_CONSECUTIVE_INTERRUPTIONS) {
    logger.warn(`Task ${taskShortId}: fast-lane circuit breaker triggered (${session.consecutive_interruptions} consecutive interruptions), falling to slow-lane auto-resume queue`);
    return;
  }

  // Re-read the task to get the current state
  const task = (await storage.listTasks()).find(t => t.id === taskId);
  if (!task) return;

  // Only auto-resume interrupted tasks
  if (task.status !== 'interrupted') return;

  const config = await loadConfig(lazyRoot);
  const dataDir = join(lazyRoot, config.data.path);

  // Usage pause ([usage_pause]): FIRST among the pacing gates, because it must
  // consume nothing — not the project-wide gap below, not the auto-react
  // budget. A held task stays interrupted, and the stranded-interrupt sweep
  // (resumeStrandedInterruptedTasks) offers it here again on every tick, so it
  // goes ahead on the first tick after the window resets.
  const usageHold = await usagePauseHold(lazyRoot, storage, task, 'auto-resume');
  if (usageHold) {
    logger.info(`Task ${taskShortId}: auto-resume held by usage pause — ${usageHold}`);
    return;
  }

  // Project-wide gap: shared with the slow lane (src/daemon/auto-resume-queue.ts)
  // via the same auto-resume-queue.json timestamp, so daemon.auto_resume_gap_minutes
  // spaces out ANY two auto-resumes, fast-lane or slow-lane. Without this, a burst
  // of simultaneous crashes (e.g. many tasks hitting a shared token-exhaustion
  // error) would relaunch all of them immediately on the fast lane — exactly the
  // pile-up the gap exists to prevent — before any of them ever reached the slow
  // lane's throttling.
  if (config.daemon.auto_resume_gap_minutes > 0) {
    const lastProjectAttempt = await getLastProjectAutoResumeAt(dataDir);
    if (lastProjectAttempt !== null) {
      const gapEligibleAt = lastProjectAttempt + config.daemon.auto_resume_gap_minutes * 60_000;
      if (Date.now() < gapEligibleAt) {
        logger.debug(`Task ${taskShortId}: within project-wide auto-resume gap (auto_resume_gap_minutes=${config.daemon.auto_resume_gap_minutes}), deferring`);
        return;
      }
    }
  }

  // Auto-react budget gate: check per-task limits, backoff, and daily budget
  try {
    const decision = await shouldAutoReact(storage, taskId, trigger, config, dataDir);

    if (!decision.allowed) {
      if (decision.backoffRemainingMs) {
        // Backoff not elapsed — the reconcile loop will retry on the next tick
        logger.debug(`Task ${taskShortId}: auto-react blocked by backoff (${decision.reason})`);
      } else {
        // Hard limit reached — log as warning so it's visible
        logger.warn(`Task ${taskShortId}: auto-react blocked: ${decision.reason}`);
      }
      return;
    }
  } catch (err) {
    // Budget check failure should not prevent auto-resume — fail open
    logger.debug(`Task ${taskShortId}: auto-react budget check failed: ${err instanceof Error ? err.message : err}`);
  }

  try {
    const success = await autoResumeTask(storage, task, session, lazyRoot);
    // Record the project-wide gap timestamp regardless of outcome — a failed
    // attempt still launched a container and cost the shared resource the gap
    // is protecting.
    try {
      await recordProjectAutoResume(dataDir, Date.now());
    } catch (err) {
      logger.debug(`Task ${taskShortId}: failed to record project-wide auto-resume timestamp: ${err instanceof Error ? err.message : err}`);
    }
    if (success) {
      // Record the auto-react consumption (counter + daily budget)
      try {
        await recordAutoReact(storage, taskId, trigger, dataDir);
      } catch (err) {
        logger.debug(`Task ${taskShortId}: failed to record auto-react: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      logger.debug(`Task ${taskShortId}: auto-resume failed, task remains interrupted`);
    }
  } catch (err) {
    logger.debug(`Task ${taskShortId}: auto-resume error: ${err instanceof Error ? err.message : err}`);
  }
}

const SANDBOX_DIR = '.lazy-task-sandbox';

/**
 * Read plan file content from the Claude Code sandbox's .claude/plans/ directory.
 * Claude Code writes plan files as .md files in this location when entering plan mode.
 * Returns the content of the most recently modified plan file, or null if none found.
 */
export function readPlanContent(worktreePath: string): string | null {
  const plansDir = join(worktreePath, SANDBOX_DIR, '.claude', 'plans');
  if (!existsSync(plansDir)) return null;

  try {
    const files = readdirSync(plansDir).filter(f => f.endsWith('.md'));
    if (files.length === 0) return null;

    // Find the most recently modified plan file
    let newest: { file: string; mtime: number } | null = null;
    for (const file of files) {
      const filePath = join(plansDir, file);
      const st = statSync(filePath);
      if (!newest || st.mtimeMs > newest.mtime) {
        newest = { file, mtime: st.mtimeMs };
      }
    }

    if (!newest) return null;

    const content = readFileSync(join(plansDir, newest.file), 'utf-8').trim();
    if (!content) return null;

    return content;
  } catch {
    return null;
  }
}

/**
 * Enrich the agent's response with plan content from the sandbox.
 *
 * When Claude Code enters plan mode, it writes the plan to a .md file in the
 * sandbox's .claude/plans/ directory, but the JSON response only contains a
 * brief summary like "The plan is ready for review." This function detects
 * plan files and appends their content to the response so the plan is captured
 * in the turn record.
 */
export function enrichResponseWithPlanContent(result: string, worktreePath: string): string {
  const planContent = readPlanContent(worktreePath);
  if (!planContent) return result;

  logger.debug('Found plan content in sandbox, enriching turn response');
  return result + '\n\n--- Plan File Content ---\n\n' + planContent;
}

/**
 * Recover a task stranded in `working` whose agent finished real, committed
 * work but whose turn was never finalized into storage.
 *
 * The normal path is: supervisor writes response.json → reconciler records the
 * agent turn + commits → working→blocked. If the supervisor never produces a
 * processable response (crash / kill / OOM / teardown at finalize, or an agent
 * that committed and reported but never exited so no response is ever written),
 * the turn is lost and the task wedges in `working` forever: zero agent turns,
 * zero recorded commits, no blocked transition, no review notification.
 *
 * The durable proof of work is the git branch — the live specimen had 625
 * committed lines while storage showed commit_count=0. This backfills those
 * commits from the branch, records a recovery turn so the lost-finalize gap is
 * visible, and transitions working→blocked through the canonical state machine.
 * That working→blocked transition is exactly what the daemon's state-change
 * detector (src/daemon/server.ts) turns into a `task.completed` notification, so
 * recovering here restores the review loop with no extra wiring.
 *
 * Returns true if it recovered (real committed work existed); false otherwise,
 * so the caller can fall back to its normal handling (e.g. interrupted).
 *
 * INVARIANT: only recovers when an unrecorded NON-MERGE commit changes the tree
 * against its own parent. A `lazy start` init commit (--allow-empty, no tree
 * change) is NOT work, and neither is any merge (a self-sync's `Merge <ref>`
 * above all) — those tasks fall through to interrupted/resume, mirroring the
 * zombie sweep's `hasAgentWork` guard. Asked per commit, a commit followed by
 * its own revert now counts as work where the old net-range gate did not; that
 * is the price of never letting upstream content a merge brought in pass.
 *
 * INVARIANT: this recovery NEVER applies to a `cluster` task. The whole
 * heuristic is "commits on the branch that storage does not know about prove
 * the agent finished and only the finalize handshake was lost". That inference
 * holds for an ordinary task, whose branch commits are its own agent's work. It
 * is simply false for a cluster, whose turn is ORCHESTRATION: every
 * `lazy_accept` of a child lands that child's work on the cluster's branch
 * DURING the driver's turn, so from its first accept onwards a cluster killed at
 * ANY point mid-turn looks like a stranded completion. It was then parked in
 * `blocked`, and `cluster-restart.ts` only wakes a blocked cluster when a NEW
 * child is added — so a driver killed by `lazy upgrade`, a daemon restart or a
 * crash never resumed on its own and sat waiting for a human (the
 * identity-remote-clients-loop incident, 2026-09-14: five and a half hours
 * parked with six child-accept merges "backfilled" as its own work). Clusters go
 * down the ordinary interrupted → auto-resume path instead, where the driver
 * re-reads its subtree — the source of truth per
 * src/prompts/cluster-constraints.md — and carries on. Nothing is lost by not
 * backfilling here: the next finalized turn records every commit since the last
 * known SHA anyway.
 */
/**
 * Build the content for a stranded-completion recovery turn.
 *
 * Incremental turn persistence: the agent's written report is recovered from
 * the Claude Code session transcript that was written incrementally to disk as
 * the agent produced it — so a lost or late finalize no longer loses the words.
 * When the transcript yields the report, the recovery turn carries the agent's
 * ACTUAL report (prefixed with a short note that finalize was lost). Only when
 * no transcript text can be found do we fall back to the lossy placeholder.
 *
 * `sinceTimestampMs` is the watermark: the timestamp of the last finalized turn.
 * Recovery surfaces only transcript content NEWER than it, so a turn that
 * produced no report falls back to the placeholder instead of resurfacing the
 * previous turn's report. Null/undefined (a stranded first turn) recovers the
 * latest message as before. See `readAgentReportFromSessionLog`.
 *
 * Exported for unit testing.
 */
export async function buildStrandedRecoveryTurnContent(
  worktreePath: string,
  agentSessionId: string | null,
  newCommitCount: number,
  sinceTimestampMs?: number | null,
): Promise<string> {
  const report = await readAgentReportFromSessionLog(worktreePath, agentSessionId, sinceTimestampMs);
  if (report) {
    return (
      '[Recovered] The supervisor never finalized this turn (no response was produced — ' +
      'likely a crash, kill, or hang at finalize), so the task was recovered from a stranded ' +
      `'working' state: ${newCommitCount} commit(s) were backfilled from the branch and the task ` +
      "moved to 'blocked' for review. The agent's written report below was recovered from the " +
      'session transcript.\n\n---\n\n' +
      report
    );
  }
  return (
    '[Recovered] The agent committed its work but the supervisor never finalized the turn ' +
    '(no response was produced — likely a crash, kill, or hang at finalize). Recovered from a ' +
    `stranded 'working' state: backfilled ${newCommitCount} commit(s) from the branch and ` +
    "moved the task to 'blocked' for review. The agent's written report for this turn was lost; " +
    'the committed code is intact on the branch.'
  );
}

async function recoverStrandedCompletion(
  storage: Storage,
  task: Pick<Task, 'id' | 'type'>,
  session: { id: string; git_start_sha: string; agent_session_id: string | null },
  worktreePath: string,
  protoDir: string,
  lazyRoot?: string,
): Promise<boolean> {
  const taskId = task.id;
  const taskShortId = shortId(taskId);

  // INVARIANT: a cluster task is never a stranded completion (see the doc
  // comment above). Its branch carries its children's accepted work, so commits
  // are never evidence that the driver's own TURN finished — and parking it in
  // `blocked` strands it, because only a newly added child wakes a blocked
  // cluster. Fall through to interrupted/auto-resume, like any other killed task.
  if (isClusterTask(task)) {
    logger.debug(`Task ${taskShortId}: cluster task — stranded-completion recovery does not apply, falling through to interrupted.`);
    return false;
  }

  // Defense-in-depth against a racy liveness probe: never claim completion while
  // the supervisor's recorded phase shows active post-work harness machinery.
  // Callers only reach here once the run looks dead, but if that probe is ever
  // wrong, this keeps us from racing a supervisor that is still finalizing the
  // turn (post-turn check/sync, merge, pushback, writing the response). Such a
  // task falls through to the interrupted/auto-resume path instead.
  const status = readStatus(protoDir);
  if (status && ACTIVE_HARNESS_PHASES.has(status.phase)) {
    logger.debug(`Task ${taskShortId}: status phase '${status.phase}' indicates active harness work — skipping stranded recovery.`);
    return false;
  }

  // INVARIANT: a killed SYNC turn is never a stranded completion. This recovery
  // reads unrecorded commits as proof the agent finished and only the finalize
  // handshake was lost — and for a sync that inference is false the same way it
  // is false for a cluster above. A sync's commits are the MERGE, landed by the
  // supervisor mid-turn: a sync killed after step 1 (the task branch's own
  // origin) but before step 2 (the parent) has commits and is HALF DONE. Backfilling
  // them and recording "[Recovered] the agent finished" parks the task looking
  // settled over a branch that is only partly synced — the fix-sync-silent-conflict
  // failure with a different cause. It also parks through the plain paused label,
  // so a `submitted` task would drop out of the review queue exactly as it did
  // before the restore existed (src/task/sync-restore-status.ts).
  //
  // Falls through to the ordinary interrupted → auto-resume path, like a cluster.
  // The restore marker is left untouched and is inert: it names a command that
  // is over, and no later turn can present that id.
  //
  // `command_type` is the right signal even though status.json can be missing: a
  // supervisor killed before it wrote status.json had not merged anything either,
  // so the commit gate below would not have fired in the first place.
  if (status?.command_type === 'sync') {
    logger.debug(`Task ${taskShortId}: killed sync turn — stranded-completion recovery does not apply, falling through to interrupted.`);
    return false;
  }

  let scan;
  try {
    scan = await scanSessionCommits(storage, session, worktreePath);
  } catch (err) {
    logger.debug(`Task ${taskShortId}: stranded-recovery commit scan failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  if (!scan.base || scan.commits.length === 0) return false;

  // INVARIANT: a merge commit is never evidence the agent finished. What this
  // recovery reads as "the turn's work is done" must be the agent's own
  // commits; a merge (two or more parents) on the first-parent line is an
  // INTEGRATION — above all the self-sync route's `Merge <ref>` (a working
  // agent's `lazy_sync`, src/daemon/self-sync.ts), which deliberately records
  // no commits because the calling agent's own work turn owns that SHA window,
  // plus a conflicted step the agent concluded with lazy_commit. An agent that
  // self-synced and then crashed has nothing unrecorded BUT that merge, and
  // reading it as finished work parked the task `blocked` behind a bogus
  // "[Recovered]" turn instead of resuming it. Every merge is excluded, not
  // only one whose second parent matches a resolved upstream ref: resolving
  // that ref needs the driver, and no kind of merge proves a turn is over.
  // Merges are still RECORDED when real work does trigger recovery below —
  // recordSessionCommits' range rules are untouched; only the inference skips them.
  const evidence: string[] = [];
  for (const c of scan.commits) {
    const second = await runGit(['rev-parse', '--verify', '--quiet', `${c.sha}^2`], { cwd: worktreePath });
    if (second.exitCode !== 0) evidence.push(c.sha);
  }
  if (evidence.length === 0) {
    logger.debug(`Task ${taskShortId}: only merge commits are unrecorded — not a stranded completion, falling through to interrupted.`);
    return false;
  }

  // Real-work gate: ignore empty (--allow-empty) commits that introduce no
  // tree change. `git diff --quiet` exits 1 when trees differ (real content) and
  // 0 when identical (nothing worth reviewing).
  //
  // Asked per UNRECORDED NON-MERGE commit against its own first parent, never
  // over a range: a range from the branch point lets prior recorded work pass
  // the gate on an empty commit, and a range spanning a sync merge lets the
  // upstream changes it brought in pass for the agent's work. A root commit has
  // no parent; there the branch point is the only sensible floor.
  let realWork = false;
  for (const sha of evidence) {
    const parent = await runGit(['rev-parse', '--verify', '--quiet', `${sha}^1`], { cwd: worktreePath });
    const from = parent.exitCode === 0 ? parent.stdout.trim() : scan.base;
    const diff = await runGit(['diff', '--quiet', from, sha], { cwd: worktreePath });
    if (diff.exitCode !== 0) { realWork = true; break; }
  }
  if (!realWork) return false;

  logger.warn(`Task ${taskShortId}: stranded in 'working' with ${scan.commits.length} unrecorded commit(s) and no response — recovering to 'blocked' and backfilling commits.`);

  // Backfill commits — git is the source of truth when storage is empty.
  await recordSessionCommits(storage, session, worktreePath, taskShortId);

  // Record a recovery turn so the lost-finalize gap is visible to reviewers.
  // Idempotent: skip if an agent turn already closes out the session.
  const turns = await storage.getSessionTurns(session.id);
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  if (lastTurn?.role !== 'agent') {
    // Watermark: recover only transcript content newer than the last finalized
    // turn. The persisted turns' timestamps ARE the high-water mark of consumed
    // transcript — using the latest one means a turn that produced no report
    // falls back to the placeholder instead of resurfacing the prior turn's
    // report. With no prior turn (stranded first turn) there is no watermark and
    // recovery takes the latest message, as before. This relies on the turn
    // timestamp (host clock at finalize) sitting after the agent's transcript
    // timestamps for already-consumed turns — true on a shared clock, which the
    // worktree + transcript + reconciler always share (same machine).
    const watermarkMs = turns.length > 0
      ? Math.max(...turns.map(t => t.timestamp))
      : null;
    const seq = await storage.getNextTurnSequence(session.id);
    await createAgentTurn(storage, {
      sessionId: session.id,
      sequence: seq,
      role: 'agent',
      content: await buildStrandedRecoveryTurnContent(worktreePath, session.agent_session_id, scan.commits.length, watermarkMs),
    }, lazyRoot);
  }

  // The agent ran to completion here (only the finalize handshake was lost), so
  // its feedback backlog is consumed — same rule as handleCompletedResponse.
  try {
    await storage.markFeedbackConsumed(session.id);
  } catch (err) {
    logger.debug(`Task ${taskShortId}: could not mark feedback consumed during recovery: ${err instanceof Error ? err.message : err}`);
  }

  // Canonical working→paused transition (validated by src/task-state-machine.ts).
  // Stranded recovery saw no response at all, so it learned nothing about
  // violations — it must not clear a pending set (violations-are-the-source-of-truth).
  await parkTaskPaused(storage, taskId, await systemActor(lazyRoot), { sessionId: session.id });

  // A healthy completion clears the crash counters.
  try {
    await storage.resetConsecutiveInterruptions(session.id);
  } catch (err) {
    logger.debug(`Task ${taskShortId}: could not reset interruption counter during recovery: ${err instanceof Error ? err.message : err}`);
  }
  try {
    const { resetAutoReactCounters } = await import('../daemon/auto-react-budget');
    await resetAutoReactCounters(storage, taskId);
  } catch (err) {
    logger.debug(`Task ${taskShortId}: could not reset auto-react counters during recovery: ${err instanceof Error ? err.message : err}`);
  }
  try {
    await resetSlowLaneState(storage, taskId);
  } catch (err) {
    logger.debug(`Task ${taskShortId}: could not reset slow-lane state during recovery: ${err instanceof Error ? err.message : err}`);
  }

  // Clear stale status so a future turn starts clean.
  clearStatus(protoDir);

  return true;
}

/**
 * Handle a completed response from the supervisor.
 * Records the agent turn, captures commits, snapshots, etc.
 */
/** Supervisor-turn heading per follow-up kind, so `lazy show` labels it clearly. */
function supervisedHeading(kind: SupervisedKind): string {
  switch (kind) {
    case 'permission_pushback':
      return '## Permission Violation Review';
    case 'maintain':
      return '## Maintained Files Review';
    case 'react':
      return '## Reactive Automation';
    case 'commit_leftovers':
      return '## Uncommitted Work';
    case 'present':
      return '## Presentation Walkthrough';
    case 'low_high_review':
      return '## Low-High Loop Self-Review';
    case 'low_high_revise':
      return '## Low-High Loop Revision';
    // The re-ask is carried on the review RESPONSE (`review_reask`), not as a
    // supervised turn of its own, so this arm exists only for completeness of
    // the union. See src/supervisor/review-reask.ts.
    case 'review_reask':
      return REVIEW_REASK_HEADING;
  }
  // A kind THIS build has no arm for. Reachable across an upgrade: a response
  // written by the previous supervisor can still be sitting in the mailbox
  // when the new daemon reads it, and `final_nudge` — retired when the turn
  // ending became derived — is exactly such a kind. Label it from the wire
  // value rather than recording a turn whose heading is `undefined`.
  return `## ${String(kind)}`;
}

/**
 * Roll up every invocation's usage in a bundle (work + supervised follow-ups).
 *
 * See src/utils/usage-recording.ts for the invariant this must be called under:
 * only where the corresponding turn(s) are written.
 */
export async function rollUpBundleUsage(
  storage: Storage,
  sessionId: string,
  responses: Array<{ usage?: AgentTokenUsage }>,
  taskShortId: string,
): Promise<void> {
  for (const resp of responses) {
    await rollUpSessionUsage(storage, sessionId, toTurnUsage(resp.usage, `Task ${taskShortId}`), `Task ${taskShortId}`);
  }
}

/**
 * Record each supervised invocation of a bundle as its own human→agent turn
 * pair, exactly as the work path's chain records them.
 *
 * Exported so the sync-turn settle can use it too. Returns every turn it
 * wrote, so the caller can stamp the wrap-up audit (§13.3) on exactly the
 * turns it recorded.
 */
export async function recordSupervisedTurns(
  storage: Storage,
  sessionId: string,
  supervised: CompletedResponse[],
  worktreePath: string,
  /**
   * Who owns the turn these follow-ups belong to. Passed in rather than read
   * off the session, because this runs on BOTH the live path (where the session
   * is right) and the superseded sweep (where it names a newer turn's owner) —
   * see createRecoveredAgentTurn.
   */
  owner: TurnOwner | null,
): Promise<Turn[]> {
  const recorded: Turn[] = [];
  for (const resp of supervised) {
    if (!resp.supervised) continue; // defensive: a supervised follow-up must carry its block
    const { kind, prompt } = resp.supervised;

    const promptSeq = await storage.getNextTurnSequence(sessionId);
    recorded.push(await storage.createTurn({
      sessionId,
      sequence: promptSeq,
      role: 'human',
      content: `${supervisedHeading(kind)}\n\n${prompt}`,
      prompt,
      // The supervisor authored this autonomously — not the human, not the agent.
      actor: 'supervisor',
      autoTriggered: true,
      turnType: 'nudge',
    }));

    const replySeq = await storage.getNextTurnSequence(sessionId);
    recorded.push(await createRecoveredAgentTurn(storage, {
      sessionId,
      sequence: replySeq,
      role: 'agent',
      content: enrichResponseWithPlanContent(resp.result, worktreePath),
      usage: toTurnUsage(resp.usage),
      ...launchSettingsFromResponse(resp),
      startSha: resp.start_sha_work,
      endSha: resp.end_sha_work,
      startShaWork: resp.start_sha_work,
      endShaWork: resp.end_sha_work,
      // Violations re-detected after THIS invocation. Persist when the field is
      // present — including [] — so latestViolationTurn treats an empty re-detect
      // as authoritative over an earlier non-empty push-back set (e.g. react
      // cleaned protected edits). Field absent (maintain) is not a re-detect.
      ...(resp.violations !== undefined ? { violations: resp.violations } : {}),
      // Pencils down declared DURING this follow-up. The claim goes on the
      // turn that made it — a supervised `nudge` turn never un-finals, so a
      // claim recorded here stands.
      ...(resp.final ? { final: finalClaimOf(resp.final) } : {}),
      turnType: 'nudge',
    }, owner));

    // THE LOW-HIGH SELF-REVIEW IS ALSO A RECORDED REVIEW.
    //
    // The nudge pair above is the transcript — what the reviewer said and what
    // the revise phase then acted on. This second turn is the same reply read
    // as a REPORT, in the one shape every review surface already understands:
    // it is what the Reviews tab lists, what `lazy show` renders, and what
    // `[review] gate = "always"` can hold a merge on. Without it that setting
    // would have been documented and inert — the mode's own review would have
    // been the one review nothing could gate on (engineer requirement,
    // 2026-09-21).
    //
    // `reviewDispatch: 'self'` because nobody ASKED for it AND it did not come
    // from a reviewer of its own: it ran inside this very session because the
    // task is in `low_high` mode. It follows the same mode rule `auto` does, so
    // the default gate leaves it alone and `always` picks it up — and the extra
    // value is what lets the dispatch dedup tell it apart from the reviewer a
    // driver escalates to (see `maybeAutoReview`).
    if (kind === 'low_high_review') {
      await recordLowHighSelfReview(
        storage,
        sessionId,
        resp.result ?? '',
        reviseApplied(supervised),
        owner,
      );
    }
  }
  return recorded;
}

/**
 * Did the revise phase of this bundle APPLY the self-review's instructions?
 *
 * Two conditions, and both are needed. The phase must have RUN — an approved
 * self-review skips it, and there is nothing to apply then anyway — and it must
 * have moved HEAD, because the loop is non-fatal at every phase: a crashed or
 * refusing revise still records a response, and the draft's work stands
 * unchanged. A revise that changed nothing addressed nothing.
 *
 * This is what lets `gate = "always"` hold a merge on a self-review that found
 * something and NOT on one that found something and fixed it — which is the
 * difference between a setting a project can live with and one that strands
 * every task the mode works on.
 */
function reviseApplied(supervised: CompletedResponse[]): boolean {
  return supervised.some(
    (r) =>
      r.supervised?.kind === 'low_high_revise' &&
      Boolean(r.end_sha_work) &&
      r.end_sha_work !== r.start_sha_work,
  );
}


/**
 * Record the low-high self-review's REPORT as a review turn, when it parsed.
 *
 * A parsed reply becomes the report the reviewer wrote. A launch failure is
 * different from an agent merely wording a reply badly: nothing reviewed the
 * work, so the supervisor's `FAILED:` response becomes an explicit failed
 * report carrying the harness error. That makes the failure loud to a cluster
 * driver and prevents "no report" from looking like a clean pass.
 *
 * An ordinary unparseable reply still records no review. Nothing is lost: the
 * supervised nudge pair above carries the reviewer's full text, which is what
 * a person reads. What is lost is only the GATE, and `always` says "any
 * recorded review gates" — there is no recorded review here to gate on.
 *
 * Never throws: the work turn is already durable, and a review turn this
 * function fails to write must not unwind the exchange that produced it.
 */
async function recordLowHighSelfReview(
  storage: Storage,
  sessionId: string,
  text: string,
  addressed: boolean,
  /** The owner of the turn this self-review belongs to — the same owner the
   *  supervised reply beside it is written with (see recordSupervisedTurns). */
  owner: TurnOwner | null,
): Promise<void> {
  try {
    const parsed = parseReviewReport(text);
    const report = text.trim().startsWith('FAILED:')
      ? {
          verdict: text.trim(),
          security: 'not reviewed',
          data_integrity: 'not reviewed',
          findings: [],
        }
      : parsed;
    if (reviewReportIsUnparsed(report) && !text.trim().startsWith('FAILED:')) return;

    const sequence = await storage.getNextTurnSequence(sessionId);
    await createRecoveredAgentTurn(storage, {
      sessionId,
      sequence,
      role: 'agent',
      content: formatReviewReport(report),
      turnType: 'review',
      review: report,
      reviewDispatch: 'self',
      ...(addressed ? { reviewAddressed: true } : {}),
    }, owner);
  } catch (err) {
    logger.warn(
      `Could not record the low-high self-review as a review turn: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}


/**
 * Turn what an agent DECLARED into the stored {@link FinalClaim}.
 *
 * The actor is imposed here rather than read off the wire: a claim arriving on
 * a protocol response was made by an agent, through `lazy_final` or its handoff
 * fallback, and a container-side process may not name itself something else.
 * `wrap_up_steps` starts empty — it is an audit record of what a wrap-up ran,
 * stamped later, and never the task's audience (design §13.3).
 */
function finalClaimOf(declaration: FinalDeclaration): FinalClaim {
  const at = Date.parse(declaration.declared_at);
  return {
    sha: declaration.sha,
    actor: 'agent',
    at: Number.isFinite(at) ? at : Date.now(),
    ...(declaration.note ? { note: declaration.note } : {}),
    wrap_up_steps: [],
  };
}

/**
 * Stamp the wrap-up audit record (§13.3) onto the turns of an exchange that
 * carried a final claim.
 *
 * `wrap_up_steps` on a FinalClaim is an AUDIT record — what the wrap-up
 * actually ran — and never the task's audience: the audience is resolved per
 * task by `audienceOf`. A claim is created with an empty list (the finalize
 * marker turn, or `finalClaimOf` for a declaration made mid-work); this fills
 * it with the kinds of the supervised invocations recorded in the same
 * exchange. A step that skipped writes no response, so the kinds are exactly
 * the steps that ran.
 *
 * Idempotent: it runs inside the record-once guards of the settle/work paths,
 * and re-stamping the same value is harmless. Deliberately skips claims whose
 * audit is already filled — a later exchange must never rewrite an earlier
 * exchange's record.
 */
export async function stampWrapUpAudit(
  storage: Storage,
  taskId: string,
  turns: Turn[],
  stepKinds: string[],
): Promise<void> {
  if (stepKinds.length === 0) return;
  for (const turn of turns) {
    if (!turn.final || turn.final.wrap_up_steps.length > 0) continue;
    try {
      await storage.updateTurnWrapUpSteps(taskId, turn.id, stepKinds);
    } catch (err) {
      logger.warn(
        `Task ${shortIdHelper(taskId)}: could not stamp the wrap-up audit on turn ${turn.sequence}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Journal a worktree rollback the supervisor performed, attributed to it.
 *
 * INVARIANT (fix-sync-silent-conflict): rolling back a half-merged worktree is
 * never silent. Whatever was in that worktree may have been a real in-progress
 * resolution — a human's or an agent's — and the only record of its destruction
 * used to be a line in a container log that dies with the container. The journal
 * is the right home: durable, attributed, and never fed back into a prompt.
 *
 * Best-effort by design: a journal write must never fail the turn it annotates.
 *
 * Exported so the mechanical acceptance gate can journal a rollback too: the
 * gate records no turn (its outcome is not a turn's answer), so the daemon-side
 * gate launcher is the only place its recovery could ever be recorded.
 */
export async function journalWorktreeRecovery(
  storage: Storage,
  taskId: string,
  recovery: WorktreeRecovery | undefined,
): Promise<void> {
  if (!recovery) return;
  const lines = [recovery.summary];
  if (recovery.files.length > 0) {
    lines.push(`Unmerged files: ${recovery.files.join(', ')}`);
  }
  if (recovery.patch_path) {
    lines.push(`Recovery patch: ${recovery.patch_path}`);
  }
  try {
    await storage.appendJournalEntry(taskId, lines.join('\n'), 'supervisor');
    logger.warn(`Task ${shortId(taskId)}: ${recovery.summary}`);
  } catch (err) {
    logger.warn(
      `Task ${shortId(taskId)}: could not journal a worktree rollback (${recovery.summary}): ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Persist the end-of-turn journal entries and follow-ups an agent could not
 * write itself because its `lazy_*` tools were unreachable.
 *
 * The supervisor collected these from the agent's handoff file (see
 * src/supervisor/turn-handoff.ts) and carried them home on the response; this is
 * where they finally reach Storage — through the daemon, like every other write,
 * so nothing bypasses storage ownership.
 *
 * Idempotent by CONTENT, for two reasons: the reconciler can re-run over a
 * response it has already consumed, and an agent whose tools came BACK may have
 * both written the file and made the tool call. Same rule as error turns.
 *
 * Best-effort by design: failing to persist a retrospective must not fail the
 * turn it belongs to — but it is warned about loudly, because a lost
 * retrospective is exactly what this whole mechanism exists to prevent.
 */
async function persistAgentHandoff(
  storage: Storage,
  taskId: string,
  entries: AgentHandoffEntry[] | undefined,
): Promise<void> {
  if (!entries || entries.length === 0) return;
  const taskShortId = shortId(taskId);

  let existingJournal: string[] = [];
  let existingRaised: string[] = [];
  try {
    existingJournal = (await storage.getTaskJournal(taskId)).map(e => e.content);
    existingRaised = (await storage.getTaskRaisedItems(taskId)).map(i => i.content);
  } catch (err) {
    logger.debug(
      `Task ${taskShortId}: could not read existing journal/raised items for handoff dedup: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let recorded = 0;
  for (const entry of entries) {
    // `final` is not a journal entry and not a raise: the supervisor already
    // turned it into a claim on the response, and the turn write records it.
    // Falling through would journal "pencils down" as a retrospective.
    if (entry.kind === 'final') continue;
    const content = entry.content.trim();
    if (!content) continue;
    try {
      if (entry.kind === 'journal') {
        if (existingJournal.includes(content)) continue;
        await storage.appendJournalEntry(taskId, content, 'agent');
        existingJournal.push(content);
      } else {
        if (existingRaised.includes(content)) continue;
        // `followup` is the non-blocking spelling; a handoff item gates accept
        // only when the agent said `blocking` explicitly.
        await storage.createRaisedItem(taskId, {
          content,
          blocking: entry.kind === 'raised' && entry.blocking === true,
        });
        existingRaised.push(content);
      }
      recorded++;
    } catch (err) {
      logger.warn(
        `Task ${taskShortId}: could not persist an end-of-turn ${entry.kind} the agent handed off: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Count what was actually written, not what was offered: a reconciler re-run
  // and an agent whose tools came back mid-turn both hand off content that is
  // already in the store, and reporting those as "recorded" would be a lie.
  if (recorded === 0) return;
  logger.info(
    `Task ${taskShortId}: recorded ${recorded} end-of-turn handoff entr` +
    `${recorded === 1 ? 'y' : 'ies'} the agent could not write itself (lazy tools were unavailable)`,
  );
}

export async function handleCompletedResponse(
  storage: Storage,
  taskId: string,
  session: { id: string; agent_session_id: string | null; git_start_sha: string; container_name: string | null },
  response: CompletedResponse,
  worktreePath: string,
  protoDir: string,
  lazyRoot?: string,
): Promise<void> {
  return handleCompletedResponses(
    storage, taskId, session, [response], worktreePath, protoDir, lazyRoot,
    responseCommandId(response),
  );
}

/**
 * Split a sync bundle into its per-step pairs, in the order the steps ran.
 *
 * A sync runs up to two merge STEPS — `origin/<task-branch>` first, then the
 * parent branch — and each contributes an announcement (the response carrying
 * `sync`) optionally followed by the agent's conflict-resolution reply (the
 * response that does not). Reading the bundle by fixed index, as this path did
 * when a sync had exactly one step, would attribute the parent step's
 * announcement to the origin step's agent reply.
 */
function groupSyncSteps(
  responses: CompletedResponse[],
): Array<{ announcement: CompletedResponse; resolution?: CompletedResponse }> {
  const steps: Array<{ announcement: CompletedResponse; resolution?: CompletedResponse }> = [];
  for (const resp of responses) {
    if (resp.sync) {
      steps.push({ announcement: resp });
    } else if (steps.length > 0) {
      steps[steps.length - 1].resolution = resp;
    }
  }
  return steps;
}

/**
 * Record the turns for a completed sync command.
 *
 * Sync is modeled differently from a work turn: the supervisor performs each
 * merge itself, so its announcement is a `supervisor`-actored turn — never an
 * agent turn and never a human turn. Each step's OUTCOME (`.sync`) drives its
 * shape:
 *
 *   - merged: false (no-op) → NO turn at all for that step. A sync that merged
 *     nothing leaves no trace in the turn history (skip-when-noop), which is why
 *     the common "origin had nothing, the parent moved" sync still records
 *     exactly one turn.
 *   - merged: true, no conflicts → a single `supervisor` merge turn; the merge
 *     commit is attributed to it (its own SHA window).
 *   - merged: true, conflicts → the `supervisor` merge turn PLUS the agent's
 *     conflict-resolution reply as a discrete `agent` turn that owns the merge
 *     commit and carries the agent's own usage (incl. cache tokens).
 *
 * INVARIANT: a no-op sync produces zero turns. This is exactly why sync turn
 * creation moved OFF the daemon (which pre-created a turn before the outcome was
 * known, leaving a spurious pair on no-ops) and ONTO the reconciler here, where
 * the supervisor has reported whether it actually merged anything.
 */
async function recordSyncTurns(
  storage: Storage,
  taskId: string,
  session: { id: string; agent_session_id: string | null; git_start_sha: string; container_name: string | null },
  responses: CompletedResponse[],
  worktreePath: string,
  protoDir: string,
  lazyRoot?: string,
  /** The sync command's id, presented to claim this sync's restore marker. */
  commandId?: CommandId,
): Promise<void> {
  const taskShortId = shortId(taskId);
  const steps = groupSyncSteps(responses);
  // Resolution replies, newest last — the agent session and the handoff belong
  // to the LAST agent this sync ran, not to whichever step happens to be first.
  const resolutionResps = steps.map(s => s.resolution).filter((r): r is CompletedResponse => !!r);
  const lastResolutionResp = resolutionResps[resolutionResps.length - 1];

  await journalWorktreeRecovery(storage, taskId, responses[0].worktree_recovery);
  // The conflict-resolution response (when there was one) carries the handoff.
  await persistAgentHandoff(
    storage,
    taskId,
    responses[0].agent_handoff ?? lastResolutionResp?.agent_handoff,
  );

  // Store the upstream merge SHA for accurate diff scope (mirrors the work path).
  // Idempotent (sets the same value), so it's safe outside the recorded guard.
  const status = readStatus(protoDir);
  if (status?.upstream_merge_sha) {
    try {
      await storage.updateSessionUpstreamMergeSha(session.id, status.upstream_merge_sha);
    } catch {
      logger.debug(`Task ${taskShortId}: could not store upstream merge SHA`);
    }
  }

  // Reconcile the agent session id from the conflict-resolution invocations — the
  // only `claude -p` runs a sync ever makes. A clean or no-op merge invokes no agent.
  if (lastResolutionResp?.session_id
    && shouldReconcileAgentSessionId(session.agent_session_id, lastResolutionResp.session_id)) {
    await storage.updateSessionClaudeId(session.id, lastResolutionResp.session_id);
  }

  // Idempotency: each merge message embeds that step's exact pre→post SHAs, so an
  // existing `supervisor` sync turn with the same content means the step is already
  // recorded. Guards a reconciler re-run before the response is consumed; the usage
  // rollup and commit recording below are gated on the same check.
  const existingTurns = await storage.getSessionTurns(session.id);
  let recordedAnything = false;

  for (const { announcement: mergeResp, resolution: resolutionResp } of steps) {
    if (!mergeResp.sync?.merged) continue;
    const alreadyRecorded = existingTurns.some(
      t => t.actor === 'supervisor' && t.turn_type === 'sync' && t.content === mergeResp.result,
    );
    if (!alreadyRecorded) {
      recordedAnything = true;
      // The supervisor authored the merge → a `supervisor`-actored, auto-triggered
      // turn (sync is never human-typed). A CLEAN merge's commit is attributed here
      // via its SHA window; a conflict merge's commit is the agent's, attributed to
      // the reply turn below (so this announcement carries no commit window).
      const supSeq = await storage.getNextTurnSequence(session.id);
      await storage.createTurn({
        sessionId: session.id,
        sequence: supSeq,
        role: 'human',
        content: mergeResp.result,
        // The CHANNEL stays `supervisor` — lazy performed this merge, and the
        // idempotency check above reads that role back. The person alongside it
        // is whoever the turn belongs to: the human who typed `lazy sync`, or
        // the configured system identity when nobody did (§3.3 case 3).
        actor: await turnChannelActor(storage, session.id, 'supervisor', lazyRoot),
        autoTriggered: true,
        turnType: 'sync',
        mergeConflicts: mergeResp.merge_conflicts,
        ...(resolutionResp
          ? {}
          : {
              startSha: mergeResp.start_sha_work,
              endSha: mergeResp.end_sha_work,
              startShaWork: mergeResp.start_sha_work,
              endShaWork: mergeResp.end_sha_work,
            }),
      });

      // Conflict-resolution reply — a discrete agent turn, recorded ONLY when the
      // agent was actually invoked (the merge had conflicts). Carries its own usage
      // (incl. cache tokens) and the SHA window covering the merge commit.
      if (resolutionResp) {
        const replySeq = await storage.getNextTurnSequence(session.id);
        await createAgentTurn(storage, {
          sessionId: session.id,
          sequence: replySeq,
          role: 'agent',
          content: enrichResponseWithPlanContent(resolutionResp.result, worktreePath),
          usage: toTurnUsage(resolutionResp.usage),
          ...launchSettingsFromResponse(resolutionResp),
          startSha: resolutionResp.start_sha_work,
          endSha: resolutionResp.end_sha_work,
          startShaWork: resolutionResp.start_sha_work,
          endShaWork: resolutionResp.end_sha_work,
          turnType: 'sync',
        }, lazyRoot);
      }

    }
  }
  // merged: false → NO turn recorded for that step (skip-when-noop). The task
  // still transitions out of 'working' below so a no-op sync doesn't strand it.

  if (recordedAnything) {
    // Roll up token usage from every invocation across both steps (the
    // conflict-resolution agents, when present — the announcements carry zero).
    // Gated on having recorded turns, per the invariant on rollUpSessionUsage.
    await rollUpBundleUsage(storage, session.id, responses, taskShortId);

    // Record the merge commit(s) — once for the whole sync, since the walk from
    // the branch point already covers every step's merge commit.
    //
    // INVARIANT: the first-parent walk in recordSessionCommits is what keeps a
    // sync from recording the UPSTREAM's history as this task's work. A sync
    // merge's second parent is months of other tasks' commits; only the merge
    // commit itself (and any conflict resolution the agent committed on this
    // branch) belongs to this task.
    await recordSessionCommits(storage, session, worktreePath, taskShortId);
  }

  // Sync completion returns the task to the status the sync FOUND — a merge
  // changes nothing about where the task stands with its reviewer. Two halves:
  //
  //   - The paused label (`blocked` / `conflict`) is derived, the same
  //     terminal-of-turn transition the work path uses. Sync runs no violation
  //     detection, so it never PRODUCES a conflict; but it must not CLEAR one
  //     either. Syncing a conflict task used to park it 'blocked' and orphan the
  //     pending set (violations-are-the-source-of-truth).
  //   - `submitted` is RESTORED from the marker the launch wrote, and only when
  //     the derivation says nothing is owed on protected files. Without it, any
  //     sync — a manual `lazy sync`, the auto-sync after an upstream accept,
  //     the retry loop — quietly dropped a task with an open PR out of the
  //     review queue and off PR-comment auto-react. See
  //     src/task/sync-restore-status.ts.
  const restore = await consumeSyncRestoreStatus(storage, taskId, commandId);
  await parkTaskPaused(storage, taskId, await systemActor(lazyRoot), {
    sessionId: session.id,
    ...(restore ? { restore } : {}),
    ...(lazyRoot ? { projectRoot: lazyRoot } : {}),
  });

  // A completed sync means the worktree is healthy.
  await storage.resetConsecutiveInterruptions(session.id);
  await resetSlowLaneState(storage, taskId);

  consumeResponse(protoDir);
  clearStatus(protoDir);
}

/**
 * Finalize a completed command from its bundle of per-invocation responses.
 *
 *   responses[0]   — the WORK response → the work agent turn
 *   responses[1..] — supervised follow-ups (push-back, maintain) → supervisor
 *                    prompt turn + agent reply turn each
 *
 * Single-invocation callers (ask, sync, stranded recovery) pass a one-element
 * array via the `handleCompletedResponse` wrapper.
 */
export async function handleCompletedResponses(
  storage: Storage,
  taskId: string,
  session: { id: string; agent_session_id: string | null; git_start_sha: string; container_name: string | null },
  responses: CompletedResponse[],
  worktreePath: string,
  protoDir: string,
  /**
   * The project root, when the caller has it. Only effect: the end-of-turn park
   * can settle the `conflict` label with a whole-branch protected-file scan
   * instead of the conservative recorded set — which is what lets a file the
   * agent reverted after the push-back actually clear. Optional because two
   * callers (a direct-call test seam, the singular wrapper) do not have one.
   */
  lazyRoot?: string,
  /**
   * The command id the ending turn carried, when the caller has it (it rides the
   * response, or its bundle, which this function receives already unpacked).
   * Only effect: a SYNC turn presents it to claim the status the launch recorded
   * against that same command — see src/task/sync-restore-status.ts. Absent, or
   * not matching, the park falls back to the derived paused label, which is what
   * every sync did before the restore existed.
   */
  commandId?: CommandId,
): Promise<void> {
  const taskShortId = shortId(taskId);
  const work = responses[0];
  const supervised = responses.slice(1);

  // Sync (upstream-merge) responses are recorded by a dedicated path — the merge
  // OUTCOME (responses[0].sync) determines the turns, including recording NONE for
  // a no-op merge. Route here before any work-turn machinery runs, so every caller
  // of handleCompletedResponses (reconcile, interrupted sweep, single-response
  // wrapper) gets identical sync handling.
  if (work?.sync) {
    await recordSyncTurns(storage, taskId, session, responses, worktreePath, protoDir, lazyRoot, commandId);
    return;
  }

  await journalWorktreeRecovery(storage, taskId, work?.worktree_recovery);
  await persistAgentHandoff(storage, taskId, work?.agent_handoff);

  // Reconcile Claude session ID with what the agent actually wrote. With multiple
  // invocations the LAST one's session id points at the JSONL that exists now
  // (each resume can rotate the id), so trust the latest non-empty session id.
  const finalSessionId = [...responses].reverse().find(r => r.session_id)?.session_id ?? work.session_id;
  if (shouldReconcileAgentSessionId(session.agent_session_id, finalSessionId)) {
    await storage.updateSessionClaudeId(session.id, finalSessionId);
  }

  // Work-turn usage (supervised usage is recorded on each supervised reply turn).
  const turnUsage = toTurnUsage(work.usage);

  // Enrich the work response with plan content from the sandbox (if any)
  const enrichedResult = enrichResponseWithPlanContent(work.result, worktreePath);

  // Read supervisor status to get the WORK turn's SHAs before it's cleared.
  // Four-SHA model: start_sha, start_sha_work, end_sha_work, end_sha. Note
  // end_sha_work (status.post_work_sha) is pinned at the WORK end — supervised
  // commits are NOT folded in, so the work turn's diff shows only work commits.
  const status = readStatus(protoDir);
  let turnStartSha: string | undefined;
  let turnStartShaWork: string | undefined;
  let turnEndShaWork: string | undefined;
  let turnEndSha: string | undefined;
  if (status) {
    turnStartSha = status.pre_turn_sha;
    turnStartShaWork = status.post_merge_sha ?? status.pre_turn_sha;
    turnEndShaWork = status.post_work_sha;
    try {
      turnEndSha = await getCurrentSha(worktreePath);
    } catch {
      logger.debug(`Task ${taskShortId}: could not get current SHA for turn end`);
    }

    // Store the upstream merge SHA for accurate diff scope
    if (status.upstream_merge_sha) {
      try {
        await storage.updateSessionUpstreamMergeSha(session.id, status.upstream_merge_sha);
      } catch {
        logger.debug(`Task ${taskShortId}: could not store upstream merge SHA`);
      }
    }
  }

  // Record agent turn (idempotent: check last turn isn't already an agent turn)
  const existingTurns = await storage.getSessionTurns(session.id);
  const lastTurn = existingTurns.length > 0 ? existingTurns[existingTurns.length - 1] : null;
  let agentTurnSeq: number;
  if (lastTurn?.role === 'agent') {
    logger.debug(`Task ${taskShortId}: agent turn already recorded, skipping`);
    agentTurnSeq = lastTurn.sequence;
  } else {
    agentTurnSeq = await storage.getNextTurnSequence(session.id);
    const workTurn = await createAgentTurn(storage, {
      sessionId: session.id,
      sequence: agentTurnSeq,
      role: 'agent',
      content: enrichedResult,
      usage: turnUsage,
      ...launchSettingsFromResponse(work),
      startSha: turnStartSha,
      endSha: turnEndSha,
      startShaWork: turnStartShaWork,
      endShaWork: turnEndShaWork,
      mergeConflicts: work.merge_conflicts,
      // The work turn carries NO violations — when present they were re-detected
      // and attributed to the push-back turn (the FINAL set). See recordSupervisedTurns.
      ...(work.check_exit_code !== undefined ? { checkExitCode: work.check_exit_code } : {}),
      ...(work.check_output !== undefined ? { checkOutput: work.check_output } : {}),
      // What the turn left loose in the worktree — recorded on the work turn
      // because it describes the TURN's end state, not one invocation's.
      ...(work.uncommitted?.length ? { uncommitted: work.uncommitted } : {}),
      ...(work.pre_turn_exit_code !== undefined ? { preTurnExitCode: work.pre_turn_exit_code } : {}),
      ...(work.pre_turn_output !== undefined ? { preTurnOutput: work.pre_turn_output } : {}),
      // Pencils down, when the WORK invocation declared it. Recorded on the
      // turn that made the claim — the only place a final ever lives.
      ...(work.final ? { final: finalClaimOf(work.final) } : {}),
    }, lazyRoot);

    // Best-effort: stamp turn_sequence onto a structured report written mid-turn.
    // INVARIANT: stamp failure must NEVER fail the turn (reporting channel only).
    try {
      await storage.stampTurnReportSequence(taskId, session.id, agentTurnSeq);
    } catch (err) {
      logger.debug(
        `Task ${taskShortId}: could not stamp turn report sequence: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Materialize each supervised follow-up as its own discrete turn pair.
    //
    // INVARIANT: supervised turns are recorded ONLY on the same pass that creates
    // the work turn (inside this `else`). On a reconciler re-run the last turn is
    // already an agent turn, so the whole block is skipped — no duplicate turns.
    const recordedSupervised = supervised.length > 0
      ? await recordSupervisedTurns(
          storage, session.id, supervised, worktreePath,
          await sessionTurnOwner(storage, session.id),
        )
      : [];

    // §13.3 — fill the wrap-up audit on the claims this exchange made. A claim
    // on the work turn (or on a supervised turn that declared pencils-down)
    // starts empty; the steps that ran here are its record. Best-effort: a
    // stamp failure must never fail the turn it annotates.
    await stampWrapUpAudit(
      storage, taskId,
      [...(work.final ? [workTurn] : []), ...recordedSupervised],
      responses.filter(r => r.supervised).map(r => r.supervised!.kind),
    );

    // Accumulate token usage into session totals — sum EVERY invocation's usage
    // (work + each supervised follow-up), so per-turn token costs roll up fully.
    //
    // INVARIANT: the session rollup lives INSIDE the same guard as the turn
    // write, so the two can never diverge. It used to sit outside: a reconciler
    // re-run over an unconsumed response.json (the consume happens later, after
    // several fallible steps) skipped the turn as already-recorded but re-added
    // its usage, leaving the session total permanently above the sum of its
    // turns. Any rollup added here must stay inside this branch.
    await rollUpBundleUsage(storage, session.id, responses, taskShortId);
  }

  // INVARIANT (CLAUDE.md — never lose human feedback): the agent responded, so
  // everything queued before this turn has now been seen. Clearing the whole
  // pending backlog at once is what makes redelivery idempotent — a turn that
  // DID consume its feedback can never be re-delivered into. Deliberately
  // OUTSIDE the `else` above so a reconciler re-run still converges, and
  // deliberately absent from handleErrorResponse — a crashed turn consumed
  // nothing. See src/utils/feedback-redelivery.ts.
  try {
    await storage.markFeedbackConsumed(session.id);
  } catch (err) {
    logger.debug(`Task ${taskShortId}: could not mark feedback consumed: ${err instanceof Error ? err.message : err}`);
  }

  // Detect and record new commits. The range always starts at the branch point
  // and is walked first-parent — see src/task/session-commits.ts for why a
  // "last known SHA" and a plain `A..HEAD` cannot be used here.
  await recordSessionCommits(storage, session, worktreePath, taskShortId);

  // Capture uncommitted changes
  try {
    if (await hasUncommittedChanges(worktreePath)) {
      const uncommittedDiff = await getUncommittedDiff(worktreePath);
      const gitStatus = (await runGit(['status', '--porcelain', '--', ':!.lazy-task-sandbox'], { cwd: worktreePath })).stdout;
      await storage.createWorktreeSnapshot(session.id, agentTurnSeq, uncommittedDiff, gitStatus);
    }
  } catch {
    logger.debug(`Task ${taskShortId}: could not capture uncommitted changes`);
  }

  // Transition to blocked (or conflict if file permission violations REMAIN).
  // Read the FINAL violation set: the last invocation that re-detected them owns
  // the truth. The push-back response carries an explicit (possibly empty) array,
  // so a resolved push-back ([]) correctly yields 'blocked' rather than falling
  // back to the work response's stale pre-push-back set.
  //
  // INVARIANT (violations-are-the-source-of-truth): a bundle that carries NO
  // violations field ran no permission check — an ask response flushed here by
  // the reconciler is the case that motivated this — and must not clear a
  // pending set that is still owed a reviewer decision. parkTaskPaused unions
  // the fresh set with what the turns already hold. See src/utils/paused-status.ts.
  const finalViolations = [...responses].reverse().find(r => r.violations !== undefined)?.violations ?? [];
  await parkTaskPaused(storage, taskId, await systemActor(lazyRoot), { sessionId: session.id, detected: finalViolations, ...(lazyRoot ? { projectRoot: lazyRoot } : {}) });

  // pending_sync is managed by the daemon sync retry loop (src/daemon/sync-retry.ts).
  // The reconciler does not touch the counter — only syncTask resets it on launch.

  // Reset consecutive interruptions counter — a successful turn means the agent is healthy.
  // This is the CRASH circuit breaker, not a budget counter: it must re-arm after a
  // healthy turn, otherwise old crashes accumulate forever and block legitimate
  // auto-resume. Deliberately kept (see the auto-react note directly below).
  await storage.resetConsecutiveInterruptions(session.id);
  // Same reasoning applies to the slow lane: a healthy turn earns the task its
  // way out of the round-robin retry queue too.
  await resetSlowLaneState(storage, taskId);

  // INVARIANT: auto-react budget counters are NOT reset here. A successful turn is
  // not human review, and resetting on every turn zeroes the per-task counters
  // between auto-triggered turns — the gate can then never be reached and
  // auto-react loops without bound. Counters reset only on human unblock/resume
  // or terminal state (docs/release/v0.11-walkthrough.md, "Reset triggers").
  // History: removed by 0cf4c1b5 (MR!364), silently resurrected by the bad v0.12
  // release merge 5857bdb0, removed again here. Guarded by
  // test/unit/reconcile-budget-counter-survival.test.ts — do not re-add.

  // Clean up protocol files for this turn (response consumed)
  consumeResponse(protoDir);
  clearStatus(protoDir);

  // Don't remove container or clear container name — supervisor stays alive between turns
  // The container name stays in the session so we can detect if it dies
}

/**
 * The turns recorded since the CURRENT turn attempt began.
 *
 * Every path that launches a turn on an existing session records a non-agent
 * turn first — `lazy unblock` writes the human's feedback, manual and automatic
 * resume write the `[system] Session interrupted and resumed` notice,
 * auto-deliver writes its `[system] …` notice. So the last non-agent turn is
 * the boundary of the attempt now ending, and anything after it belongs to it.
 *
 * INVARIANT (fix-empty-failed-turn): content-based idempotency for a failed
 * turn must be scoped to ONE attempt. Scoped to the whole session, a repeat of
 * an identical failure records nothing at all — which is exactly what happened
 * with a dead credential: a `FatalAgentError` response carries no `duration_ms`
 * and no `exit_code`, so two consecutive fatal_auth failures produce
 * byte-identical turn content, and the second unblock came back from `working`
 * in seconds with an empty turns list and no way to tell why.
 */
function turnsSinceAttemptStart<T extends { role: string }>(turns: T[]): T[] {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role !== 'agent') return turns.slice(i + 1);
  }
  return turns;
}

/** Lines a crash turn keeps from the run's log, and the budget they fit in. */
export const CRASH_LOG_TAIL_LINES = 10;
export const CRASH_LOG_TAIL_CHARS = 2000;

/**
 * The tail of a crashed run's log as the crash turn shows it: the last few
 * lines, within a budget — bounded, so a runaway log can never become the turn.
 *
 * WHOLE LINES ONLY. This used to be `slice(-10).join('\n').substring(0, 500)`,
 * and 500 characters is five supervisor log lines: the fifth Mac run of the
 * fleet demo showed a crash turn whose "Logs:" ended mid-timestamp
 * (`2026-09-21T12:27:01`), which reads as the log itself being cut off inside
 * the container. When the budget is exceeded, the OLDEST lines go first — the
 * last thing the run said is what explains its death — and the cut lands on a
 * line boundary, marked, so nobody mistakes the display bound for the log's
 * end.
 */
export function crashLogTail(logs: string): string {
  const lines = logs.trim().split('\n').slice(-CRASH_LOG_TAIL_LINES);
  let dropped = 0;
  while (lines.length > 1 && lines.join('\n').length > CRASH_LOG_TAIL_CHARS) {
    lines.shift();
    dropped++;
  }
  if (lines.length === 1 && lines[0]!.length > CRASH_LOG_TAIL_CHARS) {
    lines[0] = `${lines[0]!.slice(0, CRASH_LOG_TAIL_CHARS)} …[line cut at ${CRASH_LOG_TAIL_CHARS} chars]`;
  }
  const tail = lines.join('\n');
  return dropped > 0 ? `…[${dropped} earlier line${dropped === 1 ? '' : 's'} not shown]\n${tail}` : tail;
}

/**
 * Record a crash turn for a turn that died WITHOUT ever writing a response.
 *
 * INVARIANT (fix-empty-failed-turn): a turn that dies must always leave a
 * VISIBLE record — visible meaning "in the turns list", which is the surface a
 * human (and lazy-teams) actually reads. A run that vanishes writes no
 * response.json, so `handleErrorResponse` never runs; the only artifact used to
 * be `session.interrupt_reason`, which no turn list can show. The task then
 * looked like it returned from `working` having done nothing at all.
 *
 * Idempotency is attempt-scoped for the same reason as the error-turn write:
 * the same death must not be recorded twice within one attempt, but an
 * identical death on a LATER attempt is a new occurrence and must be recorded.
 */
async function recordUnreportedCrashTurn(
  storage: Storage,
  sessionId: string,
  taskShortId: string,
  crash: { reason: string; exitCode: number | null; phase?: string; logs?: string | null },
  lazyRoot?: string,
): Promise<void> {
  const lines = ['[Agent crashed]', '', `Error: ${crash.reason}`];
  if (crash.exitCode !== null) lines.push(`Exit code: ${crash.exitCode}`);
  lines.push(`Phase: ${crash.phase ?? 'unknown'}`);
  lines.push('', 'The turn ended without the supervisor reporting a result.');
  if (crash.logs) {
    const tail = crashLogTail(crash.logs);
    if (tail) lines.push('', 'Logs:', tail);
  }
  const content = lines.join('\n');

  try {
    const existing = await storage.getSessionTurns(sessionId);
    const alreadyRecorded = turnsSinceAttemptStart(existing)
      .some(t => t.role === 'agent' && t.content === content);
    if (alreadyRecorded) return;

    await createAgentTurn(storage, {
      sessionId,
      sequence: await storage.getNextTurnSequence(sessionId),
      role: 'agent',
      content,
    }, lazyRoot);
  } catch (err) {
    // Never let the record-keeping stop the interrupt/auto-resume path that
    // follows it — a missing turn is bad, a task stuck in `working` is worse.
    logger.warn(
      `Task ${taskShortId}: could not record crash turn: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Render a crash/error response as the agent turn a human will read.
 *
 * Extracted so the superseded-response sweep records a displaced crash in
 * EXACTLY the spelling `handleErrorResponse` uses — the "have I already recorded
 * this?" check is content-based, so two spellings of one crash would show up as
 * two turns.
 */
function buildErrorTurnContent(
  response: ErrorResponse,
  fatalClass: string | undefined,
  classified: string | undefined,
  watchdogKill: boolean,
): string {
  const heading = fatalClass
    ? '[Agent stopped — unrecoverable failure]'
    : watchdogKill
      ? WATCHDOG_TURN_HEADING
      : '[Agent crashed]';
  const lines: string[] = [heading, ''];
  if (watchdogKill) {
    lines.push(...watchdogTurnLines(response), '');
  }
  if (classified) {
    lines.push(`Failure class: ${classified}`);
    if (response.failure_reason) lines.push(`Reason: ${response.failure_reason}`);
    if (response.failure_attempts !== undefined) {
      lines.push(`Attempts before giving up: ${response.failure_attempts}`);
    }
    lines.push('');
  }
  lines.push(`Error: ${response.error}`);
  if (response.exit_code !== undefined) {
    lines.push(`Exit code: ${response.exit_code}`);
  }
  if (response.duration_ms !== undefined) {
    const secs = (response.duration_ms / 1000).toFixed(1);
    lines.push(`Runtime: ${secs}s`);
  }
  lines.push(`Phase: ${response.phase}`);
  // A merge phase that failed says what it did about the half-merged worktree.
  // Without this the human sees "merge failed" and has no idea whether files are
  // still conflicted on disk (fix-sync-silent-conflict).
  if (response.merge_state) {
    lines.push(
      response.merge_state.settled
        ? 'Worktree: merge aborted, worktree is clean.'
        : `Worktree: NOT settled — ${response.merge_state.detail}`,
    );
  }
  if (response.stdout_error && response.stdout_error !== response.error) {
    lines.push('');
    lines.push('Stdout error:');
    lines.push(response.stdout_error);
  }
  if (response.stderr) {
    lines.push('');
    lines.push('Stderr:');
    lines.push(response.stderr);
  }
  return lines.join('\n');
}

/**
 * Handle an error response from the supervisor.
 * Records an agent error turn so crash details are visible in lazy show,
 * then transitions the task to 'interrupted'.
 */
/**
 * Process an error response from the supervisor.
 *
 * Exported for unit tests (same as `handleCompletedResponse`) — the fatal /
 * ordinary-crash split below is a decision worth pinning directly.
 */
export async function handleErrorResponse(
  storage: Storage,
  taskId: string,
  session: { id: string; agent_session_id?: string | null },
  response: ErrorResponse,
  protoDir: string,
  lazyRoot?: string,
): Promise<void> {
  const taskShortId = shortId(taskId);

  // A classified failure the supervisor deliberately stopped retrying. It
  // cannot heal by itself, so the task must land in `blocked` (human's queue),
  // not `interrupted` (auto-resume's queue) — auto-resuming into a dead
  // credential or a bad model id just re-crashes on a timer.
  // `failure_class` is set when the supervisor ended the turn on purpose: a
  // `fatal_*` class, a `transient_unreachable` that outlived its bounded
  // retries, or the fast-crash-loop backstop. The first two cannot heal and
  // must block; the backstop only ever reports `unknown` — by construction, it
  // runs for no other class — and an unclassifiable failure has never been a
  // reason to stop auto-resume. So `unknown` is carried for DIAGNOSIS only and
  // keeps the pre-existing interrupted + auto-resume behavior, exactly as an
  // absent class does.
  const classified = response.failure_class;
  const fatalClass = classified && classified !== 'unknown' ? classified : undefined;

  const watchdogKill = isWatchdogKill(response);
  const turnContent = buildErrorTurnContent(response, fatalClass, classified, watchdogKill);
  await journalWorktreeRecovery(storage, taskId, response.worktree_recovery);
  // A crashed or watchdog-killed turn is exactly when the agent's own account of
  // what it was doing matters most — persist it before recording the error turn.
  await persistAgentHandoff(storage, taskId, response.agent_handoff);

  // Record error turn. Idempotency is CONTENT-based, scoped to the CURRENT turn
  // attempt: the same error must not be recorded twice for one attempt, but a
  // *different* error — or the SAME error on a later attempt — must always be
  // recorded.
  //
  // This used to skip whenever the last turn was an agent turn — which silently
  // swallowed exactly the errors this task exists to surface. A sync that
  // conflicted, ran a resolution agent (agent turn), and THEN failed to conclude
  // the merge recorded nothing at all: the task went back to blocked looking
  // settled while the worktree was still mid-merge (fix-sync-silent-conflict).
  //
  // Session-wide content matching then reintroduced the same silence from the
  // other side: a second unblock against the same dead credential produces
  // byte-identical content and recorded nothing (fix-empty-failed-turn). See
  // turnsSinceAttemptStart for why the last non-agent turn is the boundary.
  const existingTurns = await storage.getSessionTurns(session.id);
  const alreadyRecorded = turnsSinceAttemptStart(existingTurns)
    .some(t => t.role === 'agent' && t.content === turnContent);
  if (!alreadyRecorded) {
    const seq = await storage.getNextTurnSequence(session.id);
    // Tokens the dying turn had already spent, salvaged by the supervisor from
    // the agent's final output (src/supervisor/usage.ts). Absent for turns that
    // died before reporting anything, and for supervisors older than this field.
    const errorUsage = toTurnUsage(response.usage, `Task ${taskShortId}`);
    await createAgentTurn(storage, {
      sessionId: session.id,
      sequence: seq,
      role: 'agent',
      content: turnContent,
      // A crash turn still records what it ran under — "agent/model X keeps
      // crashing" is a real finding, and dropping the labels here would silently
      // exclude failures from any agent/model/effort comparison.
      ...(response.agent ? { agent: response.agent } : {}),
      ...(response.model ? { model: response.model } : {}),
      ...(response.effort ? { effort: response.effort } : {}),
      ...(errorUsage ? { usage: errorUsage } : {}),
      // Preserve the "agent had no effect" flag from the supervisor so downstream
      // consumers (the acceptance gate, etc.) know there's nothing to reflect on.
      ...(response.agent_had_no_effect !== undefined ? { agent_had_no_effect: response.agent_had_no_effect } : {}),
      // What the DYING turn left loose. A crash never reaches the wrap-up, so
      // nothing asked the agent to commit it — without this, the turn record of
      // the riskiest case is the only one saying nothing about the worktree.
      ...(response.uncommitted?.length ? { uncommitted: response.uncommitted } : {}),
    }, lazyRoot);
    // Roll the same tokens into the session total, inside the same idempotency
    // guard as the turn write (see rollUpSessionUsage). A crashed turn's tokens
    // were previously dropped on the floor entirely — the turn had no usage and
    // nothing was added to the session.
    if (errorUsage) {
      await rollUpSessionUsage(storage, session.id, errorUsage, `Task ${taskShortId}`);
    }
    logger.debug(`Task ${taskShortId}: recorded agent error turn`);
  }

  // INVARIANT: a sweep acting on a response it read EARLIER must not touch a
  // turn that started in the meantime. Everything below this point mutates
  // LIVE state — task status, the supervisor's status checkpoint, auto-resume —
  // and all of it is wrong if this response has already been superseded.
  //
  // The window is real and was observed in the wild: sweepInterruptedResponses
  // reads response.json, then awaits its way through this function; an `unblock`
  // landing inside that window moves the task to `working` and launches a turn
  // the human then watches. The trailing `updateTaskStatus(..., 'interrupted')`
  // below dragged that LIVE task back into the auto-resume queue, `clearStatus`
  // wiped the running turn's SHA checkpoints, and the auto-resume it triggered
  // wrote a command — which is what displaced the running turn's response and
  // destroyed it. The running supervisor's own fingerprint for this is
  // "Retry canceled: new command arrived" (src/supervisor/work.ts).
  //
  // `writeCommand` moves an unconsumed response aside rather than deleting it,
  // so "response.json is gone" is the precise signal that a newer command has
  // taken over. The error turn is already recorded above — evidence is kept
  // either way; only the live-state mutations are skipped.
  if (!hasResponse(protoDir)) {
    logger.warn(
      `Task ${taskShortId}: this crash report was superseded by a newer command before it could be applied — ` +
      `recording it as a turn but leaving the task's live state alone (a newer turn owns it).`,
    );
    return;
  }

  // Reconcile the agent's session id from the ERROR response — now that the
  // superseded-response guard above has confirmed this response is still the
  // current turn's. The turn already ran — its stream knew which conversation
  // it was in — and the response now carries that id even on failure paths
  // (see describeTurnFailure). Without this, the record keeps whatever earlier
  // turn last set it, and the next launch (auto-resume or `lazy unblock`)
  // continues a STALE conversation or starts a new one: in the 2026-09-16 pi
  // incident, the crashed turn's id was dropped here and the auto-resume an
  // hour later re-sent the full prompt to a brand-new session.
  //
  // Deliberately AFTER the guard, not before: the id is LIVE state for the
  // next launch, not just evidence about the old turn. Turn N may crash in
  // session A while turn N+1 (a fresh session after rediscovery failed, or an
  // agent switch) is already running in session B; a sweep processing N's
  // stale report must not write A back over B, or the next resume continues
  // the wrong conversation. A superseded turn's id is NOT the conversation
  // the next launch should continue, so only the current turn's own response
  // records it here.
  if (response.session_id && shouldReconcileAgentSessionId(session.agent_session_id ?? null, response.session_id)) {
    await storage.updateSessionClaudeId(session.id, response.session_id);
    logger.info(
      `Task ${taskShortId}: reconciled agent session id from the failed turn ` +
      `(${response.session_id.substring(0, 8)}) so a resume continues that conversation`,
    );
  }

  consumeResponse(protoDir);
  clearStatus(protoDir);

  // A sync that CRASHED says no more about where the task stands with its
  // reviewer than one that succeeded, so the restore marker is honoured here
  // too — a submitted task whose merge died must not silently become `blocked`.
  //
  // This reader sees EVERY turn type, which is exactly why the marker names the
  // command that wrote it: the crashed turn must present that id to claim the
  // status. Without the id, a marker left behind by a sync that died with no
  // response at all could be picked up by an unrelated WORK turn crashing
  // fatally turns later, parking `submitted` on a task nobody submitted. A
  // non-matching read changes nothing and leaves the marker alone — it may
  // still be owed to the turn it names. See src/task/sync-restore-status.ts.
  const syncRestore = await consumeSyncRestoreStatus(storage, taskId, responseCommandId(response));

  if (fatalClass) {
    // Blocked, not interrupted: `maybeAutoResume` only acts on interrupted
    // tasks, so this is what actually stops the reconciler from burning time.
    //
    // The stale-response sweep calls this for tasks ALREADY in 'interrupted',
    // and 'interrupted' → 'blocked' is not a valid transition (only
    // 'interrupted' → 'working' is). Route through 'working' first, mirroring
    // the same hop the completed-response sweep makes; without it the throw
    // would be swallowed by the sweep's catch and the task would sit in
    // 'interrupted' — the exact auto-resume queue this branch exists to avoid.
    const current = await storage.getTask(taskId);
    if (current?.status === 'interrupted') {
      await storage.updateTaskStatus(taskId, 'working', await systemActor(lazyRoot));
    }
    // A crashed turn detected nothing, so it cannot clear an owed decision —
    // park on the violation set (violations-are-the-source-of-truth), restoring
    // a crashed sync's `submitted` where nothing is owed. Either way the task is
    // not `interrupted`, which is what keeps auto-resume off it.
    const parked = await parkTaskPaused(storage, taskId, await systemActor(lazyRoot), {
      sessionId: session.id,
      ...(syncRestore ? { restore: syncRestore } : {}),
      ...(lazyRoot ? { projectRoot: lazyRoot } : {}),
    });
    await storage.recordInterrupt(session.id, {
      reason: `${fatalClass}: ${response.failure_reason ?? response.error}`,
      exit_code: response.exit_code ?? null,
      logs: response.stderr ?? null,
    });
    logger.warn(
      `Task ${taskShortId}: unrecoverable agent failure (${fatalClass}) — parked '${parked}' ` +
      `for human attention, not auto-resuming`,
    );
    return;
  }

  await storage.updateTaskStatus(taskId, 'interrupted', await systemActor(lazyRoot));

  // Record interrupt diagnostics. A watchdog kill gets its own reason: the
  // process was killed deliberately by lazy, and `lazy show` must say so rather
  // than translate a signal exit code into a generic crash.
  const reason = watchdogKill
    ? watchdogInterruptReason(response)
    : response.exit_code !== undefined
      ? exitCodeToReason(response.exit_code)
      : `Agent error: ${response.error}`;
  await storage.recordInterrupt(session.id, {
    reason,
    exit_code: response.exit_code ?? null,
    logs: response.stderr ?? null,
  });

  // Do NOT auto-resume if the error was during merge_and_fix — the task cannot
  // make progress without a successful upstream merge. Resuming would start
  // a new turn on a stale branch, diverging further from upstream.
  if (response.phase === 'merge_and_fix') {
    logger.warn(`Task ${taskShortId}: merge-and-fix failed, not auto-resuming (task needs human investigation)`);
  } else if (lazyRoot) {
    // Auto-resume if called from reconciler (lazyRoot provided) and circuit breaker allows
    await maybeAutoResume(storage, taskId, session.id, lazyRoot);
  }
  // Don't remove container — supervisor may still be alive for next turn
}

/**
 * Sweep interrupted tasks for stale responses.
 *
 * Race condition fix: when the reconciler moves a task to 'interrupted' due to a
 * supervisor error, the supervisor may have already picked up the next command
 * (written by resume/unblock) and completed it. The new response.json sits
 * unconsumed because the reconciler only looked at working tasks.
 *
 * This sweep finds interrupted tasks that have a valid response.json and processes them.
 */
async function sweepInterruptedResponses(storage: Storage, lazyRoot: string): Promise<void> {
  const interruptedTasks = await storage.listTasksWithOptions({ interruptedOnly: true });

  for (const task of interruptedTasks) {
    try {
      const session = await storage.getSessionByTaskId(task.id);
      if (!session) continue;

      const tRef = taskRef(task);
      const taskShortId = shortId(task.id);
      const worktreePath = getWorktreePathForRef(lazyRoot, tRef);

      // Same in-flight guard as reconcileTask — the worktree lock is invisible
      // to a sweep running in the daemon process that holds it. A sweep never
      // settles: reconcileTask is where a live record is driven forward.
      if (taskTurnInFlight(task)) {
        logger.debug(`Task ${taskShortId}: synchronous daemon turn in flight, skipping interrupted sweep`);
        continue;
      }

      // Skip tasks with active worktree locks (another process is working on them)
      if (await checkLock(worktreePath)) {
        logger.debug(`Task ${taskShortId}: worktree locked, skipping interrupted sweep`);
        continue;
      }

      // Skip tasks locked for pairing (human is working interactively)
      if (checkPairingLock(worktreePath)) {
        logger.debug(`Task ${taskShortId}: locked for pairing, skipping interrupted sweep`);
        continue;
      }

      const protoDir = getProtocolDir(task.id);
      const response = readResponse(protoDir);
      if (!response) continue;

      if (response.status === 'completed') {
        logger.debug(`Task ${taskShortId}: found stale completed response for interrupted task, processing`);
        // handleCompletedResponses transitions the task to 'blocked' (turn done),
        // but 'interrupted' → 'blocked' is not a valid transition — only
        // 'interrupted' → 'working' is (see VALID_TRANSITIONS). The completed
        // response means the supervisor DID finish the turn, so move the task
        // back through 'working' first (mirroring resume/auto-resume) and let
        // handleCompletedResponses take it 'working' → 'blocked'. Without this the
        // transition throws and the completed work is silently stranded in
        // 'interrupted'. Regression: this path predates the state machine
        // (added in a15bfc95, before updateTaskStatus validated transitions).
        await storage.updateTaskStatus(task.id, 'working', await systemActor(lazyRoot));
        await handleCompletedResponses(storage, task.id, session, completedResponses(response), worktreePath, protoDir, lazyRoot, responseCommandId(response));
      } else {
        // Error response on an already-interrupted task — record the error turn
        logger.debug(`Task ${taskShortId}: found stale error response for interrupted task, recording`);
        await handleErrorResponse(storage, task.id, session, response, protoDir);
      }
    } catch (err) {
      logger.debug(`Failed to sweep interrupted task ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Finalize a completed turn that a PAUSED task is sitting on.
 *
 * `reconcileTasks` reads `response.json` only for tasks it lists as `working`
 * (the `workingOnly` primary sweep). That is fine while a paused status can only
 * be REACHED by consuming the response — but any path that parks a task while
 * its supervisor is still running silently throws the turn away. The observed
 * instance: `recoverBacklogWithCommits` racing `lazy start` wrote `blocked` on
 * top of the launcher's `working` six milliseconds after start, and the agent's
 * turn, its commits and its turn-report sequence were never recorded even though
 * the branch carried the work. That specific race is fixed at the source in
 * `recoverBacklogWithCommits`; this sweep is the net, so the next path that
 * parks a task early costs a delayed turn rather than a lost one.
 *
 * INVARIANT: this sweep NEVER touches a task with a live turn. A completed
 * response held by a paused task is by definition nobody's business — the paths
 * that consume one (`reconcileTask`, unblock/ask settle) all consume it in the
 * same operation that parks the task. Four gates keep a live turn out:
 * `taskTurnInFlight` (synchronous daemon turn), a pending `command.json` (a turn
 * being launched right now), `readLock` — NOT `checkLock`, which is re-entrant on
 * pid and so is blind to a lock the daemon itself holds — and the pairing lock.
 */
async function sweepPausedResponses(storage: Storage, lazyRoot: string): Promise<void> {
  const pausedTasks = await storage.listTasksWithOptions({ blockedOnly: true });

  for (const task of pausedTasks) {
    try {
      const protoDir = getProtocolDir(task.id);
      // Cheapest gate first: the overwhelmingly common case is a paused task
      // with no response at all, and this costs one stat.
      if (!hasResponse(protoDir)) continue;

      const taskShortId = shortId(task.id);

      // A turn is being launched right now (start/unblock/sync/ask wrote the
      // command). Its own settle path owns whatever is in the protocol dir.
      if (hasCommand(protoDir)) {
        logger.debug(`Task ${taskShortId}: command pending, skipping paused-response sweep`);
        continue;
      }

      if (taskTurnInFlight(task)) {
        logger.debug(`Task ${taskShortId}: synchronous daemon turn in flight, skipping paused-response sweep`);
        continue;
      }

      const worktreePath = getWorktreePathForRef(lazyRoot, taskRef(task));

      // readLock, not checkLock: checkLock returns null when the CURRENT process
      // holds the lock, and this sweep runs inside the daemon — the very process
      // whose start/unblock handler took it. Re-entrancy is right for a command
      // reacquiring its own lock and wrong for a sweep asking "is anyone working
      // on this task".
      if (await readLock(worktreePath)) {
        logger.debug(`Task ${taskShortId}: worktree locked, skipping paused-response sweep`);
        continue;
      }

      if (checkPairingLock(worktreePath)) {
        logger.debug(`Task ${taskShortId}: locked for pairing, skipping paused-response sweep`);
        continue;
      }

      const session = await storage.getSessionByTaskId(task.id);
      if (!session) continue;

      const response = readResponse(protoDir);
      if (!response) continue;

      // Re-read the status immediately before acting: every gate above is an
      // await, and a task that started a new turn meanwhile is not ours.
      const current = await storage.getTask(task.id);
      if (!current || !isBlockedStatus(current.status)) continue;

      // A STOP'S OWN RESPONSE IS NOT A LOST TURN. `stopTask` writes a "Stopped
      // by user" error response after killing the run (so an in-flight waiter
      // wakes), then parks the task itself and records the stop and the
      // interrupt. Handing that response to handleErrorResponse re-parked the
      // stopped task `interrupted` one tick later — relabelling a deliberate
      // stop as a crash. Everything it carries is already recorded; drop it.
      if (response.status === 'error' && isUserStopped(session)) {
        logger.debug(`Task ${taskShortId}: user-stopped, dropping the stop's own error response`);
        consumeResponse(protoDir);
        continue;
      }

      logger.warn(
        `Task ${taskShortId}: unconsumed ${response.status} response on a ${current.status} task — ` +
        `recording the turn its supervisor already finished`,
      );

      // Both handlers end the turn from `working`: handleCompletedResponses via
      // parkTaskPaused, handleErrorResponse via `interrupted` or parkTaskPaused.
      // <paused> → either of those is not a valid transition, so hop back through
      // `working` first — exactly as sweep 3 does for interrupted tasks. Without
      // the hop updateTaskStatus throws, the catch below swallows it, and the
      // turn stays lost. parkTaskPaused returns the task to blocked (or conflict,
      // if the turn produced violations) on the way out.
      await storage.updateTaskStatus(task.id, 'working', await systemActor(lazyRoot));

      if (response.status === 'completed') {
        await handleCompletedResponses(storage, task.id, session, completedResponses(response), worktreePath, protoDir, lazyRoot, responseCommandId(response));
      } else {
        await handleErrorResponse(storage, task.id, session, response, protoDir, lazyRoot);
      }
    } catch (err) {
      logger.debug(`Failed to sweep paused task ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
    }
    await yieldToEventLoop();
  }
}

/** Is this task holding an asynchronous claim nothing else will settle? */
export function needsPausedClaimSweep(task: Task, now = Date.now()): boolean {
  // ONLY THE STATUSES THIS SWEEP CAN ACTUALLY HOP FROM. Settling goes through
  // `working` (see the hop in `sweepPausedSyncClaims`), and `pairing` and
  // `merging` have no edge to it — on those the hop throws and the claim
  // survives, so selecting them buys nothing and costs a warning per tick. For
  // `pairing` it would also be wrong on purpose: a human is in that session,
  // and settling their task's claim out from under them is not this net's call.
  // `working` is the primary sweep's business, and a terminal task's turn is
  // over however its record reads.
  if (!isBlockedStatus(task.status) && task.status !== 'interrupted') return false;
  const record = task.in_flight_turn ?? null;
  if (!isInFlightLive(record, now)) return false;
  // A SETTLED RECORD IS NOT THIS SWEEP'S BUSINESS, and `isInFlightLive` alone
  // does not say so: it stays true for a record carrying an `outcome` until
  // `IN_FLIGHT_SETTLED_GRACE_MS` elapses, which is the pickup grace that keeps
  // auto-resume and auto-deliver off a task whose outcome a waiter has not read
  // yet. Without this check a review that settled cleanly and parked the task
  // was re-selected on the next tick, found nothing left to settle, fell
  // through to `abandonIfRunIsGone`, and after the run-death grace logged a
  // false "never answered" warning while releasing the claim and deleting the
  // review mailbox inside the grace that was still protecting them. Same rule,
  // same reason, as `stoppableClaimOf`.
  if (record!.outcome) return false;
  // Only the ASYNCHRONOUS claims. `wrap_up`/`pre_accept` records have (or had) a
  // waiter of their own and their own endings; inventing a second settler for
  // them here is not this net's job.
  return record!.owner === 'ask' || record!.owner === 'review';
}

/**
 * Settle — or abandon — an ask/review claim held by a task that is NOT `working`.
 *
 * The primary sweep only visits `working` tasks, so a live ask/review claim on a
 * PAUSED task is in a dead zone: nothing settles the answer its reviewer writes,
 * nothing notices that its run died, and `sweepPausedResponses` deliberately
 * skips any task with a claim. Meanwhile the claim itself suppresses every
 * automatic launch that reads `isTurnInFlight` — including the auto-review
 * catchup — so the task stops being retried at all until the 24-hour backstop.
 *
 * That is exactly where `teams-raised-cluster-row-one-size` sat on 2026-09-20: a
 * refused review dispatch reverted the status of a task whose OTHER review had
 * just started, and the review that was really running became unsettleable. The
 * revert itself is fixed at the source (`launchReviewTaskRun`'s unwind restores
 * only what it moved); this sweep is the net under it, so no path that leaves a
 * claim on a paused task can wedge the task again.
 *
 * Deliberately narrow: only `ask` and `review` owners (the asynchronous claims
 * with no RPC caller watching), only a LIVE record (expired ones are
 * `expiredSyncRestore`'s business, and a settled one is pickup-grace debris),
 * and nothing but the same settle/abandon pair `reconcileTaskInner` runs.
 *
 * The selection rule is {@link needsPausedClaimSweep}, exported so it can be
 * asserted directly.
 */
export async function sweepPausedSyncClaims(storage: Storage, lazyRoot: string): Promise<void> {
  const tasks = await storage.listTasks();

  for (const task of tasks) {
    try {
      if (!needsPausedClaimSweep(task)) continue;
      const record = task.in_flight_turn ?? null;

      const session = await storage.getSessionByTaskId(task.id);
      if (!session) continue;

      logger.debug(
        `Task ${shortId(task.id)}: live ${record!.owner} claim on a '${task.status}' task — ` +
        `settling it here, the working sweep cannot see it`,
      );

      // HOP THROUGH `working` BEFORE SETTLING A RESPONSE, exactly as
      // `sweepPausedResponses` and `sweepInterruptedResponses` do, and for the
      // same reason: every ending the settle can reach transitions FROM
      // `working`. A crashed ask ends in `recordAskErrorTurn`, which parks
      // `interrupted` unconditionally — and <paused> → `interrupted` is not a
      // valid transition, so `updateTaskStatus` threw AFTER the turn had been
      // created and `response.json` consumed, leaving `settleInFlightTurn` and
      // `releaseAsyncClaim` unreached. The claim this sweep exists to clear
      // survived, and the task stayed exactly as wedged as before.
      //
      // Only when there IS a response: a hop with nothing to settle would leave
      // a parked task reading `working` with nothing running, which is the
      // stranded state the claim machinery exists to prevent.
      const claimProtoDir = record!.owner === 'review'
        ? reviewProtocolDir(task.id)
        : getProtocolDir(task.id);
      const parkedStatus = task.status;
      const hopped = readResponse(claimProtoDir) != null;
      if (hopped) await storage.updateTaskStatus(task.id, 'working', await systemActor(lazyRoot));

      try {
        const verdict = await settleInFlightTurnFromProtocol(
          storage, task, session, record!, getWorktreePathForRef(lazyRoot, taskRef(task)), lazyRoot,
        );
        if (verdict === 'none') {
          // Nothing written yet: the only other way this ends is the run dying,
          // and this tick is the only thing that can notice.
          await abandonIfRunIsGone(storage, task, session, record!, lazyRoot);
        }
      } finally {
        // Put back what the hop moved, and only that. Every settle that reached
        // an ending has already left the task somewhere else — `interrupted` for
        // a crashed ask, the review's own `restore_status`, whatever
        // `parkTaskPaused` derived — so a task still reading `working` here is
        // one the settle did not finish (a `foreign` or uncorrelated response, a
        // throw), and leaving it there would strand it.
        if (hopped) {
          const after = await storage.getTask(task.id);
          if (after?.status === 'working') {
            await storage.updateTaskStatus(task.id, parkedStatus, await systemActor(lazyRoot));
          }
        }
      }
    } catch (err) {
      // WARN, not debug: everything this sweep does is a last resort for a task
      // nothing else will settle, so a failure here is the task staying wedged.
      logger.warn(
        `Failed to sweep the in-flight claim on task ${shortId(task.id)}: ` +
        `${err instanceof Error ? err.message : err}`,
      );
    }
    await yieldToEventLoop();
  }
}

/**
 * Resume tasks left `interrupted` by a daemon that is no longer around.
 *
 * `interrupted` means "ungraceful end of turn, auto-resumable" — the UI says so
 * in as many words. That promise was only ever kept by the transition INTO
 * interrupted, which calls `maybeAutoResume` on the way through. If the daemon
 * that recorded the interrupt then died — it crashed, the machine rebooted, the
 * container took the daemon with it — nobody was left to make that call, and the
 * task sat interrupted forever. Seen on a live fleet: a task interrupted with
 * "Container disappeared (no exit code)", the daemon restarted, the task never
 * moved again.
 *
 * So the NEXT daemon re-offers the resume, on every tick, for any interrupted
 * task with a live session. Everything that decides whether a resume is
 * appropriate already lives in `maybeAutoResume` and is unchanged here: an
 * ended session, a `lazy stop`, the consecutive-interruption circuit breaker,
 * and the auto-react budget and backoff all still veto it. That is what keeps
 * this from becoming a retry loop — a task the gates refuse stays interrupted
 * and is simply re-offered later, at backoff pace.
 */
async function resumeStrandedInterruptedTasks(storage: Storage, lazyRoot: string): Promise<void> {
  const interruptedTasks = await storage.listTasksWithOptions({ interruptedOnly: true });

  for (const task of interruptedTasks) {
    try {
      const session = await storage.getSessionByTaskId(task.id);
      if (!session || session.ended_at) continue;

      const taskShortId = shortId(task.id);
      const worktreePath = getWorktreePathForRef(lazyRoot, taskRef(task));

      // Another process is mid-flight on this task (start/unblock/resume), or a
      // human is paired into it. Either way it is not stranded.
      if (await checkLock(worktreePath)) {
        logger.debug(`Task ${taskShortId}: worktree locked, skipping stranded-interrupt resume`);
        continue;
      }
      if (checkPairingLock(worktreePath)) {
        logger.debug(`Task ${taskShortId}: locked for pairing, skipping stranded-interrupt resume`);
        continue;
      }

      // A stale response is sweep 3's business and it runs first; by here there
      // is nothing to finalize, only a turn that never came back.
      if (readResponse(getProtocolDir(task.id))) continue;

      await maybeAutoResume(storage, task.id, session.id, lazyRoot);
    } catch (err) {
      logger.debug(`Failed to resume stranded interrupted task ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
    }
    await yieldToEventLoop();
  }
}

/**
 * Record a displaced COMPLETED turn — nothing else.
 *
 * This is `handleCompletedResponses` with every live-state mutation removed, and
 * the removals are the point rather than an oversight:
 *
 *  - no SHA window on the turn. `status.json` belongs to whatever turn is
 *    running NOW; reading it here would stamp this turn with another turn's
 *    checkpoints, and a diff derived from those SHAs would be a lie.
 *  - no commit detection, no worktree snapshot. Both read the worktree as it is
 *    at this instant, which is not what it looked like when this turn ended.
 *  - no `markFeedbackConsumed`. Feedback queued after this turn is still owed to
 *    the turn that is running now (CLAUDE.md: never lose human feedback).
 *  - no violations, no `parkTaskPaused`, no status change. The task's status is
 *    the live turn's to own — clobbering it is precisely the bug this fix exists
 *    to stop.
 *
 * What it DOES do is the whole reason the loss mattered: write the turn record,
 * and reconcile `agent_session_id` so `lazy pair` resumes the agent session that
 * did the work instead of opening an empty one.
 */
async function recordSupersededWorkTurns(
  storage: Storage,
  taskId: string,
  session: { id: string; agent_session_id: string | null },
  responses: CompletedResponse[],
  worktreePath: string,
): Promise<void> {
  const taskShortId = shortId(taskId);
  const work = responses[0];
  if (!work) return;

  await journalWorktreeRecovery(storage, taskId, work.worktree_recovery);
  await persistAgentHandoff(storage, taskId, work.agent_handoff);

  const finalSessionId = [...responses].reverse().find(r => r.session_id)?.session_id ?? work.session_id;
  if (shouldReconcileAgentSessionId(session.agent_session_id, finalSessionId)) {
    await storage.updateSessionClaudeId(session.id, finalSessionId);
  }

  // Content-based idempotency, as in handleErrorResponse. The "is the last turn
  // an agent turn?" shortcut is wrong here by construction: a displaced response
  // is recovered LATE, so a newer turn has very likely already been recorded
  // after it — and that would skip this turn forever, which is the loss again.
  const content = enrichResponseWithPlanContent(work.result, worktreePath);
  const existingTurns = await storage.getSessionTurns(session.id);
  if (existingTurns.some(t => t.role === 'agent' && t.content === content)) {
    logger.debug(`Task ${taskShortId}: displaced turn already recorded, skipping`);
    return;
  }

  const seq = await storage.getNextTurnSequence(session.id);
  // NO PERSON, deliberately — see the idempotency note just above: this
  // response is recovered LATE, so the session very likely belongs to a newer
  // turn with a different owner by now. Attributing this row from the session
  // would put this turn's work, and its token usage, on a row naming somebody
  // who did not do it. Nothing that survived the displacement names the person
  // who did (the response file is written in an agent-writable worktree and is
  // not an identity source), so the row names nobody — which reads exactly like
  // every agent row did before attribution existed.
  const workTurn = await createRecoveredAgentTurn(storage, {
    sessionId: session.id,
    sequence: seq,
    role: 'agent',
    content,
    usage: toTurnUsage(work.usage),
    ...launchSettingsFromResponse(work),
    mergeConflicts: work.merge_conflicts,
    ...(work.check_exit_code !== undefined ? { checkExitCode: work.check_exit_code } : {}),
    ...(work.check_output !== undefined ? { checkOutput: work.check_output } : {}),
    ...(work.uncommitted?.length ? { uncommitted: work.uncommitted } : {}),
  }, null);

  const supervised = responses.slice(1);
  const recordedSupervised = supervised.length > 0
    ? await recordSupervisedTurns(storage, session.id, supervised, worktreePath, null)
    : [];

  // §13.3 — same wrap-up audit fill as the live work path: a displaced turn's
  // claim is still a claim, and the steps recorded alongside it are its record.
  await stampWrapUpAudit(
    storage, taskId,
    [...(work.final ? [workTurn] : []), ...recordedSupervised],
    responses.filter(r => r.supervised).map(r => r.supervised!.kind),
  );

  await rollUpBundleUsage(storage, session.id, responses, taskShortId);
}

/**
 * Record a displaced ERROR turn — nothing else, for the same reasons as above.
 *
 * A crash whose report was displaced is still evidence: it is what the human
 * needs to explain a turn that ended without saying why. But acting on it —
 * interrupting the task, auto-resuming it — would be acting on a report about a
 * turn that is over, against a task a newer turn now owns.
 */
async function recordSupersededErrorTurn(
  storage: Storage,
  taskId: string,
  session: { id: string },
  response: ErrorResponse,
): Promise<void> {
  const taskShortId = shortId(taskId);
  const classified = response.failure_class;
  const fatalClass = classified && classified !== 'unknown' ? classified : undefined;
  const content = buildErrorTurnContent(response, fatalClass, classified, isWatchdogKill(response));

  await journalWorktreeRecovery(storage, taskId, response.worktree_recovery);
  await persistAgentHandoff(storage, taskId, response.agent_handoff);

  const existingTurns = await storage.getSessionTurns(session.id);
  if (existingTurns.some(t => t.role === 'agent' && t.content === content)) return;

  const seq = await storage.getNextTurnSequence(session.id);
  const errorUsage = toTurnUsage(response.usage, `Task ${taskShortId}`);
  // No person, for the same reason as the work turn above: a displaced report
  // is recorded after a newer turn has taken the session.
  await createRecoveredAgentTurn(storage, {
    sessionId: session.id,
    sequence: seq,
    role: 'agent',
    content,
    ...(response.agent ? { agent: response.agent } : {}),
    ...(response.model ? { model: response.model } : {}),
    ...(response.effort ? { effort: response.effort } : {}),
    ...(errorUsage ? { usage: errorUsage } : {}),
    ...(response.agent_had_no_effect !== undefined ? { agent_had_no_effect: response.agent_had_no_effect } : {}),
    ...(response.uncommitted?.length ? { uncommitted: response.uncommitted } : {}),
  }, null);
  if (errorUsage) {
    await rollUpSessionUsage(storage, session.id, errorUsage, `Task ${taskShortId}`);
  }
}

/**
 * Sweep responses that a later command displaced before anyone consumed them.
 *
 * Each one is a turn the agent ACTUALLY FINISHED whose record was never
 * written. `writeCommand` used to delete these outright, which is how a full
 * turn — the agent's conclusions, what remained to do, and the session id the
 * work happened in — vanished from a task with no trace anywhere. Preserving
 * the file is only half the fix; this is the half that turns it back into a
 * turn record.
 *
 * Runs over every non-terminal task, not just working/interrupted ones: the
 * whole point is that the task's status at this moment is unrelated to the
 * displaced turn, and filtering by status is exactly the assumption that lost
 * these in the first place.
 *
 * Exported for unit testing.
 */
export async function sweepSupersededResponses(storage: Storage, lazyRoot: string): Promise<void> {
  const tasks = await storage.listTasksWithOptions({ nonTerminalOnly: true });

  for (const task of tasks) {
    const protoDir = getProtocolDir(task.id);
    const displaced = listSupersededResponses(protoDir);
    if (displaced.length === 0) continue;

    const taskShortId = shortId(task.id);
    const session = await storage.getSessionByTaskId(task.id);
    if (!session) continue;

    const worktreePath = getWorktreePathForRef(lazyRoot, taskRef(task));

    for (const { path, response } of displaced) {
      try {
        if (response.status === 'completed') {
          logger.warn(
            `Task ${taskShortId}: recovering a completed turn whose response was displaced by a later command — ` +
            `recording it now (it would previously have been lost).`,
          );
          // Records the turn AND reconciles agent_session_id, which is what
          // makes `lazy pair` resume the session that did the work rather than
          // opening an empty one. Deliberately records only — no status
          // transition, because a newer turn may own the task's status now.
          await recordSupersededWorkTurns(
            storage, task.id, session, completedResponses(response), worktreePath,
          );
        } else {
          logger.warn(`Task ${taskShortId}: recording a crash report displaced by a later command.`);
          await recordSupersededErrorTurn(storage, task.id, session, response);
        }
        consumeSupersededResponse(path);
      } catch (err) {
        // Leave the file in place so the next tick retries — dropping it here
        // would reintroduce the exact silent loss this sweep exists to stop.
        logger.warn(
          `Task ${taskShortId}: could not record displaced response ${path}: ` +
          `${err instanceof Error ? err.message : err} (will retry next tick)`,
        );
      }
    }
  }
}

/**
 * Sweep terminal-state tasks for orphaned containers.
 *
 * When accept/close/reject calls removeContainer(), the docker rm -f can silently
 * fail. Since the reconciler previously only looked at working tasks, these containers
 * would run forever. This sweep finds and removes them.
 */
async function sweepTerminalContainers(storage: Storage, lazyRoot: string, runner: Runner): Promise<void> {
  const allTasks = await storage.listTasks();

  for (const task of allTasks) {
    if (!TERMINAL_STATUSES.has(task.status)) continue;

    try {
      const taskShortId = shortId(task.id);
      const session = await storage.getSessionByTaskId(task.id);

      // Skip tasks with no session or no tracked container — cleanup already happened
      if (!session?.container_name) continue;

      const containerName = session.container_name;

      // Use the runner the session ran on (fallback: global) so a host run isn't
      // checked for under docker (and vice versa).
      const taskRunner = session.runner_type && session.runner_type !== runner.type
        ? await createRunner(lazyRoot, session.runner_type)
        : runner;

      if (await taskRunner.runExists(containerName)) {
        logger.warn(`Task ${taskShortId}: removing orphaned run ${containerName} for ${task.status} task`);
        await taskRunner.removeRun(containerName);
      }

      // Clear container_name so future sweeps skip this task
      await storage.updateSessionContainerName(session.id, null);
    } catch (err) {
      logger.debug(`Failed to clean up run for terminal task ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Sweep non-terminal tasks that were accepted but never finished transitioning to complete.
 *
 * This detects the "zombie" scenario where `lazy accept` successfully merged the
 * task branch (squash into the target, or fast-forward from a merged PR) but crashed
 * before updating the session outcome and task status. The code is merged but the
 * task stays stuck as "blocked" or "interrupted" with an active session.
 *
 * Detection is gated SOLELY on the authoritative accept tag `lazy-accept-<full-task-id>`,
 * which accept creates during the merge step, before the status→complete transition
 * (see createAcceptTag). A task is recovered iff that tag exists and points at a real
 * commit.
 *
 * The tag is created on BOTH accept paths and is global to the repo, so the sweep does
 * not need to compute a merge target or care which branch the work landed on — this
 * avoids the reparent-target fragility and the false positives that the old branch-relative
 * tree-equality (`isBranchMergedInto`) and commit-message-grep (`findCommitByMessage`)
 * signals produced. A crash-looping task that was NEVER accepted has no tag and is left
 * alone, regardless of commit count or coincidental tree-equality with the target.
 *
 * If accepted → fix: set session outcome to "accepted", set ended_at, set task status to "complete".
 */
async function sweepMergedBranches(storage: Storage, lazyRoot: string): Promise<void> {
  const allTasks = await storage.listTasks();

  for (const task of allTasks) {
    if (TERMINAL_STATUSES.has(task.status)) continue;

    // Never auto-accept a working task — the agent is actively running.
    if (task.status === 'working') continue;

    try {
      const session = await storage.getSessionByTaskId(task.id);
      if (!session?.git_branch) continue;

      // Previously skipped whenever session.outcome was set, which left a hole:
      // accept can endSession before status→complete and before parent notify.
      // Self-heal then flips status to complete with no notify. Only skip when
      // the task is ALREADY terminal — then the pending-notify sweep owns retry.
      if (session.outcome && TERMINAL_STATUSES.has(task.status)) continue;

      const taskShortId = shortId(task.id);

      // Authoritative gate: only recover tasks that were actually accepted. The accept
      // tag is created during the merge step before the status flips to complete, so its
      // presence proves a human-driven accept merged this task's work. No tag → never
      // accepted → leave it alone.
      const acceptCommit = await getAcceptTagCommit(task.id, lazyRoot);
      if (!acceptCommit) continue;

      // A region carve reading this worktree makes the teardown below fail.
      // The tick's drain above settles the carves the RECONCILER started; a
      // carve kicked off by a READ (a reviewer opening the Changes tab of this
      // very task, `lazy_regions` on a cover miss) is invisible to it, runs for
      // seconds on a hub, and leaves `git branch -D` failing with the branch
      // still checked out.
      //
      // The whole task is skipped, not just the teardown: the task is still
      // non-terminal, so the next tick sweeps it normally, whereas finalizing
      // it now and leaving the worktree would make the leak permanent.
      const { hasCarveInFlight } = await import('../daemon/regions-service');
      if (hasCarveInFlight(task.id)) {
        logger.debug(
          `Task ${shortId(task.id)}: deferring zombie sweep, a region carve is reading the worktree`,
        );
        continue;
      }

      // Defense-in-depth: skip tasks where the agent never ran. If there are zero agent
      // turns, the task has no work to accept. This should never co-occur with an accept
      // tag, but keep the cheap guard.
      const turns = await storage.getSessionTurns(session.id);
      const hasAgentWork = turns.some(t => t.role === 'agent');
      if (!hasAgentWork) {
        logger.debug(`Task ${taskShortId}: skipping zombie sweep — accept tag present but no agent turns (${turns.length} turns, all human/system)`);
        continue;
      }

      // Zombie detected: task was accepted (tag points at ${acceptCommit}) but task/session not updated
      // (or session was ended but status never flipped — outcome-set hole above).
      logger.warn(`Task ${taskShortId}: accept tag found (commit ${acceptCommit.slice(0, 8)}), fixing zombie state (${turns.length} turns, ${turns.filter(t => t.role === 'agent').length} agent)`);

      if (!session.ended_at || !session.outcome) {
        await storage.endSession(session.id, 'accepted');
      }
      if (task.status !== 'zombie' && task.status !== 'complete') {
        await storage.updateTaskStatus(task.id, 'zombie', await systemActor(lazyRoot));
      }
      if (task.status !== 'complete') {
        await storage.updateTaskStatus(task.id, 'complete', await systemActor(lazyRoot));
      }

      // Same parent signal accept would have left — accept may have crashed
      // before notifyParentOfAcceptedSubtask ran (idempotent).
      const { notifyParentOfAcceptedSubtask } = await import('../task/notify-parent-accepted');
      await notifyParentOfAcceptedSubtask(storage, task, lazyRoot);

      // Re-parent unfinished children to the grandparent
      const reparented = await reparentChildren(task, storage);
      const reparentMsg = formatReparentWarning(reparented, task);
      if (reparentMsg) {
        logger.info(`${reparentMsg} of ${shortIdHelper(task.id)}.`);
      }
      // Their open PRs/MRs follow the new target (src/daemon/review-retarget.ts).
      const { retargetReviewsAfterReparent } = await import('../daemon/review-retarget');
      for (const note of await retargetReviewsAfterReparent(lazyRoot, storage, reparented)) logger.info(note);

      // Tear down the worktree and delete the LOCAL task branch. The original
      // accept crashed before its own cleanup ran (that's why this is a zombie),
      // so without this the task is finalized to `complete` while its worktree
      // and `lazy/...` branch are left behind forever — the exact leak this
      // fixes. Safe-deletion holds: the accept tag (gated on above) proves the
      // merge landed. LOCAL branch only — cleanupWorktreeAndBranch never touches
      // the remote ref. Kept a dynamic import so the runner and session-log
      // capture that task/cleanup pulls in stay off reconcile's own load graph
      // (reconcile is loaded by the list/blocked paths, which need neither).
      try {
        const { cleanupWorktreeAndBranch, cleanupTaskContainer } = await import('../task/cleanup');
        await cleanupTaskContainer(storage, session, taskRef(task), lazyRoot);
        const worktreePath = getWorktreePathForRef(lazyRoot, taskRef(task));
        await removeLock(worktreePath);
        await cleanupWorktreeAndBranch(worktreePath, session.git_branch, lazyRoot, storage, task.id, session.agent_session_id);
        removeProtocolDir(getProtocolDir(task.id));
      } catch (err) {
        logger.warn(`Cleanup after zombie-accept recovery failed for task ${taskShortId}: ${err instanceof Error ? err.message : err}`);
      }
    } catch (err) {
      logger.debug(`Failed to check merged branch for task ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Sweep tasks stuck in 'pairing' state where the pairing process has exited.
 *
 * When `lazy pair` transitions a task to 'pairing', it stores the pairing PID
 * in task metadata. If the process exits abnormally (terminal closed, machine
 * rebooted, process killed), the task stays in 'pairing' forever. This sweep
 * detects that the PID is no longer alive and transitions the task back to 'blocked'.
 *
 * Also handles the file-based pairing lock as a secondary check: if the lock file
 * exists but the PID is dead, the lock is cleaned up by readPairingLock().
 */
async function sweepStalePairing(storage: Storage, lazyRoot: string): Promise<void> {
  try {
    const pairingTasks = await storage.listTasksWithOptions({ pairingOnly: true });

    for (const task of pairingTasks) {
      try {
        const taskShortId = shortId(task.id);
        const pairingPidStr = task.metadata?.pairing_pid;

        if (pairingPidStr) {
          const pid = parseInt(pairingPidStr, 10);
          if (!isNaN(pid) && pid > 0) {
            // Check if the pairing process is still alive
            try {
              process.kill(pid, 0);
              // Process is alive — skip
              continue;
            } catch {
              // Process is dead — stale pairing state
            }
          }
        }

        // No valid PID or process is dead — transition back to blocked
        logger.warn(`Task ${taskShortId}: stale pairing state detected, transitioning back to blocked`);
        // A pairing session runs no permission check — parking must not clear a
        // pending set (violations-are-the-source-of-truth).
        await parkTaskPaused(storage, task.id, await systemActor(lazyRoot), { projectRoot: lazyRoot });
        await storage.updateTaskMetadata(task.id, 'pairing_pid', '');
        await storage.updateTaskMetadata(task.id, 'pairing_started_at', '');

        // Also clean up the file-based pairing lock if it exists
        const tRef = taskRef(task);
        const worktreePath = getWorktreePathForRef(lazyRoot, tRef);
        removePairingLock(worktreePath);
      } catch (err) {
        logger.debug(`Failed to recover stale pairing task ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
      }
    }
  } catch (err) {
    logger.debug(`Failed to sweep stale pairing tasks: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Recover `backlog` tasks whose git branch already has committed work.
 *
 * Backlog means "never started — no work exists." But the durable proof of
 * work is the task's git branch (sessions and worktrees are local on-disk
 * state that doesn't travel between machines; branches do). A task can end
 * up in `backlog` despite having real work in two known scenarios:
 *
 *   1. Historical bug: an over-aggressive `migrateBlockedToBacklog` sweep
 *      (introduced in #33 as a one-time migration, removed in this fix)
 *      demoted blocked-with-no-local-session tasks to backlog. Tasks where
 *      the post-turn check exited non-zero hit this path and got stuck.
 *   2. Machine move: a task's session blob lives only on the machine where
 *      it ran, but the branch (with all its commits) travels with the repo.
 *      A `backlog` task whose branch already has commits should be `blocked`.
 *
 * Recovery strategy: for each `backlog` task, check whether its task branch
 * exists and has any commits beyond `branched_from_sha` that changed the tree.
 * If yes, transition to `blocked` so the task is recoverable via `lazy unblock`
 * or `lazy resume`. The transition itself is validated by the canonical
 * state-machine table in `src/task-state-machine.ts`.
 *
 * Both branch namespaces are tried: a project that changed `[git]
 * default_branch_prefix` has pre-switch branches under the built-in `lazy/`
 * one, and those tasks' durable work must stay recoverable. Read-only either
 * way — the worst case of an extra probe is one `rev-list` that exits non-zero.
 *
 * INVARIANT: this sweep must never move a task that is CURRENTLY STARTING.
 * `lazy start` creates the worktree, cuts `lazy/<ref>` and writes the empty
 * `Initialize task …` commit while the task is still `backlog`, and only then
 * flips it to `working`. A sweep that listed the task before that flip used to
 * see "1 commit ahead of the base" and write `blocked` on top of the launcher's
 * `working` — producing a task that went `working` → `blocked` (actor `system`)
 * milliseconds after start while its agent ran on regardless. The turn was then
 * lost outright: `reconcileTasks` reads `response.json` only for `working`
 * tasks, so the supervisor's completed response sat unconsumed and the agent's
 * turn, commits and turn-report sequence were never recorded even though the
 * branch carried the work.
 *
 * Two independent gates close that, both required:
 *   1. REAL WORK — the empty init commit changes no tree, so `git diff --quiet`
 *      between base and branch says "nothing to review" and the task is left
 *      alone. Same gate `recoverStrandedCompletion` uses, for the same reason.
 *   2. STILL BACKLOG — re-read the task immediately before writing, so a task
 *      that started (or otherwise moved) during this sweep's git calls is never
 *      clobbered. Needed on top of (1) for the case where the branch legitimately
 *      carries real work already, e.g. a reopened task being restarted.
 */
export async function recoverBacklogWithCommits(storage: Storage, lazyRoot: string): Promise<void> {
  try {
    const backlogTasks = await storage.listTasksWithOptions({ backlogOnly: true });

    for (const task of backlogTasks) {
      try {
        const taskShortId = shortId(task.id);

        // We need a base SHA to ask "are there commits beyond it?". Without
        // branched_from_sha (very old tasks), skip — we can't make a safe call.
        if (!task.branched_from_sha) continue;

        const tRef = await taskRefFromId(task.id, storage);
        // The configured namespace first, then the built-in one for branches
        // created before the prefix was changed. Deduped so the common case
        // (no prefix configured) stays exactly one git call.
        const candidates = [...new Set([taskBranchFor(tRef), `${DEFAULT_BRANCH_PREFIX}/${tRef}`])];

        // One git call per candidate: count commits on the branch beyond the
        // base. If the branch doesn't exist, rev-list exits non-zero and we
        // move on. (We deliberately avoid a separate `branchExists` precheck —
        // both for efficiency and because some tests globally mock that helper.)
        let branch = '';
        let ahead = 0;
        for (const candidate of candidates) {
          const result = await runGit(
            ['rev-list', '--count', `${task.branched_from_sha}..${candidate}`],
            { cwd: lazyRoot },
          );
          if (result.exitCode !== 0) continue;
          const count = parseInt(result.stdout.trim(), 10) || 0;
          if (count === 0) continue;
          branch = candidate;
          ahead = count;
          break;
        }
        if (!branch) continue;

        // Gate 1 — real work. `lazy start` writes an empty `Initialize task …`
        // commit before the task leaves `backlog`, so "1 commit ahead" is the
        // normal state of every task mid-launch. `git diff --quiet` exits 1 when
        // the trees differ (real content worth reviewing) and 0 when identical.
        const diff = await runGit(
          ['diff', '--quiet', task.branched_from_sha, branch],
          { cwd: lazyRoot },
        );
        if (diff.exitCode === 0) continue;

        // Gate 2 — still backlog. The git calls above are awaits; a concurrent
        // `lazy start` can have taken this task to `working` in the meantime,
        // and writing `blocked` over it strands the turn that is about to run.
        const current = await storage.getTask(task.id);
        if (!current || current.status !== 'backlog') continue;

        logger.warn(`Task ${taskShortId}: backlog task has ${ahead} commit(s) on ${branch}, recovering to blocked`);
        await storage.updateTaskStatus(task.id, 'blocked', await systemActor(lazyRoot));
      } catch (err) {
        logger.debug(`Failed to check backlog recovery for ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
      }
    }
  } catch (err) {
    logger.debug(`Failed to list backlog tasks for recovery: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Recover tasks stranded in `working` whose turn was never finalized into
 * storage. This is the durable, restart-surviving net for the bug where a
 * completed agent session leaves real committed work on the branch but the
 * supervisor never produced a processable response, so the task wedges in
 * `working` forever (zero agent turns, zero recorded commits, no blocked
 * transition, no notification).
 *
 * `reconcileTask` (the primary working sweep) already attempts this recovery
 * inline. This sweep is defense-in-depth: it catches `working` tasks that
 * reconcileTask skipped (transient lock) or threw on, re-checking liveness from
 * scratch rather than relying on in-memory diffs.
 *
 * Safety: a task is acted on ONLY when its run is genuinely not alive — a live
 * run may still be finalizing the turn (post-turn check/sync, pushback) before
 * the supervisor writes response.json, and only that response finalizes a turn.
 * recoverStrandedCompletion then gates on real committed work, refuses for a
 * `cluster` task (whose branch commits are its children's, not its turn's), and
 * refuses while the recorded phase shows active harness work, so a live or
 * just-started agent is never disturbed.
 */
export async function recoverStrandedWorkingTasks(
  storage: Storage,
  lazyRoot: string,
  runner: Runner,
): Promise<void> {
  const workingTasks = await storage.listTasksWithOptions({ workingOnly: true });

  for (const task of workingTasks) {
    try {
      const session = await storage.getSessionByTaskId(task.id);
      if (!session) continue;

      const tRef = taskRef(task);
      const taskShortId = shortId(task.id);
      const worktreePath = getWorktreePathForRef(lazyRoot, tRef);

      // Don't touch tasks another process owns, or a human is pairing on —
      // nor one with a synchronous daemon turn in flight (the worktree lock is
      // pid-re-entrant and so cannot say that). A task with a waiter is not
      // stranded, however long it has been `working`.
      if (taskTurnInFlight(task)) continue;
      if (await checkLock(worktreePath)) continue;
      if (checkPairingLock(worktreePath)) continue;

      // Respect the startup grace period — a container/process that just launched
      // may not register as running yet, and has no work to recover regardless.
      if (session.last_interaction_at) {
        const elapsed = Date.now() - new Date(session.last_interaction_at).getTime();
        if (elapsed >= 0 && elapsed < getWorkingGracePeriodMs()) continue;
      }

      const protoDir = getProtocolDir(task.id);
      // A pending response means the primary path will finalize it normally.
      if (readResponse(protoDir)) continue;

      // The run on the runner the SESSION ran on — the primary sweep's
      // resolution (src/utils/working-run.ts). Probing the project runner here
      // asked about a run that does not exist there, which reads as dead.
      const { runner: taskRunner, runName: containerName } = await resolveWorkRun(lazyRoot, task, session, runner);
      // Same launch guard as the primary sweep: an image build runs for
      // minutes past the grace, and "no run yet" is the launch, not a death.
      if (launchInFlight(containerName, task.id)) continue;
      // Liveness is authoritative: only recover a run that is genuinely dead.
      // A live run may still be finalizing — leave it for the normal path.
      if (await taskRunner.isRunning(containerName)) continue;

      const recovered = await recoverStrandedCompletion(storage, task, session, worktreePath, protoDir, lazyRoot);
      if (recovered) {
        await storage.updateSessionContainerName(session.id, null);
        if (await taskRunner.runExists(containerName)) {
          await taskRunner.removeRun(containerName);
        }
        logger.info(`Task ${taskShortId}: recovered stranded 'working' task to 'blocked' (commits backfilled).`);
      }
    } catch (err) {
      logger.debug(`Failed stranded-working recovery for ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
