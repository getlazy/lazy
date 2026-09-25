/**
 * The `syncTaskFromRemote` RPC — how `lazy unblock` and `lazy loop` refresh a
 * task's forge comments and PR state. It exists so the refresh (and the accept
 * transition a merged PR triggers) runs in the daemon, where the task's
 * lifecycle lock actually excludes a concurrent accept. Tested THROUGH
 * `handleRpc`, because a test of the handler alone proves nothing about the
 * dispatch arm existing — and e2e runs take the in-process fallback, which
 * never goes through dispatch either.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

const calls: Array<{ taskId: string; actor: unknown }> = [];
const realSyncRemote = await import('../../src/task/sync-remote');
await mockModule(resolve(import.meta.dir, '../../src/task/sync-remote.ts'), () => ({
  ...realSyncRemote,
  syncTaskFromRemote: async (task: { id: string }, _storage: unknown, _root: string, actor?: unknown) => {
    calls.push({ taskId: task.id, actor });
  },
}));

const { handleRpc, initDaemonStorage, getOrCreateStorage, closeAllStorage } = await import('../../src/daemon/rpc-handlers');
const { RpcError } = await import('../../src/daemon/rpc-error');

const MEMBER = { kind: 'user', email: 'ada@example.com', name: 'Ada' } as const;

afterAll(() => restoreMockedModules());

describe('syncTaskFromRemote RPC', () => {
  let root: string;
  let unpinConfig: () => void;

  beforeEach(async () => {
    calls.length = 0;
    root = await mkdtemp(join(tmpdir(), 'lazy-rpc-sync-from-remote-'));
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    unpinConfig = pinConfig(root);
    initDaemonStorage(root);
  });

  afterEach(async () => {
    await closeAllStorage();
    unpinConfig();
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: the CLI's pre-review refresh runs in the daemon, and the rows it
  // writes name the person who ran the command — before the RPC existed they
  // were stamped through the storage proxy, and moving the call must not drop it.
  test('dispatches to the sync, passing the caller\'s person as the actor', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Refresh me');

    const result = await handleRpc('syncTaskFromRemote', root, { taskId: task.id }, undefined, MEMBER);

    expect(result).toEqual({ status: task.status });
    expect(calls).toHaveLength(1);
    expect(calls[0].taskId).toBe(task.id);
    expect(calls[0].actor).toMatchObject({ email: 'ada@example.com' });
  });

  test('an unknown task is a 404 and syncs nothing', async () => {
    let err: unknown = null;
    try {
      await handleRpc('syncTaskFromRemote', root, { taskId: 'no-such-task' }, undefined, MEMBER);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RpcError);
    expect((err as InstanceType<typeof RpcError>).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
