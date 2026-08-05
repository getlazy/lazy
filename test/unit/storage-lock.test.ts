import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StorageLock } from '../../src/utils/storage-lock';

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
    // project's daemon is self-diagnosing — not just "here is a path". Simulate a
    // live foreign holder by writing a lock file owned by pid 1 (always alive).
    mkdirSync(lockDir, { recursive: true });
    const { writeFileSync } = await import('fs');
    writeFileSync(
      join(lockDir, '.storage-lock'),
      JSON.stringify({ pid: 1, acquired_at: new Date().toISOString() }, null, 2) + '\n',
    );

    const lock = new StorageLock(tempDir, lockDir);
    await expect(lock.acquire()).rejects.toThrow('held by process pid 1');
    await expect(lock.acquire()).rejects.toThrow('external_path');
  }, 20_000); // ~6s: runs the full 50-attempt retry loop before failing.

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
