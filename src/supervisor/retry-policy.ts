/**
 * Retry policy — turns an agent failure CLASS into a retry decision.
 *
 * The supervisor consumes only the taxonomy (src/agent/failure-taxonomy.ts);
 * this module is the single place where "what does that class mean for pacing"
 * is decided. It is pure and synchronous so the decisions are unit-testable
 * without running an agent.
 *
 * WHY THE OLD CADENCE WAS WRONG
 * The previous ladder was 30s → 60s → 120s → 240s → 300s(cap), applied to every
 * failure alike. Observed live: 2 attempts in 5+ minutes against a permanently
 * dead credential. Both halves were wrong — the recoverable case waited far too
 * long, and the unrecoverable case never stopped.
 *
 * THE NEW CADENCE
 *   transient (overload / network / unreachable): 5s → 10s → 20s → 40s → 60s cap.
 *     Provider 429/529/503 windows and blips clear in seconds-to-tens-of-seconds,
 *     so starting at 5s recovers a turn in one step instead of half a minute.
 *     The 60s cap keeps a long outage from hammering the provider while still
 *     retrying ~60x/hour instead of ~12x/hour.
 *   unknown: 15s → 30s → 60s cap. Slower on purpose — we don't know what we're
 *     hitting, so we don't hammer it, but it is still 2-4x faster than before.
 *
 * WHAT STOPS
 *   fatal_auth / fatal_config      — immediately. Nothing heals without a human.
 *   transient_unreachable          — after UNREACHABLE_MAX_ATTEMPTS (see below).
 *   transient_overload / _network  — never. These genuinely recover, and a task
 *                                    waiting on a rate limit must not need a
 *                                    human to un-stick it.
 *   unknown                        — never (unchanged from before this policy);
 *                                    the fast-crash-loop detector in work.ts is
 *                                    the backstop for tight crash loops.
 *
 * WATCHDOG KILLS ARE NOT IN THE TAXONOMY
 * A watchdog kill has no error string to classify — it is the supervisor's own
 * verdict on a process that stopped advancing. `decideWatchdogRetry` below is its
 * separate decision, and it turns on whether the killed turn captured anything.
 */

import { isFatalFailureClass, type AgentFailure, type AgentFailureClass } from '../agent/failure-taxonomy';

/** Capped exponential ladder for classes that recover quickly. */
export const TRANSIENT_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000];
export const TRANSIENT_BACKOFF_CAP_MS = 60_000;

/** Slower ladder for failures we could not classify. */
export const UNKNOWN_BACKOFF_MS = [15_000, 30_000];
export const UNKNOWN_BACKOFF_CAP_MS = 60_000;

/**
 * How many times we retry `transient_unreachable` before escalating to fatal.
 *
 * "Nothing is listening" has two very different causes:
 *   - the local audit proxy / daemon is restarting → heals in seconds, retry wins;
 *   - there is no usable credential or endpoint at all → never heals, and this
 *     is exactly the condition that spun forever in the observed incident.
 * We cannot tell them apart from the error, so we retry generously and then
 * stop: 12 attempts on the transient ladder ≈ 9 minutes of trying, which is far
 * longer than any proxy/daemon restart, and finite. After that the task blocks
 * with the reason recorded, so a human sees it instead of a silent spin.
 */
export const UNREACHABLE_MAX_ATTEMPTS = 12;

export type RetryDecision =
  | { action: 'retry'; delayMs: number; reason: string }
  | { action: 'stop'; reason: string };

function ladderDelay(attempt: number, ladder: number[], capMs: number): number {
  // attempt is 1-based: the delay AFTER the 1st failure is ladder[0].
  const idx = attempt - 1;
  return idx < ladder.length ? ladder[idx]! : capMs;
}

/**
 * Decide what to do after a failed agent launch.
 *
 * @param failure  The agent's classification of the failure.
 * @param attempt  1-based count of failures so far in this turn (this one included).
 */
export function decideRetry(failure: AgentFailure, attempt: number): RetryDecision {
  if (isFatalFailureClass(failure.class)) {
    return { action: 'stop', reason: `${failure.class}: ${failure.reason}` };
  }

  if (failure.class === 'transient_unreachable') {
    if (attempt >= UNREACHABLE_MAX_ATTEMPTS) {
      return {
        action: 'stop',
        reason:
          `${failure.class}: ${failure.reason} — still unreachable after ${attempt} attempts ` +
          `(~${Math.round(totalLadderMs(attempt) / 60_000)} min). Treating as unrecoverable.`,
      };
    }
    return {
      action: 'retry',
      delayMs: ladderDelay(attempt, TRANSIENT_BACKOFF_MS, TRANSIENT_BACKOFF_CAP_MS),
      reason: `${failure.class}: ${failure.reason} (attempt ${attempt}/${UNREACHABLE_MAX_ATTEMPTS})`,
    };
  }

  if (failure.class === 'transient_overload' || failure.class === 'transient_network') {
    return {
      action: 'retry',
      delayMs: ladderDelay(attempt, TRANSIENT_BACKOFF_MS, TRANSIENT_BACKOFF_CAP_MS),
      reason: `${failure.class}: ${failure.reason}`,
    };
  }

  return {
    action: 'retry',
    delayMs: ladderDelay(attempt, UNKNOWN_BACKOFF_MS, UNKNOWN_BACKOFF_CAP_MS),
    reason: `${failure.class}: ${failure.reason}`,
  };
}

/**
 * How many times we relaunch after a watchdog kill that captured NOTHING.
 *
 * Each attempt costs a full no-progress window (30 min by default), so this is
 * an expensive ladder — 3 attempts is ~90 minutes of trying before the turn ends
 * and the task lands in the reconciler's hands. Deliberately much smaller than
 * UNREACHABLE_MAX_ATTEMPTS, whose attempts cost seconds each.
 */
export const WATCHDOG_ZERO_WORK_MAX_ATTEMPTS = 3;

/**
 * Decide what to do after the no-progress watchdog killed the agent.
 *
 * This is NOT part of the `AgentFailure` taxonomy: a watchdog kill is the
 * supervisor's own verdict on a process that stopped advancing, not the agent's
 * report of why a launch failed — there is no error string to classify.
 *
 * The split turns on one question: did the turn capture anything?
 *
 *  - **Nothing captured** (no result on the wire, no new commits). The old
 *    blanket "never retry a watchdog kill" rationale — "the agent's work is
 *    already on disk, so retrying would repeat work or wedge again" — is simply
 *    false here: nothing is on disk. This is the shape of a first model call
 *    that hangs (observed live during a provider outage), and it heals by
 *    relaunching. Retry, on the transient ladder, bounded.
 *  - **Something captured**. The original rationale holds: the work is on disk
 *    and a relaunch either redoes it or wedges the same way. Stop.
 *
 * @param capturedWork Whether the killed turn produced a result or new commits.
 * @param attempt      1-based count of watchdog kills in this turn (this one included).
 */
export function decideWatchdogRetry(capturedWork: boolean, attempt: number): RetryDecision {
  if (capturedWork) {
    return {
      action: 'stop',
      reason:
        'watchdog kill after the turn had already captured work — retrying would repeat it ' +
        'or wedge the same way',
    };
  }

  if (attempt >= WATCHDOG_ZERO_WORK_MAX_ATTEMPTS) {
    return {
      action: 'stop',
      reason:
        `watchdog killed the agent ${attempt} times with nothing captured — ` +
        'giving up on this turn',
    };
  }

  return {
    action: 'retry',
    delayMs: ladderDelay(attempt, TRANSIENT_BACKOFF_MS, TRANSIENT_BACKOFF_CAP_MS),
    reason:
      `watchdog kill captured no work (attempt ${attempt}/${WATCHDOG_ZERO_WORK_MAX_ATTEMPTS}) — ` +
      'relaunching',
  };
}

/** Cumulative wall-clock spent on the transient ladder over `attempts` retries. */
function totalLadderMs(attempts: number): number {
  let total = 0;
  for (let i = 1; i <= attempts; i++) {
    total += ladderDelay(i, TRANSIENT_BACKOFF_MS, TRANSIENT_BACKOFF_CAP_MS);
  }
  return total;
}

/**
 * Whether the fast-crash-loop detector (3 failures under 10s) should apply.
 *
 * It must NOT apply to provider-side transients: a 429 or a refused connection
 * fails in well under a second, so three of them in a row would trip the
 * detector and abort a turn that was about to succeed. For `unknown` failures
 * the detector stays on — it is the only bound we have there.
 */
export function appliesFastFailDetection(cls: AgentFailureClass): boolean {
  return cls === 'unknown';
}
