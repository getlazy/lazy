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
import { localDayKey, nextLocalMidnight } from '../utils/local-day';

/**
 * Trigger types that can cause auto-unblocks.
 *
 * ONE list, exported, because the enumeration was written out by hand in three
 * places (counter reset, `lazy status`, the budget report) and a trigger added
 * to the union but missed in one of them is a counter that never resets and a
 * report that silently omits a turn class.
 *
 * `child_added` is cluster-only — see src/daemon/cluster-restart.ts.
 *
 * `auto_review` is the daemon-dispatched review after a task's final
 * declaration (final-turn design §8): one dispatch consumes one daily-budget
 * turn exactly like every other daemon-started turn.
 */
export const AUTO_REACT_TRIGGERS = [
  'ci_failure',
  'upstream_sync',
  'comment',
  'child_completed',
  'child_added',
  'crash',
  'auto_review',
] as const;

export type AutoReactTrigger = (typeof AUTO_REACT_TRIGGERS)[number];

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
  const triggers: readonly AutoReactTrigger[] = AUTO_REACT_TRIGGERS;
  for (const trigger of triggers) {
    await storage.updateTaskMetadata(taskId, `${COUNTER_PREFIX}${trigger}`, '');
    await storage.updateTaskMetadata(taskId, `${TIMESTAMP_PREFIX}${trigger}`, '');
  }
  // The auto-review round counter rides every reset site, so a human taking
  // over (or crash recovery re-arming the task) starts a fresh review cycle.
  await resetFinalReviewRound(storage, taskId);
  await storage.updateTaskMetadata(taskId, PAUSED_KEY, '');
  await storage.updateTaskMetadata(taskId, PAUSED_REASON_KEY, '');
  // Also reset the consecutive auto-turn counter
  await resetConsecutiveAutoTurns(storage, taskId);
}

// --- Auto-review round counter (final-turn design §8.1) ---

/**
 * Metadata key counting COMPLETED auto-review rounds that filed at least one
 * non-blocking Raise.
 *
 * INVARIANT (final-turn §8.1, review-round-cap): an auto-review cycle gets two
 * rounds, then parks the task with its Raises outstanding for a person — the
 * round counter is what makes the third "final → review → fix" turn
 * never fire. It governs NON-blocking findings only: a blocking finding ends
 * the rounds on the first one without touching this counter, because no
 * auto-fix turn can clear it by working harder (the accept gate's
 * `review-issues-unaddressed` keeps holding until a human decides).
 *
 * Unlike the per-trigger auto-react counters above, this one also resets when
 * an AGENT intervenes: for a cluster's child the cluster is "the human" (§8.2),
 * and the cluster hands a capped child back by unblocking it over MCP with actor
 * `agent` — which must start a fresh cycle. Only a daemon round's own
 * auto-fix (actor `system`) leaves it standing.
 */
export const FINAL_REVIEW_ROUND_KEY = 'final_review_round';

/** How many review rounds an auto-review cycle gets before it parks. */
export const FINAL_REVIEW_CAP = 2;

/** Get the completed auto-review round count for a task (0 when unset). */
export async function getFinalReviewRound(storage: Storage, taskId: string): Promise<number> {
  const value = await storage.getTaskMetadata(taskId, FINAL_REVIEW_ROUND_KEY);
  return value ? parseInt(value, 10) || 0 : 0;
}

/**
 * Count one more completed auto-review round that filed Raises.
 * Returns the new count.
 */
export async function incrementFinalReviewRound(storage: Storage, taskId: string): Promise<number> {
  const next = (await getFinalReviewRound(storage, taskId)) + 1;
  await storage.updateTaskMetadata(taskId, FINAL_REVIEW_ROUND_KEY, String(next));
  return next;
}

/**
 * Reset the auto-review round counter — a fresh cycle is owed.
 * Best-effort at every call site; see the callers for why.
 */
export async function resetFinalReviewRound(storage: Storage, taskId: string): Promise<void> {
  await storage.updateTaskMetadata(taskId, FINAL_REVIEW_ROUND_KEY, '');
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

/**
 * A single budget-consuming auto-react, recorded for the `auto-budget list`
 * activity log. Resets with the day (lives inside the daily-budget file).
 */
export interface AutoReactLogEntry {
  /** Epoch milliseconds when the turn was consumed. */
  ts: number;
  /** Short task id (first 8 chars of the full id). */
  taskId: string;
  /** Task code, if the task had one. */
  taskCode?: string;
  /** What triggered the auto-react. */
  trigger: AutoReactTrigger;
}

/** Shape of the daily budget file. */
interface DailyBudgetState {
  /** Local-day key (YYYY-MM-DD) for the current budget period. */
  date: string;
  /** Number of auto-triggered turns used today. */
  used: number;
  /**
   * Today-only effective cap, set via `lazy daemon auto-budget update`.
   * Absolute value (not a delta). Ephemeral — cleared when the day rolls over.
   * When unset, the effective cap is the configured `auto_react_daily_budget`.
   */
  capOverride?: number;
  /** Activity log of what consumed budget today. */
  log?: AutoReactLogEntry[];
}

/**
 * Get the path to the daily budget file for a project.
 */
function getBudgetFilePath(dataDir: string): string {
  return join(dataDir, 'auto-react-budget.json');
}

/**
 * Read the current daily budget state. Resets if the local day has changed.
 *
 * "Today" is the machine's LOCAL calendar day (see src/utils/local-day.ts),
 * not UTC — the budget rolls over at local midnight.
 */
export async function readDailyBudget(dataDir: string): Promise<DailyBudgetState> {
  const filePath = getBudgetFilePath(dataDir);
  const today = localDayKey();

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
 * Persist the daily budget state.
 */
async function writeDailyBudget(dataDir: string, state: DailyBudgetState): Promise<void> {
  const filePath = getBudgetFilePath(dataDir);
  await mkdir(dataDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Increment the daily budget usage by 1. Returns the new count.
 * Optionally appends an activity-log entry describing what was consumed.
 */
export async function incrementDailyBudget(dataDir: string, entry?: Omit<AutoReactLogEntry, 'ts'>): Promise<number> {
  const state = await readDailyBudget(dataDir);
  state.used += 1;
  if (entry) {
    state.log = state.log ?? [];
    state.log.push({ ts: Date.now(), ...entry });
  }
  await writeDailyBudget(dataDir, state);
  return state.used;
}

/**
 * Resolve the effective daily cap for today: the today-only override if set,
 * otherwise the configured limit.
 */
export function effectiveDailyLimit(state: DailyBudgetState, configuredLimit: number): number {
  return state.capOverride ?? configuredLimit;
}

/**
 * Adjust today's effective cap. `delta` is one of:
 *   { kind: 'absolute', value }  — set the cap to an exact number (`=100`)
 *   { kind: 'relative', value }  — add/subtract from the current effective cap (`+50`, `-20`)
 *
 * The override is ephemeral (resets at local midnight) and is NOT written to
 * lazy.toml — permanent changes remain the job of `auto_react_daily_budget`.
 * Returns the new effective cap (floored at 0).
 */
export async function adjustDailyCap(
  dataDir: string,
  configuredLimit: number,
  delta: { kind: 'absolute' | 'relative'; value: number },
): Promise<number> {
  const state = await readDailyBudget(dataDir);
  const current = effectiveDailyLimit(state, configuredLimit);
  const next = delta.kind === 'absolute' ? delta.value : current + delta.value;
  state.capOverride = Math.max(0, next);
  await writeDailyBudget(dataDir, state);
  return state.capOverride;
}

/**
 * Check if the daily budget allows another auto-triggered turn.
 * Respects a today-only cap override when present.
 */
export async function isDailyBudgetExhausted(dataDir: string, limit: number): Promise<boolean> {
  const state = await readDailyBudget(dataDir);
  return state.used >= effectiveDailyLimit(state, limit);
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
  /**
   * Epoch milliseconds when the pause auto-expires. When omitted, the pause is
   * indefinite (the legacy `lazy config set auto_react off` behavior). The
   * `lazy daemon auto-budget pause` command defaults this to next local midnight.
   */
  expires_at?: number;
}

/** Resolved global-pause status, including any expiry. */
export interface GlobalPauseStatus {
  paused: boolean;
  reason?: string;
  /** Epoch milliseconds when the pause auto-expires, if bounded. */
  expiresAt?: number;
}

/**
 * Get the path to the global pause file for a project.
 */
function getGlobalPauseFilePath(dataDir: string): string {
  return join(dataDir, 'auto-react-paused.json');
}

/**
 * Check if auto-react is globally paused for this project.
 *
 * An expired pause (expires_at in the past) is treated as NOT paused, and the
 * stale file is cleared so the daemon auto-resumes cleanly without a manual
 * `resume`. This is the single check point the gate, status, and subcommands
 * all share.
 */
export async function isGlobalAutoReactPaused(dataDir: string): Promise<GlobalPauseStatus> {
  const filePath = getGlobalPauseFilePath(dataDir);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const state: GlobalPauseState = JSON.parse(raw);
    if (state.paused) {
      if (state.expires_at !== undefined && Date.now() >= state.expires_at) {
        // Pause window elapsed — auto-resume by clearing the stale state.
        await setGlobalAutoReactPaused(dataDir, false);
        return { paused: false };
      }
      return { paused: true, reason: state.reason, expiresAt: state.expires_at };
    }
  } catch {
    // File doesn't exist or is corrupted — not paused
  }
  return { paused: false };
}

/**
 * Set the global auto-react pause state.
 *
 * @param expiresAt Epoch milliseconds when the pause should auto-expire. Omit
 *   for an indefinite pause (legacy behavior). Ignored when paused=false.
 */
export async function setGlobalAutoReactPaused(
  dataDir: string,
  paused: boolean,
  reason?: string,
  expiresAt?: number,
): Promise<void> {
  const filePath = getGlobalPauseFilePath(dataDir);
  await mkdir(dataDir, { recursive: true });
  const state: GlobalPauseState = {
    paused,
    ...(paused
      ? { paused_at: new Date().toISOString(), reason, ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}) }
      : {}),
  };
  await writeFile(filePath, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Pause auto-react globally until the next local midnight (auto-resume).
 * Returns the expiry timestamp so callers can display the countdown.
 */
export async function pauseGlobalAutoReactUntilMidnight(dataDir: string, reason?: string): Promise<number> {
  const expiresAt = nextLocalMidnight().getTime();
  await setGlobalAutoReactPaused(dataDir, true, reason, expiresAt);
  return expiresAt;
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

/**
 * WHICH gate refused, as a token rather than as prose.
 *
 * The `reason` string is written for a person to read; a caller that has to
 * BEHAVE differently per gate must not parse it. The auto-review catchup is the
 * caller that needs the distinction: a gate that clears itself within seconds
 * (`backoff`) is invisible bookkeeping, while one that stands until a day rolls
 * over or a person acts leaves a task parked with no review and has to be
 * recorded (`src/daemon/auto-review.ts`). Deriving that from the reason text
 * would put the rule in a sentence anyone is free to reword.
 */
export type AutoReactGate =
  | 'global_pause'
  | 'task_paused'
  | 'auto_turn_budget'
  | 'daily_budget'
  | 'trigger_limit'
  | 'backoff';

export interface AutoReactDecision {
  allowed: boolean;
  reason?: string;
  /** Which gate refused. Absent when `allowed`. */
  gate?: AutoReactGate;
  /** Remaining backoff delay in ms (only set when blocked by backoff). */
  backoffRemainingMs?: number;
  /**
   * The numbers behind a `daily_budget` refusal. Set only on that gate.
   *
   * `effective` is today's cap and `configured` is the lazy.toml value, and the
   * pair is here because they differ in what WAITING buys. A today-only
   * override expires at local midnight and the configured value returns; the
   * configured value itself does not move, so `auto_react_daily_budget = 0`
   * refuses forever — midnight resets `used` to 0, and `0 >= 0` still refuses.
   * A caller that tells an operator whether to wait or to act has to be able to
   * tell those apart (`src/daemon/auto-review.ts`), and the only alternative
   * was parsing them back out of `reason`.
   */
  dailyBudget?: { used: number; effective: number; configured: number };
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
    return {
      allowed: false,
      gate: 'global_pause',
      reason: globalPause.reason || 'Auto-react globally paused',
    };
  }

  // Gate 1: task already paused
  if (await isAutoReactPaused(storage, taskId)) {
    const reason = await getAutoReactPausedReason(storage, taskId);
    return { allowed: false, gate: 'task_paused', reason: reason || 'Auto-react paused' };
  }

  // Gate 2: per-task consecutive auto-turn budget
  const autoTurnCheck = await checkAutoTurnBudget(storage, taskId, max_auto_turns);
  if (!autoTurnCheck.allowed) {
    await pauseAutoReact(storage, taskId, autoTurnCheck.reason!);
    logger.warn(`Task ${taskShortId}: ${autoTurnCheck.reason}`);
    return { allowed: false, gate: 'auto_turn_budget', reason: autoTurnCheck.reason };
  }

  // Gate 3: global daily budget (respects today-only cap override)
  if (await isDailyBudgetExhausted(dataDir, auto_react_daily_budget)) {
    const budget = await readDailyBudget(dataDir);
    const limit = effectiveDailyLimit(budget, auto_react_daily_budget);
    logger.warn(`Auto-react budget exhausted: ${budget.used}/${limit} turns used today`);
    return {
      allowed: false,
      gate: 'daily_budget',
      reason: `Daily auto-react budget exhausted (${budget.used}/${limit})`,
      dailyBudget: {
        used: budget.used,
        effective: limit,
        configured: auto_react_daily_budget,
      },
    };
  }

  // Gate 4: per-task per-trigger limit
  const count = await getAutoReactCount(storage, taskId, trigger);
  if (count >= auto_react_max_retries) {
    const reason = `Auto-react paused: ${count} ${trigger.replace('_', ' ')} retries exhausted`;
    await pauseAutoReact(storage, taskId, reason);
    logger.warn(`Task ${taskShortId}: ${reason}`);
    return { allowed: false, gate: 'trigger_limit', reason };
  }

  // Gate 5: backoff delay
  const backoff = await checkBackoff(storage, taskId, trigger, auto_react_backoff);
  if (!backoff.allowed) {
    const secs = Math.ceil(backoff.remainingMs / 1000);
    logger.debug(`Task ${taskShortId}: backoff not elapsed, ${secs}s remaining for ${trigger}`);
    return {
      allowed: false,
      gate: 'backoff',
      reason: `Backoff: ${secs}s remaining`,
      backoffRemainingMs: backoff.remainingMs,
    };
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

  // Resolve the task code for the activity log (best-effort — a missing task
  // must not block recording the consumption).
  let taskCode: string | undefined;
  try {
    const task = await storage.getTask(taskId);
    taskCode = task?.code ?? undefined;
  } catch {
    // Task lookup failed — log without a code rather than dropping the entry.
  }
  await incrementDailyBudget(dataDir, { taskId: taskId.substring(0, 8), taskCode, trigger });

  await incrementConsecutiveAutoTurns(storage, taskId);
}

/**
 * Get a summary of auto-react status for a task, suitable for display.
 */
export async function getAutoReactSummary(
  storage: Storage,
  taskId: string,
): Promise<{ paused: boolean; reason: string | null; counts: Record<AutoReactTrigger, number>; consecutiveAutoTurns: number }> {
  const triggers: readonly AutoReactTrigger[] = AUTO_REACT_TRIGGERS;
  const counts = {} as Record<AutoReactTrigger, number>;

  for (const trigger of triggers) {
    counts[trigger] = await getAutoReactCount(storage, taskId, trigger);
  }

  const paused = await isAutoReactPaused(storage, taskId);
  const reason = paused ? await getAutoReactPausedReason(storage, taskId) : null;
  const consecutiveAutoTurns = await getConsecutiveAutoTurns(storage, taskId);

  return { paused, reason, counts, consecutiveAutoTurns };
}
