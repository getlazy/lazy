/**
 * Lock file utilities to prevent concurrent sessions for the same task.
 *
 * Lock files are placed in the worktree directory:
 *   <datadir>/worktrees/<task-short-id>/.lazy-lock
 *
 * The lock file contains JSON with the PID of the owning process, allowing
 * stale lock detection when the process has exited.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

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
export function readLock(worktreePath: string): LockInfo | null {
  const lockPath = getLockPath(worktreePath);

  if (!existsSync(lockPath)) {
    return null;
  }

  try {
    const content = readFileSync(lockPath, 'utf-8');
    const lock: LockInfo = JSON.parse(content);

    // Validate required fields
    if (!lock.pid || !lock.started_at || !lock.command) {
      // Corrupt lock file — remove it
      removeLock(worktreePath);
      return null;
    }

    // Check if the owning process is still alive
    if (!isProcessRunning(lock.pid)) {
      // Stale lock — process has exited, clean up
      removeLock(worktreePath);
      return null;
    }

    return lock;
  } catch {
    // Corrupt or unreadable lock file — remove it
    removeLock(worktreePath);
    return null;
  }
}

/**
 * Acquire a lock for the given worktree.
 * Creates the lock file with current process info.
 * The worktree directory must already exist.
 */
export function acquireLock(worktreePath: string, command: string): void {
  const lock: LockInfo = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    command,
  };

  const lockPath = getLockPath(worktreePath);
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf-8');
}

/**
 * Remove the lock file for the given worktree.
 * Safe to call even if no lock exists.
 */
export function removeLock(worktreePath: string): void {
  const lockPath = getLockPath(worktreePath);
  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
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
export function checkLock(worktreePath: string): LockInfo | null {
  const lock = readLock(worktreePath);

  if (!lock) {
    return null;
  }

  // Allow re-entrant locking by same process
  if (lock.pid === process.pid) {
    return null;
  }

  return lock;
}
