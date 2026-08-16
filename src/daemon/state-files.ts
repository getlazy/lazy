/**
 * Daemon state-file integrity: inspection (for `lazy doctor`) and self-repair
 * (run by the daemon itself).
 *
 * WHY THIS EXISTS
 * ---------------
 * A daemon's `lazy.pid` and `lazy.sock` can be deleted while the daemon is
 * running fine. That used to happen through `cleanupStaleFiles` — a losing
 * `lazy daemon start` deleted the incumbent's files — and the ownership guard
 * added there closes that specific hole. But the failure mode itself is not
 * lazy's alone to cause: a `rm`, a tmp reaper, an over-eager cleanup script or
 * an older lazy build can do the same thing, and the result is a daemon that
 * holds its lock, serves its web port, and is unreachable over its unix socket
 * because the socket file that names it no longer exists.
 *
 * A unix socket file only exists while a listener holds it, so it cannot be put
 * back by hand — before this, the only recovery was killing a healthy daemon,
 * which strands every running builder, agent and pair session on a dead proxy
 * address. So the daemon repairs its own state files: it rewrites `lazy.pid`
 * and re-binds the unix listener, which re-creates the socket.
 *
 * `inspectDaemonStateFiles` is the read-only half, used by `lazy doctor` to
 * recognise the signature (lock held, files missing) and say so in plain terms
 * instead of repeating "daemon is not running".
 */

import { stat } from 'fs/promises';
import { logger } from '../utils/logger';
import { getPidPath, getSocketPath } from './paths';
import {
  isProcessAlive,
  probeDaemonLockSync,
  readDaemonLockPid,
  readPid,
  readWebPort,
  writePid,
  type DaemonLockState,
} from './lifecycle';

/** How often the daemon re-checks that its own state files still exist. */
const STATE_FILE_WATCH_INTERVAL_MS = 5_000;

/** Timeout for the "is anything listening on the recorded web port?" probe. */
const WEB_PORT_PROBE_MS = 500;

export interface DaemonStateFileReport {
  /** Verdict of the `daemon.lock` flock probe — the authoritative liveness signal. */
  lock: DaemonLockState;
  /** PID recorded in `daemon.lock` by whichever process won the lock. */
  lockPid: number | null;
  /** Whether `lazy.pid` exists (and its contents, when parseable). */
  pidFilePresent: boolean;
  pid: number | null;
  /** Whether `lazy.sock` exists. Absent ⇒ the daemon is unreachable over the socket. */
  socketFilePresent: boolean;
  /** Last web port the daemon recorded, if any. */
  webPort: number | null;
  /**
   * Whether something answered on the recorded web port. Null when there is no
   * recorded port to probe. Corroborating only — a foreign process on that port
   * would also answer, which is why `lock` is the primary signal.
   */
  webPortListening: boolean | null;
  /**
   * The wedge signature: a live daemon owns this dir (lock held) but at least
   * one of its two state files has been deleted underneath it.
   */
  filesDeletedUnderLiveDaemon: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // EACCES or similar: we cannot read the dir, so we cannot claim the file is
    // absent. Treating it as present is the conservative direction — it never
    // manufactures a "files were deleted" diagnosis out of a permissions issue.
    return true;
  }
}

/** Probe whether anything is listening on a local TCP port. */
async function probeLocalPort(port: number): Promise<boolean> {
  try {
    // Any HTTP response at all (200, 401, 404) proves a listener. Only a
    // connection-level failure means nothing is there.
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(WEB_PORT_PROBE_MS) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-only inspection of a project's daemon state files. Does not repair
 * anything and never creates a file (in particular it never creates
 * `daemon.lock`, whose absence must stay a "no conclusion").
 */
export async function inspectDaemonStateFiles(projectRoot: string): Promise<DaemonStateFileReport> {
  const lock = probeDaemonLockSync(projectRoot);
  const [pidFilePresent, socketFilePresent] = await Promise.all([
    exists(getPidPath(projectRoot)),
    exists(getSocketPath(projectRoot)),
  ]);
  const webPort = readWebPort(projectRoot);
  const webPortListening = webPort === null ? null : await probeLocalPort(webPort);

  return {
    lock,
    lockPid: readDaemonLockPid(projectRoot),
    pidFilePresent,
    pid: readPid(projectRoot),
    socketFilePresent,
    webPort,
    webPortListening,
    filesDeletedUnderLiveDaemon: lock === 'held' && (!pidFilePresent || !socketFilePresent),
  };
}

export interface DaemonStateFileWatchOptions {
  projectRoot: string;
  /** The socket path this daemon actually bound (tests pass an explicit one). */
  socketPath: string;
  /**
   * Re-create the unix socket by re-binding the listener. Must stop the old
   * listener BEFORE binding the new one: Bun unlinks the socket path when a
   * unix listener stops, so binding first and stopping second would delete the
   * file we just re-created.
   */
  rebindSocket: () => void;
  /** Override the poll interval (tests). */
  intervalMs?: number;
}

/**
 * Watch this daemon's own state files and put back anything that disappears.
 *
 * Repairs, in order of what is possible:
 *   - `lazy.pid` missing or naming a different/dead process → rewrite it.
 *   - `lazy.sock` missing → re-bind the unix listener, which re-creates it.
 *
 * Only ever runs inside the daemon that owns these files, so there is no
 * ownership question here — it is the answer to one.
 *
 * Returns a stop function.
 */
export function startDaemonStateFileWatch(options: DaemonStateFileWatchOptions): () => void {
  const { projectRoot, socketPath, rebindSocket } = options;
  const intervalMs = options.intervalMs ?? STATE_FILE_WATCH_INTERVAL_MS;
  let checking = false;

  const check = async (): Promise<void> => {
    if (checking) return;
    checking = true;
    try {
      const pidPath = getPidPath(projectRoot);
      const recorded = readPid(projectRoot);
      if (recorded !== process.pid) {
        // Either the file is gone, or it names someone else. Both mean the
        // record of who owns this dir no longer points at us, and we are the
        // process holding the lock — so we are the correct answer.
        const what = recorded === null ? 'missing' : `stale (names PID ${recorded})`;
        logger.warn(
          `Daemon PID file was ${what} — re-writing ${pidPath} with PID ${process.pid}. ` +
          `Something deleted this daemon's state files while it was running.`,
        );
        writePid(projectRoot, process.pid);
      }

      if (!(await exists(socketPath))) {
        logger.warn(
          `Daemon socket file ${socketPath} was deleted while the daemon was running — ` +
          `re-binding the unix listener so the CLI can reach the daemon again.`,
        );
        try {
          rebindSocket();
          logger.info(`Daemon socket re-created at ${socketPath}`);
        } catch (err) {
          // Leave the daemon running: the web/TCP listener and the proxy are
          // unaffected, and the next tick retries. Surface it so a persistent
          // failure is diagnosable rather than a silent unreachable daemon.
          logger.error(
            `Failed to re-bind the daemon unix socket at ${socketPath}: ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `The daemon is running but unreachable over its socket — 'lazy doctor' explains the state.`,
          );
        }
      }
    } catch (err) {
      // A watch tick must never take the daemon down.
      logger.debug(
        `Daemon state-file check failed (will retry): ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      checking = false;
    }
  };

  const timer = setInterval(() => { void check(); }, intervalMs);
  return () => clearInterval(timer);
}

/**
 * Whether a recorded pid is a live process — re-exported so callers that only
 * import this module can interpret a report without also importing lifecycle.
 */
export function reportedPidAlive(report: DaemonStateFileReport): boolean {
  return report.pid !== null && isProcessAlive(report.pid);
}
