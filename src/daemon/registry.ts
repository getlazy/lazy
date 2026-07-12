/**
 * Daemon registry — host-wide enumeration of every lazy daemon.
 *
 * `lazy daemon status` is per-project: it inspects the daemon for the current
 * project root. The registry is the host-wide counterpart that powers the
 * operator tools `lazy daemon list` and `lazy daemon kill-stray`. It scans
 * every `~/.lazy/daemon/<slug>/` dir (see getDaemonBaseDir) and classifies what
 * it finds.
 *
 * WHY A SEPARATE MODULE
 * ---------------------
 * The slug — `<basename>-<sha256(root).slice(0,8)>` — is lossy: the full
 * project root cannot be recovered from a dir name. So at startup the daemon
 * writes its absolute root to the `root` file in its dir (see getRootPath /
 * writeDaemonRoot). The registry reads that file to display the real path AND
 * to decide whether the root still exists on disk. A live daemon whose root
 * directory has been deleted is a "stray" — the exact failure mode that leaked
 * 100+ orphan daemons squatting the web-port window.
 *
 * All filesystem access is async (fs/promises) per CLAUDE.md — this code can be
 * invoked from the daemon's own event loop, and a sync scan of ~1000 dirs would
 * stall it.
 */

import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import {
  getDaemonBaseDir,
  getDaemonDir,
  getRootPath,
  PID_FILE,
  SOCKET_FILE,
  TOKEN_FILE,
  ROOT_FILE,
} from './paths';
import { isProcessAlive } from './lifecycle';

/** Status payload returned by GET /daemon/status (subset we care about). */
interface DaemonStatusPayload {
  uptime?: number;
  version?: string;
  buildTime?: string;
  webPort?: number;
  bindHost?: string;
}

export interface DaemonRecord {
  /** Daemon dir name under the base dir (the project slug). */
  slug: string;
  /** Absolute path to the daemon dir. */
  dir: string;
  /** Project root the daemon serves, from the `root` file. Null if unknown
   *  (older daemon that predates the root file, or the file is unreadable). */
  projectRoot: string | null;
  /** PID from the pidfile, or null if missing/invalid. */
  pid: number | null;
  /** Whether `pid` names a live process. */
  alive: boolean;
  /** Whether the daemon recorded its root (the `root` file exists & is readable). */
  rootKnown: boolean;
  /** Whether the recorded project root still exists on disk. False when unknown. */
  rootExists: boolean;
  /**
   * A live daemon whose recorded project root no longer exists on disk. These
   * are the daemons `kill-stray` reaps. We never classify a daemon with an
   * unknown root as stray — we can't prove its root is gone, so we leave it be.
   */
  stray: boolean;
  /** Live status fields, present only when the daemon answered on its socket. */
  webPort?: number;
  bindHost?: string;
  version?: string;
  buildTime?: string;
  /** Uptime in ms, from the live socket status. */
  uptimeMs?: number;
  /** mtime of the pidfile in epoch ms — age fallback when the socket is silent. */
  pidMtimeMs?: number;
}

/**
 * Persist the project root the daemon serves so the registry can recover it.
 * Called once at daemon startup (alongside writePid). Best-effort: a failure to
 * write this marker must not block daemon startup — it only degrades `lazy
 * daemon list` to "(unknown root)" for this daemon, which the registry handles.
 */
export async function writeDaemonRoot(projectRoot: string): Promise<void> {
  try {
    await writeFile(getRootPath(projectRoot), projectRoot, { mode: 0o644 });
  } catch (err) {
    // Non-fatal: the daemon still runs; only operator tooling loses the path.
    const { logger } = await import('../utils/logger');
    logger.warn(`Could not write daemon root marker for ${projectRoot}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Read and parse the pidfile inside a daemon dir. Null if missing/invalid. */
async function readPidInDir(dir: string): Promise<number | null> {
  try {
    const content = (await readFile(join(dir, PID_FILE), 'utf-8')).trim();
    const pid = parseInt(content, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    // ENOENT (no pidfile) or unreadable — treat as "no pid".
    return null;
  }
}

/** Read the recorded project root inside a daemon dir. Null if missing. */
async function readRootInDir(dir: string): Promise<string | null> {
  try {
    const content = (await readFile(join(dir, ROOT_FILE), 'utf-8')).trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/** Whether a path exists on disk and is a directory. */
async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Query a daemon's live status over its unix socket. The /daemon/status
 * endpoint requires no auth and is documented to respond immediately, so this
 * is a cheap liveness+metadata probe. Returns null if the socket is absent or
 * the daemon doesn't answer (dead, hung, or starting up).
 */
async function fetchStatusInDir(dir: string): Promise<DaemonStatusPayload | null> {
  const socketPath = join(dir, SOCKET_FILE);
  if (!(await dirExists(dir))) return null;
  try {
    const response = await fetch('http://localhost/daemon/status', {
      unix: socketPath,
      // A wedged daemon should not hang the whole scan.
      signal: AbortSignal.timeout(1500),
    } as any);
    if (!response.ok) return null;
    return (await response.json()) as DaemonStatusPayload;
  } catch {
    // No socket / connection refused / timeout — not reachable.
    return null;
  }
}

/** mtime (epoch ms) of the pidfile, or undefined if it can't be stat'd. */
async function pidMtimeInDir(dir: string): Promise<number | undefined> {
  try {
    return (await stat(join(dir, PID_FILE))).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Enumerate every daemon dir under the base dir and classify each. Dirs are
 * scanned concurrently. Returns one record per dir (running or not) sorted by
 * slug; callers filter by `alive` / `stray` as needed.
 *
 * A missing base dir (no daemon ever started on this host) yields an empty list
 * — that is a normal condition, not an error.
 */
export async function enumerateDaemons(): Promise<DaemonRecord[]> {
  const baseDir = getDaemonBaseDir();

  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Failed to scan daemon directory ${baseDir}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const records = await Promise.all(
    entries.map(async (slug): Promise<DaemonRecord | null> => {
      const dir = join(baseDir, slug);
      if (!(await dirExists(dir))) return null; // skip stray files in the base dir

      const [pid, projectRoot] = await Promise.all([readPidInDir(dir), readRootInDir(dir)]);
      const alive = pid !== null && isProcessAlive(pid);
      const rootKnown = projectRoot !== null;
      const rootExists = rootKnown ? await dirExists(projectRoot!) : false;

      const record: DaemonRecord = {
        slug,
        dir,
        projectRoot,
        pid,
        alive,
        rootKnown,
        rootExists,
        stray: alive && rootKnown && !rootExists,
      };

      // Only probe the socket / stat the pidfile for live daemons — a dead-pid
      // dir has nothing to ask and shouldn't pay the connect timeout.
      if (alive) {
        const [status, mtime] = await Promise.all([fetchStatusInDir(dir), pidMtimeInDir(dir)]);
        if (status) {
          record.webPort = status.webPort;
          record.bindHost = status.bindHost;
          record.version = status.version;
          record.buildTime = status.buildTime;
          record.uptimeMs = status.uptime;
        }
        record.pidMtimeMs = mtime;
      }

      return record;
    }),
  );

  return records
    .filter((r): r is DaemonRecord => r !== null)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Reference for callers that want the dir for a known root (parity helper). */
export { getDaemonDir };
