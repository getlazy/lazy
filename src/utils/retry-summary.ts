/**
 * Retry summary formatting — the one place that turns a supervisor's retry
 * state into a short human-readable phrase like:
 *
 *   attempt 7 (overloaded): API 529 overloaded
 *
 * A retrying task used to render as a bare `phase=retrying (47s)` in the watch
 * header and `harness:retrying` in list/active, which told a human nothing about
 * WHAT was being retried. The data (attempt count, deduplicated error log,
 * failure class) has always been in status.json — these helpers put it on the
 * one line a human is already looking at.
 *
 * Pure functions, no I/O: every read surface (watch header, working-substate
 * label, supervisor log line, MCP) formats retry state identically.
 */

import type { AgentFailureClass } from '../agent/failure-taxonomy';
import type { RetryError } from '../protocol/types';

/** Default max length of an error snippet on a status line. */
export const RETRY_SNIPPET_MAX = 80;

/**
 * The most recent error in a deduplicated retry error log, by `lastSeen`.
 *
 * `recordError` appends new messages and bumps `lastSeen` in place for repeats,
 * so the array order alone does not identify the latest error — an error seen
 * first but repeated most recently sorts last by time, not by index.
 */
export function latestRetryError(errors: RetryError[] | undefined): RetryError | null {
  if (!errors || errors.length === 0) return null;
  let latest = errors[0];
  let latestT = Date.parse(latest.lastSeen);
  for (const err of errors.slice(1)) {
    const t = Date.parse(err.lastSeen);
    // NaN comparisons are false, so an unparseable timestamp never wins — the
    // first parseable entry stays. Falling back to the last array entry when
    // nothing parses keeps "most recently appended" as the tiebreak.
    if (t > latestT || Number.isNaN(latestT)) {
      latest = err;
      latestT = t;
    }
  }
  return latest;
}

/**
 * Collapse an error message to a single truncated line fit for a status line.
 * Multi-line stack traces and wrapped API errors otherwise blow up a one-line
 * header.
 */
export function formatErrorSnippet(message: string, max: number = RETRY_SNIPPET_MAX): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The retry fields any surface needs to render a summary. */
export interface RetrySummaryInput {
  retryCount?: number;
  errors?: RetryError[];
  retry_failure_class?: AgentFailureClass;
}

/**
 * Render `attempt <n>[ (<class>)][: <error snippet>]`, or null when there is
 * nothing meaningful to say (no attempts recorded yet).
 *
 * Callers prepend their own context (`phase=retrying `, `harness:retrying `).
 */
export function formatRetrySummary(
  status: RetrySummaryInput | null | undefined,
  max: number = RETRY_SNIPPET_MAX,
): string | null {
  if (!status || status.retryCount === undefined || status.retryCount <= 0) return null;

  let summary = `attempt ${status.retryCount}`;
  if (status.retry_failure_class) {
    summary += ` (${status.retry_failure_class})`;
  }
  const latest = latestRetryError(status.errors);
  if (latest) {
    summary += `: ${formatErrorSnippet(latest.message, max)}`;
  }
  return summary;
}
