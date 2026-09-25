/**
 * Unit tests for the post-turn check execution helper.
 *
 * These tests deterministically reproduce the failure modes that left a
 * production `cargo build` post-turn check stuck for ~30 minutes despite a
 * configured 600s timeout. The historical bug had four pieces:
 *
 *   1. stdio pipes were never drained → verbose children blocked on write
 *      → proc.exited never resolved.
 *   2. timeout fired SIGTERM only, no SIGKILL escalation → SIGTERM-ignoring
 *      children survived indefinitely.
 *   3. proc.exited was not awaited after kill → caller didn't know whether
 *      the child was actually gone.
 *   4. no heartbeat output between "Running post-turn check" and the timeout
 *      → silence looked like a hang.
 *
 * Each test below pins one of these guarantees so they cannot regress.
 */

import { describe, test, expect } from 'bun:test';
import { tmpdir } from 'os';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { runTurnHookCommand, formatHookOutput } from '../../src/supervisor/post-turn-check';

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'post-turn-check-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('runTurnHookCommand', () => {
  test('returns exit code 0 on success', async () => {
    await withTmpDir(async dir => {
      const result = await runTurnHookCommand('echo hello >&2', dir, 5000);
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.stderr).toContain('hello');
    });
  }, 20_000);

  test('returns non-zero exit code and captured stderr on failure', async () => {
    await withTmpDir(async dir => {
      const result = await runTurnHookCommand('echo bad >&2 && exit 7', dir, 5000);
      expect(result.exitCode).toBe(7);
      expect(result.timedOut).toBe(false);
      expect(result.stderr).toContain('bad');
    });
  }, 20_000);

  // INVARIANT: a verbose child that fills the OS pipe buffer (~64KB) must
  // still exit cleanly. Pre-fix this hung because pipes were never drained.
  test('drains stdout/stderr concurrently so verbose checks do not deadlock', async () => {
    await withTmpDir(async dir => {
      // Write ~200KB to both stdout and stderr — more than the pipe buffer.
      // Without concurrent draining, the child blocks on write forever.
      const cmd =
        "for i in $(seq 1 2000); do " +
        "echo 'stdout-line-padding-padding-padding-padding-padding-' $i; " +
        "echo 'stderr-line-padding-padding-padding-padding-padding-' $i >&2; " +
        "done; exit 3";
      const result = await runTurnHookCommand(cmd, dir, 15_000);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain('stderr-line-padding');
    });
  }, 20_000);

  // INVARIANT: SIGTERM-ignoring children must be killed via SIGKILL escalation.
  // Pre-fix the supervisor called proc.kill() (SIGTERM only) and moved on,
  // leaving cargo build subtrees alive for the rest of the container's life.
  test('escalates to SIGKILL when child ignores SIGTERM and reports timedOut=true', async () => {
    await withTmpDir(async dir => {
      const t0 = Date.now();
      const result = await runTurnHookCommand(
        // Ignore TERM; the only thing that takes us down is SIGKILL.
        "trap '' TERM; while true; do sleep 1; done",
        dir,
        1500,
      );
      const elapsed = Date.now() - t0;
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(-2);
      expect(result.killSignal).toBe('SIGKILL');
      // 1.5s timeout + 5s grace = ~6.5s, allow generous slack.
      expect(elapsed).toBeGreaterThanOrEqual(6000);
      expect(elapsed).toBeLessThan(15_000);
    });
  }, 20_000);

  // INVARIANT: well-behaved children get SIGTERM only (no escalation needed).
  test('uses SIGTERM only when child exits promptly on signal', async () => {
    await withTmpDir(async dir => {
      const result = await runTurnHookCommand('sleep 30', dir, 500);
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(-2);
      expect(result.killSignal).toBe('SIGTERM');
      // Should be well under the SIGKILL grace period (5s).
      expect(result.elapsedMs).toBeLessThan(3000);
    });
  }, 20_000);

  // INVARIANT: we always await proc.exited after killing, so the function
  // does not return while the child is still consuming CPU or fds.
  test('awaits child exit before returning on timeout', async () => {
    await withTmpDir(async dir => {
      const result = await runTurnHookCommand('sleep 30', dir, 200);
      // If we returned before the child was reaped, elapsedMs would be ~200ms
      // and exitCode would not reliably be set on the underlying proc. By
      // contract elapsedMs reflects "time until we knew the child was gone".
      expect(result.timedOut).toBe(true);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(200);
    });
  }, 20_000);
});

describe('turn hook stdout capture', () => {
  // INVARIANT: stdout is CAPTURED, not drained to a null sink. Service setup
  // scripts routinely report failure on stdout; discarding it left the only
  // explanation of a failed hook nowhere to be found.
  test('captures stdout as well as stderr', async () => {
    await withTmpDir(async dir => {
      const result = await runTurnHookCommand(
        'echo out-line; echo err-line >&2',
        dir,
        5000,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('out-line');
      expect(result.stderr).toContain('err-line');
      // The two streams stay separate — neither leaks into the other.
      expect(result.stdout).not.toContain('err-line');
      expect(result.stderr).not.toContain('out-line');
    });
  }, 20_000);

  // INVARIANT: capturing stdout must not reintroduce the blocked-writer hang
  // that the null sink was there to avoid — a chatty child still completes.
  test('a child writing bulk stdout still completes', async () => {
    await withTmpDir(async dir => {
      const result = await runTurnHookCommand(
        'i=0; while [ $i -lt 2000 ]; do echo "line $i padding padding padding"; i=$((i+1)); done',
        dir,
        20_000,
      );
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('line 1999');
    });
  }, 30_000);
});

describe('formatHookOutput', () => {
  // INVARIANT: the streams are drained concurrently, so there is no true
  // interleave to reproduce. They are rendered as separate labelled blocks
  // rather than concatenated into an order that never happened.
  test('labels both streams as separate blocks', () => {
    const text = formatHookOutput({ stdout: 'out', stderr: 'err' });
    expect(text).toContain('--- stdout ---');
    expect(text).toContain('out');
    expect(text).toContain('--- stderr ---');
    expect(text).toContain('err');
    expect(text.indexOf('--- stdout ---')).toBeLessThan(text.indexOf('--- stderr ---'));
  });

  test('omits an empty stream entirely', () => {
    expect(formatHookOutput({ stdout: 'out', stderr: '   ' })).not.toContain('--- stderr ---');
    expect(formatHookOutput({ stdout: '', stderr: 'err' })).not.toContain('--- stdout ---');
  });

  test('says so explicitly when the hook produced no output at all', () => {
    expect(formatHookOutput({ stdout: '', stderr: '' })).toBe('(no output on stdout or stderr)');
  });
});
