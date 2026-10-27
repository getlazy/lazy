/**
 * Stopping a RUNNING turn for spend — the half of the usage pause that acts
 * after launch.
 *
 * Two limits, one mechanism:
 *
 *   USAGE — `[usage_pause]` (src/daemon/usage-pause.ts) used to judge only turn
 *   STARTS, so one long turn could run far past the threshold. The proxy now
 *   asks {@link runningTurnStopFor} before forwarding each model request a task
 *   agent makes. Once the credential that turn spends is past its threshold
 *   (the same verdict a launch gets, `usagePauseForTask`), the request is
 *   refused and the turn is stopped: `interrupted`, the container and every
 *   commit kept, nothing reverted. The ordinary auto-resume is then HELD by the
 *   launch gate until the window resets, so the task resumes by itself exactly
 *   like any other held daemon launch. A per-task allowance (`lazy resume
 *   <task> --override-usage-pause`, the dashboard's and Teams' button) lets
 *   that task's next turn through, and the turn it lets through is not stopped
 *   for the same window again.
 *
 *   TOKEN CAP — a task may carry its own cap (`lazy edit --token-cap 50M`, task
 *   metadata `token_cap`). Its spend is the proxy's durable per-task token
 *   total (the tool-stats record). At the cap the turn is stopped the same way
 *   but parked `blocked`, and NOT resumed: a person raises or clears the cap,
 *   then unblocks or resumes it. Launches of a task at its cap are refused
 *   (explicit) or held (the daemon's own) until then.
 *
 * Every harness: the decision is made on the proxy's request path from the
 * proxy's own readings, and the stop kills the agent from outside, so nothing
 * depends on a harness recognising a refusal. The refused request carries a
 * plain-language 429 for the harness that does read it.
 *
 * Only WORK turns are stopped; an ask or review visiting the task is left to
 * finish. The builder's own traffic carries no task and is never judged here.
 */

import { loadConfig } from '../config/loader';
import { logger } from '../utils/logger';
import { displayId, taskRef } from '../task/identity';
import { createRunner } from '../runner';
import { stopTaskAgent } from '../runner/stop-task-agent';
import { protocolDir as getProtocolDir, writeResponse, clearStatus, readDispatchedCommandId } from '../protocol';
import type { ErrorResponse } from '../protocol';
import { parkTaskPaused } from '../utils/paused-status';
import { systemActor } from '../identity/system-identity';
import { isInFlightLive } from './in-flight-turn';
import { isUserStopped } from '../task/user-stop';
import { withTaskLifecycleLock } from './task-lifecycle-lock';
import type { Storage } from '../storage/interface';
import type { Task } from '../types';
import { describeUsagePause } from '../usage-pause/policy';
import {
  TOKEN_CAP_STOPPED_KEY,
  USAGE_PAUSE_STOPPED_KEY,
  describeTokenCapStop,
  describeUsagePauseStop,
  tokenCapStopOf,
  usagePauseStopOf,
  type TokenCapStop,
  type UsagePauseStop,
} from '../usage-pause/running-stop';
import { usagePauseForTask, runningTurnAllowedPastPause } from './usage-pause';
import { tokenCapReached } from './token-cap';
import { getTaskSessionBinding } from './session-credentials';

/** What the proxy answers a refused request with, and why the turn is being stopped. */
export interface RunningTurnStop {
  kind: 'usage' | 'cap';
  /** The 429's body: what happened and what happens next. */
  message: string;
  usage?: Omit<UsagePauseStop, 'stoppedAt' | 'commandId'>;
  cap?: { cap: number; spent: number };
}

// --- The per-request check (the proxy's hot path) ---

/**
 * How long a verdict is reused for one task. The proxy asks on EVERY request;
 * the verdict reads config, readings and the task record, and a reading moves
 * at most once per response. A few seconds of lag past the threshold costs one
 * or two requests, never a turn.
 */
const VERDICT_TTL_MS = 5_000;
const verdictCache = new Map<string, { at: number; stop: RunningTurnStop | null }>();
/** Stops in progress, so a burst of refused requests stops the turn once. */
const stopping = new Set<string>();

export function resetRunningTurnStopForTest(): void {
  verdictCache.clear();
  stopping.clear();
}

/**
 * Should this task's running turn be stopped right now? Null to forward the
 * request. Never throws: a failure to decide forwards the request (the launch
 * gate still holds the NEXT turn), and is logged.
 */
export async function runningTurnStopFor(
  projectRoot: string,
  storage: Storage,
  taskId: string,
  now: number = Date.now(),
): Promise<RunningTurnStop | null> {
  const cached = verdictCache.get(taskId);
  if (cached && now - cached.at < VERDICT_TTL_MS) return cached.stop;
  let stop: RunningTurnStop | null = null;
  try {
    stop = await judgeRunningTurn(projectRoot, storage, taskId, now);
  } catch (err) {
    logger.warn(`[running-stop] cannot judge task ${taskId.slice(0, 8)}'s running turn: ${err instanceof Error ? err.message : String(err)}`);
  }
  verdictCache.set(taskId, { at: now, stop });
  if (verdictCache.size > 512) verdictCache.delete(verdictCache.keys().next().value!);
  return stop;
}

async function judgeRunningTurn(projectRoot: string, storage: Storage, taskId: string, now: number): Promise<RunningTurnStop | null> {
  const task = await storage.getTask(taskId);
  if (!task || task.status !== 'working') return null;
  const claim = task.in_flight_turn ?? null;
  if (claim && isInFlightLive(claim) && (claim.owner === 'ask' || claim.owner === 'review')) return null;

  const commandId = readDispatchedCommandId(getProtocolDir(task.id));
  await clearStaleStopRecords(storage, task, commandId);
  // The turn a person's "let its next turn through" launched runs to its end,
  // past the usage pause and the task's token cap alike.
  if (runningTurnAllowedPastPause(task.id, commandId)) return null;

  const reached = await tokenCapReached(storage, task);
  if (reached) {
    return {
      kind: 'cap',
      cap: reached,
      message:
        `lazy stopped this turn: ${describeTokenCapStop(reached)}. Your work so far is kept. ` +
        `The task will not continue until a person raises its token cap.`,
    };
  }

  const config = await loadConfig(projectRoot);
  // The running turn spends its live session binding's owner (Teams member
  // billing); the proxy path has no request scope to read a turn owner from.
  const binding = await getTaskSessionBinding(projectRoot, task.id);
  const owner = binding && binding.revokedAt === null ? binding.ownerUserId : null;
  const pause = await usagePauseForTask(projectRoot, config, task, undefined, now, owner);
  if (!pause || pause.verdict.storeError) return null;
  // An allowance set while the turn runs is for its NEXT turn: this one
  // stops, and the allowance then lets the resume through.
  const v = pause.verdict;
  return {
    kind: 'usage',
    usage: v,
    message:
      `lazy paused this turn for usage: ${describeUsagePause(v, now)} ` +
      `Your work so far is kept, and the task resumes by itself once the window resets.`,
  };
}

/** A stop record from an earlier turn describes nothing once a new turn runs. */
async function clearStaleStopRecords(storage: Storage, task: Task, commandId: string | null): Promise<void> {
  const u = usagePauseStopOf(task);
  if (u && u.commandId !== commandId) await storage.updateTaskMetadata(task.id, USAGE_PAUSE_STOPPED_KEY, '');
  const c = tokenCapStopOf(task);
  if (c && c.commandId !== commandId) await storage.updateTaskMetadata(task.id, TOKEN_CAP_STOPPED_KEY, '');
}

// --- The stop itself ---

/**
 * Stop `taskId`'s running work turn for `stop`, once. Runs behind the refused
 * request (the proxy never waits for it). Save first: the record of WHY is on
 * the task before the agent is touched.
 */
export function stopRunningTurnForSpend(projectRoot: string, storage: Storage, taskId: string, stop: RunningTurnStop): void {
  if (stopping.has(taskId)) return;
  stopping.add(taskId);
  void withTaskLifecycleLock(taskId, () => stopRunningTurn(projectRoot, storage, taskId, stop))
    .catch((err) => {
      logger.error(`[running-stop] could not stop task ${taskId.slice(0, 8)}'s turn: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      stopping.delete(taskId);
      verdictCache.delete(taskId);
    });
}

async function stopRunningTurn(projectRoot: string, storage: Storage, taskId: string, stop: RunningTurnStop): Promise<void> {
  const task = await storage.getTask(taskId);
  if (!task || task.status !== 'working') return;
  const claim = task.in_flight_turn ?? null;
  if (claim && isInFlightLive(claim) && (claim.owner === 'ask' || claim.owner === 'review')) return;
  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess || sess.ended_at) return;

  const protoDir = getProtocolDir(task.id);
  const commandId = readDispatchedCommandId(protoDir);
  const stoppedAt = Date.now();
  const line = stop.kind === 'usage'
    ? describeUsagePauseStop({ ...stop.usage!, stoppedAt, commandId })
    : describeTokenCapStop(stop.cap!);

  // SAVE FIRST: why the turn stopped is on the task before anything can fail.
  if (stop.kind === 'usage') {
    const record: UsagePauseStop = { ...stop.usage!, stoppedAt, commandId };
    await storage.updateTaskMetadata(task.id, USAGE_PAUSE_STOPPED_KEY, JSON.stringify(record));
  } else {
    const record: TokenCapStop = { ...stop.cap!, stoppedAt, commandId };
    await storage.updateTaskMetadata(task.id, TOKEN_CAP_STOPPED_KEY, JSON.stringify(record));
  }
  logger.warn(`[running-stop] task ${displayId(task)}: ${line} — stopping its running turn`);

  // Resolved BEFORE the agent is stopped: nothing awaitable may sit between
  // the stop's response landing and the task being parked, or the reconciler
  // can read that response as a crash first.
  const actor = await systemActor(projectRoot);

  // Halt only the agent; the container (and its services) is kept, exactly as
  // `lazy stop` keeps it.
  const runner = await createRunner(projectRoot, sess.runner_type ?? undefined);
  const containerName = sess.container_name ?? runner.runNameForTask(taskRef(task));
  await stopTaskAgent(runner, containerName, protoDir);
  if (!runner.usesSandbox()) await storage.updateSessionContainerName(sess.id, null);

  const response: ErrorResponse = {
    status: 'error', error: `Stopped by lazy: ${line}`, phase: 'work',
    ...(commandId ? { command_id: commandId } : {}),
  };
  try {
    writeResponse(protoDir, response);
  } catch (err) {
    logger.warn(`[running-stop] failed to write the stop response to ${protoDir}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (stop.kind === 'usage') {
    // `interrupted`: the reconciler offers it to auto-resume on every tick, and
    // the usage-pause hold keeps it waiting until the window resets.
    await storage.updateTaskStatus(task.id, 'interrupted', actor);
    await storage.recordInterrupt(sess.id, { reason: `Stopped by lazy: ${line}.`, exit_code: null, logs: null });
    // Not the task's fault: no circuit-breaker charge. Skipped for a
    // user-stopped session — the reset also clears that flag.
    if (!isUserStopped(sess)) await storage.resetConsecutiveInterruptions(sess.id);
  } else {
    // `blocked`: no auto-resume; a person raises the cap.
    await parkTaskPaused(storage, task.id, actor, { sessionId: sess.id, projectRoot, reason: `Stopped by lazy: ${line}` });
    await storage.recordInterrupt(sess.id, { reason: `Stopped by lazy: ${line}.`, exit_code: null, logs: null });
  }
  try {
    clearStatus(protoDir);
  } catch (err) {
    logger.debug(`[running-stop] could not clear the status line in ${protoDir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
