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
import { TERMINAL_STATUSES } from '../types';
import { isBlockedStatus } from '../task-state-machine';
import type { TokenUsage, AgentTokenUsage, Task } from '../types';
import { toTurnUsage, rollUpSessionUsage } from './usage-recording';
import { createRunner } from '../runner';
import type { Runner } from '../runner';
import {
  protocolDir as getProtocolDir, readResponse, readStatus, hasResponse, consumeResponse, clearStatus,
  removeProtocolDir, listSupersededResponses, consumeSupersededResponse,
} from '../protocol';
import type { CompletedResponse, ErrorResponse, WorktreeRecovery, AgentHandoffEntry } from '../protocol';
import { completedResponses } from '../protocol';
import { getNewCommits, hasUncommittedChanges, getUncommittedDiff, getCurrentSha, getAcceptTagCommit } from '../git/operations';
import { launchSettingsFromResponse } from './turns';
import { parkTaskPaused } from './paused-status';
import { checkLock, removeLock } from './lock';
import { checkPairingLock, removePairingLock } from './pairing-lock';
import { logger } from './logger';
import { shortId as shortIdHelper, taskRef, taskRefFromId, getWorktreePathForRef } from '../cli/helpers';
import { autoResumeTask, exitCodeToReason, MAX_CONSECUTIVE_INTERRUPTIONS } from './auto-resume';
import { shouldAutoReact, recordAutoReact } from '../daemon/auto-react-budget';
import type { AutoReactTrigger } from '../daemon/auto-react-budget';
import { resetSlowLaneState, getLastProjectAutoResumeAt, recordProjectAutoResume } from '../daemon/auto-resume-queue';
import { tryAdmitAgentSlot, releaseAgentSlot, countActiveAgents, effectiveAgentLimit, orderQueuedTasks, selectContainersToReap } from '../daemon/concurrency';
import { sweepStrandedMerging } from '../daemon/stranded-merge';
import { loadConfig } from '../config/loader';
import { runGit } from './git';
import { reparentChildren, formatReparentWarning } from '../cli/orphan';
import { readAgentReportFromSessionLog } from '../import/recover-agent-report';
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
 */
// Evaluated at call time (not module load) so that LAZY_TEST=1 set after import takes effect.
function getWorkingGracePeriodMs(): number {
  return process.env.LAZY_TEST === '1' ? 0 : 30000; // 30 seconds (0 in tests)
}

/**
 * Supervisor phases that indicate active post-work harness machinery is still
 * running for a turn. These legitimately run for minutes AFTER the agent is
 * "done" (a `post_turn_check` can be a full `cargo build`; `post_turn_sync`
 * merges upstream; pushback re-invokes the agent) and only THEN does the
 * supervisor write `response.json` to finalize the turn.
 *
 * Stranded-completion recovery must never fire while one of these is the
 * recorded phase: doing so would race the supervisor's own `writeResponse`,
 * record commits before post-turn sync settles (wrong end_sha / diff scope),
 * and drop the agent's real report. Only the supervisor's `response.json`
 * finalizes a turn — recovery is a fallback for when that will NEVER come
 * (the run is dead), not a shortcut around legitimate finalization.
 */
const ACTIVE_HARNESS_PHASES: ReadonlySet<string> = new Set([
  'sync_with_remote',
  'merge_and_fix',
  'permission_pushback',
  'post_turn_check',
  'post_turn_sync',
  'writing_response',
  'retrying',
]);


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
 * Exported for unit testing — `maybeAutoResume` calls this and returns early
 * when it returns true. Manual `lazy resume` / `lazy unblock` clears the flag
 * via `resetConsecutiveInterruptions`, re-arming auto-resume.
 */
export function shouldSkipAutoResumeForUserStop(
  session: { user_stopped?: boolean },
): boolean {
  return session.user_stopped === true;
}

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
  // Primary sweep: reconcile working tasks
  const workingTasks = await storage.listTasksWithOptions({ workingOnly: true });

    for (const task of workingTasks) {
      try {
        await reconcileTask(storage, task.id, lazyRoot, runner);
      } catch (err) {
        logger.debug(`Failed to reconcile task ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
      }
      // Yield to event loop between tasks so pending HTTP requests get served
      await yieldToEventLoop();
    }

    // Sweep 2: recover turns whose response a later command displaced.
    // Runs before the other response sweeps so a recovered turn is recorded
    // ahead of whatever the current turn produces — it happened first.
    try {
      await sweepSupersededResponses(storage, lazyRoot);
    } catch (err) {
      logger.warn(`Sweep superseded responses failed: ${err instanceof Error ? err.message : err}`);
    }

    // Sweep 3: process stale responses for interrupted tasks
    // This handles the race where the supervisor writes a new response AFTER
    // reconciliation already moved the task to interrupted.
    try {
      await sweepInterruptedResponses(storage, lazyRoot);
    } catch (err) {
      logger.warn(`Sweep interrupted responses failed: ${err instanceof Error ? err.message : err}`);
    }

    // Sweep 4: clean up orphaned runs for terminal-state tasks
    // This catches containers/processes that survived a failed cleanup during accept/close/reject.
    try {
      await sweepTerminalContainers(storage, lazyRoot, runner);
    } catch (err) {
      logger.warn(`Sweep terminal containers failed: ${err instanceof Error ? err.message : err}`);
    }

    // Sweep 5: detect tasks whose branch was already merged into their target
    // This catches the zombie scenario where accept squash-merged the branch
    // but crashed before updating session/task metadata.
    try {
      await sweepMergedBranches(storage, lazyRoot);
    } catch (err) {
      logger.warn(`Sweep merged branches failed: ${err instanceof Error ? err.message : err}`);
    }

    // Sweep 6: recover stale pairing states
    // If a task is in 'pairing' state but the pairing process has exited,
    // transition it back to 'blocked'. This handles: terminal closed,
    // machine rebooted, process killed.
    try {
      await sweepStalePairing(storage, lazyRoot);
    } catch (err) {
      logger.warn(`Sweep stale pairing failed: ${err instanceof Error ? err.message : err}`);
    }

    // Sweep 7: recover backlog tasks that actually have committed work.
    // The durable proof of work is the task's git branch — sessions and
    // worktrees are local on-disk state that doesn't travel between machines.
    // If a `backlog` task's branch has commits beyond its base, real work
    // exists and the task belongs in `blocked` so it surfaces in
    // `lazy blocked` and downstream commands can act on it.
    try {
      await recoverBacklogWithCommits(storage, lazyRoot);
    } catch (err) {
      logger.warn(`Recover backlog with commits failed: ${err instanceof Error ? err.message : err}`);
    }

    // Sweep 8: recover tasks stranded in `working` whose turn was never finalized.
    // Defense-in-depth for the primary working sweep above (reconcileTask). If
    // reconcileTask was skipped (transient worktree lock) or threw for a task, a
    // task whose agent finished and committed real work can sit in `working`
    // forever — turns/commits unpersisted, no blocked transition, no notification.
    // This independent net re-checks run liveness and backfills the
    // committed work to `blocked`. It re-reads current git/task state, so it
    // survives daemon restarts (mirrors recoverBacklogWithCommits).
    try {
      await recoverStrandedWorkingTasks(storage, lazyRoot, runner);
    } catch (err) {
      logger.warn(`Recover stranded working tasks failed: ${err instanceof Error ? err.message : err}`);
    }

    // Sweep 9: recover tasks stranded in `merging` by an accept that died.
    // `merging` is stamped by the accept orchestration and only that
    // orchestration clears it, so a daemon killed mid-accept leaves the task
    // there with nothing able to finish or undo it — and every exit (reject,
    // close, submit) refuses. Running here means it also runs shortly after
    // daemon startup, which is exactly when a killed accept is discovered.
    // See src/daemon/stranded-merge.ts for why this never touches a live merge
    // or a legitimately forge-pending one.
    try {
      await sweepStrandedMerging(storage, lazyRoot);
    } catch (err) {
      logger.warn(`Recover stranded merging tasks failed: ${err instanceof Error ? err.message : err}`);
    }

    // Sweep 10: reap idle blocked containers that are eating concurrency slots.
    // A blocked task keeps a live (idle-polling) supervisor container with no
    // idle reaper of its own — this is that reaper. Runs BEFORE the drain so a
    // freed slot is filled by a queued task in the same tick.
    try {
      await reapIdleContainers(storage, lazyRoot, runner);
    } catch (err) {
      logger.warn(`Reap idle containers failed: ${err instanceof Error ? err.message : err}`);
    }

    // Sweep 11: drain queued tasks as agent slots free up.
    // Tasks queued at the concurrency cap (backlog→queued in launchTask) wait
    // here until a slot frees (a working turn ends or an idle container is reaped).
    try {
      await drainQueuedTasks(storage, lazyRoot);
    } catch (err) {
      logger.warn(`Drain queued tasks failed: ${err instanceof Error ? err.message : err}`);
    }
}

/**
 * Reap idle blocked containers to bound Docker load and free concurrency slots.
 *
 * A blocked task keeps its supervisor container alive (idle-polling with an
 * infinite command wait) until the next unblock/review — potentially forever.
 * The reap decision ({@link selectContainersToReap}) is priority-aware: it frees
 * a warm container after a grace period (RAM bound) OR immediately when
 * equal-or-higher-priority work is queued and starved. Reaping is safe: all
 * durable state lives in storage + the on-disk Claude session, and the next
 * unblock does removeRun-before-relaunch anyway, so reaping only costs a
 * container cold-start on the next turn.
 *
 * Applies via the Runner (`removeRun`) and clears `container_name`, so the
 * existing slot accounting frees the slot with no special-case counting.
 */
export async function reapIdleContainers(storage: Storage, lazyRoot: string, runner: Runner): Promise<void> {
  const config = await loadConfig(lazyRoot);
  const graceMs = config.limits.idle_grace_minutes * 60_000;
  const limit = effectiveAgentLimit(config);

  const nonTerminal = await storage.listTasksWithOptions({ nonTerminalOnly: true });
  const working: { taskId: string; priority: Task['priority'] }[] = [];
  const queued: { taskId: string; priority: Task['priority']; created_at: number }[] = [];
  const blocked: { taskId: string; priority: Task['priority']; idleSinceMs: number }[] = [];
  const sessionByTask = new Map<string, { id: string; container_name: string | null }>();

  for (const t of nonTerminal) {
    if (t.status === 'working') {
      working.push({ taskId: t.id, priority: t.priority });
      continue;
    }
    if (t.status === 'queued') {
      queued.push({ taskId: t.id, priority: t.priority, created_at: t.created_at });
      continue;
    }
    // Only turn-done, container-idle statuses are reap candidates. `pairing`,
    // `merging`, `interrupted` are excluded (transient, or container already
    // cleared). A `merging` task with no owner is not left to rot by that
    // exclusion — sweep 8 (sweepStrandedMerging) recovers it to a resting
    // status, and it becomes a reap candidate on the next tick.
    if (!isBlockedStatus(t.status)) continue;
    const session = await storage.getSessionByTaskId(t.id);
    if (!session?.container_name) continue; // no live container to reap
    sessionByTask.set(t.id, session);
    // Idle-since = the last turn's timestamp (turn end ≈ when the container went
    // idle). Falls back to session timestamps for a sessionless-but-containered edge.
    const turns = await storage.getSessionTurns(session.id);
    const idleSinceMs = turns.length > 0
      ? turns[turns.length - 1].timestamp
      : session.last_interaction_at ?? session.started_at;
    blocked.push({ taskId: t.id, priority: t.priority, idleSinceMs });
  }

  if (blocked.length === 0) return;

  const toReap = selectContainersToReap({
    blocked,
    queued,
    working,
    limit,
    graceMs,
    nowMs: Date.now(),
    baseReapEnabled: runner.reapsIdleRuns,
  });

  for (const taskId of toReap) {
    const session = sessionByTask.get(taskId);
    if (!session?.container_name) continue;
    try {
      if (await runner.runExists(session.container_name)) {
        await runner.removeRun(session.container_name);
      }
      await storage.updateSessionContainerName(session.id, null);
      logger.info(`Reaped idle container for task ${shortId(taskId)} — freed a concurrency slot`);
    } catch (err) {
      logger.warn(`Failed to reap idle container for task ${shortId(taskId)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Launch queued tasks as agent slots free up.
 *
 * A task lands in `queued` when `launchTask` hit the concurrency cap. This sweep
 * re-enters `launchTask` for each queued task (oldest first) while slots remain;
 * launchTask's own gate is authoritative, so a task that still can't get a slot
 * simply stays `queued`. Stops early once the cap is reached to avoid churn.
 */
async function drainQueuedTasks(storage: Storage, lazyRoot: string): Promise<void> {
  const queued = await storage.listTasksWithOptions({ queuedOnly: true });
  if (queued.length === 0) return;

  const config = await loadConfig(lazyRoot);
  const limit = effectiveAgentLimit(config);

  // Highest priority first, FIFO within a priority — the same pure ordering the
  // "queued #N of M" display uses. Kept out of this loop so a future scheduler
  // can reuse it (see src/daemon/concurrency.ts).
  const ordered = orderQueuedTasks(queued);

  // Lazy import to avoid a module-load cycle (task-launcher → rpc-handlers).
  const { launchTask } = await import('../daemon/task-launcher');

  for (const task of ordered) {
    if (await countActiveAgents(storage) >= limit) break; // no free slots
    try {
      // actor 'system': the reconciler launches on the human's behalf; the
      // original start's model/effort overrides were persisted on the task at
      // queue time, so this taskId-only relaunch reuses them.
      const result = await launchTask(lazyRoot, { taskId: task.id, actor: 'system' });
      if (result.queued) break; // gate re-queued it — cap reached, stop trying
      logger.info(`Drained queued task ${shortId(task.id)} → working`);
    } catch (err) {
      logger.warn(`Failed to launch queued task ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function reconcileTask(storage: Storage, taskId: string, lazyRoot: string, runner: Runner): Promise<void> {
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
  const taskRunner = session.runner_type && session.runner_type !== runner.type
    ? await createRunner(lazyRoot, session.runner_type)
    : runner;

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

  const containerName = session.container_name ?? taskRunner.runNameForTask(tRef);

  // Step 1: Check if supervisor has written a response
  const protoDir = getProtocolDir(taskId);
  const response = readResponse(protoDir);

  // If there's a response file, process it immediately (no grace period applies).
  // The grace period only matters when there's NO response yet - we want to give
  // the container time to start before checking if it's running.
  if (response) {
    if (response.status === 'completed') {
      logger.info(`Task ${taskShortId} finished turn, transitioning to blocked`);
      await handleCompletedResponses(storage, taskId, session, completedResponses(response), worktreePath, protoDir);

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
  if (await recoverStrandedCompletion(storage, taskId, session, worktreePath, protoDir)) {
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

    // Run stopped without writing response — interrupted
    await storage.updateTaskStatus(taskId, 'interrupted', 'system');
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
  await storage.updateTaskStatus(taskId, 'interrupted', 'system');
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
): Promise<boolean> {
  const taskShortId = shortId(taskId);
  const session = await storage.getSessionByTaskId(taskId);
  if (!session) return false;

  const task = await storage.getTask(taskId);
  if (!task || task.status !== 'working') return false;

  await storage.updateTaskStatus(taskId, 'interrupted', 'system');
  await storage.recordInterrupt(session.id, {
    reason:
      'Stopped by lazy: the daemon restarted, which invalidated this turn’s ' +
      'connection to the audit proxy. Resuming against the new daemon.',
    exit_code: null,
    logs: null,
  });
  // Not the task's fault — see the doc comment. Skipped when the session is
  // user-stopped: resetConsecutiveInterruptions also clears `user_stopped`
  // (that is how manual resume re-arms auto-resume), and a daemon restart must
  // never undo a human's `lazy stop`.
  if (!shouldSkipAutoResumeForUserStop(session)) {
    await storage.resetConsecutiveInterruptions(session.id);
    await resetSlowLaneState(storage, taskId);
  }
  await storage.updateSessionContainerName(session.id, null);

  // The dead supervisor's last status line describes a turn that no longer
  // exists. Left behind it is read as live progress by anything polling the
  // protocol dir, and the resumed turn writes over it only once it gets going.
  // Same clear the crash path does.
  clearStatus(getProtocolDir(taskId));

  logger.info(`Task ${taskShortId}: interrupted by daemon restart, resuming against the new daemon`);
  await maybeAutoResume(storage, taskId, session.id, lazyRoot);
  return true;
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
  if (shouldSkipAutoResumeForUserStop(session)) {
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

  const config = await loadConfig(lazyRoot, { cwd: lazyRoot });
  const dataDir = join(lazyRoot, config.data.path);

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

  // Concurrency gate: auto-resume must respect the agent cap too. At the cap,
  // defer — the reconciler retries every tick, so the resume happens naturally
  // once a slot frees (no durable queue needed for this autonomous path).
  let slotAdmitted = false;
  try {
    const decision = await tryAdmitAgentSlot(storage, taskId, effectiveAgentLimit(config));
    if (!decision.admitted) {
      logger.debug(`Task ${taskShortId}: at agent cap (${decision.running}/${decision.limit}), deferring auto-resume`);
      return;
    }
    slotAdmitted = true;
  } catch (err) {
    // Fail open on a cap-check error — do not block recovery on a config read.
    logger.debug(`Task ${taskShortId}: agent cap check failed (proceeding): ${err instanceof Error ? err.message : err}`);
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
  } finally {
    // autoResumeTask flips the task to `working` on success (slot stays counted)
    // or leaves it interrupted on failure (slot freed) — either way release the
    // short-lived reservation now that storage reflects the outcome.
    if (slotAdmitted) releaseAgentSlot(taskId);
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
 * INVARIANT: only recovers when the branch holds real committed content beyond
 * what storage already knows. A `lazy start` init commit (--allow-empty, no
 * tree change) is NOT work — those tasks fall through to interrupted/resume,
 * mirroring the zombie sweep's `hasAgentWork` guard.
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
  taskId: string,
  session: { id: string; git_start_sha: string; agent_session_id: string | null },
  worktreePath: string,
  protoDir: string,
): Promise<boolean> {
  const taskShortId = shortId(taskId);

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

  const existingCommits = await storage.getSessionCommits(session.id);
  const lastKnownSha = existingCommits.length > 0
    ? existingCommits[existingCommits.length - 1].sha
    : session.git_start_sha;

  let newCommits;
  try {
    newCommits = await getNewCommits(lastKnownSha, worktreePath);
  } catch (err) {
    logger.debug(`Task ${taskShortId}: stranded-recovery commit scan failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  if (newCommits.length === 0) return false;

  // Real-work gate: ignore empty (--allow-empty) init commits that introduce no
  // tree change. `git diff --quiet` exits 1 when trees differ (real content) and
  // 0 when identical (nothing worth reviewing).
  const diff = await runGit(['diff', '--quiet', lastKnownSha, 'HEAD'], { cwd: worktreePath });
  if (diff.exitCode === 0) return false;

  logger.warn(`Task ${taskShortId}: stranded in 'working' with ${newCommits.length} unrecorded commit(s) and no response — recovering to 'blocked' and backfilling commits.`);

  // Backfill commits — git is the source of truth when storage is empty.
  for (const c of newCommits) {
    await storage.createCommit(session.id, c.sha, c.message);
  }

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
    await storage.createTurn({
      sessionId: session.id,
      sequence: seq,
      role: 'agent',
      content: await buildStrandedRecoveryTurnContent(worktreePath, session.agent_session_id, newCommits.length, watermarkMs),
    });
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
  await parkTaskPaused(storage, taskId, 'system', { sessionId: session.id });

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
function supervisedHeading(kind: 'permission_pushback' | 'maintain'): string {
  switch (kind) {
    case 'permission_pushback':
      return '## Permission Violation Review';
    case 'maintain':
      return '## Maintained Files Review';
  }
}

/**
 * Roll up every invocation's usage in a bundle (work + supervised follow-ups).
 *
 * See src/utils/usage-recording.ts for the invariant this must be called under:
 * only where the corresponding turn(s) are written.
 */
async function rollUpBundleUsage(
  storage: Storage,
  sessionId: string,
  responses: Array<{ usage?: AgentTokenUsage }>,
  taskShortId: string,
): Promise<void> {
  for (const resp of responses) {
    await rollUpSessionUsage(storage, sessionId, toTurnUsage(resp.usage, `Task ${taskShortId}`), `Task ${taskShortId}`);
  }
}

async function recordSupervisedTurns(
  storage: Storage,
  sessionId: string,
  supervised: CompletedResponse[],
  worktreePath: string,
): Promise<void> {
  for (const resp of supervised) {
    if (!resp.supervised) continue; // defensive: a supervised follow-up must carry its block
    const { kind, prompt } = resp.supervised;

    const promptSeq = await storage.getNextTurnSequence(sessionId);
    await storage.createTurn({
      sessionId,
      sequence: promptSeq,
      role: 'human',
      content: `${supervisedHeading(kind)}\n\n${prompt}`,
      prompt,
      // The supervisor authored this autonomously — not the human, not the agent.
      actor: 'supervisor',
      autoTriggered: true,
      turnType: 'nudge',
    });

    const replySeq = await storage.getNextTurnSequence(sessionId);
    await storage.createTurn({
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
      // Violations re-detected after THIS invocation. Stored only when non-empty;
      // the final set lands on the push-back turn (latestViolationTurn finds it).
      ...(resp.violations && resp.violations.length > 0 ? { violations: resp.violations } : {}),
      turnType: 'nudge',
    });
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
 */
async function journalWorktreeRecovery(
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
  let existingFollowUps: string[] = [];
  try {
    existingJournal = (await storage.getTaskJournal(taskId)).map(e => e.content);
    existingFollowUps = (await storage.getTaskFollowUps(taskId)).map(f => f.content);
  } catch (err) {
    logger.debug(
      `Task ${taskShortId}: could not read existing journal/follow-ups for handoff dedup: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let recorded = 0;
  for (const entry of entries) {
    const content = entry.content.trim();
    if (!content) continue;
    try {
      if (entry.kind === 'journal') {
        if (existingJournal.includes(content)) continue;
        await storage.appendJournalEntry(taskId, content, 'agent');
        existingJournal.push(content);
      } else {
        if (existingFollowUps.includes(content)) continue;
        await storage.createFollowUp(taskId, content);
        existingFollowUps.push(content);
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
): Promise<void> {
  return handleCompletedResponses(storage, taskId, session, [response], worktreePath, protoDir);
}

/**
 * Record the turns for a completed upstream-merge (sync) command.
 *
 * Sync is modeled differently from a work turn: the supervisor performs the merge
 * itself, so its announcement is a `supervisor`-actored turn — never an agent turn
 * and never a human turn. The merge OUTCOME (responses[0].sync) drives the shape:
 *
 *   - merged: false (no-op) → NO turn at all. A sync that merged nothing leaves no
 *     trace in the turn history (skip-when-noop).
 *   - merged: true, no conflicts → a single `supervisor` merge turn; the merge
 *     commit is attributed to it (its own SHA window).
 *   - merged: true, conflicts → the `supervisor` merge turn PLUS the agent's
 *     conflict-resolution reply (responses[1]) as a discrete `agent` turn that owns
 *     the merge commit and carries the agent's own usage (incl. cache tokens).
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
): Promise<void> {
  const taskShortId = shortId(taskId);
  const mergeResp = responses[0];
  const resolutionResp = responses[1]; // present only when the merge had conflicts
  const sync = mergeResp.sync!;

  await journalWorktreeRecovery(storage, taskId, mergeResp.worktree_recovery);
  // The conflict-resolution response (when there was one) carries the handoff.
  await persistAgentHandoff(storage, taskId, mergeResp.agent_handoff ?? resolutionResp?.agent_handoff);

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

  // Reconcile the agent session id from the conflict-resolution invocation — the
  // only `claude -p` a sync ever runs. A clean or no-op merge invokes no agent.
  if (resolutionResp?.session_id && shouldReconcileAgentSessionId(session.agent_session_id, resolutionResp.session_id)) {
    await storage.updateSessionClaudeId(session.id, resolutionResp.session_id);
  }

  if (sync.merged) {
    // Idempotency: the merge message embeds the exact pre→post SHAs, so an existing
    // `supervisor` sync turn with this content means we already recorded this merge.
    // Guards a reconciler re-run before the response is consumed; usage rollup and
    // commit recording live inside this guard so a re-run stays fully idempotent.
    const existingTurns = await storage.getSessionTurns(session.id);
    const alreadyRecorded = existingTurns.some(
      t => t.actor === 'supervisor' && t.turn_type === 'sync' && t.content === mergeResp.result,
    );

    if (!alreadyRecorded) {
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
        actor: 'supervisor',
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
        await storage.createTurn({
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
        });
      }

      // Roll up token usage from every invocation (the conflict-resolution agent,
      // when present — the announcement carries zero). Inside `!alreadyRecorded`
      // with the turn writes, per the invariant on rollUpSessionUsage.
      await rollUpBundleUsage(storage, session.id, responses, taskShortId);

      // Record the merge commit(s).
      const existingCommits = await storage.getSessionCommits(session.id);
      const lastKnownSha = existingCommits.length > 0
        ? existingCommits[existingCommits.length - 1].sha
        : session.git_start_sha;
      try {
        const newCommits = await getNewCommits(lastKnownSha, worktreePath);
        for (const c of newCommits) {
          await storage.createCommit(session.id, c.sha, c.message);
        }
      } catch (err) {
        logger.debug(`Task ${taskShortId}: could not detect new commits after sync: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  // merged: false → NO turn recorded (skip-when-noop). The task still transitions
  // out of 'working' below so a no-op sync doesn't strand it.

  // Sync completion returns the task to its paused status — the same
  // terminal-of-turn transition the work path uses. Sync runs no violation
  // detection, so it never PRODUCES a conflict; but it must not CLEAR one
  // either. Syncing a conflict task used to park it 'blocked' and orphan the
  // pending set (violations-are-the-source-of-truth).
  await parkTaskPaused(storage, taskId, 'system', { sessionId: session.id });

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
    await recordSyncTurns(storage, taskId, session, responses, worktreePath, protoDir);
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
    await storage.createTurn({
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
    });

    // Materialize each supervised follow-up as its own discrete turn pair.
    //
    // INVARIANT: supervised turns are recorded ONLY on the same pass that creates
    // the work turn (inside this `else`). On a reconciler re-run the last turn is
    // already an agent turn, so the whole block is skipped — no duplicate turns.
    if (supervised.length > 0) {
      await recordSupervisedTurns(storage, session.id, supervised, worktreePath);
    }

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

  // Detect and record new commits
  const existingCommits = await storage.getSessionCommits(session.id);
  const lastKnownSha = existingCommits.length > 0
    ? existingCommits[existingCommits.length - 1].sha
    : session.git_start_sha;

  try {
    const newCommits = await getNewCommits(lastKnownSha, worktreePath);
    logger.debug(`Task ${taskShortId}: detected ${newCommits.length} new commit(s) since ${lastKnownSha.substring(0, 8)} in ${worktreePath}`);
    for (const c of newCommits) {
      await storage.createCommit(session.id, c.sha, c.message);
    }
  } catch (err) {
    logger.debug(`Task ${taskShortId}: could not detect new commits: ${err instanceof Error ? err.message : err}`);
  }

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
  await parkTaskPaused(storage, taskId, 'system', { sessionId: session.id, detected: finalViolations });

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
  session: { id: string },
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

  // Record error turn. Idempotency is CONTENT-based: the same error must not be
  // recorded twice, but a *different* error must always be recorded.
  //
  // This used to skip whenever the last turn was an agent turn — which silently
  // swallowed exactly the errors this task exists to surface. A sync that
  // conflicted, ran a resolution agent (agent turn), and THEN failed to conclude
  // the merge recorded nothing at all: the task went back to blocked looking
  // settled while the worktree was still mid-merge (fix-sync-silent-conflict).
  const existingTurns = await storage.getSessionTurns(session.id);
  const alreadyRecorded = existingTurns.some(t => t.role === 'agent' && t.content === turnContent);
  if (!alreadyRecorded) {
    const seq = await storage.getNextTurnSequence(session.id);
    // Tokens the dying turn had already spent, salvaged by the supervisor from
    // the agent's final output (src/supervisor/usage.ts). Absent for turns that
    // died before reporting anything, and for supervisors older than this field.
    const errorUsage = toTurnUsage(response.usage, `Task ${taskShortId}`);
    await storage.createTurn({
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
      // consumers (pre-accept, etc.) know there's nothing to reflect on.
      ...(response.agent_had_no_effect !== undefined ? { agent_had_no_effect: response.agent_had_no_effect } : {}),
    });
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

  consumeResponse(protoDir);
  clearStatus(protoDir);

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
      await storage.updateTaskStatus(taskId, 'working', 'system');
    }
    // A crashed turn detected nothing, so it cannot clear an owed decision —
    // park on the violation set (violations-are-the-source-of-truth).
    await parkTaskPaused(storage, taskId, 'system', { sessionId: session.id });
    await storage.recordInterrupt(session.id, {
      reason: `${fatalClass}: ${response.failure_reason ?? response.error}`,
      exit_code: response.exit_code ?? null,
      logs: response.stderr ?? null,
    });
    logger.warn(
      `Task ${taskShortId}: unrecoverable agent failure (${fatalClass}) — blocked for human attention, not auto-resuming`,
    );
    return;
  }

  await storage.updateTaskStatus(taskId, 'interrupted', 'system');

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
        await storage.updateTaskStatus(task.id, 'working', 'system');
        await handleCompletedResponses(storage, task.id, session, completedResponses(response), worktreePath, protoDir);
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
  await storage.createTurn({
    sessionId: session.id,
    sequence: seq,
    role: 'agent',
    content,
    usage: toTurnUsage(work.usage),
    ...launchSettingsFromResponse(work),
    mergeConflicts: work.merge_conflicts,
    ...(work.check_exit_code !== undefined ? { checkExitCode: work.check_exit_code } : {}),
    ...(work.check_output !== undefined ? { checkOutput: work.check_output } : {}),
  });

  const supervised = responses.slice(1);
  if (supervised.length > 0) {
    await recordSupervisedTurns(storage, session.id, supervised, worktreePath);
  }

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
  await storage.createTurn({
    sessionId: session.id,
    sequence: seq,
    role: 'agent',
    content,
    ...(response.agent ? { agent: response.agent } : {}),
    ...(response.model ? { model: response.model } : {}),
    ...(response.effort ? { effort: response.effort } : {}),
    ...(errorUsage ? { usage: errorUsage } : {}),
    ...(response.agent_had_no_effect !== undefined ? { agent_had_no_effect: response.agent_had_no_effect } : {}),
  });
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

      // Skip if session already has an outcome (self-healing in listTasksWithOptions handles that case)
      if (session.outcome) continue;

      const taskShortId = shortId(task.id);

      // Authoritative gate: only recover tasks that were actually accepted. The accept
      // tag is created during the merge step before the status flips to complete, so its
      // presence proves a human-driven accept merged this task's work. No tag → never
      // accepted → leave it alone.
      const acceptCommit = await getAcceptTagCommit(task.id, lazyRoot);
      if (!acceptCommit) continue;

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
      logger.warn(`Task ${taskShortId}: accept tag found (commit ${acceptCommit.slice(0, 8)}), fixing zombie state (${turns.length} turns, ${turns.filter(t => t.role === 'agent').length} agent)`);

      await storage.endSession(session.id, 'accepted');
      await storage.updateTaskStatus(task.id, 'zombie', 'system');
      await storage.updateTaskStatus(task.id, 'complete', 'system');

      // Re-parent unfinished children to the grandparent
      const reparented = await reparentChildren(task, storage);
      const reparentMsg = formatReparentWarning(reparented, task);
      if (reparentMsg) {
        logger.info(`${reparentMsg} of ${shortIdHelper(task.id)}.`);
      }

      // Tear down the worktree and delete the LOCAL task branch. The original
      // accept crashed before its own cleanup ran (that's why this is a zombie),
      // so without this the task is finalized to `complete` while its worktree
      // and `lazy/...` branch are left behind forever — the exact leak this
      // fixes. Safe-deletion holds: the accept tag (gated on above) proves the
      // merge landed. LOCAL branch only — cleanupWorktreeAndBranch never touches
      // the remote ref. Dynamic import avoids a top-level cycle with the heavy
      // cli/commands/shared graph (reconcile is loaded by list/blocked paths).
      try {
        const { cleanupWorktreeAndBranch, cleanupTaskContainer } = await import('../cli/commands/shared');
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
        await parkTaskPaused(storage, task.id, 'system');
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
 * Recovery strategy: for each `backlog` task, check if `lazy/<ref>` exists
 * and has any commits beyond `branched_from_sha`. If yes, transition to
 * `blocked` so the task is recoverable via `lazy unblock` or `lazy resume`.
 * The transition itself is validated by the canonical state-machine table
 * in `src/task-state-machine.ts`.
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
        const branch = `lazy/${tRef}`;

        // Single git call: count commits on the branch beyond the base.
        // If the branch doesn't exist, rev-list exits non-zero and we skip.
        // (We deliberately avoid a separate `branchExists` precheck — both for
        // efficiency and because some tests globally mock that helper.)
        const result = await runGit(
          ['rev-list', '--count', `${task.branched_from_sha}..${branch}`],
          { cwd: lazyRoot },
        );
        if (result.exitCode !== 0) continue;
        const ahead = parseInt(result.stdout.trim(), 10) || 0;
        if (ahead === 0) continue;

        logger.warn(`Task ${taskShortId}: backlog task has ${ahead} commit(s) on ${branch}, recovering to blocked`);
        await storage.updateTaskStatus(task.id, 'blocked', 'system');
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
 * recoverStrandedCompletion then gates on real committed work AND refuses while
 * the recorded phase shows active harness work, so a live or just-started agent
 * is never disturbed.
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

      // Don't touch tasks another process owns, or a human is pairing on.
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

      const containerName = session.container_name ?? runner.runNameForTask(tRef);
      // Liveness is authoritative: only recover a run that is genuinely dead.
      // A live run may still be finalizing — leave it for the normal path.
      if (await runner.isRunning(containerName)) continue;

      const recovered = await recoverStrandedCompletion(storage, task.id, session, worktreePath, protoDir);
      if (recovered) {
        await storage.updateSessionContainerName(session.id, null);
        if (await runner.runExists(containerName)) {
          await runner.removeRun(containerName);
        }
        logger.info(`Task ${taskShortId}: recovered stranded 'working' task to 'blocked' (commits backfilled).`);
      }
    } catch (err) {
      logger.debug(`Failed stranded-working recovery for ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
