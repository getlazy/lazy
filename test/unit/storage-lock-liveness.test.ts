/**
 * Unit tests: storage-lock holder liveness, with zombie awareness.
 *
 * A PID-based lock must reclaim a lock held by a process that has died. The
 * subtle case: a ZOMBIE (defunct, terminated-but-unreaped) process still
 * answers `process.kill(pid, 0)`, so a naive "kill(0) succeeds → alive" check
 * keeps the lock forever. Observed in the wild: a `lazy pair` child grabbed the
 * storage lock, died, was left unreaped, and the daemon then 500'd on every
 * storage RPC ("Failed to acquire storage lock after 50 attempts").
 */

import { describe, test, expect } from 'bun:test';
import { isProcessRunning, isZombieState } from '../../src/utils/storage-lock';

describe('isZombieState', () => {
  test('treats Z-prefixed ps states as zombie', () => {
    expect(isZombieState('Z')).toBe(true);
    expect(isZombieState('Z+')).toBe(true);
    expect(isZombieState('  Z+ \n')).toBe(true); // trims whitespace
  });

  test('treats live states as not-zombie', () => {
    expect(isZombieState('S')).toBe(false);
    expect(isZombieState('S+')).toBe(false);
    expect(isZombieState('R')).toBe(false);
    expect(isZombieState('')).toBe(false);
  });
});

describe('isProcessRunning', () => {
  test('reports the current (live, non-zombie) process as running', async () => {
    expect(await isProcessRunning(process.pid)).toBe(true);
  });

  // A pid well above the OS max never exists → kill(0) throws → not running.
  test('reports a non-existent pid as not running', async () => {
    expect(await isProcessRunning(2_000_000)).toBe(false);
  });
});
