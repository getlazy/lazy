/**
 * Global file-system lock for the storage layer.
 *
 * Provides inter-process locking using a PID-based lock file at
 * <datadir>/.storage-lock, with stale lock detection (checks if the
 * owning process is still alive).
 *
 * Only WRITE operations need this lock. Read operations are safe without
 * it because all file writes use atomic rename (write to temp, rename
 * into place), so readers always see complete file content.
 *
 * The lock is re-entrant within the same process (uses a depth counter)
 * so nested storage calls don't deadlock.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, constants } from 'fs';
import { join, dirname } from 'path';
import { getDataDir } from '../cli/init';

const LOCK_FILENAME = '.storage-lock';

/** Maximum number of attempts to acquire the lock */
const MAX_ATTEMPTS = 50;

/** Base delay between lock acquisition attempts in milliseconds */
const RETRY_DELAY_MS = 100;

/** Maximum jitter added to retry delay to prevent thundering herd */
const RETRY_JITTER_MS = 50;

interface StorageLockFile {
  pid: number;
  acquired_at: string;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Storage lock manager.
 *
 * One instance per FileStorage. Uses a file-system lock for inter-process
 * exclusion and a depth counter for intra-process re-entrancy.
 */
export class StorageLock {
  private readonly lockPath: string;
  private depth: number = 0;

  constructor(lazyRoot: string, lockDir?: string) {
    this.lockPath = lockDir
      ? join(lockDir, LOCK_FILENAME)
      : join(lazyRoot, getDataDir(lazyRoot), LOCK_FILENAME);
  }

  /**
   * Acquire the storage lock. Blocks (with retry) until acquired.
   *
   * Re-entrant: if the current process already holds the lock,
   * increments the depth counter without touching the file system.
   */
  async acquire(): Promise<void> {
    // Re-entrant: already held by this process in-memory
    if (this.depth > 0) {
      this.depth++;
      return;
    }

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (this.tryAcquire()) {
        this.depth = 1;
        return;
      }
      // Add random jitter to prevent multiple processes from retrying in lockstep
      const jitter = Math.floor(Math.random() * RETRY_JITTER_MS);
      await sleep(RETRY_DELAY_MS + jitter);
    }

    throw new Error(
      `Failed to acquire storage lock after ${MAX_ATTEMPTS} attempts. ` +
        `Lock file: ${this.lockPath}`
    );
  }

  /**
   * Release the storage lock. Decrements the depth counter and only
   * removes the lock file when depth reaches 0.
   */
  release(): void {
    if (this.depth <= 0) {
      return;
    }

    this.depth--;

    if (this.depth === 0) {
      try {
        if (existsSync(this.lockPath)) {
          unlinkSync(this.lockPath);
        }
      } catch {
        // Best effort — lock file may already be gone
      }
    }
  }

  /**
   * Run a function while holding the storage lock.
   * Guarantees the lock is released even if the function throws.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Try to acquire the file-system lock once.
   * Returns true if acquired, false if held by another live process.
   *
   * Uses O_EXCL for atomic create-or-fail to prevent TOCTOU races where
   * two processes both see "no lock file" and both write their own.
   */
  private tryAcquire(): boolean {
    // Precondition: lock directory must exist
    const lockDir = dirname(this.lockPath);
    if (!existsSync(lockDir)) {
      throw new Error(
        `Storage lock directory does not exist: ${lockDir}. Has 'lazy init' been run?`
      );
    }

    const lockData: StorageLockFile = {
      pid: process.pid,
      acquired_at: new Date().toISOString(),
    };
    const lockContent = JSON.stringify(lockData, null, 2) + '\n';

    // Fast path: try atomic create with O_EXCL — fails if file already exists.
    // This eliminates the TOCTOU race in the old check-then-write approach.
    try {
      const fd = openSync(this.lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try {
        writeFileSync(fd, lockContent, 'utf-8');
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err: unknown) {
      // EEXIST means the lock file already exists — check if it's stale
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'EEXIST') {
        return false; // Unexpected error — treat as failed acquisition
      }
    }

    // Lock file exists — check if we own it or if it's stale
    try {
      const content = readFileSync(this.lockPath, 'utf-8');
      const lock: StorageLockFile = JSON.parse(content);

      // If the current process already holds the file lock, allow it
      if (lock.pid === process.pid) {
        return true;
      }

      // Check if the owning process is still alive
      if (isProcessRunning(lock.pid)) {
        return false; // Lock held by a live process
      }

      // Stale lock — process is dead. Remove and retry atomically.
      // Another process might also be trying to claim this stale lock,
      // so we remove-then-create with O_EXCL to race safely.
      try {
        unlinkSync(this.lockPath);
      } catch {
        // Someone else already removed it — that's fine, we'll retry next attempt
        return false;
      }

      // Try atomic create again after removing stale lock
      try {
        const fd = openSync(this.lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
        try {
          writeFileSync(fd, lockContent, 'utf-8');
        } finally {
          closeSync(fd);
        }
        return true;
      } catch {
        return false; // Another process got it first — retry on next attempt
      }
    } catch {
      return false;
    }
  }
}
