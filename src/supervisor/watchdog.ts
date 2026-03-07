/**
 * Watchdog timer for agent processes.
 *
 * Monitors stdout/stderr output from an agent subprocess. If no output is
 * produced for a configurable timeout, kills the process with SIGTERM,
 * then SIGKILL after a grace period.
 *
 * This is a supervisor-level feature, not agent-specific. Each agent provides
 * a default timeout via defaultWatchdogTimeoutMs(); users can override in
 * lazy.toml via [agent].watchdog_output_timeout_ms.
 */

import { log } from './log';

/** Grace period between SIGTERM and SIGKILL (ms). */
const KILL_GRACE_MS = 5000;

export class WatchdogTimeoutError extends Error {
  durationMs: number;
  timeoutMs: number;

  constructor(timeoutMs: number, durationMs: number) {
    super(`Agent process killed by watchdog (no output for ${timeoutMs / 1000}s)`);
    this.name = 'WatchdogTimeoutError';
    this.timeoutMs = timeoutMs;
    this.durationMs = durationMs;
  }
}

export interface WatchdogResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  killedByWatchdog: boolean;
}

/**
 * Resolve the effective watchdog timeout.
 * Config value of 0 means "use agent default". If agent default is also 0, disabled.
 */
export function resolveWatchdogTimeout(configValue: number, agentDefault: number): number {
  return configValue !== 0 ? configValue : agentDefault;
}

/**
 * Spawn a subprocess with watchdog monitoring on stdout/stderr.
 *
 * The watchdog timer resets on every chunk of output from either stream.
 * If the timer fires, the process is killed (SIGTERM -> grace -> SIGKILL).
 *
 * When timeoutMs is 0, the watchdog is disabled and this behaves like a
 * normal spawn-and-wait.
 */
export async function execWithWatchdog(
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
  },
): Promise<WatchdogResult> {
  const { cwd, env, timeoutMs } = opts;
  const enabled = timeoutMs > 0;

  if (enabled) {
    log(`[watchdog] Enabled: output timeout ${timeoutMs}ms`);
  }

  const proc = Bun.spawn(args, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let killedByWatchdog = false;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const launchTime = Date.now();

  function clearTimers() {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  }

  function killProcess() {
    killedByWatchdog = true;
    const elapsed = Date.now() - launchTime;
    log(`[watchdog] No output for ${timeoutMs}ms (elapsed: ${elapsed}ms). Sending SIGTERM.`);
    proc.kill('SIGTERM');

    graceTimer = setTimeout(() => {
      // Check if the process is still running
      if (proc.exitCode === null) {
        log(`[watchdog] Process still alive after ${KILL_GRACE_MS}ms grace period. Sending SIGKILL.`);
        proc.kill('SIGKILL');
      }
    }, KILL_GRACE_MS);
  }

  function resetWatchdog() {
    if (!enabled) return;
    if (killedByWatchdog) return; // Don't reset after we've started killing
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(killProcess, timeoutMs);
  }

  // Start the watchdog timer
  resetWatchdog();

  // Stream stdout
  const stdoutDone = (async () => {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stdoutChunks.push(Buffer.from(value));
        resetWatchdog();
      }
    } finally {
      reader.releaseLock();
    }
  })();

  // Stream stderr
  const stderrDone = (async () => {
    const reader = proc.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrChunks.push(Buffer.from(value));
        resetWatchdog();
      }
    } finally {
      reader.releaseLock();
    }
  })();

  // Wait for streams and process exit
  await Promise.all([stdoutDone, stderrDone, proc.exited]);

  clearTimers();

  const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
  const stderr = Buffer.concat(stderrChunks).toString('utf-8');
  const exitCode = proc.exitCode ?? 1;

  return { stdout, stderr, exitCode, killedByWatchdog };
}
