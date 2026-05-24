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
import { spawn } from '../utils/spawn';
import { pathExists } from '../utils/fs';

/** Grace period between SIGTERM and SIGKILL (ms). */
const KILL_GRACE_MS = 5000;

/** How often the graceful-exit watcher polls the marker file. */
const GRACEFUL_MARKER_POLL_MS = 500;

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

/**
 * Thrown when the agent process is killed because it failed to exit within
 * `graceful_exit_timeout_ms` after writing the end-of-turn marker (lazy_commit).
 *
 * Non-retriable, same as WatchdogTimeoutError: the agent's work is already on
 * disk (the commit landed before the marker was written), so retrying would
 * either repeat work or hang again on the same stuck tool call.
 */
export class GracefulExitTimeoutError extends Error {
  durationMs: number;
  timeoutMs: number;
  /** ms between the marker appearing and the kill. Equal to timeoutMs unless the kill was delayed. */
  elapsedSinceSignalMs: number;
  /** Absolute path of the marker file — included so users can see which task signalled. */
  markerPath: string;
  /**
   * Claude session id, when recoverable — either from `--resume` (the supervisor
   * already knew it) or by discovering the JSONL file Claude writes from process
   * start (same path `lazy watch` uses). Undefined only when neither source
   * yields anything (e.g. claude died before writing any jsonl).
   *
   * INVARIANT: GracefulExitTimeoutError must carry session_id whenever it is
   * recoverable, so the human can `lazy unblock` after the kill instead of
   * orphaning the conversation.
   */
  sessionId?: string;

  constructor(opts: {
    timeoutMs: number;
    durationMs: number;
    elapsedSinceSignalMs: number;
    markerPath: string;
    sessionId?: string;
  }) {
    super(
      `Killed ${Math.round(opts.elapsedSinceSignalMs / 1000)}s after lazy_commit returned — ` +
      `claude -p still had outstanding tool calls (marker: ${opts.markerPath})`,
    );
    this.name = 'GracefulExitTimeoutError';
    this.timeoutMs = opts.timeoutMs;
    this.durationMs = opts.durationMs;
    this.elapsedSinceSignalMs = opts.elapsedSinceSignalMs;
    this.markerPath = opts.markerPath;
    this.sessionId = opts.sessionId;
  }
}

export interface WatchdogResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  killedByWatchdog: boolean;
  /** True when the kill was triggered by the graceful-exit marker timer (not the output watchdog). */
  killedByGracefulExit: boolean;
  /**
   * ms between the marker appearing and the kill (only set when
   * killedByGracefulExit is true).
   */
  gracefulExitElapsedMs?: number;
}

/**
 * Resolve the effective watchdog timeout.
 * Config value of 0 means "use agent default". Agent default is also 0 for
 * claude-code, so users can disable the watchdog by setting watchdog_output_timeout_ms = 0.
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
    /**
     * Optional marker file watched alongside the agent process. When the file
     * appears, `gracefulExitTimeoutMs` is started; if the timer fires before
     * the process exits, the process is killed with the same SIGTERM→SIGKILL
     * protocol as the output watchdog. See `src/protocol/turn-end-signal.ts`.
     */
    gracefulExitMarkerPath?: string;
    /**
     * Grace period after the marker appears before killing the process.
     * 0 (or omitted) disables the graceful-exit watcher.
     */
    gracefulExitTimeoutMs?: number;
  },
): Promise<WatchdogResult> {
  const { cwd, env, timeoutMs, gracefulExitMarkerPath, gracefulExitTimeoutMs } = opts;
  const enabled = timeoutMs > 0;
  const gracefulEnabled = !!gracefulExitMarkerPath && (gracefulExitTimeoutMs ?? 0) > 0;

  if (enabled) {
    log(`[watchdog] Enabled: output timeout ${timeoutMs}ms`);
  }
  if (gracefulEnabled) {
    log(`[watchdog] Graceful-exit watcher enabled: timeout ${gracefulExitTimeoutMs}ms, marker ${gracefulExitMarkerPath}`);
  }

  const proc = spawn(args, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env,
    timeout: 0, // Long-running: watchdog has its own output-based timeout mechanism
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let killedByWatchdog = false;
  let killedByGracefulExit = false;
  let gracefulExitElapsedMs: number | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let gracefulExitTimer: ReturnType<typeof setTimeout> | null = null;
  let gracefulMarkerPoll: ReturnType<typeof setInterval> | null = null;
  let gracefulMarkerSeenAt: number | null = null;
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
    if (gracefulExitTimer) {
      clearTimeout(gracefulExitTimer);
      gracefulExitTimer = null;
    }
    if (gracefulMarkerPoll) {
      clearInterval(gracefulMarkerPoll);
      gracefulMarkerPoll = null;
    }
  }

  function scheduleSigkill(reason: string) {
    graceTimer = setTimeout(() => {
      if (proc.exitCode === null) {
        log(`[watchdog] Process still alive after ${KILL_GRACE_MS}ms grace period (${reason}). Sending SIGKILL.`);
        proc.kill('SIGKILL');
      }
    }, KILL_GRACE_MS);
  }

  function killProcess() {
    killedByWatchdog = true;
    const elapsed = Date.now() - launchTime;
    log(`[watchdog] No output for ${timeoutMs}ms (elapsed: ${elapsed}ms). Sending SIGTERM.`);
    proc.kill('SIGTERM');
    scheduleSigkill('output watchdog');
  }

  function killProcessForGracefulExit() {
    // If the output watchdog already started killing, don't double-kill.
    if (killedByWatchdog) return;
    killedByGracefulExit = true;
    const now = Date.now();
    gracefulExitElapsedMs = gracefulMarkerSeenAt !== null ? now - gracefulMarkerSeenAt : (gracefulExitTimeoutMs ?? 0);
    log(
      `[watchdog] Killed ${Math.round(gracefulExitElapsedMs / 1000)}s after lazy_commit returned — ` +
      `claude -p still had outstanding tool calls (marker: ${gracefulExitMarkerPath}). Sending SIGTERM.`,
    );
    proc.kill('SIGTERM');
    scheduleSigkill('graceful exit');
  }

  function resetWatchdog() {
    if (!enabled) return;
    if (killedByWatchdog || killedByGracefulExit) return; // Don't reset after we've started killing
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(killProcess, timeoutMs);
  }

  // Start the watchdog timer
  resetWatchdog();

  // Start the graceful-exit marker poller.
  //
  // INVARIANT: once the marker is observed, the timer runs to completion.
  // We do NOT reset on later tool calls or re-writes of the marker file —
  // resetting would reintroduce the indefinite-hang failure mode this feature
  // is designed to prevent. The poller stops itself after first detection.
  if (gracefulEnabled) {
    gracefulMarkerPoll = setInterval(async () => {
      // Already firing — stop polling.
      if (gracefulMarkerSeenAt !== null || killedByWatchdog || killedByGracefulExit) {
        if (gracefulMarkerPoll) {
          clearInterval(gracefulMarkerPoll);
          gracefulMarkerPoll = null;
        }
        return;
      }
      let present = false;
      try {
        present = await pathExists(gracefulExitMarkerPath!);
      } catch (err) {
        // "marker absent" is normal; "found but unreadable" is a real error.
        // pathExists swallows errors, so reaching this branch is unusual — log loudly.
        log(`[watchdog] Failed to stat graceful-exit marker ${gracefulExitMarkerPath}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (!present) return;

      gracefulMarkerSeenAt = Date.now();
      if (gracefulMarkerPoll) {
        clearInterval(gracefulMarkerPoll);
        gracefulMarkerPoll = null;
      }
      log(`[watchdog] End-of-turn signal observed; starting ${gracefulExitTimeoutMs}ms grace timer.`);
      gracefulExitTimer = setTimeout(killProcessForGracefulExit, gracefulExitTimeoutMs!);
    }, GRACEFUL_MARKER_POLL_MS);
  }

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

  return { stdout, stderr, exitCode, killedByWatchdog, killedByGracefulExit, gracefulExitElapsedMs };
}
