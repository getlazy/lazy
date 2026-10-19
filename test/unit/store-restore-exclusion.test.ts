/**
 * Nothing opens a store a restore owns — not the daemon, not a CLI-local
 * storage open, not the lock-free append streams — whatever order the restore
 * and the opener arrive in, and whichever pid namespace the restore's lock
 * names (src/utils/storage-lock.ts, StorageLockOptions.restoreMarker).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileStorage } from '../../src/storage/file-storage';
import { assertNoRestoreInProgress, restoreMarkerPathFor } from '../../src/storage/store-backup';
import { closeAllStorage, getOrCreateStorage, initDaemonStorage, setStoreOpenDeadlineForTests } from '../../src/daemon/rpc-handlers';

let root: string;
let store: string;
const FOREIGN = 'linux:00000000-host-boot:pid:[4026531836]';

beforeEach(async () => {
  // Start from a closed daemon store whatever an earlier file in this bun
  // process left open: getOrCreateStorage returns a cached instance as-is.
  await closeAllStorage();
  root = await realpath(await mkdtemp(join(tmpdir(), 'restore-exclusion-')));
  store = join(root, 'store');
  await mkdir(join(store, 'tasks'), { recursive: true });
  await mkdir(join(root, '.lazy'), { recursive: true });
  await writeFile(join(root, 'lazy.toml'), `[storage]\nbackend = "external"\nexternal_path = "${store}"\n`);
});

afterEach(async () => {
  await closeAllStorage();
  setStoreOpenDeadlineForTests();
  await rm(root, { recursive: true, force: true });
});

/** What a restore out of this side's sight leaves in the store: its lock and its marker, both from a kernel this side cannot see into. */
async function hostRestoreArrives(): Promise<string> {
  const lock = JSON.stringify({ pid: 999_999, acquired_at: new Date().toISOString(), holder_namespace: FOREIGN, holder_guest: true });
  await writeFile(join(store, '.storage-lock'), lock);
  await writeFile(restoreMarkerPathFor(store), JSON.stringify({
    pid: 999_999, holder_namespace: FOREIGN, holder_guest: true, started_at: new Date().toISOString(), backup: 'b',
    staging: '/host/store.restoring-x', moved_aside_to: '/host/store.before-restore-x',
  }));
  return lock;
}

describe('a restore that arrives between the daemon\'s check and its lock', () => {
  // INVARIANT: the daemon's storage lock refuses while a restore's marker is in
  // the store, and refuses BEFORE judging the lock file — a host restore's lock
  // names a pid the guest cannot see, which `judge` would take for stale and
  // reclaim. The check at daemon start alone was a check-then-lock race.
  test('the daemon refuses to open the store and leaves the restore\'s lock alone', async () => {
    await assertNoRestoreInProgress(store); // startDaemon's check: nothing yet.
    const lock = await hostRestoreArrives(); // ...the restore starts...
    initDaemonStorage(root);
    await expect(getOrCreateStorage()).rejects.toThrow(/another machine or pid namespace/);
    expect(await readFile(join(store, '.storage-lock'), 'utf-8')).toBe(lock);
    expect(await readdir(store)).toContain('.restore-in-progress');
  });

  // INVARIANT: every other opener goes through the same lock, so a CLI-local
  // storage open refuses too, and the append streams that write without the
  // lock check the marker themselves.
  test('a CLI-local storage open and the lock-free append streams refuse too', async () => {
    const storage = new FileStorage(root, { basePath: store });
    await storage.initialize();
    const lock = await hostRestoreArrives();
    await expect(storage.createTask('written mid-restore')).rejects.toThrow(/a store restore owns this store/);
    await expect(new FileStorage(root, { basePath: store }).initialize()).rejects.toThrow(/a store restore owns this store/);
    await expect(storage.appendTraceSpans([])).rejects.toThrow(/a store restore owns this store/);
    // A write that never takes the lock (a whole-record replace) checks too.
    await expect(storage.saveProjectSettings({} as never)).rejects.toThrow(/a store restore owns this store/);
    await expect(readdir(store)).resolves.not.toContain('project-settings.json');
    await expect(storage.recordWaitEnd('w', new Date().toISOString(), 'completed' as never)).rejects.toThrow(/a store restore owns this store/);
    expect(await readFile(join(store, '.storage-lock'), 'utf-8')).toBe(lock);
    await storage.close();
  });

  test('an open that finds a marker creates no lock, and works again once the restore is done', async () => {
    const storage = new FileStorage(root, { basePath: store });
    await storage.initialize();
    await writeFile(restoreMarkerPathFor(store), JSON.stringify({ pid: 999_999, holder_namespace: FOREIGN, holder_guest: true, started_at: 'x', backup: 'b', staging: 's', moved_aside_to: null }));
    await expect(storage.createTask('nope')).rejects.toThrow(/a store restore owns this store/);
    expect(await readdir(store)).not.toContain('.storage-lock');
    await rm(restoreMarkerPathFor(store));
    await storage.createTask('after the restore');
    await storage.close();
  });
});
