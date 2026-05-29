/**
 * Unit tests for the supervisor watchdog timer.
 *
 * Tests use real subprocesses (bun -e "script") to verify watchdog behavior
 * with actual stdout/stderr output and process signals.
 */

import { describe, test, expect } from 'bun:test';
import { execWithWatchdog, resolveWatchdogTimeout, WatchdogTimeoutError } from '../../src/supervisor/watchdog';

describe('resolveWatchdogTimeout', () => {
  test('returns config value when non-zero', () => {
    expect(resolveWatchdogTimeout(5000, 30000)).toBe(5000);
  });

  test('returns agent default when config is 0', () => {
    expect(resolveWatchdogTimeout(0, 30000)).toBe(30000);
  });

  // INVARIANT: 0 config + 0 agent default = disabled.
  // Agents that don't hang (Claude Code) have 0 default, so watchdog is off unless the user forces it.
  test('returns 0 (disabled) when both config and agent default are 0', () => {
    expect(resolveWatchdogTimeout(0, 0)).toBe(0);
  });
});

describe('execWithWatchdog', () => {
  // INVARIANT: When timeoutMs is 0, the watchdog is disabled and does not interfere.
  test('disabled when timeout is 0 — process runs normally', async () => {
    const result = await execWithWatchdog(
      [process.execPath, '-e', 'console.log("hello"); process.exit(0)'],
      { cwd: '/tmp', env: {}, timeoutMs: 0 },
    );

    expect(result.killedByWatchdog).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  test('process completes normally when output is produced before timeout', async () => {
    const result = await execWithWatchdog(
      [process.execPath, '-e', 'console.log("fast output"); process.exit(0)'],
      { cwd: '/tmp', env: {}, timeoutMs: 5000 },
    );

    expect(result.killedByWatchdog).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('fast output');
  });

  // INVARIANT: Watchdog resets on each output chunk. A process that keeps producing
  // output should never be killed, even if each gap is close to the timeout.
  test('watchdog resets on stdout output', async () => {
    // Output every 50ms for 250ms total, with a 200ms timeout.
    // Without reset, the watchdog would fire. With reset, it doesn't.
    const script = `
      for (let i = 0; i < 5; i++) {
        console.log("tick " + i);
        await Bun.sleep(50);
      }
      process.exit(0);
    `;
    const result = await execWithWatchdog(
      [process.execPath, '-e', script],
      { cwd: '/tmp', env: {}, timeoutMs: 200 },
    );

    expect(result.killedByWatchdog).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('tick 4');
  });

  // INVARIANT: Watchdog resets on stderr output too — not just stdout.
  test('watchdog resets on stderr output', async () => {
    const script = `
      for (let i = 0; i < 5; i++) {
        console.error("err " + i);
        await Bun.sleep(50);
      }
      process.exit(0);
    `;
    const result = await execWithWatchdog(
      [process.execPath, '-e', script],
      { cwd: '/tmp', env: {}, timeoutMs: 200 },
    );

    expect(result.killedByWatchdog).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('err 4');
  });

  // INVARIANT: When no output is produced for the timeout period, the watchdog
  // kills the process. This is the core purpose — detecting hung agents.
  test('kills process after timeout with no output', async () => {
    // Process hangs for 10s — watchdog should kill it much sooner
    const result = await execWithWatchdog(
      [process.execPath, '-e', 'console.log("start"); await Bun.sleep(10000)'],
      { cwd: '/tmp', env: {}, timeoutMs: 200 },
    );

    expect(result.killedByWatchdog).toBe(true);
    expect(result.stdout.trim()).toBe('start');
  });

  test('captures partial stdout before watchdog kill', async () => {
    const script = `
      console.log("line 1");
      console.log("line 2");
      await Bun.sleep(10000);
    `;
    const result = await execWithWatchdog(
      [process.execPath, '-e', script],
      { cwd: '/tmp', env: {}, timeoutMs: 200 },
    );

    expect(result.killedByWatchdog).toBe(true);
    expect(result.stdout).toContain('line 1');
    expect(result.stdout).toContain('line 2');
  });

  test('non-zero exit code is captured when watchdog is not involved', async () => {
    const result = await execWithWatchdog(
      [process.execPath, '-e', 'console.log("oops"); process.exit(42)'],
      { cwd: '/tmp', env: {}, timeoutMs: 5000 },
    );

    expect(result.killedByWatchdog).toBe(false);
    expect(result.exitCode).toBe(42);
    expect(result.stdout.trim()).toBe('oops');
  });
});

describe('WatchdogTimeoutError', () => {
  test('has descriptive message with timeout duration', () => {
    const err = new WatchdogTimeoutError(30000, 45000);
    expect(err.message).toBe('Agent process killed by watchdog (no output for 30s)');
    expect(err.timeoutMs).toBe(30000);
    expect(err.durationMs).toBe(45000);
    expect(err.name).toBe('WatchdogTimeoutError');
  });
});
