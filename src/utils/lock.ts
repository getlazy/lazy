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
import { join } from 'path';
import { pathExists } from './fs';

export interface LockInfo {
  pid: number;
  started_at: string;
  command: string;
}

const LOCK_FILENAME = '.lazy-lock';

/**
 * Get the lock file path for a worktree directory.
 */
export function getLockPath(worktreePath: string): string {
  return join(worktreePath, LOCK_FILENAME);
}

/**
 * Check if a process is still running by sending signal 0.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
      // Corrupt lock file — remove it
      await removeLock(worktreePath);
      return null;
    }

    // Check if the owning process is still alive
    if (!isProcessRunning(lock.pid)) {
      // Stale lock — process has exited, clean up
      await removeLock(worktreePath);
      return null;
    }

    return lock;
  } catch {
    // Corrupt or unreadable lock file — remove it
    await removeLock(worktreePath);
    return null;
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

  const lock: LockInfo = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    command,
  };

  const lockPath = getLockPath(worktreePath);
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf-8');
}

/**
 * Remove the lock file for the given worktree.
 * Safe to call even if no lock exists.
 */
export async function removeLock(worktreePath: string): Promise<void> {
  const lockPath = getLockPath(worktreePath);
  try {
    await stat(lockPath);
    await unlink(lockPath);
  } catch {
    // Best effort — lock file may already be gone
  }
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
