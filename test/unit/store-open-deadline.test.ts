import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  closeAllStorage,
  getOrCreateStorage,
  initDaemonStorage,
  setStoreOpenDeadlineForTests,
  storeAvailability,
} from '../../src/daemon/rpc-handlers';

describe('opening the daemon store is bounded', () => {
  let root: string | null = null;

  afterEach(async () => {
    setStoreOpenDeadlineForTests();
    await closeAllStorage();
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  // INVARIANT: a storage caller never waits for ever on a store that does not
  // open — it fails after the deadline with an error naming the stuck stage, and
  // storeUnavailable says the same. A daemon whose every reconcile tick, sync
  // tick and RPC hung silently on one unsettled opening is what this prevents.
  test('a config read that never returns fails callers by name, then recovers', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'store-open-deadline-')));
    const configPath = join(root, 'lazy.toml');
    const mk = Bun.spawn(['mkfifo', configPath]);
    expect(await mk.exited).toBe(0);

    setStoreOpenDeadlineForTests(300);
    initDaemonStorage(root);

    await expect(getOrCreateStorage()).rejects.toThrow(/did not open within .*loading the config/);
    expect(storeAvailability()?.error).toContain('loading the config');

    // Opening the FIFO for writing releases the blocked read with an empty file
    // (lazy's defaults); the SAME opening then finishes and clears the report.
    await writeFile(configPath, '');
    setStoreOpenDeadlineForTests(10_000);
    const storage = await getOrCreateStorage();
    expect(storage).toBeDefined();
    expect(storeAvailability()).toBeNull();
  }, 20_000);
});
