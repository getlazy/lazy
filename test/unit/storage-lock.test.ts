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
