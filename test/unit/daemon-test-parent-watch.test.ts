/**
 * Unit tests for the test-only parent-death watch (src/daemon/test-parent-watch.ts).
 *
 * INVARIANT: the watch is INERT in production. It arms only when
 * LAZY_TEST_PARENT_PID is set, which nothing in src/ ever does — if that ever
 * regressed, every real daemon would start polling a pid it has no business
 * caring about, and could shut itself down when an unrelated process exits.
 */

import { describe, test, expect } from 'bun:test';
import {
  startTestParentWatch,
  isProcessAlive,
  TEST_PARENT_PID_ENV,
} from '../../src/daemon/test-parent-watch';

function spawnSleeper() {
  return Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
}

describe('startTestParentWatch', () => {
  // INVARIANT: no env var → no timer, no behavior change. This is what keeps
  // production daemons untouched by a test-only mechanism.
  test('returns null when the env var is unset', () => {
    expect(startTestParentWatch(() => {}, { env: {} })).toBeNull();
    expect(startTestParentWatch(() => {}, { env: { [TEST_PARENT_PID_ENV]: '' } })).toBeNull();
  });

  // A malformed value can only be a harness bug. Ignoring it would silently
  // restore the leak the watch exists to prevent, so it fails loud instead.
  test('throws on a non-pid value', () => {
    expect(() => startTestParentWatch(() => {}, { env: { [TEST_PARENT_PID_ENV]: 'nope' } }))
      .toThrow(TEST_PARENT_PID_ENV);
    expect(() => startTestParentWatch(() => {}, { env: { [TEST_PARENT_PID_ENV]: '0' } }))
      .toThrow(TEST_PARENT_PID_ENV);
  });

  test('does not fire while the parent is alive', async () => {
    const sleeper = spawnSleeper();
    let fired = false;
    const stop = startTestParentWatch(() => { fired = true; }, {
      env: { [TEST_PARENT_PID_ENV]: String(sleeper.pid) },
      pollMs: 10,
    });
    expect(stop).not.toBeNull();

    await new Promise(r => setTimeout(r, 150));
    expect(fired).toBe(false);

    stop!();
    sleeper.kill('SIGKILL');
    await sleeper.exited;
  });

  test('fires once the parent exits', async () => {
    const sleeper = spawnSleeper();
    let fireCount = 0;
    const stop = startTestParentWatch(() => { fireCount++; }, {
      env: { [TEST_PARENT_PID_ENV]: String(sleeper.pid) },
      pollMs: 10,
    });

    sleeper.kill('SIGKILL');
    await sleeper.exited;

    const deadline = Date.now() + 2000;
    while (fireCount === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(fireCount).toBe(1);

    // The callback shuts the daemon down; firing it twice would double-run
    // shutdown. Polling must stop at the first observation.
    await new Promise(r => setTimeout(r, 100));
    expect(fireCount).toBe(1);
    stop!();
  });

  test('stop() cancels the watch', async () => {
    const sleeper = spawnSleeper();
    let fired = false;
    const stop = startTestParentWatch(() => { fired = true; }, {
      env: { [TEST_PARENT_PID_ENV]: String(sleeper.pid) },
      pollMs: 10,
    });
    stop!();

    sleeper.kill('SIGKILL');
    await sleeper.exited;
    await new Promise(r => setTimeout(r, 150));
    expect(fired).toBe(false);
  });
});

describe('isProcessAlive', () => {
  test('true for this process, false for a reaped one', async () => {
    expect(isProcessAlive(process.pid)).toBe(true);

    const sleeper = spawnSleeper();
    expect(isProcessAlive(sleeper.pid)).toBe(true);
    sleeper.kill('SIGKILL');
    await sleeper.exited;
    // Bun.spawn reaps the child, so the pid is fully gone (not a zombie).
    expect(isProcessAlive(sleeper.pid)).toBe(false);
  });
});
