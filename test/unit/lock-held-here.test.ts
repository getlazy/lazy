/**
 * INVARIANT: this process's record of a worktree lock it holds
 * (`lockHeldHere`) is cleared ONLY by its own release (`removeLock`), never by
 * the state of the lock FILE. The file is in the worktree, which a task's
 * agent can write: overwriting it with `{}` (or a dead pid) made the next
 * `checkLock` — which runs on every reconciler tick, in auto-deliver and in
 * the Pair/Chat preflight — remove the file AND the record, so a member's
 * entry saw no lock while the daemon still held one.
 */

import { test, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireLock, checkLock, getLockPath, lockHeldHere, removeLock } from '../../src/utils/lock';

test('a corrupted lock file does not erase the holder\'s own record; only its release does', async () => {
  const worktree = await mkdtemp(join(tmpdir(), 'lock-held-here-'));
  try {
    await acquireLock(worktree, 'lazy chat (web)');
    for (const planted of ['{}', 'not json', JSON.stringify({ pid: 2 ** 22 - 7, started_at: 'x', command: 'dead' })]) {
      await writeFile(getLockPath(worktree), planted);
      await checkLock(worktree); // what every reconciler tick does
      expect(lockHeldHere(worktree)).toBe('lazy chat (web)');
    }
    await removeLock(worktree);
    expect(lockHeldHere(worktree)).toBeNull();
  } finally {
    await removeLock(worktree);
    await rm(worktree, { recursive: true, force: true });
  }
});
