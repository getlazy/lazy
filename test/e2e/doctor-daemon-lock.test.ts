/**
 * e2e: `lazy doctor` alongside a RUNNING daemon.
 *
 * INVARIANT: the daemon holds the storage lock from startup to shutdown — that
 * is what makes it the store's single writer (`getOrCreateStorage` in
 * src/daemon/rpc-handlers.ts). A held storage lock is therefore the NORMAL state
 * of every healthy lazy install, and doctor must run its storage-reading checks
 * anyway (it reads through the daemon, not through the file lock).
 *
 * The regression this guards: doctor's held-lock probe treated any lock held for
 * its whole observation window as "the store is busy", so with a daemon running
 * it skipped every check that reads task state — and, once the daemon had been
 * up for a minute, failed the sweep with "Storage lock is wedged". It surfaced as
 * test/e2e/daemon-capture-sweep.test.ts never seeing "All conversations
 * captured".
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { getSocketPath } from '../../src/daemon/paths';
import { storageDirFor } from '../helpers/storage';
import { expectOutput, expectOutputExcludes } from '../helpers/assertions';

/** The pid recorded in the store's `.storage-lock` — the daemon's, here. */
function lockHolderPid(root: string): number {
  const lock = JSON.parse(readFileSync(join(storageDirFor(root), '.storage-lock'), 'utf-8'));
  return lock.pid as number;
}

describe('lazy doctor with a running daemon', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('runs the storage-reading checks instead of skipping them', async () => {
    const pid = lockHolderPid(ctx.root);

    const result = await ctx.lazy(['doctor']);

    // The holder IS the daemon, and doctor says so rather than warning about it.
    expectOutput(result, `✓ Storage lock held by the daemon (pid ${pid}, as designed)`);
    expectOutputExcludes(result, 'the store is busy');
    expectOutputExcludes(result, 'Storage lock is wedged');

    // Nothing was skipped for the lock — these are the checks that read task
    // state through the daemon.
    expectOutputExcludes(result, '(skipped — storage lock held by');
    expectOutput(result, 'All conversations captured');
    expectOutput(result, 'Protected tasks resolvable');
  }, 60_000);

  /**
   * The reported symptom, exactly: a daemon that has been up long enough for
   * its lock to outlive the wedged-age threshold.
   *
   * The daemon takes the lock at startup and holds it for its whole lifetime,
   * so `acquired_at` is the daemon's start time — it grows without bound on a
   * healthy machine and says NOTHING about whether the store is stuck. Doctor
   * used to read it as the duration of one storage operation and declare
   * "Storage lock is wedged" on every install whose daemon had been up for more
   * than a minute, while that same daemon was serving accepts, comments and
   * unblocks normally. Observed live at 29 minutes of uptime.
   *
   * Aging the lock file is faithful to that state: the daemon holds the lock
   * in-process (depth counter) and never re-reads the file, so rewriting the
   * timestamp changes only what a reader sees — which is the whole bug.
   */
  test('does not call the lock wedged when the daemon has held it for half an hour', async () => {
    const lockPath = join(storageDirFor(ctx.root), '.storage-lock');
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
    const pid = lock.pid as number;
    lock.acquired_at = new Date(Date.now() - 29 * 60_000).toISOString();
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');

    const result = await ctx.lazy(['doctor']);

    expectOutputExcludes(result, 'Storage lock is wedged');
    expectOutputExcludes(result, 'will block on it until that process releases it or dies');
    expectOutput(result, `✓ Storage lock held by the daemon (pid ${pid}, as designed)`);
    // And the age did not cost the report its storage-reading checks either.
    expectOutputExcludes(result, '(skipped — storage lock held by');
  }, 60_000);

  /**
   * The other half of the split: a daemon that holds the lock and is NOT
   * reachable for storage reads is a real failure, and must not be waved
   * through by the "it's the daemon, so it's fine" branch.
   *
   * Deleting the socket file reproduces a state that happens in the wild (see
   * src/daemon/state-files.ts — a tmp reaper or an over-eager cleanup script):
   * the daemon is alive and still holds the storage lock, but nothing can
   * reach it, so nothing can read task state. The daemon puts the socket back
   * within a few seconds, which is why the assertions run on a doctor started
   * immediately after.
   */
  test('fails loudly when the daemon holds the lock but cannot be reached', async () => {
    const pid = lockHolderPid(ctx.root);
    await rm(getSocketPath(ctx.root), { force: true });

    const result = await ctx.lazy(['doctor']);

    expectOutput(result, '✗ Daemon holds the storage lock but is not serving storage');
    expectOutput(result, `pid ${pid}`);
    // Aimed at the daemon, never at the lock file — deleting a live holder's
    // lock admits a second writer and corrupts the store.
    expectOutput(result, 'lazy daemon restart');
    expectOutput(result, 'Do NOT delete');
    // And the checks it could not run are named, not silently dropped.
    expectOutput(result, `(skipped — daemon pid ${pid} is not serving storage)`);
    expect(result.exitCode).not.toBe(0);
  }, 60_000);
});
