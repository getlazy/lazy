/**
 * Daemon file paths.
 *
 * All daemon state lives under ~/.lazy/daemon/<project-slug>/ — PID file,
 * unix socket, bearer token, and log file. Each project gets its own daemon
 * directory derived from the project root path.
 *
 * Directory naming: <last-dir-component>-<sha256(projectRoot).slice(0,8)>
 * e.g., /home/user/prg/workshop → ~/.lazy/daemon/workshop-a1b2c3d4/
 *
 * Uses getHome() from utils/home which prefers $HOME over os.homedir()
 * because Bun's homedir() doesn't respect the HOME env var on some platforms.
 */

import { join, basename } from 'path';
import { createHash } from 'crypto';
import { getHome } from '../utils/home';

/**
 * Derive a human-readable, collision-resistant slug from a project root.
 * Format: <last-dir-component>-<sha256(projectRoot).slice(0,8)>
 */
export function projectSlug(projectRoot: string): string {
  const name = basename(projectRoot) || 'root';
  const hash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 8);
  return `${name}-${hash}`;
}

/** Root directory for all daemon state: ~/.lazy/daemon/ */
export function getDaemonBaseDir(): string {
  return join(getHome(), '.lazy', 'daemon');
}

/** Per-project daemon directory: ~/.lazy/daemon/<slug>/ */
export function getDaemonDir(projectRoot: string): string {
  return join(getDaemonBaseDir(), projectSlug(projectRoot));
}

/** PID file: ~/.lazy/daemon/<slug>/lazy.pid */
export function getPidPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), 'lazy.pid');
}

/** Unix socket: ~/.lazy/daemon/<slug>/lazy.sock */
export function getSocketPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), 'lazy.sock');
}

/** Bearer token file: ~/.lazy/daemon/<slug>/token */
export function getTokenPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), 'token');
}

/** Daemon log file: ~/.lazy/daemon/<slug>/daemon.log */
export function getLogPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), 'daemon.log');
}

/** Startup lock file: ~/.lazy/daemon/<slug>/start.lock
 *  @deprecated Superseded by daemon.lock flock — kept for test compatibility. */
export function getStartLockPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), 'start.lock');
}

/** Exclusive daemon lock file: ~/.lazy/daemon/<slug>/daemon.lock
 *  Held by the running daemon for its entire lifetime via flock(2).
 *  When the daemon exits (cleanly or via crash/SIGKILL), the OS releases
 *  the lock automatically. This is the primary singleton enforcement. */
export function getDaemonLockPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), 'daemon.lock');
}

/** Startup error marker: ~/.lazy/daemon/<slug>/startup-error
 *  Written by a background daemon child just before it throws a fatal
 *  startup error (e.g., web-port bind failure). The parent process
 *  (startDaemonBackground) reads this file after its readiness poll
 *  times out, so it can surface the actual error to the user's terminal
 *  instead of a generic "daemon did not start within Ns" message.
 *  Cleared before each spawn. */
export function getStartupErrorPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), 'startup-error');
}
