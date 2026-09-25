/**
 * INVARIANT: `editTask` RPC enforces the same edit rules as `lazy edit` —
 * locked fields (goal/prompt/type/code/parent) refuse once a task has turns;
 * model/effort/agent may change on a started task.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initDaemonStorage,
  getOrCreateStorage,
  closeAllStorage,
  handleEditTask,
  RpcError,
} from '../../src/daemon/rpc-handlers';

describe('editTask RPC', () => {
  let root: string;
  let prevLazyConfig: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-edittask-'));
    const configPath = join(root, 'lazy.toml');
    await writeFile(
      configPath,
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    prevLazyConfig = process.env.LAZY_CONFIG;
    process.env.LAZY_CONFIG = configPath;
    initDaemonStorage(root);
  });

  afterEach(async () => {
    await closeAllStorage();
    if (prevLazyConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = prevLazyConfig;
    await rm(root, { recursive: true, force: true });
  });

  test('updates goal and prompt before any turns', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Old goal', undefined, undefined, 'edit-me');

    const result = await handleEditTask(root, {
      taskId: task.id,
      goal: 'New goal',
      prompt: 'Fresh brief',
    });

    expect(result.changes).toEqual(['goal', 'prompt']);
    const updated = await storage.getTask(task.id);
    expect(updated?.goal).toBe('New goal');
    expect(updated?.prompt).toBe('Fresh brief');
  });

  test('refuses goal edits after the agent has worked', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Started', undefined, undefined, 'started');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/started', 'abc');
    await storage.createTurn({
      sessionId: session.id,
      sequence: 1,
      role: 'agent',
      content: 'did work',
    });

    await expect(handleEditTask(root, { taskId: task.id, goal: 'Nope' }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('allows effort changes on a started task', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Started', undefined, undefined, 'effort-task');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/effort-task', 'abc');
    await storage.createTurn({
      sessionId: session.id,
      sequence: 1,
      role: 'agent',
      content: 'did work',
    });

    const result = await handleEditTask(root, { taskId: task.id, effort: 'low' });
    expect(result.changes).toEqual(['effort']);
    const updated = await storage.getTask(task.id);
    expect(updated?.metadata?.effort).toBe('low');
  });

  test('refuses terminal tasks outright', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Done', undefined, undefined, 'done');
    await storage.updateTaskStatus(task.id, 'abandoned');

    await expect(handleEditTask(root, { taskId: task.id, goal: 'Nope' }))
      .rejects.toBeInstanceOf(RpcError);
  });
});
