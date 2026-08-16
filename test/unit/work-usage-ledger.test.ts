/**
 * Unit tests for the tokens a turn spends on attempts that FAIL.
 *
 * A turn is one billable unit from the human's point of view, but runWork may
 * launch the agent several times inside it (zero-work watchdog kills are
 * retried). Every one of those launches spends real tokens. Historically only
 * the surviving attempt's usage escaped runWork, so a turn that crashed twice
 * and then succeeded reported roughly a third of what it cost — and a turn that
 * never succeeded reported nothing at all.
 *
 * See docs/token-usage-recording.md.
 */

import { describe, test, expect } from 'bun:test';
import { runWork, FatalAgentError, type WorkResult, type RetryState } from '../../src/supervisor/work';
import { WatchdogTimeoutError } from '../../src/supervisor/watchdog';
import { WATCHDOG_ZERO_WORK_MAX_ATTEMPTS, UNREACHABLE_MAX_ATTEMPTS } from '../../src/supervisor/retry-policy';
import { readUsage } from '../../src/supervisor/usage';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import { createRunnerFromType } from '../../src/runner';

const agent = new ClaudeCodeAgent();
const runner = createRunnerFromType('dangerously-host-process-without-any-isolation');

/** Nonexistent on purpose: the "did this turn commit anything?" probe answers false. */
const NO_REPO = '/tmp/test';

function runWorkWith(opts: {
  execute: () => Promise<WorkResult>;
  onRetryStateChange?: (state: RetryState | null) => void;
}): Promise<WorkResult> {
  return runWork(
    agent,
    runner,
    NO_REPO,
    'Do the work',
    undefined, // systemPrompt
    undefined, // modelId
    undefined, // claudeSessionId
    undefined, // protocolDir
    opts.onRetryStateChange,
    opts.execute,
    undefined, // watchdogTimeoutMs
    undefined, // effort
    undefined, // permissionMode
    undefined, // windDownTimeoutMs
    undefined, // agentExtraArgs
    async () => {}, // sleep: no real backoff in tests
  );
}

/** A zero-work watchdog kill (the retriable shape) that reported usage first. */
function killedAfterSpending(input: number, output: number): WatchdogTimeoutError {
  return new WatchdogTimeoutError(30_000, 45_000, {
    usage: { input_tokens: input, output_tokens: output },
  });
}

describe('runWork token ledger across retries', () => {
  // INVARIANT: a turn reports what the WHOLE turn spent, retries included.
  //
  // runWork owns the retry loop, so it is the only place that can see the
  // attempts that died. If it returns only the winning attempt's usage, the
  // failed attempts' tokens exist on no record anywhere — they were spent, and
  // then forgotten.
  test('folds failed attempts into the successful result', async () => {
    let callCount = 0;

    const result = await runWorkWith({
      execute: async () => {
        callCount++;
        if (callCount < 3) throw killedAfterSpending(10 * callCount, callCount);
        return {
          result: 'Task completed successfully',
          session_id: 'session-abc',
          usage: { input_tokens: 100, output_tokens: 200 },
        };
      },
    });

    expect(callCount).toBe(3);
    // attempt 1 (10/1) + attempt 2 (20/2) + the winner (100/200)
    expect(result.usage).toEqual({
      input_tokens: 130,
      output_tokens: 203,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  // INVARIANT: a turn that never succeeds still reports its tokens.
  //
  // This is the expensive case, not the cheap one — every attempt paid to read
  // the full context before dying. The accumulated usage rides out on the thrown
  // error so the supervisor can put it on the error response, and the reconciler
  // can put it on the recorded turn.
  test('carries the accumulated usage out on the escaping error', async () => {
    let callCount = 0;

    try {
      await runWorkWith({
        execute: async () => {
          callCount++;
          throw killedAfterSpending(10, 1);
        },
      });
      expect.unreachable('runWork should have thrown');
    } catch (err) {
      expect(callCount).toBe(WATCHDOG_ZERO_WORK_MAX_ATTEMPTS);
      expect(readUsage(err)).toEqual({
        input_tokens: 10 * WATCHDOG_ZERO_WORK_MAX_ATTEMPTS,
        output_tokens: WATCHDOG_ZERO_WORK_MAX_ATTEMPTS,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
    }
  });

  // A FatalAgentError REPLACES the underlying error rather than re-throwing it,
  // so it has to carry the ledger forward explicitly or the same tokens vanish
  // through a different door. `transient_unreachable` is the interesting shape:
  // it retries a bounded number of times and only THEN escalates to fatal, so
  // the error that escapes must account for every one of those attempts.
  test('a FatalAgentError carries the ledger of the attempts it replaced', async () => {
    let callCount = 0;

    try {
      await runWorkWith({
        execute: async () => {
          callCount++;
          const err = new Error('connect ECONNREFUSED 127.0.0.1:8080') as Error & { usage?: unknown };
          err.usage = { input_tokens: 5, output_tokens: 3 };
          throw err;
        },
      });
      expect.unreachable('runWork should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FatalAgentError);
      expect(callCount).toBe(UNREACHABLE_MAX_ATTEMPTS);
      const usage = readUsage(err)!;
      expect(usage.input_tokens).toBe(5 * UNREACHABLE_MAX_ATTEMPTS);
      expect(usage.output_tokens).toBe(3 * UNREACHABLE_MAX_ATTEMPTS);
    }
  });

  // Nothing reported, nothing invented: an attempt that died before the agent
  // said anything must not contribute a zeroed block that reads like a measurement.
  test('reports no usage when no attempt reported any', async () => {
    try {
      await runWorkWith({
        execute: async () => {
          throw new WatchdogTimeoutError(30_000, 45_000);
        },
      });
      expect.unreachable('runWork should have thrown');
    } catch (err) {
      expect(readUsage(err)).toBeUndefined();
    }
  });
});
