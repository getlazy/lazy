import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, existsSync, chmodSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StorageLock } from '../../src/utils/storage-lock';
import { logger } from '../../src/utils/logger';

describe('StorageLock', () => {
  let tempDir: string;
  let lockDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lazy-storage-lock-test-'));
    lockDir = join(tempDir, 'lock-dir');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('acquire throws clear error when lock directory does not exist', async () => {
    // INVARIANT: Lock acquisition must fail fast with a clear error when the
    // directory doesn't exist, not retry 50 times and then throw a generic error.
    const lock = new StorageLock(tempDir, lockDir);

    await expect(lock.acquire()).rejects.toThrow('Storage lock directory does not exist');
    await expect(lock.acquire()).rejects.toThrow(lockDir);
    await expect(lock.acquire()).rejects.toThrow("Has 'lazy init' been run?");
  });

  test('acquire succeeds when lock directory exists', async () => {
    mkdirSync(lockDir, { recursive: true });

    const lock = new StorageLock(tempDir, lockDir);

    await expect(lock.acquire()).resolves.toBeUndefined();
    lock.release();
  });

  test('acquire failure names the holder pid, not just the lock path', async () => {
    // INVARIANT: the storage-lock failure must identify WHO holds the lock (pid +
    // command), so a misconfigured external_path that collides with another
    // project's daemon is self-diagnosing — not just "here is a path".
    //
    // The holder here is THIS process's parent-of-record: a lock file carrying
    // our own verified identity under a pid that is not ours. This test used to
    // write pid 1 and assert the acquire failed — that assertion encoded the
    // PID-REUSE BUG (a live process that never took the lock read as a holder
    // forever). See test/unit/storage-lock-pid-reuse.test.ts.
    mkdirSync(lockDir, { recursive: true });
    const { writeFileSync } = await import('fs');
    const { spawn } = await import('../../src/utils/spawn');
    const { readProcessIdentity } = await import('../../src/utils/process-identity');

    // A real, live holder whose recorded identity matches what the OS reports.
    const holder = spawn(['/bin/sleep', '120'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      const identity = await readProcessIdentity(holder.pid);
      writeFileSync(
        join(lockDir, '.storage-lock'),
        JSON.stringify(
          {
            pid: holder.pid,
            acquired_at: new Date().toISOString(),
            holder_started_at: identity?.started,
            holder_start_source: identity?.startedSource,
          },
          null,
          2,
        ) + '\n',
      );

      const lock = new StorageLock(tempDir, lockDir);
      await expect(lock.acquire()).rejects.toThrow(`held by process pid ${holder.pid}`);
      await expect(lock.acquire()).rejects.toThrow('external_path');
    } finally {
      holder.kill('SIGKILL');
    }
  }, 40_000); // ~12s: runs the full 50-attempt retry loop twice before failing.

  test('lock is re-entrant within same process', async () => {
    mkdirSync(lockDir, { recursive: true });

    const lock = new StorageLock(tempDir, lockDir);

    await lock.acquire();
    await lock.acquire(); // Should not block
    await lock.acquire(); // Should not block

    lock.release();
    lock.release();
    lock.release();
  });

  test('withLock executes function while holding lock', async () => {
    mkdirSync(lockDir, { recursive: true });

    const lock = new StorageLock(tempDir, lockDir);

    let executed = false;
    const result = await lock.withLock(async () => {
      executed = true;
      return 'test-result';
    });

    expect(executed).toBe(true);
    expect(result).toBe('test-result');
  });

  test('withLock releases lock even if function throws', async () => {
    mkdirSync(lockDir, { recursive: true });

    const lock = new StorageLock(tempDir, lockDir);

    await expect(
      lock.withLock(async () => {
        throw new Error('test error');
      })
    ).rejects.toThrow('test error');

    // Should be able to acquire again
    await expect(lock.acquire()).resolves.toBeUndefined();
    lock.release();
  });

  /**
   * INVARIANT: the lock file is removed by the LAST in-process holder to let
   * go, not by whichever instance happens to release first.
   *
   * The file is PID-keyed, so a second StorageLock on the same store inside one
   * process (the daemon's long-lived storage plus anything that opens its own
   * handle) sails through `tryAcquire` on the "same pid" path without writing
   * anything. Its release used to unlink the file anyway — deleting the lock a
   * DIFFERENT, still-holding instance had taken, which silently drops
   * cross-process exclusion on a store the daemon believes it owns.
   */
  test('a second instance does not delete the lock file the first one holds', async () => {
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, '.storage-lock');

    const first = new StorageLock(tempDir, lockDir);
    const second = new StorageLock(tempDir, lockDir);

    await first.acquire();
    expect(existsSync(lockPath)).toBe(true);

    // Same pid, so this re-enters the file lock without creating anything.
    await second.acquire();
    second.release();

    expect(existsSync(lockPath)).toBe(true); // first still holds it

    first.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  /**
   * INVARIANT: a lock file the process could not remove is never silently
   * forgotten. A lingering file with our own pid is self-acquired forever by
   * this process (the "same pid" path) while every OTHER process queues on it,
   * and `lazy doctor` reads it as a holder that never let go — so the failure
   * has to reach a log, not an empty catch. ENOENT is the exception: the file
   * already being gone is the outcome release wanted.
   */
  test('a failed unlink is surfaced, not swallowed', async () => {
    mkdirSync(lockDir, { recursive: true });
    const lock = new StorageLock(tempDir, lockDir);
    await lock.acquire();

    const warnings: string[] = [];
    const originalWarn = logger.warn.bind(logger);
    (logger as unknown as { warn: (m: string) => void }).warn = (m: string) => { warnings.push(m); };
    // Make the directory read-only so the unlink fails with EPERM/EACCES.
    chmodSync(lockDir, 0o500);
    try {
      lock.release();
    } finally {
      chmodSync(lockDir, 0o700);
      (logger as unknown as { warn: (m: string) => void }).warn = originalWarn;
    }

    expect(warnings.join('\n')).toContain('.storage-lock');
    // Depth still went to zero — a stuck file must not leave the instance
    // thinking it holds a lock it no longer serves.
    await expect(lock.acquire()).resolves.toBeUndefined();
    lock.release();
  });

  /**
   * INVARIANT: `acquired_at` describes the hold that is happening NOW.
   *
   * A leftover file carrying our own pid is claimed with a fresh timestamp —
   * its old one belongs to a hold that already ended, and every reader of this
   * file treats the age as "how long the current holder has been sitting here".
   * While an instance really is holding, the timestamp is left alone: resetting
   * it per re-entry would keep a stuck holder looking permanently fresh.
   */
  test('claiming a leftover lock file refreshes acquired_at; re-entry does not', async () => {
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, '.storage-lock');
    const stale = new Date(Date.now() - 30 * 60_000).toISOString();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquired_at: stale }, null, 2) + '\n');

    const lock = new StorageLock(tempDir, lockDir);
    await lock.acquire();

    const claimed = JSON.parse(readFileSync(lockPath, 'utf-8')).acquired_at as string;
    expect(claimed).not.toBe(stale);
    expect(Date.now() - new Date(claimed).getTime()).toBeLessThan(60_000);

    // A second instance re-entering our hold must leave that timestamp alone.
    const second = new StorageLock(tempDir, lockDir);
    await second.acquire();
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).acquired_at).toBe(claimed);
    second.release();
    lock.release();
  });

  test('multiple releases are safe', () => {
    const lock = new StorageLock(tempDir, lockDir);

    // Should not throw even if never acquired
    expect(() => {
      lock.release();
      lock.release();
      lock.release();
    }).not.toThrow();
  });
});
