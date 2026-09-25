/**
 * Daemon state-file integrity: inspection (for `lazy doctor`) and self-repair
 * (run by the daemon itself).
 *
 * WHY THIS EXISTS
 * ---------------
 * A daemon's `lazy.pid` can be deleted while the daemon is running fine. That
 * used to happen through `cleanupStaleFiles` — a losing `lazy daemon start`
 * deleted the incumbent's files — and the ownership guard added there closes
 * that specific hole. But the failure mode itself is not lazy's alone to
 * cause: a `rm`, a tmp reaper, an over-eager cleanup script or an older lazy
 * build can do the same thing, and the result is a daemon that holds its lock
 * and serves its TCP port while the file-based fallbacks (liveness when the
 * lock verdict is 'unknown', `lazy doctor`'s reporting) no longer name it.
 * So the daemon repairs its own state file: it rewrites `lazy.pid`.
 *
 * (Pre-v0.22 daemons also had a unix socket file with the same exposure —
 * worse, in fact, since a deleted socket file made the daemon unreachable and
 * could not be put back by hand. The TCP port is now the only transport
 * (drop-unix-socket): a bound listener cannot be deleted out from under the
 * daemon, so the PID file is the only state left to repair.)
 *
 * `inspectDaemonStateFiles` is the read-only half, used by `lazy doctor` to
 * recognise the signature (lock held, file missing) and say so in plain terms
 * instead of repeating "daemon is not running".
 */

import { stat } from 'fs/promises';
import { logger } from '../utils/logger';
import { getPidPath } from './paths';
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
  /** Last web port the daemon recorded, if any. */
  webPort: number | null;
  /**
   * Whether something answered on the recorded web port. Null when there is no
   * recorded port to probe. Corroborating only — a foreign process on that port
   * would also answer, which is why `lock` is the primary signal.
   */
  webPortListening: boolean | null;
  /**
   * The wedge signature: a live daemon owns this dir (lock held) but its PID
   * file has been deleted underneath it.
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
  const pidFilePresent = await exists(getPidPath(projectRoot));
  const webPort = readWebPort(projectRoot);
  const webPortListening = webPort === null ? null : await probeLocalPort(webPort);

  return {
    lock,
    lockPid: readDaemonLockPid(projectRoot),
    pidFilePresent,
    pid: readPid(projectRoot),
    webPort,
    webPortListening,
    filesDeletedUnderLiveDaemon: lock === 'held' && !pidFilePresent,
  };
}

export interface DaemonStateFileWatchOptions {
  projectRoot: string;
  /** Override the poll interval (tests). */
  intervalMs?: number;
}

/**
 * Watch this daemon's own state files and put back anything that disappears.
 *
 * The one repair left in the TCP-only world: `lazy.pid` missing or naming a
 * different/dead process → rewrite it. (The unix-socket re-bind this watch was
 * born for went away with the socket — a bound TCP listener cannot be deleted
 * out from under the daemon.)
 *
 * Only ever runs inside the daemon that owns these files, so there is no
 * ownership question here — it is the answer to one.
 *
 * Returns a stop function.
 */
export function startDaemonStateFileWatch(options: DaemonStateFileWatchOptions): () => void {
  const { projectRoot } = options;
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
