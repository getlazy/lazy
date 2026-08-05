/**
 * Retry status projection — writes the retry loop's state into status.json.
 *
 * One implementation shared by every command path (work, ask, pre-accept) that
 * calls runWork. Previously each path carried its own copy of this callback and
 * they had already drifted (only the work path logged). Presentation surfaces
 * (`lazy watch` header, `lazy show`, MCP) read these fields — including the
 * failure classification, so they can say WHY a turn is retrying rather than
 * just "retrying (attempt 3)".
 */

import type { SupervisorStatus } from '../protocol/types';
import { writeStatus } from '../protocol/io';
import { formatRetrySummary } from '../utils/retry-summary';
import { log } from './log';
import type { RetryState } from './work';

export function makeRetryStatusHandler(
  status: SupervisorStatus,
  protocolDir: string,
): (retryState: RetryState | null) => void {
  // The phase we were in when retrying started (always the work phase today) —
  // restored on success so readers don't see a stale `retrying` on disk until
  // the next phase transition happens to rewrite status.json.
  const entryPhase = status.phase;

  return (retryState: RetryState | null) => {
    const now = new Date().toISOString();

    if (!retryState) {
      // Exiting retry state (the attempt succeeded).
      delete status.retryCount;
      delete status.errors;
      delete status.retry_failure_class;
      delete status.retry_failure_reason;
      delete status.retry_next_delay_ms;
      if (status.phase === 'retrying') {
        status.phase = entryPhase;
        status.phase_started_at = now;
      }
      status.updated_at = now;
      writeStatus(protocolDir, status);
      return;
    }

    if (status.phase !== 'retrying') {
      status.phase_started_at = now;
    }
    status.phase = 'retrying';
    status.retryCount = retryState.count;
    status.errors = retryState.errors;
    status.updated_at = now;

    if (retryState.failureClass) {
      status.retry_failure_class = retryState.failureClass;
      status.retry_failure_reason = retryState.failureReason;
    }
    if (retryState.nextDelayMs !== undefined) {
      status.retry_next_delay_ms = retryState.nextDelayMs;
    } else {
      delete status.retry_next_delay_ms;
    }

    writeStatus(protocolDir, status);
    // Include the error itself: a log line that says only "attempt 7" tells the
    // human watching the stream nothing about what keeps failing.
    log(`[supervisor] Phase: retrying ${formatRetrySummary(status) ?? `attempt ${retryState.count}`}`);
  };
}
