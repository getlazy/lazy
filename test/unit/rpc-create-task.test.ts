/**
 * The `createTask` RPC — the whole create, over the wire, for Lazy Teams.
 *
 * INVARIANT: a create sent over RPC runs the daemon's one create
 * implementation, so a subtask gets the same parent rules as one made from the
 * daemon's own dashboard. Teams used to assemble a create from raw storage
 * writes, which accepted a finished parent and skipped agent inheritance.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initDaemonStorage,
  getOrCreateStorage,
  closeAllStorage,
  handleRpc,
} from '../../src/daemon/rpc-handlers';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

describe('createTask RPC', () => {
  let root: string;
  let unpinConfig: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-rpc-create-'));
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

  test('creates a subtask under a live parent, with its prompt, in one call', async () => {
    const storage = await getOrCreateStorage();
    const parent = await storage.createTask('Parent work', undefined, undefined, 'parent-work');

    const result = await handleRpc('createTask', root, {
      goal: 'Child work', prompt: 'Do the child part', parent: 'parent-work', code: 'child-work',
    }) as any;

    const child = await storage.getTask(result.taskId);
    expect(child?.target).toEqual({ kind: 'task', parentTaskId: parent.id });
    expect(child?.prompt).toBe('Do the child part');
    expect(result.displayId).toBe('child-work');
  });

  test('refuses a finished parent, as the dashboard does', async () => {
    const storage = await getOrCreateStorage();
    const parent = await storage.createTask('Done work', undefined, undefined, 'done-work');
    await storage.updateTaskStatus(parent.id, 'abandoned');

    await expect(handleRpc('createTask', root, { goal: 'Too late', parent: parent.id }))
      .rejects.toThrow(/as parent: task is abandoned/);
  });
});
