/**
 * Slow-lane auto-resume queue — round-robin retry for tasks whose fast-lane
 * circuit breaker (MAX_CONSECUTIVE_INTERRUPTIONS, src/utils/auto-resume.ts) has
 * tripped.
 *
 * Fast lane (unchanged): a fresh crash resumes immediately, up to
 * MAX_CONSECUTIVE_INTERRUPTIONS consecutive interruptions.
 *
 * Slow lane (this module): once the breaker trips, the task is retried every
 * `daemon.auto_resume_interval_minutes`, up to `daemon.auto_resume_max_attempts`
 * times, after which it stops for good and says so clearly (status/log/`lazy
 * show`). Across ALL tasks project-wide, at most one task is retried per
 * `daemon.auto_resume_gap_minutes` — round-robin, oldest attempt first — so one
 * flapping task can never starve every other queued task. `daemon.auto_resume`
 * is the master switch for both lanes.
 *
 * Per-task attempt count/timestamp/exhausted flag live in task metadata (same
 * pattern as src/daemon/auto-react-budget.ts's per-task counters). The
 * project-wide last-attempt timestamp lives in a small JSON file in the
 * project's data dir, mirroring that same module's daily-budget file.
 *
 * All time-dependent logic here takes `now` as an explicit parameter rather
 * than calling Date.now() itself, so tests can exercise interval/gap/attempt
 * arithmetic deterministically without real sleeps.
 */

import { join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import type { Storage } from '../storage';
import type { ResolvedConfig } from '../config/types';
import type { Task } from '../types';
import { logger } from '../utils/logger';
import { shortId } from '../cli/helpers';
import { autoResumeTask, MAX_CONSECUTIVE_INTERRUPTIONS } from '../utils/auto-resume';
import { effectiveAgentLimit, tryAdmitAgentSlot, releaseAgentSlot } from './concurrency';

// --- Per-task slow-lane state (task metadata) ---

const SLOW_LANE_ATTEMPTS_KEY = 'slow_lane_attempts';
const SLOW_LANE_LAST_ATTEMPT_KEY = 'slow_lane_last_attempt_at';
const SLOW_LANE_EXHAUSTED_KEY = 'slow_lane_exhausted';

export interface SlowLaneState {
  attempts: number;
  /** Epoch milliseconds of the last slow-lane attempt, or null if never attempted. */
  lastAttemptAt: number | null;
  /** True once attempts reached daemon.auto_resume_max_attempts — retries stop for good. */
  exhausted: boolean;
}

/** Read a task's current slow-lane state. */
export async function getSlowLaneState(storage: Storage, taskId: string): Promise<SlowLaneState> {
  const [attemptsRaw, lastRaw, exhaustedRaw] = await Promise.all([
    storage.getTaskMetadata(taskId, SLOW_LANE_ATTEMPTS_KEY),
    storage.getTaskMetadata(taskId, SLOW_LANE_LAST_ATTEMPT_KEY),
    storage.getTaskMetadata(taskId, SLOW_LANE_EXHAUSTED_KEY),
  ]);
  return {
    attempts: attemptsRaw ? parseInt(attemptsRaw, 10) || 0 : 0,
    lastAttemptAt: lastRaw ? parseInt(lastRaw, 10) || null : null,
    exhausted: exhaustedRaw === '1',
  };
}

/**
 * Record a slow-lane attempt: bump the count, stamp the timestamp, and mark
 * exhausted once the configured max is reached. Returns the resulting state.
 */
export async function recordSlowLaneAttempt(
  storage: Storage,
  taskId: string,
  now: number,
  maxAttempts: number,
): Promise<SlowLaneState> {
  const current = await getSlowLaneState(storage, taskId);
  const attempts = current.attempts + 1;
  const exhausted = attempts >= maxAttempts;
  await storage.updateTaskMetadata(taskId, SLOW_LANE_ATTEMPTS_KEY, String(attempts));
  await storage.updateTaskMetadata(taskId, SLOW_LANE_LAST_ATTEMPT_KEY, String(now));
  if (exhausted) {
    await storage.updateTaskMetadata(taskId, SLOW_LANE_EXHAUSTED_KEY, '1');
  }
  return { attempts, lastAttemptAt: now, exhausted };
}

/**
 * Clear a task's slow-lane state. Called wherever a task gets a fresh chance
 * (a successful turn, a daemon-restart recovery, a completed sync) alongside
 * the existing resetConsecutiveInterruptions() call — the task earned its way
 * back out of the slow lane the same way it earned its way out of the fast-lane
 * circuit breaker.
 */
export async function resetSlowLaneState(storage: Storage, taskId: string): Promise<void> {
  await storage.updateTaskMetadata(taskId, SLOW_LANE_ATTEMPTS_KEY, '');
  await storage.updateTaskMetadata(taskId, SLOW_LANE_LAST_ATTEMPT_KEY, '');
  await storage.updateTaskMetadata(taskId, SLOW_LANE_EXHAUSTED_KEY, '');
}

// --- Project-wide round-robin gap state (file) ---

interface AutoResumeQueueFileState {
  /** Epoch milliseconds of the last slow-lane attempt, project-wide. */
  lastAutoResumeAt: number | null;
}

function getQueueFilePath(dataDir: string): string {
  return join(dataDir, 'auto-resume-queue.json');
}

/** Read the project-wide last-slow-lane-attempt timestamp. Null if never attempted. */
export async function getLastProjectAutoResumeAt(dataDir: string): Promise<number | null> {
  try {
    const raw = await readFile(getQueueFilePath(dataDir), 'utf-8');
    const state: AutoResumeQueueFileState = JSON.parse(raw);
    return state.lastAutoResumeAt ?? null;
  } catch {
    // File doesn't exist or is corrupted — treat as never attempted
    return null;
  }
}

/**
 * Stamp the project-wide last-auto-resume timestamp. Shared by BOTH lanes: the
 * fast lane (src/utils/reconcile.ts's maybeAutoResume) and the slow lane
 * (processAutoResumeQueue below) call this after every attempt, so the
 * project-wide gap holds regardless of which lane resumed a task. Without
 * this, a burst of simultaneous fast-lane crashes (e.g. many tasks hitting a
 * shared token-exhaustion error at once) would relaunch all of them
 * immediately — exactly the pile-up the gap exists to prevent — and only
 * throttle once they'd already fallen to the slow lane.
 */
export async function recordProjectAutoResume(dataDir: string, now: number): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const state: AutoResumeQueueFileState = { lastAutoResumeAt: now };
  await writeFile(getQueueFilePath(dataDir), JSON.stringify(state, null, 2) + '\n');
}

// --- Queue listing (read-only, for `lazy daemon resume-queue` / `lazy show` / `lazy list`) ---

export interface AutoResumeQueueEntry {
  task: Task;
  attempts: number;
  maxAttempts: number;
  /** Epoch milliseconds of the last slow-lane attempt, or null if never attempted. */
  lastAttemptAt: number | null;
  /** Epoch milliseconds this task becomes eligible again (interval elapsed). */
  intervalEligibleAt: number;
}

/**
 * A task is user_stopped-gated the same way maybeAutoResume() gates the fast
 * lane — mirrored here (not imported from src/utils/reconcile.ts) to avoid a
 * circular import, since reconcile.ts calls back into this module's resets.
 */
function isUserStopped(session: { user_stopped?: boolean }): boolean {
  return session.user_stopped === true;
}

/**
 * List every task currently in (or waiting to enter) the slow lane, in
 * round-robin order: oldest last-attempt first, never-attempted tasks first
 * of all. Read-only — no side effects, safe to call from CLI/RPC handlers.
 */
export async function listSlowLaneQueue(
  storage: Storage,
  config: ResolvedConfig,
  now: number,
): Promise<AutoResumeQueueEntry[]> {
  const tasks = await storage.listTasks();
  const intervalMs = config.daemon.auto_resume_interval_minutes * 60_000;
  const entries: AutoResumeQueueEntry[] = [];

  for (const task of tasks) {
    if (task.status !== 'interrupted') continue;
    const session = await storage.getSessionByTaskId(task.id);
    if (!session || session.ended_at) continue;
    if (session.consecutive_interruptions < MAX_CONSECUTIVE_INTERRUPTIONS) continue;
    if (isUserStopped(session)) continue;

    const state = await getSlowLaneState(storage, task.id);
    if (state.exhausted) continue;

    // A task that hasn't been slow-lane-attempted yet still owes a full
    // interval before its first retry, counted from when it ENTERED the
    // queue (the interruption that tripped the circuit breaker), not from
    // whenever this listing happens to run — otherwise a task could sit in
    // the queue for most of the interval and then retry seconds after being
    // listed, defeating "retried every N minutes".
    const enteredQueueAt = session.interrupt_at ?? now;
    entries.push({
      task,
      attempts: state.attempts,
      maxAttempts: config.daemon.auto_resume_max_attempts,
      lastAttemptAt: state.lastAttemptAt,
      intervalEligibleAt: state.lastAttemptAt === null ? enteredQueueAt + intervalMs : state.lastAttemptAt + intervalMs,
    });
  }

  entries.sort((a, b) => (a.lastAttemptAt ?? -1) - (b.lastAttemptAt ?? -1));
  return entries;
}

// --- The tick: process at most one slow-lane resume ---

export interface AutoResumeQueueTickResult {
  /** True if a resume attempt was made this tick (whether it succeeded or not). */
  attempted: boolean;
  taskId?: string;
  success?: boolean;
  /** True if this attempt exhausted the task's slow-lane budget. */
  exhausted?: boolean;
}

/**
 * Process at most one slow-lane resume this tick, respecting the master
 * switch, the project-wide gap, and the per-task interval/attempt cap.
 * Intended to be called once per reconcile tick from src/daemon/server.ts,
 * the same way the existing runAutoReact phase is.
 */
export async function processAutoResumeQueue(
  storage: Storage,
  lazyRoot: string,
  config: ResolvedConfig,
  dataDir: string,
  now: number,
): Promise<AutoResumeQueueTickResult> {
  if (!config.daemon.auto_resume) return { attempted: false };

  const gapMs = config.daemon.auto_resume_gap_minutes * 60_000;
  const lastProjectAttempt = await getLastProjectAutoResumeAt(dataDir);
  if (lastProjectAttempt !== null && now - lastProjectAttempt < gapMs) {
    return { attempted: false };
  }

  const queue = await listSlowLaneQueue(storage, config, now);
  const candidate = queue.find(entry => entry.intervalEligibleAt <= now);
  if (!candidate) return { attempted: false };

  const { task } = candidate;
  const taskShortId = shortId(task.id);
  const session = await storage.getSessionByTaskId(task.id);
  if (!session) return { attempted: false };

  let slotAdmitted = false;
  try {
    const decision = await tryAdmitAgentSlot(storage, task.id, effectiveAgentLimit(config));
    if (!decision.admitted) {
      logger.debug(`Task ${taskShortId}: at agent cap (${decision.running}/${decision.limit}), deferring slow-lane resume`);
      return { attempted: false };
    }
    slotAdmitted = true;
  } catch (err) {
    logger.debug(`Task ${taskShortId}: agent cap check failed (proceeding): ${err instanceof Error ? err.message : err}`);
  }

  let success = false;
  try {
    success = await autoResumeTask(storage, task, session, lazyRoot);
  } catch (err) {
    logger.warn(`Task ${taskShortId}: slow-lane resume error: ${err instanceof Error ? err.message : err}`);
  } finally {
    if (slotAdmitted) releaseAgentSlot(task.id);
  }

  // Record the attempt (and consume the round-robin gap) regardless of
  // success — a failed attempt still cost a container launch and should not
  // let the same task retry again before the gap elapses.
  const slowLaneState = await recordSlowLaneAttempt(storage, task.id, now, config.daemon.auto_resume_max_attempts);
  await recordProjectAutoResume(dataDir, now);

  if (success) {
    logger.info(`Task ${taskShortId}: slow-lane auto-resume succeeded (attempt ${slowLaneState.attempts}/${slowLaneState.exhausted ? slowLaneState.attempts : config.daemon.auto_resume_max_attempts})`);
  } else if (slowLaneState.exhausted) {
    logger.warn(
      `Task ${taskShortId}: slow-lane auto-resume exhausted after ${slowLaneState.attempts}/${config.daemon.auto_resume_max_attempts} attempts. ` +
      `Giving up — resume manually with 'lazy resume ${taskShortId}' (config key: daemon.auto_resume_max_attempts).`,
    );
  } else {
    logger.debug(`Task ${taskShortId}: slow-lane auto-resume attempt ${slowLaneState.attempts}/${config.daemon.auto_resume_max_attempts} failed, will retry`);
  }

  return { attempted: true, taskId: task.id, success, exhausted: slowLaneState.exhausted };
}
