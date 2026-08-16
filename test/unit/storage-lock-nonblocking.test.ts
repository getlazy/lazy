/**
 * Unit tests: looking at the storage lock without queueing behind it.
 *
 * `lazy doctor` exists to diagnose a wedged store, and it used to die of that
 * exact condition — every storage-backed check queued on the retry loop and
 * then threw. Two primitives fix that, and both are tested here:
 *
 *   - `probeHeldStorageLock` — LOOK at the lock in bounded time and report a
 *     single live holder, or nothing.
 *   - `StorageLock`'s opt-in `acquireTimeoutMs` — fail fast instead of running
 *     the fixed attempt loop.
 *
 * INVARIANT: the DEFAULT acquire behaviour is unchanged. A command that has
 * work to do must keep queueing on a busy store; only a read-only diagnostic
 * opts out. A test here that "improves" the default into a timeout would break
 * every other caller, silently, under load.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { probeHeldStorageLock, STORAGE_LOCK_FILENAME, StorageLock } from '../../src/utils/storage-lock';
import { startForeignProcess, type ForeignProcess } from '../helpers/foreign-process';

describe('probeHeldStorageLock', () => {
  let tempDir: string;
  let lockDir: string;
  let lockPath: string;
  let holders: ForeignProcess[] = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'strg-lock-probe-'));
    lockDir = join(tempDir, 'lock-dir');
    mkdirSync(lockDir, { recursive: true });
    lockPath = join(lockDir, STORAGE_LOCK_FILENAME);
  });

  afterEach(() => {
    for (const h of holders) h.kill();
    holders = [];
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** A real live process, plus the identity fields that verify it IS the holder. */
  async function startVerifiableHolder(): Promise<{ pid: number; record: Record<string, unknown> }> {
    const holder = await startForeignProcess(tempDir, 'holder-proc');
    holders.push(holder);
    return {
      pid: holder.pid,
      record: {
        pid: holder.pid,
        acquired_at: new Date().toISOString(),
        holder_started_at: holder.identity.started,
        holder_start_source: holder.identity.startedSource,
        holder_command: holder.identity.command,
      },
    };
  }

  function write(record: Record<string, unknown>): void {
    writeFileSync(lockPath, JSON.stringify(record, null, 2) + '\n');
  }

  test('reports nothing when there is no lock file', async () => {
    expect(await probeHeldStorageLock(lockPath, { windowMs: 200, pollMs: 50 })).toBeNull();
  });

  test('reports nothing for a stale lock', async () => {
    // A holder that does not verify is `checkStorageLock`'s case — it offers to
    // remove it. Reporting it here too would double-report one problem and, far
    // worse, tell the reader to go looking for a live process that is not there.
    write({ pid: 2_000_000, acquired_at: new Date().toISOString() });

    expect(await probeHeldStorageLock(lockPath, { windowMs: 200, pollMs: 50 })).toBeNull();
  });

  test('reports nothing when the lock is released during the window', async () => {
    const { record } = await startVerifiableHolder();
    write(record);
    setTimeout(() => { try { unlinkSync(lockPath); } catch { /* already gone */ } }, 150);

    expect(await probeHeldStorageLock(lockPath, { windowMs: 1_500, pollMs: 50 })).toBeNull();
  }, 20_000);

  test('reports nothing when the lock churns from one holder to the next', async () => {
    // THE false positive that matters: FileStorage takes this lock per
    // operation, so a healthy busy daemon is a rapid succession of DIFFERENT
    // acquires. Reporting that as a held lock would make doctor cry wolf on
    // every project with a working daemon.
    const { record } = await startVerifiableHolder();
    write(record);
    setTimeout(() => write({ ...record, acquired_at: new Date(Date.now() + 5).toISOString() }), 150);

    expect(await probeHeldStorageLock(lockPath, { windowMs: 1_500, pollMs: 50 })).toBeNull();
  }, 20_000);

  test('reports one live holder that never lets go', async () => {
    const { pid, record } = await startVerifiableHolder();
    write(record);

    const report = await probeHeldStorageLock(lockPath, { windowMs: 600, pollMs: 100 });
    expect(report).not.toBeNull();
    expect(report!.pid).toBe(pid);
    expect(report!.acquiredAt).toBe(record.acquired_at as string);
    expect(report!.observedForMs).toBeGreaterThanOrEqual(500);
  }, 20_000);

  test('answers within its window rather than waiting the holder out', async () => {
    const { record } = await startVerifiableHolder();
    write(record);

    const started = Date.now();
    await probeHeldStorageLock(lockPath, { windowMs: 400, pollMs: 100 });
    // Generously bounded: the assertion is "does not queue", not a budget. The
    // old behaviour on this input was the full retry loop, an order of
    // magnitude longer.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);
});

describe('StorageLock — acquireTimeoutMs', () => {
  let tempDir: string;
  let lockDir: string;
  let holders: ForeignProcess[] = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'strg-lock-timeout-'));
    lockDir = join(tempDir, 'lock-dir');
    mkdirSync(lockDir, { recursive: true });
  });

  afterEach(() => {
    for (const h of holders) h.kill();
    holders = [];
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function holdLockWithLiveProcess(): Promise<number> {
    const holder = await startForeignProcess(tempDir, 'holder-proc');
    holders.push(holder);
    writeFileSync(
      join(lockDir, STORAGE_LOCK_FILENAME),
      JSON.stringify({
        pid: holder.pid,
        acquired_at: new Date().toISOString(),
        holder_started_at: holder.identity.started,
        holder_start_source: holder.identity.startedSource,
      }, null, 2) + '\n',
    );
    return holder.pid;
  }

  test('gives up after the timeout instead of running the full attempt loop', async () => {
    const holderPid = await holdLockWithLiveProcess();

    const lock = new StorageLock(tempDir, lockDir, { acquireTimeoutMs: 300 });
    const started = Date.now();
    await expect(lock.acquire()).rejects.toThrow(`held by process pid ${holderPid}`);
    const elapsed = Date.now() - started;

    // Loosely bounded on purpose: the final failure message shells out to `ps`
    // to name the holder, which costs real time on a machine without procfs.
    // What must hold is that it did not run 50 × ~125ms of retries.
    expect(elapsed).toBeLessThan(4_000);
  }, 20_000);

  test('the failure still names the holder and says how long it waited', async () => {
    // A fail-fast path that reports less than the slow path would be a
    // downgrade: this message is the whole reason doctor can name the pid.
    const holderPid = await holdLockWithLiveProcess();

    const lock = new StorageLock(tempDir, lockDir, { acquireTimeoutMs: 200 });
    await expect(lock.acquire()).rejects.toThrow('after 200ms');
    await expect(lock.acquire()).rejects.toThrow(`pid ${holderPid}`);
  }, 20_000);

  test('an uncontended acquire is unaffected by the timeout', async () => {
    const lock = new StorageLock(tempDir, lockDir, { acquireTimeoutMs: 50 });
    await expect(lock.acquire()).resolves.toBeUndefined();
    lock.release();
  });

  // INVARIANT: no timeout means the historical fixed-attempt loop, unchanged.
  // Every command other than doctor depends on queueing through contention.
  test('without the option the default retry loop still runs', async () => {
    await holdLockWithLiveProcess();

    const lock = new StorageLock(tempDir, lockDir);
    const started = Date.now();
    await expect(lock.acquire()).rejects.toThrow('attempts');
    // 50 attempts at 100–150ms each cannot complete in anything like the
    // fail-fast budget above.
    expect(Date.now() - started).toBeGreaterThan(3_000);
  }, 60_000);
});
