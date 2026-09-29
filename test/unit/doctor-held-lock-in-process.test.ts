/**
 * Doctor's held-storage-lock assessment when the sweep runs INSIDE the daemon.
 *
 * INVARIANT: in-process (LAZY_IS_DAEMON=1 — Teams' doctor.run, the dashboard's
 * Doctor page) the liveness probe reads through the daemon's OWN storage handle.
 * The daemon must not RPC itself, so the remote client is absent there, and
 * reading that absence as "did not answer" reported every healthy daemon as
 * stuck. A read that genuinely stalls must still be `daemon-stuck`, and no
 * handle at all is `daemon-unprobed`, never `daemon-stuck`.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { assessHeldLock, describeHeldStorageLock } from '../../src/doctor/sweep';
import { getDaemonLockPath } from '../../src/daemon/paths';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import type { Storage } from '../../src/storage/interface';
import type { HeldLockReport } from '../../src/utils/storage-lock';

const HOLDER_PID = 424242;

function held(): HeldLockReport {
  return { pid: HOLDER_PID, acquiredAt: new Date().toISOString(), command: null, observedForMs: 100 };
}

describe('assessHeldLock inside the daemon', () => {
  let root: string;
  let baseDir: string;
  let restoreBase: () => void;
  let prevIsDaemon: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-held-lock-'));
    baseDir = await makeDaemonBaseDir();
    restoreBase = pinDaemonBaseDir(baseDir);
    const lockPath = getDaemonLockPath(root);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, `${HOLDER_PID}\n`);
    prevIsDaemon = process.env.LAZY_IS_DAEMON;
    process.env.LAZY_IS_DAEMON = '1';
  });

  afterEach(async () => {
    if (prevIsDaemon === undefined) delete process.env.LAZY_IS_DAEMON;
    else process.env.LAZY_IS_DAEMON = prevIsDaemon;
    restoreBase();
    await removeDaemonBaseDir(baseDir);
    await rm(root, { recursive: true, force: true });
  });

  test('a live in-process storage answers: daemon-serving', async () => {
    const storage = { getTask: async () => null } as unknown as Storage;
    expect(await assessHeldLock(root, held(), storage)).toBe('daemon-serving');
  });

  test('a stalled in-process read is daemon-stuck at the budget', async () => {
    const storage = { getTask: () => new Promise(() => {}) } as unknown as Storage;
    const started = Date.now();
    expect(await assessHeldLock(root, held(), storage)).toBe('daemon-stuck');
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
  }, 10_000);

  test('a read that fails is daemon-stuck', async () => {
    const storage = { getTask: async () => { throw new Error('500'); } } as unknown as Storage;
    expect(await assessHeldLock(root, held(), storage)).toBe('daemon-stuck');
  });

  test('stuck carries a remedy; unprobed is a warning, not a failure', () => {
    const stuck = describeHeldStorageLock(held(), root, 'daemon-stuck');
    expect(stuck.ok).toBe(false);
    expect(stuck.remedy?.length ?? 0).toBeGreaterThan(0);
    const unprobed = describeHeldStorageLock(held(), root, 'daemon-unprobed');
    expect(unprobed.ok).toBe(true);
    expect(unprobed.warning).toBeTruthy();
  });

  test('no handle to probe with is daemon-unprobed, never daemon-stuck', async () => {
    expect(await assessHeldLock(root, held(), undefined)).toBe('daemon-unprobed');
  });

  test('a foreign holder is not probed', async () => {
    const storage = { getTask: async () => null } as unknown as Storage;
    expect(await assessHeldLock(root, { ...held(), pid: HOLDER_PID + 1 }, storage)).toBe('foreign');
  });
});
