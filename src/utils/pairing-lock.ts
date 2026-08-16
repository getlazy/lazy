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
import { dirname, join } from 'path';
import { checkHolderSync, selfIdentitySync, type StartTimeSource } from './process-identity';

export interface PairingLockInfo {
  pid: number;
  started_at: string;
  user: string;
  /**
   * Identity of the pairing process, captured at acquire time. A pid alone
   * cannot distinguish the holder from whatever the OS later recycles that
   * number to — see src/utils/process-identity.ts. Optional: locks written by
   * older lazy versions have neither, and fall back to the backstops there.
   */
  holder_started_at?: string;
  holder_start_source?: StartTimeSource;
  holder_command?: string;
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

    // Is the RECORDED HOLDER still there? "Something is alive at that pid" is
    // not the same question: pids get recycled, and a pairing lock left behind
    // by a killed `lazy pair` would otherwise block every automated command on
    // that task forever once the OS handed its number to an unrelated program.
    const verdict = checkHolderSync({
      pid: lock.pid,
      started: lock.holder_started_at ?? null,
      startedSource: lock.holder_start_source ?? null,
      acquiredAt: lock.started_at ?? null,
    });
    if (!verdict.alive) {
      // Stale lock — holder is gone (exited, defunct, or its pid recycled).
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
  const self = selfIdentitySync();
  const lock: PairingLockInfo = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    user: process.env.USER || process.env.USERNAME || 'unknown',
    ...(self?.started && self.startedSource
      ? { holder_started_at: self.started, holder_start_source: self.startedSource }
      : {}),
    ...(self?.command ? { holder_command: self.command } : {}),
  };

  const lockPath = getPairingLockPath(worktreePath);
  // Derive the directory from the lock path itself. This used to hardcode
  // `<worktree>/.lazy`, which stopped being the lock's directory when the lock
  // moved into `.lazy-task-sandbox/` — so on a worktree whose sandbox had not
  // been created yet, pairing died with a raw ENOENT from writeFileSync.
  const lockDir = dirname(lockPath);
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
