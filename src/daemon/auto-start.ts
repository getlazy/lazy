/**
 * Daemon auto-start — starts the daemon if not running.
 *
 * Called early in the CLI entry point before command dispatch.
 * Also exports startDaemonBackground() for use by `lazy daemon start`.
 *
 * In v0.11+, the daemon is required. If auto-start fails, the CLI
 * exits with an actionable error. The only exceptions are:
 * - Test mode (LAZY_TEST=1): daemon is bypassed entirely
 * - Commands that don't need the daemon (daemon, init, completion, help)
 */

import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { spawn } from '../utils/spawn';
import { waitForDaemon, cleanupStaleFiles, isDaemonRunning, getLogPath } from './index';
import { getLazyCommand } from '../utils/cli-path';

/** Commands that should NOT trigger auto-start (they work without daemon) */
const SKIP_AUTO_START = new Set([
  'daemon',     // avoid recursion
  'init',       // bootstrap command — must work before daemon exists
  'completion', // shell completion — must be fast
  '--help',
  '-h',
  '--version',
  '-V',
]);

/**
 * Start the daemon in the background. Used by ensureDaemon() and daemonStart().
 *
 * Forks a child process and waits for its socket to become ready.
 * Singleton enforcement is handled by startDaemonServer()'s flock — if two
 * callers race and both spawn, only one child wins the lock; the other exits.
 *
 * @param projectRoot - Project root directory
 */
export async function startDaemonBackground(projectRoot: string): Promise<void> {
  const logPath = getLogPath(projectRoot);

  // Ensure daemon directory exists before spawning — Bun.spawn needs the
  // log file's parent directory to exist for stdout/stderr redirection.
  mkdirSync(dirname(logPath), { recursive: true });

  // Fork a detached child running `lazy daemon start --foreground --project <root>`
  const proc = spawn([...getLazyCommand(), 'daemon', 'start', '--foreground', '--project', projectRoot], {
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
    stdin: 'ignore',
    timeout: 0, // Long-running: daemon runs indefinitely
  });

  // Detach the child so it outlives this process
  proc.unref();

  // Wait for the daemon to become available
  const ready = await waitForDaemon(projectRoot, 5000);
  if (!ready) {
    throw new Error(
      `Daemon did not start within 5 seconds.\n` +
      `Check logs: ${logPath}`,
    );
  }
}

/**
 * Ensure the daemon is running for the given project. Called before command dispatch.
 *
 * Checks for the socket file — if it exists, the daemon is ready.
 * If not, spawns a daemon and polls for the socket.
 * Singleton enforcement is in startDaemonServer() (flock), not here.
 *
 * @param command - The CLI command being run (to check skip list)
 * @param projectRoot - The project root directory (for per-project daemon paths)
 */
export async function ensureDaemon(command: string | undefined, projectRoot: string): Promise<boolean> {
  // Test mode bypasses daemon entirely
  if (process.env.LAZY_TEST === '1') return false;

  // Commands that don't need daemon
  if (!command || SKIP_AUTO_START.has(command)) return false;

  // Fast path: socket exists, token readable, AND process is alive.
  // After a crash, socket+token files remain but the process is dead —
  // the PID check catches this (the old check only tested file existence).
  if (isDaemonRunning(projectRoot)) {
    return true;
  }

  // Daemon is dead or never started. Clean up stale files (socket, PID)
  // left behind by a crash, then start a fresh daemon.
  // startDaemonServer's flock ensures only one daemon wins if multiple
  // callers race to start.
  cleanupStaleFiles(projectRoot);
  await startDaemonBackground(projectRoot);
  return true;
}
