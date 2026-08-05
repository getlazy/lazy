/**
 * Rendering for a turn the no-progress watchdog ended.
 *
 * A watchdog kill used to reach the human as `[Agent crashed] … no forward
 * progress for 1800s`, which explains nothing: it does not say a guard fired
 * rather than the agent dying, it does not say which setting the number came
 * from, and it does not say whether lazy already retried. Whoever opens the task
 * next has to reconstruct all of that. This module is the one place that spells
 * it out, shared by the reconciler (work turns) and the ask path.
 */

import type { ErrorResponse } from '../protocol/types';

/**
 * Format a millisecond duration for a human reading a turn or a log line.
 * `1800000` reads as `30m`, not as `1800s` — the number in the message has to be
 * recognizable as the guard the human configured.
 *
 * Lives here rather than in supervisor/watchdog.ts so the daemon-side renderers
 * do not have to import supervisor internals.
 */
export function formatWatchdogMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSecs = Math.round(ms / 1000);
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins < 60) return secs === 0 ? `${mins}m` : `${mins}m${secs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins === 0 ? `${hours}h` : `${hours}h${remMins}m`;
}

/** Heading used instead of `[Agent crashed]` when the watchdog was the cause. */
export const WATCHDOG_TURN_HEADING = '[Agent killed by watchdog — no forward progress]';

/** True when this error response came from a no-progress watchdog kill. */
export function isWatchdogKill(response: ErrorResponse): boolean {
  return response.watchdog_timeout_ms !== undefined;
}

/**
 * The explanatory block for a watchdog-killed turn. Empty array when the
 * response is not a watchdog kill, so callers can splice it unconditionally.
 */
export function watchdogTurnLines(response: ErrorResponse): string[] {
  const timeoutMs = response.watchdog_timeout_ms;
  if (timeoutMs === undefined) return [];

  const lines = [
    `Watchdog: the agent produced no forward progress for ${formatWatchdogMs(timeoutMs)}, ` +
    `so lazy killed the process.`,
    `Limit: [agent] watchdog_output_timeout_ms = ${timeoutMs} ms (0 disables it).`,
    'Forward progress means completed steps — periodic keep-alives do not count, ' +
    'and the timer resets on every step, so a long-but-advancing turn is never killed.',
  ];

  if (response.watchdog_captured_work) {
    lines.push(
      'This turn had already captured work (a result or new commits), so it was NOT ' +
      'relaunched automatically — relaunching would repeat that work or wedge the same way.',
    );
  } else {
    const attempts = response.watchdog_attempts ?? 1;
    lines.push(
      attempts > 1
        ? `Nothing was captured, so lazy relaunched the agent automatically — ${attempts} attempts, ` +
          'all killed the same way.'
        : 'Nothing was captured by this turn (no result, no new commits).',
    );
  }

  return lines;
}

/** One-line interrupt reason recorded on the session for a watchdog kill. */
export function watchdogInterruptReason(response: ErrorResponse): string {
  const timeoutMs = response.watchdog_timeout_ms ?? 0;
  const attempts = response.watchdog_attempts ?? 1;
  const suffix = response.watchdog_captured_work
    ? ' (work was captured — not relaunched)'
    : attempts > 1
      ? ` (nothing captured — relaunched ${attempts}x, killed each time)`
      : ' (nothing captured)';
  return `Watchdog kill: no forward progress for ${formatWatchdogMs(timeoutMs)}${suffix}`;
}
