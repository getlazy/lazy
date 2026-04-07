import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, readLock, removeLock, checkLock } from '../../src/utils/lock';

describe('lock utilities', () => {
  let tempDir: string;
  let worktreePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lazy-lock-test-'));
    worktreePath = join(tempDir, 'worktree');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('acquireLock throws clear error when worktree directory does not exist', async () => {
    // INVARIANT: Lock acquisition must fail fast with a clear error when the
    // directory doesn't exist, not throw a raw ENOENT that confuses users.
    await expect(acquireLock(worktreePath, 'test-command')).rejects.toThrow('Cannot acquire lock: worktree directory does not exist');
    await expect(acquireLock(worktreePath, 'test-command')).rejects.toThrow(worktreePath);
  });

  test('acquireLock succeeds when worktree directory exists', async () => {
    // Create the worktree directory
    Bun.write(join(worktreePath, '.gitkeep'), '');

    await expect(acquireLock(worktreePath, 'test-command')).resolves.not.toThrow();

    const lock = await readLock(worktreePath);
    expect(lock).not.toBeNull();
    expect(lock?.command).toBe('test-command');
    expect(lock?.pid).toBe(process.pid);
  });

  test('checkLock returns null when no lock exists', async () => {
    Bun.write(join(worktreePath, '.gitkeep'), '');
    const lock = await checkLock(worktreePath);
    expect(lock).toBeNull();
  });

  test('checkLock returns null when current process holds the lock', async () => {
    Bun.write(join(worktreePath, '.gitkeep'), '');
    await acquireLock(worktreePath, 'test-command');

    const lock = await checkLock(worktreePath);
    expect(lock).toBeNull(); // Re-entrant safe
  });

  test('removeLock removes the lock file', async () => {
    Bun.write(join(worktreePath, '.gitkeep'), '');
    await acquireLock(worktreePath, 'test-command');

    let lock = await readLock(worktreePath);
    expect(lock).not.toBeNull();

    await removeLock(worktreePath);

    lock = await readLock(worktreePath);
    expect(lock).toBeNull();
  });

  test('removeLock is safe to call when no lock exists', async () => {
    Bun.write(join(worktreePath, '.gitkeep'), '');
    await expect(removeLock(worktreePath)).resolves.not.toThrow();
  });
});
