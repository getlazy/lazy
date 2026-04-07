/**
 * Auto-react budget controls — prevent runaway costs from auto-triggered agent turns.
 *
 * Provides:
 * 1. Per-task counters by trigger type (ci_failure, upstream_sync, comment, child_completed, crash)
 * 2. Per-task consecutive auto-turn budget (max N auto-triggered turns without human intervention)
 * 3. Exponential backoff between repeated auto-unblocks of the same type
 * 4. Global daily budget limiting total auto-triggered turns per project
 *
 * Counters are stored as task metadata (via Storage.updateTaskMetadata).
 * The global daily budget is stored as a file in the project's data directory.
 *
 * All counters reset when:
 * - A human manually unblocks the task
 * - The task reaches a terminal state (accepted/rejected/closed)
 */

import { join } from 'path';
import { stat, readFile, writeFile, mkdir } from 'fs/promises';
import type { Storage } from '../storage';
import type { ResolvedConfig } from '../config/types';
import { logger } from '../utils/logger';

/** Trigger types that can cause auto-unblocks. */
export type AutoReactTrigger = 'ci_failure' | 'upstream_sync' | 'comment' | 'child_completed' | 'crash';

/** Metadata key prefix for per-task auto-react counters. */
const COUNTER_PREFIX = 'auto_react_count_';

/** Metadata key prefix for per-task last auto-react timestamps. */
const TIMESTAMP_PREFIX = 'auto_react_last_';

/** Metadata key for the auto-react paused flag. */
const PAUSED_KEY = 'auto_react_paused';

/** Metadata key for the auto-react paused reason. */
const PAUSED_REASON_KEY = 'auto_react_paused_reason';

// --- Per-task counters ---

/**
 * Get the auto-react counter for a specific trigger type on a task.
 */
export async function getAutoReactCount(storage: Storage, taskId: string, trigger: AutoReactTrigger): Promise<number> {
  const value = await storage.getTaskMetadata(taskId, `${COUNTER_PREFIX}${trigger}`);
  return value ? parseInt(value, 10) || 0 : 0;
}

/**
 * Increment the auto-react counter for a specific trigger type.
 * Also records the timestamp of this auto-react.
 * Returns the new count.
 */
export async function incrementAutoReactCount(
  storage: Storage,
  taskId: string,
  trigger: AutoReactTrigger,
): Promise<number> {
  const current = await getAutoReactCount(storage, taskId, trigger);
  const newCount = current + 1;
  await storage.updateTaskMetadata(taskId, `${COUNTER_PREFIX}${trigger}`, String(newCount));
  await storage.updateTaskMetadata(taskId, `${TIMESTAMP_PREFIX}${trigger}`, String(Date.now()));
  return newCount;
}

/**
 * Get the timestamp of the last auto-react for a trigger type.
 */
export async function getLastAutoReactTimestamp(
  storage: Storage,
  taskId: string,
  trigger: AutoReactTrigger,
): Promise<number | null> {
  const value = await storage.getTaskMetadata(taskId, `${TIMESTAMP_PREFIX}${trigger}`);
  return value ? parseInt(value, 10) || null : null;
}

/**
 * Reset all auto-react counters and timestamps for a task.
 * Called when a human manually unblocks or the task reaches a terminal state.
 */
export async function resetAutoReactCounters(storage: Storage, taskId: string): Promise<void> {
  const triggers: AutoReactTrigger[] = ['ci_failure', 'upstream_sync', 'comment', 'child_completed', 'crash'];
  for (const trigger of triggers) {
    await storage.updateTaskMetadata(taskId, `${COUNTER_PREFIX}${trigger}`, '');
    await storage.updateTaskMetadata(taskId, `${TIMESTAMP_PREFIX}${trigger}`, '');
  }
  await storage.updateTaskMetadata(taskId, PAUSED_KEY, '');
  await storage.updateTaskMetadata(taskId, PAUSED_REASON_KEY, '');
  // Also reset the consecutive auto-turn counter
  await resetConsecutiveAutoTurns(storage, taskId);
}

/**
 * Mark a task as paused for auto-react (limit reached).
 */
export async function pauseAutoReact(
  storage: Storage,
  taskId: string,
  reason: string,
): Promise<void> {
  await storage.updateTaskMetadata(taskId, PAUSED_KEY, 'true');
  await storage.updateTaskMetadata(taskId, PAUSED_REASON_KEY, reason);
}

/**
 * Check if a task's auto-react is paused.
 */
export async function isAutoReactPaused(storage: Storage, taskId: string): Promise<boolean> {
  const value = await storage.getTaskMetadata(taskId, PAUSED_KEY);
  return value === 'true';
}

/**
 * Get the auto-react paused reason for a task.
 */
export async function getAutoReactPausedReason(storage: Storage, taskId: string): Promise<string | null> {
  const value = await storage.getTaskMetadata(taskId, PAUSED_REASON_KEY);
  return value || null;
}

// --- Backoff calculation ---

/**
 * Backoff delays in milliseconds for each attempt.
 * Index 0 = 1st auto-unblock, index 1 = 2nd, etc.
 */
const EXPONENTIAL_DELAYS_MS = [
  0,         // 1st: immediate
  60_000,    // 2nd: 1 minute
  300_000,   // 3rd: 5 minutes
];

const LINEAR_DELAYS_MS = [
  0,         // 1st: immediate
  60_000,    // 2nd: 1 minute
  120_000,   // 3rd: 2 minutes
];

/**
 * Calculate the required delay before the next auto-react of this type.
 * Returns 0 if no delay is needed, or the delay in ms.
 */
export function calculateBackoffDelay(
  backoffStrategy: 'none' | 'linear' | 'exponential',
  currentCount: number,
): number {
  if (backoffStrategy === 'none' || currentCount <= 0) return 0;

  const delays = backoffStrategy === 'exponential' ? EXPONENTIAL_DELAYS_MS : LINEAR_DELAYS_MS;
  const index = Math.min(currentCount, delays.length - 1);
  return delays[index];
}

/**
 * Check if enough time has elapsed since the last auto-react to satisfy backoff.
 * Returns { allowed: true } if the auto-react can proceed, or
 * { allowed: false, remainingMs } if it must wait.
 */
export async function checkBackoff(
  storage: Storage,
  taskId: string,
  trigger: AutoReactTrigger,
  backoffStrategy: 'none' | 'linear' | 'exponential',
): Promise<{ allowed: boolean; remainingMs: number }> {
  const count = await getAutoReactCount(storage, taskId, trigger);
  const requiredDelay = calculateBackoffDelay(backoffStrategy, count);

  if (requiredDelay === 0) {
    return { allowed: true, remainingMs: 0 };
  }

  const lastTimestamp = await getLastAutoReactTimestamp(storage, taskId, trigger);
  if (!lastTimestamp) {
    return { allowed: true, remainingMs: 0 };
  }

  const elapsed = Date.now() - lastTimestamp;
  if (elapsed >= requiredDelay) {
    return { allowed: true, remainingMs: 0 };
  }

  return { allowed: false, remainingMs: requiredDelay - elapsed };
}

// --- Global daily budget ---

/** Shape of the daily budget file. */
interface DailyBudgetState {
  /** ISO date string (YYYY-MM-DD) for the current budget period. */
  date: string;
  /** Number of auto-triggered turns used today. */
  used: number;
}

/**
 * Get the path to the daily budget file for a project.
 */
function getBudgetFilePath(dataDir: string): string {
  return join(dataDir, 'auto-react-budget.json');
}

/**
 * Read the current daily budget state. Resets if the date has changed.
 */
export async function readDailyBudget(dataDir: string): Promise<DailyBudgetState> {
  const filePath = getBudgetFilePath(dataDir);
  const today = new Date().toISOString().split('T')[0];

  try {
    await stat(filePath);
    const raw = await readFile(filePath, 'utf-8');
    const state: DailyBudgetState = JSON.parse(raw);
    if (state.date === today) {
      return state;
    }
  } catch {
    // File doesn't exist or is corrupted — reset
  }

  return { date: today, used: 0 };
}

/**
 * Increment the daily budget usage by 1. Returns the new count.
 */
export async function incrementDailyBudget(dataDir: string): Promise<number> {
  const state = await readDailyBudget(dataDir);
  state.used += 1;
  const filePath = getBudgetFilePath(dataDir);
  await mkdir(dataDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2) + '\n');
  return state.used;
}

/**
 * Check if the daily budget allows another auto-triggered turn.
 */
export async function isDailyBudgetExhausted(dataDir: string, limit: number): Promise<boolean> {
  const state = await readDailyBudget(dataDir);
  return state.used >= limit;
}

// --- Global pause ---

/** Shape of the global pause file. */
interface GlobalPauseState {
  /** Whether auto-react is globally paused. */
  paused: boolean;
  /** ISO timestamp of when the pause was set. */
  paused_at?: string;
  /** Reason for the pause. */
  reason?: string;
}

/**
 * Get the path to the global pause file for a project.
 */
function getGlobalPauseFilePath(dataDir: string): string {
  return join(dataDir, 'auto-react-paused.json');
}

/**
 * Check if auto-react is globally paused for this project.
 */
export async function isGlobalAutoReactPaused(dataDir: string): Promise<{ paused: boolean; reason?: string }> {
  const filePath = getGlobalPauseFilePath(dataDir);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const state: GlobalPauseState = JSON.parse(raw);
    if (state.paused) {
      return { paused: true, reason: state.reason };
    }
  } catch {
    // File doesn't exist or is corrupted — not paused
  }
  return { paused: false };
}

/**
 * Set the global auto-react pause state.
 */
export async function setGlobalAutoReactPaused(dataDir: string, paused: boolean, reason?: string): Promise<void> {
  const filePath = getGlobalPauseFilePath(dataDir);
  await mkdir(dataDir, { recursive: true });
  const state: GlobalPauseState = {
    paused,
    ...(paused ? { paused_at: new Date().toISOString(), reason } : {}),
  };
  await writeFile(filePath, JSON.stringify(state, null, 2) + '\n');
}

// --- Per-task consecutive auto-turn budget ---

/** Metadata key for consecutive auto-turn count. */
const CONSECUTIVE_AUTO_TURNS_KEY = 'consecutive_auto_turns';

/**
 * Get the consecutive auto-triggered turn count for a task.
 */
export async function getConsecutiveAutoTurns(storage: Storage, taskId: string): Promise<number> {
  const value = await storage.getTaskMetadata(taskId, CONSECUTIVE_AUTO_TURNS_KEY);
  return value ? parseInt(value, 10) || 0 : 0;
}

/**
 * Increment the consecutive auto-triggered turn count.
 * Returns the new count.
 */
export async function incrementConsecutiveAutoTurns(storage: Storage, taskId: string): Promise<number> {
  const current = await getConsecutiveAutoTurns(storage, taskId);
  const newCount = current + 1;
  await storage.updateTaskMetadata(taskId, CONSECUTIVE_AUTO_TURNS_KEY, String(newCount));
  return newCount;
}

/**
 * Reset the consecutive auto-triggered turn count.
 * Called when a human or builder manually unblocks/provides feedback.
 */
export async function resetConsecutiveAutoTurns(storage: Storage, taskId: string): Promise<void> {
  await storage.updateTaskMetadata(taskId, CONSECUTIVE_AUTO_TURNS_KEY, '');
}

/**
 * Check if the per-task consecutive auto-turn budget allows another auto-triggered turn.
 * Returns { allowed: true } if the turn can proceed, or
 * { allowed: false, reason, count } if the budget is exhausted.
 */
export async function checkAutoTurnBudget(
  storage: Storage,
  taskId: string,
  maxAutoTurns: number,
): Promise<{ allowed: boolean; reason?: string; count?: number }> {
  const count = await getConsecutiveAutoTurns(storage, taskId);
  if (count >= maxAutoTurns) {
    const reason = `Auto-turn budget exhausted (${count}/${maxAutoTurns}). Waiting for human review.`;
    return { allowed: false, reason, count };
  }
  return { allowed: true, count };
}

// --- Combined gate: should an auto-react be allowed? ---

export interface AutoReactDecision {
  allowed: boolean;
  reason?: string;
  /** Remaining backoff delay in ms (only set when blocked by backoff). */
  backoffRemainingMs?: number;
}

/**
 * Check all auto-react gates for a task + trigger combination.
 * Returns whether the auto-react should proceed and why not if blocked.
 *
 * Gates checked in order:
 * 0. Global auto-react is not paused
 * 1. Task is not already paused
 * 2. Per-task consecutive auto-turn budget not exhausted
 * 3. Daily budget is not exhausted
 * 4. Per-task per-trigger count hasn't hit the limit
 * 5. Backoff delay has elapsed
 */
export async function shouldAutoReact(
  storage: Storage,
  taskId: string,
  trigger: AutoReactTrigger,
  config: ResolvedConfig,
  dataDir: string,
): Promise<AutoReactDecision> {
  const taskShortId = taskId.substring(0, 8);
  const { auto_react_max_retries, auto_react_backoff, auto_react_daily_budget, max_auto_turns } = config.daemon;

  // Gate 0: global pause
  const globalPause = await isGlobalAutoReactPaused(dataDir);
  if (globalPause.paused) {
    return { allowed: false, reason: globalPause.reason || 'Auto-react globally paused' };
  }

  // Gate 1: task already paused
  if (await isAutoReactPaused(storage, taskId)) {
    const reason = await getAutoReactPausedReason(storage, taskId);
    return { allowed: false, reason: reason || 'Auto-react paused' };
  }

  // Gate 2: per-task consecutive auto-turn budget
  const autoTurnCheck = await checkAutoTurnBudget(storage, taskId, max_auto_turns);
  if (!autoTurnCheck.allowed) {
    await pauseAutoReact(storage, taskId, autoTurnCheck.reason!);
    logger.warn(`Task ${taskShortId}: ${autoTurnCheck.reason}`);
    return { allowed: false, reason: autoTurnCheck.reason };
  }

  // Gate 3: global daily budget
  if (await isDailyBudgetExhausted(dataDir, auto_react_daily_budget)) {
    const budget = await readDailyBudget(dataDir);
    logger.warn(`Auto-react budget exhausted: ${budget.used}/${auto_react_daily_budget} turns used today`);
    return { allowed: false, reason: `Daily auto-react budget exhausted (${budget.used}/${auto_react_daily_budget})` };
  }

  // Gate 4: per-task per-trigger limit
  const count = await getAutoReactCount(storage, taskId, trigger);
  if (count >= auto_react_max_retries) {
    const reason = `Auto-react paused: ${count} ${trigger.replace('_', ' ')} retries exhausted`;
    await pauseAutoReact(storage, taskId, reason);
    logger.warn(`Task ${taskShortId}: ${reason}`);
    return { allowed: false, reason };
  }

  // Gate 5: backoff delay
  const backoff = await checkBackoff(storage, taskId, trigger, auto_react_backoff);
  if (!backoff.allowed) {
    const secs = Math.ceil(backoff.remainingMs / 1000);
    logger.debug(`Task ${taskShortId}: backoff not elapsed, ${secs}s remaining for ${trigger}`);
    return { allowed: false, reason: `Backoff: ${secs}s remaining`, backoffRemainingMs: backoff.remainingMs };
  }

  return { allowed: true };
}

/**
 * Record that an auto-react was consumed (counter incremented + daily budget used).
 * Call this AFTER the auto-react has been successfully initiated.
 */
export async function recordAutoReact(
  storage: Storage,
  taskId: string,
  trigger: AutoReactTrigger,
  dataDir: string,
): Promise<void> {
  await incrementAutoReactCount(storage, taskId, trigger);
  await incrementDailyBudget(dataDir);
  await incrementConsecutiveAutoTurns(storage, taskId);
}

/**
 * Get a summary of auto-react status for a task, suitable for display.
 */
export async function getAutoReactSummary(
  storage: Storage,
  taskId: string,
): Promise<{ paused: boolean; reason: string | null; counts: Record<AutoReactTrigger, number>; consecutiveAutoTurns: number }> {
  const triggers: AutoReactTrigger[] = ['ci_failure', 'upstream_sync', 'comment', 'child_completed', 'crash'];
  const counts = {} as Record<AutoReactTrigger, number>;

  for (const trigger of triggers) {
    counts[trigger] = await getAutoReactCount(storage, taskId, trigger);
  }

  const paused = await isAutoReactPaused(storage, taskId);
  const reason = paused ? await getAutoReactPausedReason(storage, taskId) : null;
  const consecutiveAutoTurns = await getConsecutiveAutoTurns(storage, taskId);

  return { paused, reason, counts, consecutiveAutoTurns };
}
