/**
 * Unit tests: the storage lock must not be wedged by PID REUSE.
 *
 * The incident this reproduces: a lazy process took the storage lock and died
 * without releasing it (crash/SIGKILL/upgrade). macOS recycled its pid to an
 * unrelated system daemon (`postersyncd`). From then on every lazy command
 * failed with "Failed to acquire storage lock after 50 attempts … held by
 * process pid 1433 (/System/…/postersyncd)", forever, across daemon restarts —
 * because the liveness check only asked "does this pid exist and is it not a
 * zombie", which a recycled pid answers "yes" to for as long as it lives. The
 * stale-lock cleanup path below it was therefore unreachable.
 *
 * INVARIANT: a lock is only held if the process at that pid is the SAME process
 * that took it. Liveness alone is not identity.
 *
 * These tests use a real live process that definitively never took the lock,
 * rather than pid 1: pid 1 is not portable as "obviously not lazy" — in the
 * lazy agent container pid 1's own command line mentions `lazy-agent`, which is
 * exactly the "could plausibly be lazy" case the backstop must NOT reclaim.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StorageLock } from '../../src/utils/storage-lock';
import { startForeignProcess, type ForeignProcess } from '../helpers/foreign-process';

const LOCK_FILE = '.storage-lock';

describe('StorageLock — PID reuse', () => {
  let tempDir: string;
  let lockDir: string;
  let holders: ForeignProcess[] = [];

  beforeEach(() => {
    // NOTE: the temp prefix deliberately does not contain "lazy". The holder
    // processes below run from inside this directory, so their command line is
    // this path — and a path containing "lazy" would read as a plausible lazy
    // process to the backstop, defeating the very case under test.
    tempDir = mkdtempSync(join(tmpdir(), 'strg-lock-pidreuse-'));
    lockDir = join(tempDir, 'lock-dir');
    mkdirSync(lockDir, { recursive: true });
  });

  afterEach(() => {
    for (const h of holders) h.kill();
    holders = [];
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Start a real, long-lived process under a chosen program NAME, so its command
   * line either does or does not look like a lazy process. See
   * `test/helpers/foreign-process.ts` for why the name comes from a symlink to
   * /bin/sleep, and why the process is verified live before it is handed back.
   */
  async function startHolder(programName: string): Promise<ForeignProcess> {
    const holder = await startForeignProcess(tempDir, programName);
    holders.push(holder);
    return holder;
  }

  function writeLockFile(contents: Record<string, unknown>): void {
    writeFileSync(join(lockDir, LOCK_FILE), JSON.stringify(contents, null, 2) + '\n');
  }

  function lockFilePid(): number {
    return JSON.parse(readFileSync(join(lockDir, LOCK_FILE), 'utf-8')).pid;
  }

  test('reclaims a lock whose pid was recycled to an unrelated live process', async () => {
    // THE INCIDENT, exactly: a lock file carrying only {pid, acquired_at} — the
    // shape older lazy versions wrote — whose pid now belongs to a live process
    // that never took the lock and never will release it.
    const foreign = await startHolder('unrelated-system-daemon');
    writeLockFile({ pid: foreign.pid, acquired_at: new Date().toISOString() });

    const lock = new StorageLock(tempDir, lockDir);
    await lock.acquire();

    expect(lockFilePid()).toBe(process.pid);
    lock.release();
  }, 20_000);

  test('reclaims a lock whose recorded holder start time no longer matches', async () => {
    // Same pid, different process: the recorded start time is the primary
    // identity test and it does not match what the OS reports now.
    const foreign = await startHolder('lazy-daemon-lookalike');
    writeLockFile({
      pid: foreign.pid,
      acquired_at: new Date().toISOString(),
      holder_started_at: 'definitely-not-the-current-start-time',
      holder_start_source: foreign.identity.startedSource,
    });

    const lock = new StorageLock(tempDir, lockDir);
    await lock.acquire();

    expect(lockFilePid()).toBe(process.pid);
    lock.release();
  }, 20_000);

  test('does NOT steal a lock from a verified live holder', async () => {
    // INVARIANT: reclaiming a stale lock must never become "reclaiming any lock
    // whose holder is not us". A holder whose recorded identity still matches
    // the process at that pid is genuinely holding the lock — we must wait, and
    // then fail with a message that names it.
    const holder = await startHolder('lazy-daemon-sim');
    const holderPid = holder.pid;
    writeLockFile({
      pid: holderPid,
      acquired_at: new Date().toISOString(),
      holder_started_at: holder.identity.started,
      holder_start_source: holder.identity.startedSource,
    });

    const lock = new StorageLock(tempDir, lockDir);
    await expect(lock.acquire()).rejects.toThrow(`held by process pid ${holderPid}`);
    // The lock file must be untouched — still the holder's.
    expect(lockFilePid()).toBe(holderPid);
  }, 30_000);

  test('records verifiable holder identity when it takes the lock', async () => {
    // Without this, every lock this process writes is one future PID collision
    // away from the same deadlock.
    const lock = new StorageLock(tempDir, lockDir);
    await lock.acquire();
    const written = JSON.parse(readFileSync(join(lockDir, LOCK_FILE), 'utf-8'));
    lock.release();

    expect(written.pid).toBe(process.pid);
    expect(typeof written.holder_started_at).toBe('string');
    expect(written.holder_started_at.length).toBeGreaterThan(0);
    expect(['proc', 'ps']).toContain(written.holder_start_source);
  });

  test('reclaims a lock whose pid no longer exists at all', async () => {
    // The pre-existing stale-lock path must keep working.
    writeLockFile({ pid: 2_000_000, acquired_at: new Date().toISOString() });

    const lock = new StorageLock(tempDir, lockDir);
    await lock.acquire();

    expect(lockFilePid()).toBe(process.pid);
    lock.release();
  }, 20_000);
});
