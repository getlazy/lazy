/**
 * Lock file utilities to prevent concurrent sessions for the same task.
 *
 * Lock files are placed in the worktree directory:
 *   <datadir>/worktrees/<task-short-id>/.lazy-lock
 *
 * The lock file contains JSON with the PID of the owning process, allowing
 * stale lock detection when the process has exited.
 */

import { stat, readFile, writeFile, unlink } from 'fs/promises';
import { join, resolve } from 'path';
import { pathExists } from './fs';
import { checkHolder, selfIdentity, type StartTimeSource } from './process-identity';

export interface LockInfo {
  pid: number;
  started_at: string;
  /** The lazy command that took the lock, e.g. 'lazy start'. Display only. */
  command: string;
  /**
   * Identity of the holder OS process, captured at acquire time. A pid alone
   * cannot distinguish the holder from whatever the OS later recycles that
   * number to — see src/utils/process-identity.ts. Optional: locks written by
   * older lazy versions have neither, and fall back to the backstops there.
   */
  holder_started_at?: string;
  holder_start_source?: StartTimeSource;
  holder_command?: string;
}

const LOCK_FILENAME = '.lazy-lock';

/**
 * The locks THIS process has taken and not yet removed, by worktree, with the
 * command each was taken for. The lock FILE lives in the worktree, which a
 * task's agent can write, so its contents — command, pid, all of it — can be
 * planted; this record cannot. See {@link lockHeldHere}.
 */
const heldHere = new Map<string, string>();

/**
 * The command this process took the worktree's lock for, or null when this
 * process holds no lock on it — read from memory, never from the lock file.
 */
export function lockHeldHere(worktreePath: string): string | null {
  return heldHere.get(resolve(worktreePath)) ?? null;
}

/**
 * Get the lock file path for a worktree directory.
 */
export function getLockPath(worktreePath: string): string {
  return join(worktreePath, LOCK_FILENAME);
}

/**
 * Read and validate an existing lock file.
 * Returns the lock info if the lock is valid (process still running), null otherwise.
 * Automatically cleans up stale locks from dead processes.
 */
export async function readLock(worktreePath: string): Promise<LockInfo | null> {
  const lockPath = getLockPath(worktreePath);

  if (!(await pathExists(lockPath))) {
    return null;
  }

  try {
    const content = await readFile(lockPath, 'utf-8');
    const lock: LockInfo = JSON.parse(content);

    // Validate required fields
    if (!lock.pid || !lock.started_at || !lock.command) {
      // Corrupt lock file — remove the FILE (never this process's record of
      // its own lock: see unlinkLockFile).
      await unlinkLockFile(worktreePath);
      return null;
    }

    // Is the RECORDED HOLDER still there? "Something is alive at that pid" is
    // not the same question: pids get recycled, and a lock whose holder died
    // without releasing it would otherwise look held forever once the OS handed
    // its number to an unrelated program.
    const verdict = await checkHolder({
      pid: lock.pid,
      started: lock.holder_started_at ?? null,
      startedSource: lock.holder_start_source ?? null,
      acquiredAt: lock.started_at ?? null,
    });
    if (!verdict.alive) {
      // Stale lock — holder is gone (exited, defunct, or its pid recycled).
      await unlinkLockFile(worktreePath);
      return null;
    }

    return lock;
  } catch {
    // Corrupt or unreadable lock file — remove it
    await unlinkLockFile(worktreePath);
    return null;
  }
}

/**
 * Remove the lock FILE only. What stale- and corrupt-file cleanup does: the
 * file is in the worktree, which a task's agent can write, so its state — a
 * `{}`, a dead pid — says nothing about a lock this process still holds, and
 * must never clear this process's record of it ({@link lockHeldHere}). Only
 * the holder's own release ({@link removeLock}) does that.
 */
async function unlinkLockFile(worktreePath: string): Promise<void> {
  const lockPath = getLockPath(worktreePath);
  try {
    await stat(lockPath);
    await unlink(lockPath);
  } catch {
    // Best effort — lock file may already be gone
  }
}

/**
 * Acquire a lock for the given worktree.
 * Creates the lock file with current process info.
 * The worktree directory must already exist.
 */
export async function acquireLock(worktreePath: string, command: string): Promise<void> {
  if (!(await pathExists(worktreePath))) {
    throw new Error(`Cannot acquire lock: worktree directory does not exist: ${worktreePath}`);
  }

  const self = await selfIdentity();
  const lock: LockInfo = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    command,
    ...(self?.started && self.startedSource
      ? { holder_started_at: self.started, holder_start_source: self.startedSource }
      : {}),
    ...(self?.command ? { holder_command: self.command } : {}),
  };

  const lockPath = getLockPath(worktreePath);
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf-8');
  heldHere.set(resolve(worktreePath), command);
}

/**
 * Remove the lock file for the given worktree.
 * Safe to call even if no lock exists.
 */
export async function removeLock(worktreePath: string): Promise<void> {
  heldHere.delete(resolve(worktreePath));
  await unlinkLockFile(worktreePath);
}

/**
 * Check if a lock exists and is held by another process.
 * Returns the lock info if locked by another process, null if free.
 *
 * If the current process holds the lock, returns null (re-entrant safe).
 */
export async function checkLock(worktreePath: string): Promise<LockInfo | null> {
  const lock = await readLock(worktreePath);

  if (!lock) {
    return null;
  }

  // Allow re-entrant locking by same process
  if (lock.pid === process.pid) {
    return null;
  }

  return lock;
}
