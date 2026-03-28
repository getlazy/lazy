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

  test('acquireLock throws clear error when worktree directory does not exist', () => {
    // INVARIANT: Lock acquisition must fail fast with a clear error when the
    // directory doesn't exist, not throw a raw ENOENT that confuses users.
    expect(() => {
      acquireLock(worktreePath, 'test-command');
    }).toThrow('Cannot acquire lock: worktree directory does not exist');
    expect(() => {
      acquireLock(worktreePath, 'test-command');
    }).toThrow(worktreePath);
  });

  test('acquireLock succeeds when worktree directory exists', () => {
    // Create the worktree directory
    Bun.write(join(worktreePath, '.gitkeep'), '');

    expect(() => {
      acquireLock(worktreePath, 'test-command');
    }).not.toThrow();

    const lock = readLock(worktreePath);
    expect(lock).not.toBeNull();
    expect(lock?.command).toBe('test-command');
    expect(lock?.pid).toBe(process.pid);
  });

  test('checkLock returns null when no lock exists', () => {
    Bun.write(join(worktreePath, '.gitkeep'), '');
    const lock = checkLock(worktreePath);
    expect(lock).toBeNull();
  });

  test('checkLock returns null when current process holds the lock', () => {
    Bun.write(join(worktreePath, '.gitkeep'), '');
    acquireLock(worktreePath, 'test-command');

    const lock = checkLock(worktreePath);
    expect(lock).toBeNull(); // Re-entrant safe
  });

  test('removeLock removes the lock file', () => {
    Bun.write(join(worktreePath, '.gitkeep'), '');
    acquireLock(worktreePath, 'test-command');

    let lock = readLock(worktreePath);
    expect(lock).not.toBeNull();

    removeLock(worktreePath);

    lock = readLock(worktreePath);
    expect(lock).toBeNull();
  });

  test('removeLock is safe to call when no lock exists', () => {
    Bun.write(join(worktreePath, '.gitkeep'), '');
    expect(() => {
      removeLock(worktreePath);
    }).not.toThrow();
  });
});
