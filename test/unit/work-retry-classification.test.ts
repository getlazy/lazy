/**
 * Unit tests for runWork's use of the failure taxonomy.
 *
 * These cover the seam between the agent (which classifies) and the retry loop
 * (which paces and stops). Backoff sleeps are injected so the cadence can be
 * asserted without burning wall-clock.
 */

import { describe, test, expect } from 'bun:test';
import { runWork, CrashError, FatalAgentError, CrashLoopError, type WorkResult, type RetryState } from '../../src/supervisor/work';
import { describeTurnFailure } from '../../src/supervisor';
import type { ErrorResponse } from '../../src/protocol';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import { createRunnerFromType } from '../../src/runner';
import { UNREACHABLE_MAX_ATTEMPTS } from '../../src/supervisor/retry-policy';

const agent = new ClaudeCodeAgent();
const runner = createRunnerFromType('dangerously-host-process-without-any-isolation');

const MOCK_SUCCESS: WorkResult = {
  result: 'done',
  session_id: 'session-abc123',
  usage: { input_tokens: 1, output_tokens: 1 },
};

/** Run with injected execute + sleep; returns the recorded sleeps and retry states. */
async function run(opts: {
  execute: () => Promise<WorkResult>;
  onRetryStateChange?: (s: RetryState | null) => void;
}): Promise<{ sleeps: number[]; result?: WorkResult; error?: unknown }> {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  try {
    const result = await runWork(
      agent,
      runner,
      '/tmp/test',
      'Do the work',
      undefined,             // systemPrompt
      undefined,             // modelId
      undefined,             // claudeSessionId
      undefined,             // protocolDir
      opts.onRetryStateChange,
      opts.execute,
      undefined,             // watchdogTimeoutMs
      undefined,             // effort
      undefined,             // permissionMode
      undefined,             // windDownTimeoutMs
      undefined,             // agentExtraArgs
      sleep,
    );
    return { sleeps, result };
  } catch (error) {
    return { sleeps, error };
  }
}

const crash = (message: string, exitCode = 1) =>
  new CrashError({ message, exitCode, stderr: '', durationMs: 50 });

describe('runWork — fatal classifications stop the turn', () => {
  // INVARIANT: a fatal class ends the turn on the FIRST failure. The observed
  // incident retried a dead credential for 5+ minutes with no end in sight.
  test('fatal_auth throws FatalAgentError after a single attempt', async () => {
    let calls = 0;
    const { sleeps, error } = await run({
      execute: async () => {
        calls++;
        throw crash('API Error: 401 {"type":"authentication_error"}');
      },
    });

    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(error).toBeInstanceOf(FatalAgentError);
    expect((error as FatalAgentError).failureClass).toBe('fatal_auth');
    expect((error as FatalAgentError).attempts).toBe(1);
  });

  test('fatal_config (missing binary) stops immediately', async () => {
    let calls = 0;
    const { error } = await run({
      execute: async () => {
        calls++;
        throw crash('claude: command not found', 127);
      },
    });
    expect(calls).toBe(1);
    expect((error as FatalAgentError).failureClass).toBe('fatal_config');
  });
});

describe('runWork — transient classifications retry on the tight ladder', () => {
  test('a 429 that clears is retried at 5s and succeeds', async () => {
    let calls = 0;
    const { sleeps, result } = await run({
      execute: async () => {
        calls++;
        if (calls === 1) throw crash('API Error: 429 rate_limit_error');
        return MOCK_SUCCESS;
      },
    });

    expect(calls).toBe(2);
    expect(sleeps).toEqual([5_000]);
    expect(result).toEqual(MOCK_SUCCESS);
  });

  // INVARIANT: fast provider-side transients must not trip the crash-loop
  // detector. Three sub-10s 429s in a row previously aborted the turn with
  // "Crash loop detected".
  test('three fast 429s do not trip the crash-loop detector', async () => {
    let calls = 0;
    const { sleeps, result, error } = await run({
      execute: async () => {
        calls++;
        if (calls <= 3) throw crash('API Error: 429 rate_limit_error');
        return MOCK_SUCCESS;
      },
    });

    expect(error).toBeUndefined();
    expect(calls).toBe(4);
    expect(sleeps).toEqual([5_000, 10_000, 20_000]);
    expect(result).toEqual(MOCK_SUCCESS);
  });

  test('three fast UNKNOWN crashes still trip the crash-loop detector', async () => {
    let calls = 0;
    const { error } = await run({
      execute: async () => {
        calls++;
        throw crash('Segmentation fault (core dumped)');
      },
    });

    expect(calls).toBe(3);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Crash loop detected');
  });

  // INVARIANT (fix-cursor-action-required): the crash-loop backstop must carry
  // what the loop learned. It used to throw a bare Error, so the class, the
  // agent's reason and the attempt count never reached the ErrorResponse —
  // the recorded turn said only "Crash loop detected: …" and `lazy watch`
  // showed no attempt count at all.
  test('a crash-loop exit carries class, reason and attempts', async () => {
    const { error } = await run({
      execute: async () => { throw crash('Segmentation fault (core dumped)'); },
    });

    expect(error).toBeInstanceOf(CrashLoopError);
    const loop = error as CrashLoopError;
    expect(loop.failureClass).toBe('unknown');
    expect(loop.failureReason).toBeTruthy();
    expect(loop.attempts).toBe(3);
  });

  // The classification has to survive the trip onto the wire — that is the
  // half that was silently dropped, in describeTurnFailure.
  test('the crash-loop classification reaches the ErrorResponse', async () => {
    const { error } = await run({
      execute: async () => { throw crash('Segmentation fault (core dumped)'); },
    });

    const response: ErrorResponse = {
      status: 'error',
      error: (error as Error).message,
      phase: 'work',
    };
    describeTurnFailure(response, error);

    expect(response.failure_class).toBe('unknown');
    expect(response.failure_reason).toBeTruthy();
    expect(response.failure_attempts).toBe(3);
  });

  // INVARIANT: carrying the class must NOT flip crash loops from `interrupted`
  // to `blocked`. The detector only fires for `unknown` — precisely the
  // failures we could not judge — and many of those heal on a relaunch, so the
  // reconciler keeps them on the auto-resume path. See the comment above the
  // detector in work.ts and handleErrorResponse in reconcile.ts.
  test('a crash loop is reported as unknown, so it stays auto-resumable', async () => {
    const { error } = await run({
      execute: async () => { throw crash('Segmentation fault (core dumped)'); },
    });

    expect(error).not.toBeInstanceOf(FatalAgentError);
    expect((error as CrashLoopError).failureClass).toBe('unknown');
  });
});

describe('runWork — refused connections are bounded, never infinite', () => {
  // INVARIANT (the engineer's bar): never spin forever on something that
  // cannot recover. A refused connection is retried generously — it may be a
  // local proxy restarting — and then escalated to fatal.
  test('ConnectionRefused escalates to FatalAgentError at the attempt cap', async () => {
    let calls = 0;
    const { sleeps, error } = await run({
      execute: async () => {
        calls++;
        throw crash('API Error: Unable to connect to API (ConnectionRefused)');
      },
    });

    expect(calls).toBe(UNREACHABLE_MAX_ATTEMPTS);
    expect(sleeps.length).toBe(UNREACHABLE_MAX_ATTEMPTS - 1);
    expect(error).toBeInstanceOf(FatalAgentError);
    expect((error as FatalAgentError).failureClass).toBe('transient_unreachable');
    expect((error as FatalAgentError).attempts).toBe(UNREACHABLE_MAX_ATTEMPTS);
  });

  test('a refused connection that heals mid-window succeeds', async () => {
    let calls = 0;
    const { result } = await run({
      execute: async () => {
        calls++;
        if (calls <= 3) throw crash('connect ECONNREFUSED 127.0.0.1:8087');
        return MOCK_SUCCESS;
      },
    });
    expect(result).toEqual(MOCK_SUCCESS);
    expect(calls).toBe(4);
  });
});

describe('runWork — retry state carries the classification', () => {
  test('onRetryStateChange reports class, reason and next delay', async () => {
    const states: RetryState[] = [];
    let calls = 0;
    await run({
      execute: async () => {
        calls++;
        if (calls === 1) throw crash('API Error: 529 {"type":"overloaded_error"}');
        return MOCK_SUCCESS;
      },
      onRetryStateChange: (s) => { if (s) states.push({ ...s }); },
    });

    expect(states.length).toBe(1);
    expect(states[0]!.failureClass).toBe('transient_overload');
    expect(states[0]!.failureReason).toBeTruthy();
    expect(states[0]!.nextDelayMs).toBe(5_000);
    expect(states[0]!.errors[0]!.failure_class).toBe('transient_overload');
  });
});
