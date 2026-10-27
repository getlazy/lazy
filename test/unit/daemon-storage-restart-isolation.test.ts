/**
 * A daemon stopped and started again in the SAME process serves the new
 * project's store, never the old one.
 *
 * INVARIANT: after closeAllStorage(), nothing left over from the stopped daemon
 * can install a store for the next one. An open still in flight at the close is
 * discarded rather than published, and a store a late caller reopened for the
 * old root is dropped when the next daemon initializes a different root. Without this, a background job of a stopped
 * daemon (the runner-image boot build) reopened ITS root's store into the shared
 * module slot, and the next daemon answered "Task not found" for a task already
 * on disk under its own root — the image-recovery-rpc flake under parallel load.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDaemonStorage, getOrCreateStorage, closeAllStorage } from '../../src/daemon/rpc-handlers';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lazy-storage-restart-'));
  await writeFile(join(root, 'lazy.toml'), `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`);
  return root;
}

describe('daemon storage across an in-process restart', () => {
  const roots: string[] = [];
  let unpin: (() => void) | undefined;

  afterEach(async () => {
    await closeAllStorage();
    unpin?.();
    for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
  });

  test('an open in flight at the close is never published to the next daemon', async () => {
    const a = await project();
    const b = await project();
    roots.push(a, b);
    unpin = pinConfig(a);
    initDaemonStorage(a);
    const straggler = getOrCreateStorage();
    await closeAllStorage();
    await expect(straggler).rejects.toThrow();

    unpin();
    unpin = pinConfig(b);
    initDaemonStorage(b);
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('lives in b');
    expect((await storage.resolveTask(task.id.substring(0, 8))).task?.id).toBe(task.id);
    expect((await storage.listTasks()).map((t) => t.goal)).toEqual(['lives in b']);
  });

  test('a store a straggler reopened after the close is dropped when the next root starts', async () => {
    const a = await project();
    const b = await project();
    roots.push(a, b);
    unpin = pinConfig(a);
    initDaemonStorage(a);
    await getOrCreateStorage();
    await closeAllStorage();
    // The stopped daemon's leftover job reopens ITS root.
    await (await getOrCreateStorage()).createTask('lives in a');

    unpin();
    unpin = pinConfig(b);
    initDaemonStorage(b);
    const storage = await getOrCreateStorage();
    await storage.createTask('lives in b');
    expect((await storage.listTasks()).map((t) => t.goal)).toEqual(['lives in b']);
  });
});
