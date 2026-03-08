/**
 * Daemon auto-start — starts the daemon if not running.
 *
 * Called early in the CLI entry point before command dispatch.
 * Forks a background daemon process and waits up to 5s for the socket.
 *
 * Skip when:
 * - LAZY_NO_DAEMON=1 is set
 * - The command is `daemon` itself (to avoid recursion)
 * - We're in a test environment (LAZY_TEST=1)
 */

import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { spawn } from '../utils/spawn';
import { checkDaemonHealth, waitForDaemon, cleanupStaleFiles, getLogPath, acquireStartLock, releaseStartLock } from './index';
import { getLazyCommand } from '../utils/cli-path';

/** Commands that should NOT trigger auto-start */
const SKIP_AUTO_START = new Set([
  'daemon',     // avoid recursion
  'completion', // shell completion — must be fast
  '--help',
  '-h',
  '--version',
  '-V',
]);

/**
 * Ensure the daemon is running. Called before command dispatch.
 *
 * If the daemon is already running, returns immediately.
 * If not, forks a background daemon and waits for it to be ready.
 *
 * Returns true if the daemon is running (or was started), false if skipped.
 */
export async function ensureDaemon(command: string | undefined): Promise<boolean> {
  // Skip conditions
  if (process.env.LAZY_NO_DAEMON === '1') return false;
  if (process.env.LAZY_TEST === '1') return false;
  if (!command || SKIP_AUTO_START.has(command)) return false;

  // Check if already running
  const status = await checkDaemonHealth();
  if (status.running) return true;

  // Try to acquire the startup lock to prevent concurrent spawns.
  // If another process is already starting the daemon, wait for it.
  if (!acquireStartLock()) {
    // Another process is starting the daemon — wait for it
    return await waitForDaemon(5000);
  }

  try {
    // Re-check after acquiring lock — daemon may have started while we waited
    const recheck = await checkDaemonHealth();
    if (recheck.running) return true;

    // Clean up any stale files
    cleanupStaleFiles();

    // Fork a background daemon
    const logPath = getLogPath();

    // Ensure daemon directory exists before spawning — Bun.spawn needs the
    // log file's parent directory to exist for stdout/stderr redirection.
    mkdirSync(dirname(logPath), { recursive: true });

    const proc = spawn([...getLazyCommand(), 'daemon', 'start', '--foreground'], {
      stdout: Bun.file(logPath),
      stderr: Bun.file(logPath),
      stdin: 'ignore',
    });
    proc.unref();

    // Wait for daemon to become ready (up to 5s)
    return await waitForDaemon(5000);
  } catch {
    // Auto-start failure is non-fatal — the CLI command proceeds without daemon
    return false;
  } finally {
    releaseStartLock();
  }
}
