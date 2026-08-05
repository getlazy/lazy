/**
 * Unit tests for the supervisor's retry policy.
 *
 * INVARIANT: the supervisor decides retry pacing from the failure CLASS alone.
 * These tests pin both halves of the fix:
 *   - a fatal class never retries (the observed incident spun on a dead
 *     credential for 5+ minutes and would have spun forever);
 *   - a transient class retries on a tight ladder (5s→60s), not the old
 *     30s→300s ladder that produced 2 attempts in 5 minutes.
 */

import { describe, test, expect } from 'bun:test';
import {
  decideRetry,
  decideWatchdogRetry,
  appliesFastFailDetection,
  TRANSIENT_BACKOFF_MS,
  TRANSIENT_BACKOFF_CAP_MS,
  UNREACHABLE_MAX_ATTEMPTS,
  WATCHDOG_ZERO_WORK_MAX_ATTEMPTS,
} from '../../src/supervisor/retry-policy';
import { resolveWatchdogTimeout } from '../../src/supervisor/watchdog';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import type { AgentFailure } from '../../src/agent/failure-taxonomy';

const f = (cls: AgentFailure['class']): AgentFailure => ({ class: cls, reason: `${cls} reason` });

describe('decideRetry — fatal classes stop immediately', () => {
  test('fatal_auth stops on the first failure', () => {
    const decision = decideRetry(f('fatal_auth'), 1);
    expect(decision.action).toBe('stop');
    expect(decision.reason).toContain('fatal_auth');
  });

  test('fatal_config stops on the first failure', () => {
    expect(decideRetry(f('fatal_config'), 1).action).toBe('stop');
  });
});

describe('decideRetry — transient classes retry on a tight ladder', () => {
  test('overload starts at 5s and caps at 60s', () => {
    const delays = [1, 2, 3, 4, 5, 6, 20].map(a => {
      const d = decideRetry(f('transient_overload'), a);
      if (d.action !== 'retry') throw new Error(`expected retry at attempt ${a}`);
      return d.delayMs;
    });
    expect(delays.slice(0, 4)).toEqual(TRANSIENT_BACKOFF_MS);
    expect(delays[4]).toBe(TRANSIENT_BACKOFF_CAP_MS);
    expect(delays[6]).toBe(TRANSIENT_BACKOFF_CAP_MS);
  });

  test('network uses the same ladder', () => {
    const d = decideRetry(f('transient_network'), 1);
    expect(d).toEqual({ action: 'retry', delayMs: 5_000, reason: 'transient_network: transient_network reason' });
  });

  test('overload and network never stop, however many attempts', () => {
    // A rate limit must not need a human to un-stick the task.
    expect(decideRetry(f('transient_overload'), 500).action).toBe('retry');
    expect(decideRetry(f('transient_network'), 500).action).toBe('retry');
  });

  // Regression bound: the old ladder was 30s/60s/120s/240s/300s. The first two
  // attempts used to consume 90s; they now consume 15s.
  test('is materially faster than the old 30s→300s ladder', () => {
    const first = decideRetry(f('transient_overload'), 1);
    const second = decideRetry(f('transient_overload'), 2);
    if (first.action !== 'retry' || second.action !== 'retry') throw new Error('expected retries');
    expect(first.delayMs + second.delayMs).toBeLessThanOrEqual(15_000);
  });
});

describe('decideRetry — transient_unreachable is bounded', () => {
  test('retries on the transient ladder below the cap', () => {
    const d = decideRetry(f('transient_unreachable'), 1);
    expect(d.action).toBe('retry');
    if (d.action === 'retry') expect(d.delayMs).toBe(5_000);
  });

  test('still retrying one attempt before the cap', () => {
    expect(decideRetry(f('transient_unreachable'), UNREACHABLE_MAX_ATTEMPTS - 1).action).toBe('retry');
  });

  // INVARIANT: "never spin forever on something that cannot recover". A refused
  // connection may heal (local proxy restarting), so we retry generously — but
  // a proxy that never returns must escalate to a stop, not an infinite loop.
  test('escalates to stop at the attempt cap', () => {
    const d = decideRetry(f('transient_unreachable'), UNREACHABLE_MAX_ATTEMPTS);
    expect(d.action).toBe('stop');
    expect(d.reason).toContain('unrecoverable');
  });

  test('the bounded window is long enough to outlast a proxy restart', () => {
    let total = 0;
    for (let attempt = 1; attempt < UNREACHABLE_MAX_ATTEMPTS; attempt++) {
      const d = decideRetry(f('transient_unreachable'), attempt);
      if (d.action !== 'retry') throw new Error(`expected retry at ${attempt}`);
      total += d.delayMs;
    }
    expect(total).toBeGreaterThan(5 * 60_000); // > 5 minutes of trying
    expect(total).toBeLessThan(20 * 60_000);   // but finite and bounded
  });
});

describe('decideRetry — unknown', () => {
  test('retries indefinitely on a slower ladder', () => {
    const first = decideRetry(f('unknown'), 1);
    expect(first).toEqual({ action: 'retry', delayMs: 15_000, reason: 'unknown: unknown reason' });
    const later = decideRetry(f('unknown'), 9);
    if (later.action !== 'retry') throw new Error('expected retry');
    expect(later.delayMs).toBe(60_000);
  });
});

describe('appliesFastFailDetection', () => {
  // INVARIANT: the 3-fast-failures crash-loop detector must not fire on
  // provider-side transients. A 429 comes back in milliseconds; three in a row
  // would abort a turn that was about to succeed.
  test('is off for transient classes', () => {
    expect(appliesFastFailDetection('transient_overload')).toBe(false);
    expect(appliesFastFailDetection('transient_network')).toBe(false);
    expect(appliesFastFailDetection('transient_unreachable')).toBe(false);
  });

  test('stays on for unknown — the only bound we have there', () => {
    expect(appliesFastFailDetection('unknown')).toBe(true);
  });
});

describe('decideWatchdogRetry', () => {
  // INVARIANT: a watchdog kill that captured work is never retried — the work is
  // already on disk, so a relaunch would repeat it or wedge the same way. That
  // one is a human's call.
  test('stops immediately when the turn captured work', () => {
    const decision = decideWatchdogRetry(true, 1);
    expect(decision.action).toBe('stop');
    expect(decision.reason).toContain('already captured work');
  });

  // INVARIANT: a watchdog kill that captured NOTHING is retriable. The
  // "work is already on disk" rationale does not apply to it — a first model call
  // that hangs leaves nothing behind — and relaunching is exactly what heals it.
  test('retries with backoff when nothing was captured', () => {
    const first = decideWatchdogRetry(false, 1);
    if (first.action !== 'retry') throw new Error('expected retry');
    expect(first.delayMs).toBe(TRANSIENT_BACKOFF_MS[0]);

    const second = decideWatchdogRetry(false, 2);
    if (second.action !== 'retry') throw new Error('expected retry');
    expect(second.delayMs).toBeGreaterThan(first.delayMs);
  });

  // Bounded much tighter than the network ladders: each attempt here costs a full
  // no-progress window (30 min by default), not seconds.
  test('gives up at the attempt bound', () => {
    const last = decideWatchdogRetry(false, WATCHDOG_ZERO_WORK_MAX_ATTEMPTS);
    expect(last.action).toBe('stop');
    expect(WATCHDOG_ZERO_WORK_MAX_ATTEMPTS).toBeLessThan(UNREACHABLE_MAX_ATTEMPTS);
  });
});

describe('the effective no-progress window for claude-code', () => {
  // INVARIANT: a fresh install kills a no-progress agent at 30 minutes. It used to
  // be 2 hours, and a task stranded 45 minutes on a hung first model call during a
  // provider incident with the supervisor correctly doing nothing. claude-code's
  // own default is 0 ("no opinion"), so the config value IS the effective window —
  // both halves have to be checked together or the flip means nothing.
  test('resolves to 30 minutes out of the box', () => {
    expect(DEFAULT_CONFIG.agent.watchdog_output_timeout_ms).toBe(1_800_000);
    expect(
      resolveWatchdogTimeout(
        DEFAULT_CONFIG.agent.watchdog_output_timeout_ms,
        new ClaudeCodeAgent().defaultWatchdogTimeoutMs(),
      ),
    ).toBe(1_800_000);
  });
});
