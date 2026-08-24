/**
 * `progress.json` — the protocol-dir marker for "here is what this task's agent
 * says it is doing right now".
 *
 * A `working` task is opaque even after the working-substate work: `working(agent)`
 * tells an observer that the agent is alive, never what it is up to. This is the
 * complementary lightweight channel — the agent posts a short human-readable line
 * ("running migration 3/7", "reproducing the bug") via `lazy_update_progress`, and
 * every surface that already renders the substate folds it in.
 *
 * EPHEMERAL, LATEST-WINS. This is runtime session state, exactly like the working
 * substate itself — NOT task history. It never reaches Storage: a progress line is
 * worthless five minutes after it was written, and permanent storage of a
 * self-reported status blurb would be a second, worse turn log.
 *
 * It lives in the protocol dir (`~/.lazy/protocol/<task-id>/`) rather than in
 * daemon memory for the same reason `waiting.json` does: the READERS are other
 * processes (`lazy list`, `status`, `show`, `watch`, and the MCP list/active
 * tools), and the protocol dir is the seam that already exists between whoever
 * knows and everyone who renders.
 *
 * STALENESS — a message from a finished turn must never linger, and that is
 * guaranteed structurally rather than by remembering to clean up:
 *   1. `writeCommand` deletes this file. Every turn begins with a command, so a
 *      new turn always begins with no progress. (Doing it there, rather than at
 *      each of the eight command call sites, is what makes it a guarantee.)
 *   2. The substate is only rendered at all while a `status.json` exists and the
 *      run is alive — i.e. inside a live turn.
 *   3. `cleanProtocol` includes it in teardown.
 *   4. The writing process's pid is recorded; a reader that finds it dead treats
 *      the file as a lie and reports no progress.
 */

import { join } from 'path';
import { mkdir, readFile, writeFile, rename, unlink } from 'fs/promises';
import { logger } from '../utils/logger';

export const PROGRESS_FILE = 'progress.json';

/**
 * Display cap for a progress line, in characters.
 *
 * This label is rendered inside a `working(...)` cell in `lazy list` output, so
 * it has to stay on one line next to a task goal. Over-length messages are
 * TRUNCATED, never rejected: a progress post is fire-and-forget from the agent's
 * side, and failing its call over a display concern would be the one way this
 * feature could hurt a turn.
 */
export const MAX_PROGRESS_MESSAGE_LENGTH = 120;

export interface ProgressFile {
  version: 1;
  /** Pid of the process that wrote this file — the staleness tripwire. */
  writer_pid: number;
  /** The agent's progress line, already normalized and truncated. */
  message: string;
  /** ISO timestamp the message was recorded. */
  recorded_at: string;
}

/** What a reader gets back: the current progress line, or null. */
export interface ProgressEntry {
  message: string;
  recorded_at: string;
}

function progressPath(protoDir: string): string {
  return join(protoDir, PROGRESS_FILE);
}

/**
 * Normalize an agent-supplied progress line for display: collapse all whitespace
 * (a multi-line paste must not break a table cell) and truncate to
 * {@link MAX_PROGRESS_MESSAGE_LENGTH} with an ellipsis.
 *
 * Returns the empty string when nothing printable remains — callers treat that
 * as "clear the marker" rather than writing a blank line.
 */
export function normalizeProgressMessage(raw: string): { message: string; truncated: boolean } {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_PROGRESS_MESSAGE_LENGTH) return { message: collapsed, truncated: false };
  return {
    message: `${collapsed.slice(0, MAX_PROGRESS_MESSAGE_LENGTH - 1).trimEnd()}…`,
    truncated: true,
  };
}

/**
 * Write the current progress line for a task. Atomic (temp file + rename) so a
 * reader never sees a half-written file.
 */
export async function writeProgressFile(protoDir: string, file: ProgressFile): Promise<void> {
  await mkdir(protoDir, { recursive: true });
  const target = progressPath(protoDir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8');
  await rename(tmp, target);
}

/** Remove the marker (no progress to report). Missing file is success. */
export async function clearProgressFile(protoDir: string): Promise<void> {
  try {
    await unlink(progressPath(protoDir));
  } catch (err) {
    // Already gone is the expected case — the turn-start clear and the teardown
    // clear both run unconditionally. Anything else is worth surfacing.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`progress-file: failed to clear ${progressPath(protoDir)}: ${(err as Error).message}`);
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
 * Read the current progress line for a task.
 *
 * Returns null for every "no trustworthy signal" case — missing file (normal),
 * corrupt file (logged), a file left behind by a process that is no longer
 * running, or a shape this version does not understand. Callers then render the
 * task exactly as they did before this existed, which is the right failure
 * direction for a purely observational signal.
 */
export async function readTaskProgress(protoDir: string): Promise<ProgressEntry | null> {
  const filePath = progressPath(protoDir);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    logger.warn(`progress-file: failed to read ${filePath}: ${(err as Error).message}`);
    return null;
  }

  let parsed: ProgressFile;
  try {
    parsed = JSON.parse(raw) as ProgressFile;
  } catch (err) {
    logger.warn(`progress-file: corrupt ${filePath}: ${(err as Error).message}`);
    return null;
  }

  // Shape-check rather than trusting the file: this is a read surface for a file
  // on disk, and a half-understood older/newer entry must degrade to "no
  // progress" instead of rendering `working(agent: undefined)`.
  if (typeof parsed.message !== 'string' || parsed.message.trim() === '') return null;
  if (typeof parsed.recorded_at !== 'string') return null;
  if (!pidAlive(parsed.writer_pid)) return null;

  // Truncate on read as well as on write: the cap is a display invariant, and a
  // file written by an older/other build must not be able to break a table cell.
  return { message: normalizeProgressMessage(parsed.message).message, recorded_at: parsed.recorded_at };
}
