/**
 * Pairing lock utilities for `lazy pair`.
 *
 * When a human pairs on a task (interactive Claude Code session in the worktree),
 * a pairing lock file is placed inside the worktree's .lazy directory:
 *   <worktree>/.lazy-task-sandbox/pairing-lock
 *
 * While this lock exists, automated commands (start, unblock, accept, reject,
 * resume) and the reconciler must refuse to operate on the task.
 *
 * The lock file contains JSON with the PID of the pairing process, allowing
 * stale lock detection when the process has exited.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

export interface PairingLockInfo {
  pid: number;
  started_at: string;
  user: string;
}

const PAIRING_LOCK_FILENAME = 'pairing-lock';

/**
 * Get the pairing lock file path for a worktree directory.
 * Lives inside .lazy-task-sandbox/ so it doesn't appear as an untracked git file.
 */
export function getPairingLockPath(worktreePath: string): string {
  return join(worktreePath, '.lazy-task-sandbox', PAIRING_LOCK_FILENAME);
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
 * Read and validate an existing pairing lock file.
 * Returns the lock info if the lock is valid (process still running), null otherwise.
 * Automatically cleans up stale locks from dead processes.
 */
export function readPairingLock(worktreePath: string): PairingLockInfo | null {
  const lockPath = getPairingLockPath(worktreePath);

  if (!existsSync(lockPath)) {
    return null;
  }

  try {
    const content = readFileSync(lockPath, 'utf-8');
    const lock: PairingLockInfo = JSON.parse(content);

    // Validate required fields
    if (!lock.pid || !lock.started_at) {
      // Corrupt lock file — remove it
      removePairingLock(worktreePath);
      return null;
    }

    // Check if the owning process is still alive
    if (!isProcessRunning(lock.pid)) {
      // Stale lock — process has exited, clean up
      removePairingLock(worktreePath);
      return null;
    }

    return lock;
  } catch {
    // Corrupt or unreadable lock file — remove it
    removePairingLock(worktreePath);
    return null;
  }
}

/**
 * Acquire a pairing lock for the given worktree.
 * Creates the lock file with current process info.
 */
export function acquirePairingLock(worktreePath: string): void {
  const lock: PairingLockInfo = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    user: process.env.USER || process.env.USERNAME || 'unknown',
  };

  const lockPath = getPairingLockPath(worktreePath);
  const lockDir = join(worktreePath, '.lazy');
  if (!existsSync(lockDir)) {
    mkdirSync(lockDir, { recursive: true });
  }
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf-8');
}

/**
 * Remove the pairing lock file for the given worktree.
 * Safe to call even if no lock exists.
 */
export function removePairingLock(worktreePath: string): void {
  const lockPath = getPairingLockPath(worktreePath);
  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
  } catch {
    // Best effort — lock file may already be gone
  }
}

/**
 * Check if a pairing lock exists and is held by another process.
 * Returns the lock info if locked by another process, null if free.
 *
 * Unlike the regular worktree lock, pairing locks are NOT re-entrant —
 * the same process should not pair twice on the same task.
 */
export function checkPairingLock(worktreePath: string): PairingLockInfo | null {
  return readPairingLock(worktreePath);
}

/**
 * Force-remove a pairing lock regardless of PID.
 * Used by `lazy pair --unlock` to clear stale/orphaned locks.
 */
export function forceRemovePairingLock(worktreePath: string): boolean {
  const lockPath = getPairingLockPath(worktreePath);
  if (!existsSync(lockPath)) {
    return false;
  }
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}
