/**
 * Daemon lifecycle management — flock-based singleton, PID file, health checks.
 *
 * All functions require a projectRoot parameter to locate per-project daemon
 * state files (PID, socket, token, lock).
 *
 * Singleton enforcement: flock(2) is the SOLE source of truth for daemon
 * liveness. The daemon acquires an exclusive lock on daemon.lock at startup
 * and holds it for its entire lifetime. When the process exits — cleanly,
 * via SIGTERM, SIGKILL, or crash — the OS automatically releases the lock.
 *
 * Health checks (socket connectivity) are ONLY for diagnostic display
 * (lazy daemon status). They are NOT used as a liveness gate in the start path.
 *
 * NOTE: fd-lock (npm) is the preferred package for flock(2) semantics, but it
 * depends on fs-native-extensions which calls uv_get_osfhandle — a libuv
 * function that Bun v1.3.11 does not support. Bun panics with:
 *   "Bun encountered a crash when running a NAPI module that tried to call
 *    the uv_get_osfhandle libuv function."
 * See: https://github.com/oven-sh/bun/issues/18546
 * Until Bun adds support, we use Bun FFI to call flock(2) directly from libc.
 */

import { existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync, openSync, closeSync, statSync, constants } from 'fs';
import { randomBytes } from 'crypto';
import { getPidPath, getSocketPath, getTokenPath, getDaemonDir, getDaemonLockPath, getStartLockPath } from './paths';

export interface AutoReactBudgetEntry {
  project: string;
  used: number;
  limit: number;
  tasksAtLimit: string[];
}

export interface AutoReactBudgetEntry {
  project: string;
  used: number;
  limit: number;
  tasksAtLimit: string[];
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  socketPath?: string;
  uptime?: number;
  version?: string;
  webPort?: number;
  autoReactBudget?: AutoReactBudgetEntry[];
}

/** Read the PID from the PID file. Returns null if file doesn't exist or is invalid. */
export function readPid(projectRoot: string): number | null {
  const pidPath = getPidPath(projectRoot);
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
export function writePid(projectRoot: string, pid: number): void {
  mkdirSync(getDaemonDir(projectRoot), { recursive: true });
  writeFileSync(getPidPath(projectRoot), String(pid), { mode: 0o644 });
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
export function readToken(projectRoot: string): string | null {
  const tokenPath = getTokenPath(projectRoot);
  if (!existsSync(tokenPath)) return null;
  try {
    return readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    return null;
  }
}

/** Generate and write a new bearer token. Returns the token string. */
export function generateToken(projectRoot: string): string {
  mkdirSync(getDaemonDir(projectRoot), { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(getTokenPath(projectRoot), token, { mode: 0o600 });
  return token;
}

/**
 * Remove stale daemon files (PID, socket).
 * Called when we detect the daemon is dead but files remain.
 */
export function cleanupStaleFiles(projectRoot: string): void {
  const pidPath = getPidPath(projectRoot);
  const socketPath = getSocketPath(projectRoot);

  if (existsSync(pidPath)) {
    try { unlinkSync(pidPath); } catch { /* ignore — another process may have removed it */ }
  }
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* ignore — another process may have removed it */ }
  }
}

/**
 * Unified daemon liveness check — the SINGLE function that all code paths
 * must use to determine whether the daemon is running.
 *
 * Checks three signals, all of which must be true:
 *   1. Socket file exists (daemon created it on startup)
 *   2. Token file is readable (daemon created it on startup)
 *   3. PID file exists and process is alive (kill -0)
 *
 * This is synchronous and fast (~microseconds): file stat + kill(pid, 0).
 * No network I/O, no flock probing.
 *
 * After a crash, the socket and token files remain but the process is dead.
 * The PID check catches this case — the previous fast-path (socket+token
 * existence only) did not, causing `lazy daemon start` to say "already
 * running" while `lazy daemon status` (which connects to the socket) said
 * "not running".
 */
export function isDaemonRunning(projectRoot: string): boolean {
  const socketPath = getSocketPath(projectRoot);
  if (!existsSync(socketPath)) return false;

  if (!readToken(projectRoot)) return false;

  const pid = readPid(projectRoot);
  if (pid === null) return false;

  return isProcessAlive(pid);
}

/**
 * Full health check: verify socket responds to HTTP request.
 * Used ONLY for diagnostic display (lazy daemon status), NOT for liveness.
 * Returns DaemonStatus with running=true if the daemon responds.
 */
export async function checkDaemonHealth(projectRoot: string): Promise<DaemonStatus> {
  const pid = readPid(projectRoot);

  const socketPath = getSocketPath(projectRoot);
  if (!existsSync(socketPath)) {
    return { running: false, pid: pid ?? undefined };
  }

  const token = readToken(projectRoot);
  if (!token) {
    return { running: false, pid: pid ?? undefined };
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
      return { running: false, pid: pid ?? undefined };
    }

    const data = await response.json() as { uptime?: number; version?: string; webPort?: number; autoReactBudget?: AutoReactBudgetEntry[] };
    return {
      running: true,
      pid: pid ?? undefined,
      socketPath,
      uptime: data.uptime,
      version: data.version,
      webPort: data.webPort,
      autoReactBudget: data.autoReactBudget,
    };
  } catch {
    return { running: false, pid: pid ?? undefined };
  }
}

/**
 * Send a graceful shutdown request to the daemon via its socket.
 * Returns true if the shutdown request was accepted.
 */
export async function requestShutdown(projectRoot: string): Promise<boolean> {
  const socketPath = getSocketPath(projectRoot);
  const token = readToken(projectRoot);
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
 * Wait for the daemon socket to become available.
 * Polls every 100ms up to the given timeout.
 * Returns true if the daemon responded to a health check within the timeout.
 */
export async function waitForDaemon(projectRoot: string, timeoutMs: number = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await checkDaemonHealth(projectRoot);
    if (status.running) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

// ─── Legacy start lock (deprecated — superseded by flock) ────────────────────
// Kept for test compatibility. Not used in production code.

/** Maximum age (in ms) for a startup lock before it's considered stale. */
const LOCK_STALE_MS = 30_000;

/**
 * @deprecated Superseded by acquireDaemonLock (flock). Kept for test compatibility.
 */
export function acquireStartLock(projectRoot: string): boolean {
  const lockPath = getStartLockPath(projectRoot);
  mkdirSync(getDaemonDir(projectRoot), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;

      try {
        const stat = statSync(lockPath);
        const age = Date.now() - stat.mtimeMs;
        if (age > LOCK_STALE_MS) {
          try { unlinkSync(lockPath); } catch { /* another process may have removed it */ }
          continue;
        }
      } catch {
        continue;
      }

      return false;
    }
  }

  return false;
}

/**
 * @deprecated Superseded by releaseDaemonLock (flock). Kept for test compatibility.
 */
export function releaseStartLock(projectRoot: string): void {
  try {
    unlinkSync(getStartLockPath(projectRoot));
  } catch {
    // Lock already removed — fine
  }
}

// ─── flock(2) + fcntl(2) singleton enforcement ─────────────────────────────

// flock(2) constants from sys/file.h
const LOCK_EX = 2;  // exclusive lock
const LOCK_NB = 4;  // non-blocking

// fcntl(2) constants
const F_SETFD = 2;
// FD_CLOEXEC = 1, but we pass 0 to clear it

/** Lazy-loaded native flock/fcntl functions via Bun FFI. */
let nativeFlock: ((fd: number, operation: number) => number) | undefined;
let nativeFcntl: ((fd: number, cmd: number, arg: number) => number) | undefined;

/**
 * Initialize native FFI bindings for flock(2) and fcntl(2).
 * Lazy-loaded on first call to either function.
 *
 * Uses Bun FFI because fd-lock (npm) depends on fs-native-extensions which
 * calls uv_get_osfhandle — unsupported in Bun v1.3.11.
 * See: https://github.com/oven-sh/bun/issues/18546
 */
function ensureNativeBindings(): void {
  if (nativeFlock) return;
  const { dlopen, FFIType } = require('bun:ffi');
  const libName = process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6';
  const lib = dlopen(libName, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  nativeFlock = lib.symbols.flock as (fd: number, operation: number) => number;
  nativeFcntl = lib.symbols.fcntl as (fd: number, cmd: number, arg: number) => number;
}

/** Call flock(2) via Bun FFI. Returns true if the lock was acquired/operation succeeded. */
function tryFlock(fd: number, operation: number): boolean {
  ensureNativeBindings();
  return nativeFlock!(fd, operation) === 0;
}

/**
 * Clear O_CLOEXEC on a file descriptor so it survives exec().
 * Used when passing a lock fd to a forked daemon child process.
 */
export function clearCloexec(fd: number): void {
  ensureNativeBindings();
  const result = nativeFcntl!(fd, F_SETFD, 0);
  if (result !== 0) {
    throw new Error(`fcntl(F_SETFD, 0) failed on fd ${fd}`);
  }
}

/**
 * Acquire a BLOCKING exclusive flock on the daemon lock file.
 * Blocks until the lock is available (i.e., the current holder exits).
 * Used by daemon stop to wait for daemon exit without polling.
 *
 * @param timeoutMs - Maximum time to wait. Returns false on timeout.
 */
export function blockingFlock(projectRoot: string, timeoutMs: number): { fd: number } | null {
  const lockPath = getDaemonLockPath(projectRoot);
  if (!existsSync(lockPath)) return null;

  const fd = openSync(lockPath, constants.O_RDWR);

  // Use a blocking flock with a timer-based timeout.
  // We race the flock against a timeout by attempting it in a tight
  // retry loop with short sleeps. True blocking flock(LOCK_EX) without
  // LOCK_NB would block the entire Bun event loop with no timeout,
  // so we use non-blocking attempts with backoff instead.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (tryFlock(fd, LOCK_EX | LOCK_NB)) {
      return { fd };
    }
    // Bun.sleepSync is synchronous and doesn't block the event loop
    // the way a true blocking flock would. 50ms polling is acceptable
    // for a stop command that runs at most once.
    Bun.sleepSync(50);
  }

  closeSync(fd);
  return null;
}

/**
 * Try to acquire an exclusive daemon lock using flock(2).
 *
 * This is the SOLE singleton enforcement mechanism. The lock is held for
 * the daemon's entire lifetime via an open file descriptor. When the daemon
 * exits — cleanly, via SIGTERM, SIGKILL, or crash — the OS automatically
 * releases the lock. No stale-lock cleanup needed.
 *
 * Returns the file descriptor on success (caller must keep it open),
 * or null if another daemon holds the lock.
 */
export function acquireDaemonLock(projectRoot: string): number | null {
  const lockPath = getDaemonLockPath(projectRoot);
  mkdirSync(getDaemonDir(projectRoot), { recursive: true });

  // Open (or create) the lock file
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR, 0o644);

  try {
    // Try non-blocking exclusive lock
    if (!tryFlock(fd, LOCK_EX | LOCK_NB)) {
      closeSync(fd);
      return null;
    }

    // Write our PID for diagnostics (not used for enforcement — flock handles that).
    // Use the path (not the fd) so the file is truncated and written from position 0.
    // Writing via fd after ftruncate would leave null bytes because the file offset
    // isn't reset. The lock is held on our fd's open file description — writing via
    // a separate open()/write()/close() does not release it.
    writeFileSync(lockPath, String(process.pid));

    return fd;
  } catch {
    closeSync(fd);
    return null;
  }
}

/**
 * Release the daemon lock by closing the file descriptor.
 * The OS releases the flock automatically when the fd is closed.
 */
export function releaseDaemonLock(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // fd may already be closed
  }
}
