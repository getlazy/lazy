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
import { spawn } from './spawn';

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

/** True if a `ps`-reported process state denotes a zombie/defunct process. */
export function isZombieState(state: string): boolean {
  // 'Z' is the zombie/defunct code on both macOS and Linux ps output.
  return state.trim().startsWith('Z');
}

/**
 * Check if a process is alive AND able to hold the lock.
 *
 * `process.kill(pid, 0)` only tests whether the pid exists in the process
 * table — and a ZOMBIE (defunct) process, terminated but not yet reaped by its
 * parent, still answers it. A zombie holds no resources and will NEVER release
 * the storage lock, so treating it as "alive" deadlocks every future writer
 * forever (observed in the wild: a `lazy pair` child grabbed the lock, died,
 * and was left unreaped — the daemon then 500'd on every storage RPC). So we
 * additionally check the process state and treat a zombie as dead.
 */
export async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false; // No such process.
  }
  // Exists in the table — distinguish a live process from a zombie via `ps`.
  try {
    const proc = spawn(['ps', '-o', 'state=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return !isZombieState(out);
  } catch {
    // `ps` unavailable — be conservative and assume the holder is alive rather
    // than risk stealing a lock from a genuinely-running process.
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Describe the process currently holding the lock, for the failure message.
 *
 * Reads the lock file for the holder pid/acquired_at and asks `ps` for the
 * holder's command line (which, for a lazy daemon, includes the project path it
 * serves). Returns a human-readable one-liner. Best-effort: if the lock file is
 * gone or `ps` is unavailable, it degrades to whatever it could learn so the
 * error is never made worse by this diagnostic. Only called on the terminal
 * acquire failure — not on the hot path — so the sync file read is acceptable.
 */
async function describeLockHolder(lockPath: string): Promise<string> {
  let pid: number | null = null;
  let acquiredAt: string | null = null;
  try {
    const content = readFileSync(lockPath, 'utf-8');
    const lock = JSON.parse(content) as Partial<StorageLockFile>;
    if (typeof lock.pid === 'number') pid = lock.pid;
    if (typeof lock.acquired_at === 'string') acquiredAt = lock.acquired_at;
  } catch {
    // Lock file vanished or is unparseable — the holder may have just released.
    return 'holder unknown (lock file could not be read — the holder may have just released it; retry)';
  }
  if (pid === null) return 'holder unknown (lock file has no pid)';

  let command: string | null = null;
  try {
    const proc = spawn(['ps', '-o', 'command=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const trimmed = out.trim();
    if (trimmed) command = trimmed;
  } catch {
    // `ps` unavailable — pid alone still lets the user identify the holder.
  }

  const parts = [`held by process pid ${pid}`];
  if (acquiredAt) parts.push(`since ${acquiredAt}`);
  if (command) parts.push(`(${command})`);
  return parts.join(' ');
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
      if (await this.tryAcquire()) {
        this.depth = 1;
        return;
      }
      // Add random jitter to prevent multiple processes from retrying in lockstep
      const jitter = Math.floor(Math.random() * RETRY_JITTER_MS);
      await sleep(RETRY_DELAY_MS + jitter);
    }

    const holder = await describeLockHolder(this.lockPath);
    throw new Error(
      `Failed to acquire storage lock after ${MAX_ATTEMPTS} attempts. ` +
        `Lock file: ${this.lockPath} — ${holder}.\n` +
        `If that holder is a different project's daemon, your storage paths collide: ` +
        `check [storage] external_path in lazy.toml — two projects must not share one store. ` +
        `Run 'lazy daemon list' to see which project each daemon serves.`
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
  private async tryAcquire(): Promise<boolean> {
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

      // Check if the owning process is still alive (zombies count as dead)
      if (await isProcessRunning(lock.pid)) {
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
