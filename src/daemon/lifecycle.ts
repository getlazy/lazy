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
import { getPidPath, getSocketPath, getTokenPath, getWebPortPath, getDaemonDir, getDaemonLockPath, getStartLockPath } from './paths';

export interface AutoReactBudgetEntry {
  project: string;
  used: number;
  /** Effective cap for today (reflects any today-only override). */
  limit: number;
  tasksAtLimit: string[];
  /** Epoch ms when today's budget window resets (next local midnight). */
  resetAt?: number;
  /** Whether auto-react is globally paused. */
  paused?: boolean;
  /** Epoch ms when an active pause auto-resumes, if bounded. */
  pauseExpiresAt?: number;
  /** True when a today-only cap override is in effect. */
  capOverridden?: boolean;
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  socketPath?: string;
  uptime?: number;
  version?: string;
  /**
   * Opaque id minted fresh every time a daemon process starts. Two readings
   * carrying DIFFERENT ids came from different daemon processes — which is
   * exactly the question a child that holds a daemon-issued address needs
   * answered (see src/daemon/generation.ts for why this and not pid/uptime).
   * Absent when the daemon predates this field.
   */
  instanceId?: string;
  /** UTC ISO timestamp the daemon binary was built, or 'dev' when run from source. */
  buildTime?: string;
  /** Git short SHA of the source the daemon is running (dev mode only; null/absent
   *  for compiled binaries). Used to detect a stale daemon vs the working tree. */
  codeSha?: string;
  webPort?: number;
  /** Interface the web dashboard bound to (= config.server.bind). Used to
   *  print a dashboard URL that points at the real interface, not `localhost`. */
  bindHost?: string;
  autoReactBudget?: AutoReactBudgetEntry[];
  /** Anthropic passthrough proxy status, when a `[proxy]` section is configured. */
  proxy?: DaemonProxyStatus;
}

/** Live proxy status surfaced in `lazy daemon status` / GET /daemon/status. */
export interface DaemonProxyStatus {
  /** False only when `[proxy] enabled = false` — agent traffic connects directly. */
  enabled: boolean;
  /** Whether the proxy server is currently listening. */
  running: boolean;
  /** Bind address. */
  bind: string;
  /** Actual bound port (OS-assigned when `[proxy] port` was omitted), or null if not running. */
  port: number | null;
  /** Full base URL agents route through (`http://bind:port`), or null if not running. */
  address: string | null;
  /** Upstream the proxy forwards to. */
  upstream: string;
  /** Number of configured failover targets. */
  fallbacks: number;
  /** Whether the mechanistic policy engine is enforcing (vs pure passthrough/audit). */
  policyEnforce: boolean;
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
 * Read the last web port the daemon successfully bound. Returns null when the
 * marker is missing or unparseable — the caller falls back to the configured
 * or default port.
 *
 * Sync is intentional: this is one-shot daemon-startup code (called before the
 * TCP bind, alongside readToken) and never runs on a hot path. Mirrors readToken.
 */
export function readWebPort(projectRoot: string): number | null {
  const portPath = getWebPortPath(projectRoot);
  if (!existsSync(portPath)) return null;
  try {
    const port = Number.parseInt(readFileSync(portPath, 'utf-8').trim(), 10);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Persist the web port the daemon just bound so the next start prefers it.
 * Keeping the port stable across restarts is what lets a running builder's
 * mounted daemon MCP config (target = host.docker.internal:<webPort>) stay
 * valid — otherwise a restart that lands on a different port permanently breaks
 * the builder's tool calls (they hit a stray/foreign daemon and get 401).
 *
 * Best-effort: a failure to persist only means the next start falls back to the
 * default-port scan, so it must never block startup. Sync mirrors generateToken
 * and runs once during startup.
 */
export function writeWebPort(projectRoot: string, port: number): void {
  try {
    mkdirSync(getDaemonDir(projectRoot), { recursive: true });
    writeFileSync(getWebPortPath(projectRoot), String(port), { mode: 0o600 });
  } catch {
    // Non-fatal — see doc comment. Next start just re-scans from the default.
  }
}

/** Result of probing `daemon.lock` for a live holder. See probeDaemonLockSync. */
export type DaemonLockState =
  /** Something holds the lock — a live daemon owns this project's daemon dir. */
  | 'held'
  /** We acquired the lock, so nothing held it — no daemon owns this dir. */
  | 'free'
  /** No lock file, or flock unavailable — no conclusion either way. */
  | 'unknown';

/**
 * Probe whether this project's `daemon.lock` is currently held by a live process.
 *
 * This is the ONE signal about daemon liveness that a process which is not the
 * daemon cannot forge or destroy: the lock is held on an open file descriptor
 * for the daemon's entire lifetime, the OS releases it on exit/crash/SIGKILL,
 * and flock never preempts a held lock. Unlinking the lock FILE does not
 * release the lock either — so even a hostile racer cannot make a running
 * daemon look dead through it.
 *
 * Never creates the lock file: an absent lock file means "no conclusion"
 * (daemons started under LAZY_TEST=1 skip the lock, and dirs predating flock
 * enforcement have none), not "free".
 *
 * flock conflicts even within a single process when two separate file
 * descriptors are used, so this probe correctly reports 'held' when it runs
 * inside the daemon that holds the lock. That is why the daemon's own cleanup
 * path must identify itself (see cleanupOwnDaemonFiles) rather than go through
 * the guarded cleanup.
 *
 * Sync mirrors the rest of this module (one-shot CLI/startup code, never a hot
 * path); `probeDaemonLock` in ./process-identity.ts is the async equivalent for
 * the registry, which scans many dirs at once and takes a dir rather than a
 * project root.
 */
export function probeDaemonLockSync(projectRoot: string): DaemonLockState {
  const lockPath = getDaemonLockPath(projectRoot);
  let fd: number;
  try {
    fd = openSync(lockPath, constants.O_RDWR);
  } catch {
    // ENOENT / EACCES — nothing can be concluded from the lock.
    return 'unknown';
  }
  try {
    return tryFlockNonBlocking(fd) ? 'free' : 'held';
  } catch {
    // FFI/dlopen unavailable on this platform — no conclusion.
    return 'unknown';
  } finally {
    // Closing releases anything the probe just acquired.
    try { closeSync(fd); } catch { /* fd already gone; nothing to release */ }
  }
}

/**
 * Read the PID recorded inside `daemon.lock` by acquireDaemonLock.
 *
 * The lock holder writes its pid there for diagnostics. Unlike `lazy.pid` this
 * record is only ever written by a process that actually won the lock, which
 * makes it the recoverable source of "who owns this daemon dir" when `lazy.pid`
 * has been deleted underneath a running daemon.
 */
export function readDaemonLockPid(projectRoot: string): number | null {
  const lockPath = getDaemonLockPath(projectRoot);
  if (!existsSync(lockPath)) return null;
  try {
    const pid = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Outcome of a guarded {@link cleanupStaleFiles} call. */
export type CleanupOutcome =
  /** The files were stale and have been removed. */
  | 'removed'
  /** There was nothing to remove. */
  | 'nothing-to-remove'
  /** Refused: a live process holds the daemon lock for this dir. */
  | 'refused-lock-held'
  /** Refused: the recorded PID belongs to a process that is still alive. */
  | 'refused-pid-alive';

/** Unlink the PID and socket files, no questions asked. Internal. */
function unlinkStateFiles(projectRoot: string): CleanupOutcome {
  const pidPath = getPidPath(projectRoot);
  const socketPath = getSocketPath(projectRoot);
  let removed = false;

  if (existsSync(pidPath)) {
    removed = true;
    try { unlinkSync(pidPath); } catch { /* ignore — another process may have removed it */ }
  }
  if (existsSync(socketPath)) {
    removed = true;
    try { unlinkSync(socketPath); } catch { /* ignore — another process may have removed it */ }
  }
  return removed ? 'removed' : 'nothing-to-remove';
}

/**
 * Remove STALE daemon files (PID, socket) — only after proving they are stale.
 *
 * WHY THE GUARD EXISTS: this function used to take a projectRoot and nothing
 * else, so it had no notion of WHOSE files it was deleting; "stale" was assumed
 * by each caller. A `lazy daemon start` that then LOST the singleton race had
 * already deleted the incumbent's `lazy.pid` and `lazy.sock`, and because the
 * old liveness check read exactly those two files, every later command
 * concluded "dead", cleaned up again, and tried to start a daemon that could
 * never win the lock — a permanent wedge against a daemon that was running
 * fine, with no recovery short of killing it.
 *
 * So staleness is now ESTABLISHED here, not asserted by the caller:
 *   - the daemon lock is held by a live process → refuse (a daemon owns this dir)
 *   - the recorded PID is alive → refuse (something is using these files)
 *
 * Refusing is cheap and safe in the wrong direction: a leftover PID/socket file
 * no longer makes a dead daemon look alive (isDaemonRunning prefers the lock)
 * and a starting daemon unlinks a stale socket and overwrites the PID file
 * itself. A wrongly-permitted delete, by contrast, wedges the project. When in
 * doubt, refuse.
 *
 * The daemon removing its OWN files (clean shutdown, failed-start teardown)
 * must use {@link cleanupOwnDaemonFiles} — this guard would refuse it, since
 * the daemon holds its own lock and its own PID is alive.
 */
export function cleanupStaleFiles(projectRoot: string): CleanupOutcome {
  if (probeDaemonLockSync(projectRoot) === 'held') return 'refused-lock-held';

  const pid = readPid(projectRoot);
  if (pid !== null && isProcessAlive(pid)) return 'refused-pid-alive';

  return unlinkStateFiles(projectRoot);
}

/**
 * Remove the calling daemon's OWN PID and socket files, unconditionally.
 *
 * Only a daemon process may call this, and only for state it wrote itself:
 * clean shutdown (src/daemon/server.ts stop) and failed-start teardown. The
 * ownership guard in {@link cleanupStaleFiles} would refuse both — the daemon
 * holds the lock and its own PID is alive — which is exactly the guard working
 * as intended, so the owner says so explicitly instead of weakening it.
 */
export function cleanupOwnDaemonFiles(projectRoot: string): void {
  unlinkStateFiles(projectRoot);
}

/**
 * Unified daemon liveness check — the SINGLE function that all code paths
 * must use to determine whether the daemon is running.
 *
 * Primary signal: the flock on `daemon.lock`. Held → a daemon owns this dir and
 * is running. Free → nothing owns it, whatever files are lying around. This is
 * deliberately the same evidence `acquireDaemonLock` uses to refuse a second
 * daemon, so start and liveness can never disagree.
 *
 * INVARIANT: liveness must rest on evidence a losing racer cannot destroy.
 * Before this, the answer came from the socket file plus the PID file — the very
 * two files `cleanupStaleFiles` deletes. Deleting them therefore made a running
 * daemon look dead, and the wrong answer then re-triggered the cleanup that
 * caused it: a self-reinforcing wedge (see cleanupStaleFiles). An flock cannot
 * be faked, and unlinking the lock file does not release it.
 *
 * Fallback (lock verdict 'unknown' — no lock file, or flock unavailable on this
 * platform): the original three file-based signals, all of which must hold:
 *   1. Socket file exists (daemon created it on startup)
 *   2. Token file is readable (daemon created it on startup)
 *   3. PID file exists and process is alive (kill -0)
 * A dir with no lock file is either a daemon started under LAZY_TEST=1 (which
 * skips the lock) or one predating flock enforcement.
 *
 * Synchronous and fast (~microseconds): open + flock + close, or file stat +
 * kill(pid, 0). No network I/O.
 */
export function isDaemonRunning(projectRoot: string): boolean {
  const lock = probeDaemonLockSync(projectRoot);
  if (lock === 'held') return true;
  if (lock === 'free') return false;

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

    const data = await response.json() as { uptime?: number; version?: string; instanceId?: string; buildTime?: string; codeSha?: string; webPort?: number; bindHost?: string; autoReactBudget?: AutoReactBudgetEntry[]; proxy?: DaemonProxyStatus };
    return {
      running: true,
      pid: pid ?? undefined,
      socketPath,
      uptime: data.uptime,
      version: data.version,
      instanceId: data.instanceId,
      buildTime: data.buildTime,
      codeSha: data.codeSha,
      webPort: data.webPort,
      bindHost: data.bindHost,
      autoReactBudget: data.autoReactBudget,
      proxy: data.proxy,
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

/**
 * Wait for the daemon to fully STOP. Polls every 100ms up to the timeout;
 * returns true once stopped, false if still alive at the deadline.
 *
 * `requestShutdown` only delivers the shutdown request — the daemon process
 * exits asynchronously afterward. A caller that wants to start a FRESH daemon
 * (e.g. `lazy upgrade`) must wait for the old one to actually die first;
 * otherwise `ensureDaemon` sees a live process and skips the restart, leaving
 * no daemon running once the old one finishes exiting.
 *
 * `expectedPid` (the OLD daemon's pid, captured before shutdown) is the precise
 * signal and should always be passed for a restart. Without it we fall back to
 * `isDaemonRunning`, which is lock-based: the daemon releases its flock as the
 * very LAST step of exit, after removing its own socket/PID files, so the
 * fallback no longer returns "stopped" while the old daemon is still finishing
 * cleanup. (It used to key on the socket FILE, which the daemon removes while
 * still alive — returning then let a new daemon start whose freshly-written
 * socket/PID got clobbered by the old daemon's trailing cleanup.) Waiting on the
 * actual process death is still the precise signal and remains preferred, since
 * a daemon dir with no lock file falls back to those same file signals.
 */
export async function waitForDaemonStop(
  projectRoot: string,
  timeoutMs: number = 10000,
  expectedPid?: number | null,
): Promise<boolean> {
  const stopped = (): boolean =>
    expectedPid != null ? !isProcessAlive(expectedPid) : !isDaemonRunning(projectRoot);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (stopped()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return stopped();
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
 * Attempt a NON-BLOCKING exclusive flock on an already-open fd. Returns true if
 * the lock was acquired (i.e. nobody else held it), false if it is held.
 *
 * Exposed for the daemon registry's identity check: taking the lock on a
 * daemon dir's `daemon.lock` proves no daemon owns that dir, whatever its
 * pidfile says (see src/daemon/process-identity.ts). The caller owns the fd and
 * must close it to release anything this acquired. Throws if the native flock
 * bindings are unavailable, which callers treat as "no conclusion".
 */
export function tryFlockNonBlocking(fd: number): boolean {
  return tryFlock(fd, LOCK_EX | LOCK_NB);
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
 * How long {@link acquireDaemonLock} keeps retrying before it believes a
 * refusal. See the WHY in that function — this window exists to outlast a
 * liveness PROBE holding the lock, not to wait out an incumbent daemon.
 */
const ACQUIRE_RETRY_ATTEMPTS = 10;
const ACQUIRE_RETRY_DELAY_MS = 10;

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
 *
 * WHY THE RETRY IS NOT SUPERSTITION: liveness probing proves a lock is FREE by
 * momentarily taking it (probeDaemonLockSync here, probeDaemonLock in
 * ./process-identity.ts). That is the only way to ask flock(2) a question —
 * flock exposes no "who holds this?" query, and fcntl's F_GETLK answers about
 * POSIX record locks, which are a completely separate mechanism that does not
 * interact with flock at all. Probing therefore opens a microseconds-wide window
 * in which a legitimate start can be refused by a probe rather than by a daemon.
 * A single-shot attempt turns that into `Another daemon is already running` when
 * none is — the same class of false liveness verdict this module exists to
 * eliminate. And probes are frequent: every CLI invocation calls
 * isDaemonRunning, and the riskiest moment is exactly "no daemon running, two
 * commands starting at once" (a script, two terminals, a shell right after
 * boot).
 *
 * Retrying closes that window at zero cost to a REAL refusal: a genuine
 * incumbent holds its lock for its entire lifetime, so a true conflict still
 * returns null — just ~100ms later, once per losing start. Do not collapse this
 * back to one attempt.
 */
export function acquireDaemonLock(projectRoot: string): number | null {
  const lockPath = getDaemonLockPath(projectRoot);
  mkdirSync(getDaemonDir(projectRoot), { recursive: true });

  // Open (or create) the lock file
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR, 0o644);

  try {
    // Try non-blocking exclusive lock, retrying briefly (see WHY above).
    // Bun.sleepSync matches blockingFlock's approach: a truly blocking
    // flock(LOCK_EX) would stall the event loop with no timeout at all.
    let locked = false;
    for (let attempt = 0; attempt < ACQUIRE_RETRY_ATTEMPTS; attempt++) {
      if (tryFlock(fd, LOCK_EX | LOCK_NB)) {
        locked = true;
        break;
      }
      if (attempt < ACQUIRE_RETRY_ATTEMPTS - 1) Bun.sleepSync(ACQUIRE_RETRY_DELAY_MS);
    }
    if (!locked) {
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
