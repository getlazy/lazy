/**
 * Daemon lifecycle management — PID file, liveness detection, stale cleanup.
 *
 * Liveness check sequence (same pattern as Docker daemon):
 * 1. Does lazy.pid exist? If not → not running.
 * 2. Is the PID alive (kill -0)? If not → stale files, clean up.
 * 3. Can we connect to the socket? If not → stale files, clean up.
 * 4. Health check request responds? → daemon is running.
 */

import { existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync, openSync, closeSync, statSync, constants } from 'fs';
import { randomBytes } from 'crypto';
import { getPidPath, getSocketPath, getTokenPath, getDaemonDir, getStartLockPath } from './paths';

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  socketPath?: string;
  uptime?: number;
  version?: string;
}

/** Read the PID from the PID file. Returns null if file doesn't exist or is invalid. */
export function readPid(): number | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const content = readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Write the current process PID to the PID file. */
export function writePid(pid: number): void {
  mkdirSync(getDaemonDir(), { recursive: true });
  writeFileSync(getPidPath(), String(pid), { mode: 0o644 });
}

/** Check if a process with the given PID is alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read the bearer token from disk. Returns null if not found. */
export function readToken(): string | null {
  const tokenPath = getTokenPath();
  if (!existsSync(tokenPath)) return null;
  try {
    return readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    return null;
  }
}

/** Generate and write a new bearer token. Returns the token string. */
export function generateToken(): string {
  mkdirSync(getDaemonDir(), { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(getTokenPath(), token, { mode: 0o600 });
  return token;
}

/**
 * Remove stale daemon files (PID, socket).
 * Called when we detect the daemon is dead but files remain.
 */
export function cleanupStaleFiles(): void {
  const pidPath = getPidPath();
  const socketPath = getSocketPath();

  if (existsSync(pidPath)) {
    try { unlinkSync(pidPath); } catch { /* ignore */ }
  }
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* ignore */ }
  }
}

/**
 * Check daemon liveness by verifying the PID file and process.
 * Does NOT check socket connectivity (use checkDaemonHealth for that).
 *
 * Returns the PID if the daemon process is alive, null otherwise.
 * Cleans up stale files if the process is dead.
 */
export function checkDaemonProcess(): number | null {
  const pid = readPid();
  if (pid === null) return null;

  if (!isProcessAlive(pid)) {
    cleanupStaleFiles();
    return null;
  }

  return pid;
}

/**
 * Full health check: verify PID is alive AND socket responds to HTTP request.
 * Returns DaemonStatus with running=true if the daemon is healthy.
 */
export async function checkDaemonHealth(): Promise<DaemonStatus> {
  const pid = checkDaemonProcess();
  if (pid === null) {
    return { running: false };
  }

  const socketPath = getSocketPath();
  if (!existsSync(socketPath)) {
    cleanupStaleFiles();
    return { running: false };
  }

  const token = readToken();
  if (!token) {
    cleanupStaleFiles();
    return { running: false };
  }

  // Try to connect and hit the health endpoint
  try {
    const response = await fetch(`http://localhost/daemon/status`, {
      unix: socketPath,
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    } as any);

    if (!response.ok) {
      cleanupStaleFiles();
      return { running: false };
    }

    const data = await response.json() as { uptime?: number; version?: string };
    return {
      running: true,
      pid,
      socketPath,
      uptime: data.uptime,
      version: data.version,
    };
  } catch {
    // Socket exists but can't connect — stale
    cleanupStaleFiles();
    return { running: false };
  }
}

/**
 * Send a graceful shutdown request to the daemon via its socket.
 * Returns true if the shutdown request was accepted.
 */
export async function requestShutdown(): Promise<boolean> {
  const socketPath = getSocketPath();
  const token = readToken();
  if (!token || !existsSync(socketPath)) return false;

  try {
    const response = await fetch(`http://localhost/daemon/shutdown`, {
      method: 'POST',
      unix: socketPath,
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    } as any);

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for the daemon socket to become available (for auto-start).
 * Polls every 100ms up to the given timeout.
 * Returns true if the daemon responded to a health check within the timeout.
 */
export async function waitForDaemon(timeoutMs: number = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await checkDaemonHealth();
    if (status.running) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

/** Maximum age (in ms) for a startup lock before it's considered stale. */
const LOCK_STALE_MS = 30_000;

/**
 * Try to acquire the daemon startup lock.
 *
 * Uses O_CREAT | O_EXCL for atomic creation — fails if the file already exists.
 * If the lock file exists but is older than LOCK_STALE_MS, it's from a crashed
 * starter — we remove it and retry once.
 *
 * Returns true if the lock was acquired, false if another process holds it.
 */
export function acquireStartLock(): boolean {
  const lockPath = getStartLockPath();
  mkdirSync(getDaemonDir(), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
      // Write our PID so stale detection can identify the holder
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;

      // Lock file exists — check if it's stale
      try {
        const stat = statSync(lockPath);
        const age = Date.now() - stat.mtimeMs;
        if (age > LOCK_STALE_MS) {
          // Stale lock from a crashed starter — remove and retry
          try { unlinkSync(lockPath); } catch { /* another process may have removed it */ }
          continue;
        }
      } catch {
        // Lock file vanished between our open and stat — retry
        continue;
      }

      // Lock is held by another process and is not stale
      return false;
    }
  }

  return false;
}

/**
 * Release the daemon startup lock.
 * Safe to call even if we don't hold the lock (e.g., cleanup after error).
 */
export function releaseStartLock(): void {
  try {
    unlinkSync(getStartLockPath());
  } catch {
    // Lock already removed — fine
  }
}
