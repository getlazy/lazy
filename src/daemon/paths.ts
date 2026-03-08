/**
 * Daemon file paths.
 *
 * All daemon state lives under ~/.lazy/daemon/ — PID file, unix socket,
 * bearer token, and log file.
 *
 * Uses process.env.HOME directly (not os.homedir()) because Bun's homedir()
 * doesn't respect the HOME env var, which breaks tests.
 */

import { join } from 'path';
import { homedir } from 'os';

/** Get the user's home directory, preferring $HOME over os.homedir(). */
function getHome(): string {
  return process.env.HOME || homedir();
}

/** Root directory for daemon state: ~/.lazy/daemon/ */
export function getDaemonDir(): string {
  return join(getHome(), '.lazy', 'daemon');
}

/** PID file: ~/.lazy/daemon/lazy.pid */
export function getPidPath(): string {
  return join(getDaemonDir(), 'lazy.pid');
}

/** Unix socket: ~/.lazy/daemon/lazy.sock */
export function getSocketPath(): string {
  return join(getDaemonDir(), 'lazy.sock');
}

/** Bearer token file: ~/.lazy/daemon/token */
export function getTokenPath(): string {
  return join(getDaemonDir(), 'token');
}

/** Daemon log file: ~/.lazy/daemon/daemon.log */
export function getLogPath(): string {
  return join(getDaemonDir(), 'daemon.log');
}

/** Startup lock file: ~/.lazy/daemon/start.lock */
export function getStartLockPath(): string {
  return join(getDaemonDir(), 'start.lock');
}
