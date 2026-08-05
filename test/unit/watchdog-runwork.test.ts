/**
 * Unit tests for watchdog integration with runWork.
 *
 * A watchdog kill is classified by ONE question: did this turn capture anything?
 * "Captured" means the agent's final result was on the wire, or the turn added
 * commits. Captured-work kills are not retried; zero-work kills are, with
 * backoff, up to WATCHDOG_ZERO_WORK_MAX_ATTEMPTS.
 */

import { describe, test, expect } from 'bun:test';
import { runWork, type WorkResult, type RetryState } from '../../src/supervisor/work';
import { WatchdogTimeoutError } from '../../src/supervisor/watchdog';
import { WATCHDOG_ZERO_WORK_MAX_ATTEMPTS } from '../../src/supervisor/retry-policy';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import { createRunnerFromType } from '../../src/runner';

const agent = new ClaudeCodeAgent();
// Any runner works here: these tests inject _executeOverride, so the runner is
// never consulted for session-log discovery.
const runner = createRunnerFromType('dangerously-host-process-without-any-isolation');

/**
 * `/tmp/test` deliberately does not exist, so the "did this turn commit
 * anything?" probe cannot read git and answers false — the zero-work shape.
 */
const NO_REPO = '/tmp/test';

/**
 * Call runWork with only the arguments these tests care about. The positional
 * signature is long enough that spelling out fifteen `undefined`s per test hides
 * which seam is actually being exercised.
 */
function runWorkWith(opts: {
  execute: () => Promise<WorkResult>;
  claudeSessionId?: string;
  onRetryStateChange?: (state: RetryState | null) => void;
  sleeps?: number[];
}): Promise<WorkResult> {
  const sleep = opts.sleeps
    ? async (ms: number) => {
        opts.sleeps!.push(ms);
      }
    : undefined;

  return runWork(
    agent,
    runner,
    NO_REPO,
    'Do the work',
    undefined, // systemPrompt
    undefined, // modelId
    opts.claudeSessionId,
    undefined, // protocolDir
    opts.onRetryStateChange,
    opts.execute,
    undefined, // watchdogTimeoutMs
    undefined, // effort
    undefined, // permissionMode
    undefined, // windDownTimeoutMs
    undefined, // agentExtraArgs
    sleep,
  );
}

describe('runWork watchdog handling', () => {
  // INVARIANT: a watchdog kill that CAPTURED WORK is never retried. The agent's
  // work is already on disk, so relaunching would either repeat it or wedge the
  // same way — that call belongs to a human, who can read what was captured.
  test('does not retry a watchdog kill that captured a result', async () => {
    let callCount = 0;

    await expect(
      runWorkWith({
        execute: async () => {
          callCount++;
          throw new WatchdogTimeoutError(30000, 45000, { capturedResult: true });
        },
      }),
    ).rejects.toThrow('Agent process killed by watchdog');

    expect(callCount).toBe(1);
  });

  // INVARIANT: a watchdog kill that captured NOTHING is retried with backoff.
  // The non-retriable rationale above does not apply to it — there is nothing on
  // disk to repeat — and it is exactly the shape of a first model call that hung
  // (a provider stall), which heals by relaunching. Bounded, because each attempt
  // costs a full no-progress window.
  test('retries a zero-work watchdog kill up to the attempt bound, then propagates', async () => {
    let callCount = 0;
    const sleeps: number[] = [];

    await expect(
      runWorkWith({
        sleeps,
        execute: async () => {
          callCount++;
          throw new WatchdogTimeoutError(30000, 45000); // no result captured
        },
      }),
    ).rejects.toThrow('Agent process killed by watchdog');

    expect(callCount).toBe(WATCHDOG_ZERO_WORK_MAX_ATTEMPTS);
    // Backoff between attempts, not a hot loop.
    expect(sleeps.length).toBe(WATCHDOG_ZERO_WORK_MAX_ATTEMPTS - 1);
    expect(sleeps.every((ms) => ms > 0)).toBe(true);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]!);
  });

  // A relaunch that succeeds is the whole point: the turn completes with no human
  // in the loop, which is what the 45-minute stranded task could not do.
  test('a zero-work watchdog kill that heals on relaunch returns the result', async () => {
    let callCount = 0;
    const sleeps: number[] = [];

    const result = await runWorkWith({
      sleeps,
      execute: async () => {
        callCount++;
        if (callCount === 1) throw new WatchdogTimeoutError(30000, 45000);
        return {
          result: 'Task completed successfully',
          session_id: 'new-session-abc123',
          usage: { input_tokens: 100, output_tokens: 200 },
        };
      },
    });

    expect(result.result).toBe('Task completed successfully');
    expect(callCount).toBe(2);
    expect(sleeps.length).toBe(1);
  });

  // The presence of a session ID means a relaunch resumes the same conversation.
  // It does not change the classification — capturing work does.
  test('a captured-work kill propagates even when a session ID is present', async () => {
    let callCount = 0;

    await expect(
      runWorkWith({
        claudeSessionId: 'session-123',
        execute: async () => {
          callCount++;
          throw new WatchdogTimeoutError(30000, 45000, { capturedResult: true });
        },
      }),
    ).rejects.toThrow('Agent process killed by watchdog');

    expect(callCount).toBe(1);
  });

  // The supervisor stamps its verdict onto the error before letting it escape,
  // because that is what the recorded turn renders for the human.
  test('error metadata carries the retry verdict out of runWork', async () => {
    const sleeps: number[] = [];

    try {
      await runWorkWith({
        sleeps,
        execute: async () => {
          throw new WatchdogTimeoutError(30000, 45000);
        },
      });
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(WatchdogTimeoutError);
      const watchdogErr = err as WatchdogTimeoutError;
      expect(watchdogErr.timeoutMs).toBe(30000);
      expect(watchdogErr.durationMs).toBe(45000);
      expect(watchdogErr.capturedWork).toBe(false);
      expect(watchdogErr.attempts).toBe(WATCHDOG_ZERO_WORK_MAX_ATTEMPTS);
    }
  });

  test('captured-work metadata survives the throw', async () => {
    try {
      await runWorkWith({
        execute: async () => {
          throw new WatchdogTimeoutError(30000, 45000, { capturedResult: true });
        },
      });
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const watchdogErr = err as WatchdogTimeoutError;
      expect(watchdogErr.capturedResult).toBe(true);
      expect(watchdogErr.capturedWork).toBe(true);
      expect(watchdogErr.attempts).toBe(1);
    }
  });
});
