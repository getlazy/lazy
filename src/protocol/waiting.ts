/**
 * `waiting.json` — the protocol-dir marker for "this task's agent is BLOCKED on
 * another task right now".
 *
 * The daemon is the only writer: it knows, from the per-session MCP token that
 * authenticated the call, exactly which task is making an in-flight blocking
 * call (`lazy_wait`, `lazy_ask`) and for how long. Nothing here is derived from
 * agent output.
 *
 * It lives in the protocol dir (`~/.lazy/protocol/<task-id>/`) rather than in
 * daemon memory because the READERS are other processes: `lazy list`, `lazy
 * status`, `lazy show`, `lazy watch` all derive the working substate from that
 * directory (see src/utils/working-substate.ts). A file is the seam that already
 * exists between the daemon and every read surface.
 *
 * STALENESS: the daemon clears each entry when its call settles, so the normal
 * case is self-cleaning. A daemon that is SIGKILLed mid-wait cannot clear
 * anything, so the file also carries the writing daemon's pid — a reader that
 * finds that pid dead treats the whole file as stale and reports no waits, which
 * degrades to the pre-existing `working(agent)` rather than to a lie.
 */

import { join } from 'path';
import { mkdir, readFile, writeFile, rename, unlink } from 'fs/promises';
import { logger } from '../utils/logger';

/** One in-flight blocking call. */
export interface WaitingEntry {
  /** Wait id — matches the persisted `WaitInterval.id`. */
  id: string;
  /** MCP tool that is blocking, e.g. `lazy_wait`. */
  tool: string;
  /** Task ids being waited on. */
  targets: string[];
  /** Display labels (code or short id) for `targets`, same order. */
  labels: string[];
  /** ISO timestamp the call started. */
  started_at: string;
}

export interface WaitingFile {
  version: 1;
  /** Pid of the daemon that wrote this file — the staleness tripwire. */
  daemon_pid: number;
  /** In-flight waits. An empty list is written as a deleted file, never as `[]`. */
  waits: WaitingEntry[];
}

export const WAITING_FILE = 'waiting.json';

function waitingPath(protoDir: string): string {
  return join(protoDir, WAITING_FILE);
}

/**
 * Write the in-flight wait set for a task. Atomic (temp file + rename) so a
 * reader never sees a half-written file.
 */
export async function writeWaitingFile(protoDir: string, file: WaitingFile): Promise<void> {
  await mkdir(protoDir, { recursive: true });
  const target = waitingPath(protoDir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8');
  await rename(tmp, target);
}

/** Remove the marker (no waits in flight). Missing file is success. */
export async function clearWaitingFile(protoDir: string): Promise<void> {
  try {
    await unlink(waitingPath(protoDir));
  } catch (err) {
    // Already gone is the expected case whenever the last wait settles twice or
    // the protocol dir was torn down first — anything else is worth surfacing.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`waiting-file: failed to clear ${waitingPath(protoDir)}: ${(err as Error).message}`);
    }
  }
}

/** Whether a pid is currently alive. Signal 0 checks existence without signalling. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read the in-flight waits for a task.
 *
 * Returns `[]` for every "no trustworthy signal" case — missing file (normal),
 * corrupt file (logged), or a file left behind by a daemon that is no longer
 * running. Callers then render the task exactly as they did before this
 * existed, which is the right failure direction for a purely observational
 * signal.
 */
export async function readActiveWaits(protoDir: string): Promise<WaitingEntry[]> {
  const filePath = waitingPath(protoDir);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    logger.warn(`waiting-file: failed to read ${filePath}: ${(err as Error).message}`);
    return [];
  }

  let parsed: WaitingFile;
  try {
    parsed = JSON.parse(raw) as WaitingFile;
  } catch (err) {
    logger.warn(`waiting-file: corrupt ${filePath}: ${(err as Error).message}`);
    return [];
  }

  if (!Array.isArray(parsed.waits) || parsed.waits.length === 0) return [];
  if (!pidAlive(parsed.daemon_pid)) return [];
  // Shape-check every entry rather than trusting the file: this is a read
  // surface for a file on disk, and a half-understood older/newer entry must
  // degrade to "no wait" instead of rendering `waiting on undefined`.
  return parsed.waits.filter(isWaitingEntry);
}

function isWaitingEntry(value: unknown): value is WaitingEntry {
  const e = value as Partial<WaitingEntry> | null;
  return (
    !!e &&
    typeof e.id === 'string' &&
    typeof e.tool === 'string' &&
    typeof e.started_at === 'string' &&
    Array.isArray(e.targets) &&
    Array.isArray(e.labels)
  );
}
