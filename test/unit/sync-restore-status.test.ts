/**
 * The marker a sync turn leaves for its own end-of-turn park.
 *
 * A sync moves the task through `working`, and the park that ends it happens a
 * turn later in the reconciler, with no caller left to remember where the task
 * started. The launch records it; the park reads it once and clears it.
 *
 * See src/task/sync-restore-status.ts for why only `submitted` is restored, and
 * test/e2e/sync-restores-submitted.test.ts for the end-to-end behaviour.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createStorage, type Storage } from '../../src/storage';
import {
  SYNC_RESTORE_STATUS_KEY,
  clearSyncRestoreStatus,
  consumeSyncRestoreStatus,
  isSyncRestorable,
  markSyncRestoreStatus,
} from '../../src/task/sync-restore-status';

describe('isSyncRestorable', () => {
  // INVARIANT: `blocked` and `conflict` are the DERIVED paused label
  // (src/utils/paused-status.ts) and are never restored — writing one back would
  // assert a label the derivation owns. `interrupted` means "the agent died,
  // resume it", and a completed sync is positive evidence it did not.
  test('only submitted is restorable', () => {
    expect(isSyncRestorable('submitted')).toBe(true);
    for (const status of ['blocked', 'conflict', 'interrupted', 'working', 'merging']) {
      expect(isSyncRestorable(status)).toBe(false);
    }
  });
});

describe('the sync restore marker', () => {
  let testDir: string;
  let storage: Storage;

  const CMD = 'cmd-sync-1';
  const OTHER_CMD = 'cmd-some-other-turn';

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-sync-restore-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });
    storage = await createStorage(testDir, { backend: 'external' });
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  async function newTask(): Promise<string> {
    return (await storage.createTask('Do the thing')).id;
  }

  test('records submitted against its command and hands it to that turn', async () => {
    const taskId = await newTask();
    await markSyncRestoreStatus(storage, taskId, 'submitted', CMD);
    expect(await consumeSyncRestoreStatus(storage, taskId, CMD)).toBe('submitted');
  });

  // INVARIANT (the marker names its own turn): a marker left behind by a sync
  // that died with no response must never be claimable by a LATER, unrelated
  // turn. The crash reader (handleErrorResponse) deliberately sees every turn
  // type, so without the id an ordinary work turn crashing fatally would park
  // `submitted` on a task nobody had submitted — in the review queue, on
  // PR-comment auto-react, with no PR behind it.
  test('another turn cannot claim a marker left by a dead sync', async () => {
    const taskId = await newTask();
    await markSyncRestoreStatus(storage, taskId, 'submitted', CMD);

    expect(await consumeSyncRestoreStatus(storage, taskId, OTHER_CMD)).toBeNull();

    // And the mismatch left it ALONE: it may still be owed to the turn it names.
    expect(await consumeSyncRestoreStatus(storage, taskId, CMD)).toBe('submitted');
  });

  // INVARIANT: an unidentified turn never matches. A response carrying no
  // command id (version skew from an older supervisor) loses the restore rather
  // than asserting `submitted` on the strength of a turn it cannot name.
  test('a turn with no command id claims nothing', async () => {
    const taskId = await newTask();
    await markSyncRestoreStatus(storage, taskId, 'submitted', CMD);
    expect(await consumeSyncRestoreStatus(storage, taskId, undefined)).toBeNull();
  });

  test('claiming the marker clears it, so the same turn cannot claim twice', async () => {
    const taskId = await newTask();
    await markSyncRestoreStatus(storage, taskId, 'submitted', CMD);
    expect(await consumeSyncRestoreStatus(storage, taskId, CMD)).toBe('submitted');
    expect(await consumeSyncRestoreStatus(storage, taskId, CMD)).toBeNull();
  });

  // INVARIANT: the launch CLEARS as well as writes. It is the one moment that
  // knows this sync's starting point, so leaving a previous sync's value in
  // place would hand a reader something this launch never vouched for.
  test('recording a non-restorable status clears a previous value', async () => {
    const taskId = await newTask();
    await markSyncRestoreStatus(storage, taskId, 'submitted', CMD);
    await markSyncRestoreStatus(storage, taskId, 'blocked', OTHER_CMD);
    expect(await consumeSyncRestoreStatus(storage, taskId, CMD)).toBeNull();
    expect(await consumeSyncRestoreStatus(storage, taskId, OTHER_CMD)).toBeNull();
  });

  test('a launch that fails after recording drops the marker', async () => {
    const taskId = await newTask();
    await markSyncRestoreStatus(storage, taskId, 'submitted', CMD);
    await clearSyncRestoreStatus(storage, taskId);
    expect(await consumeSyncRestoreStatus(storage, taskId, CMD)).toBeNull();
  });

  test('a task that never synced has nothing to restore', async () => {
    expect(await consumeSyncRestoreStatus(storage, await newTask(), CMD)).toBeNull();
  });

  // A store written by the build that recorded the bare status with no id. It
  // names no turn, so nobody can claim it — and reading it is not an error.
  test('a marker from the id-less build is claimed by nobody', async () => {
    const taskId = await newTask();
    await storage.updateTaskMetadata(taskId, SYNC_RESTORE_STATUS_KEY, 'submitted');
    expect(await consumeSyncRestoreStatus(storage, taskId, CMD)).toBeNull();
  });
});
