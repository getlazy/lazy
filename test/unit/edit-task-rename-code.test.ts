/**
 * `editTask` on a STARTED task's code: a cosmetic rename. Covers the daemon's
 * rules for it and the MCP door that routes to them.
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
} from '../../src/daemon/rpc-handlers';
import { createEditHandler } from '../../src/mcp/tools';

describe('editTask: renaming a started task', () => {
  let root: string;
  let configPath: string;
  let prevLazyConfig: string | undefined;
  let prevLazyRoot: string | undefined;

  async function writeConfig(extra = ''): Promise<void> {
    await writeFile(configPath, `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n${extra}`);
  }

  async function startedTask(code: string) {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Started', undefined, undefined, code);
    await storage.updateTaskMetadata(task.id, 'task_ref', code);
    const session = await storage.createSession(task.id, 'claude-code', `lazy/${code}`, 'abc');
    await storage.createTurn({ sessionId: session.id, sequence: 1, role: 'agent', content: 'did work' });
    return task;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-rename-code-'));
    configPath = join(root, 'lazy.toml');
    await writeConfig();
    prevLazyConfig = process.env.LAZY_CONFIG;
    prevLazyRoot = process.env.LAZY_ROOT;
    process.env.LAZY_CONFIG = configPath;
    initDaemonStorage(root);
  });

  afterEach(async () => {
    await closeAllStorage();
    if (prevLazyConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = prevLazyConfig;
    if (prevLazyRoot === undefined) delete process.env.LAZY_ROOT;
    else process.env.LAZY_ROOT = prevLazyRoot;
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: a started task's code changes and nothing else — the stored
  // branch and ref stay, and the announcement names the STORED branch.
  test('renames the code, keeps ref and branch, and says so', async () => {
    const task = await startedTask('hub-old');
    const result = await handleEditTask(root, { taskId: task.id, code: 'hub-new' });
    expect(result.changes).toEqual(['code']);
    expect(result.announcements?.join('\n')).toContain('lazy/hub-old');
    const storage = await getOrCreateStorage();
    const updated = await storage.getTask(task.id);
    expect(updated?.code).toBe('hub-new');
    expect(updated?.metadata?.task_ref).toBe('hub-old');
    expect((await storage.getSessionByTaskId(task.id))?.git_branch).toBe('lazy/hub-old');
  });

  test('refuses a clash with a live task, a clear, and a combined edit', async () => {
    const task = await startedTask('alpha');
    const storage = await getOrCreateStorage();
    await storage.createTask('Other', undefined, undefined, 'beta');

    await expect(handleEditTask(root, { taskId: task.id, code: 'beta' })).rejects.toMatchObject({ status: 409 });
    await expect(handleEditTask(root, { taskId: task.id, code: '' })).rejects.toMatchObject({ status: 400 });
    await expect(handleEditTask(root, { taskId: task.id, code: 'gamma', model: 'opus' })).rejects.toMatchObject({ status: 400 });
    expect((await storage.getTask(task.id))?.code).toBe('alpha');
  });

  // INVARIANT: [protection].protected_tasks resolves entries by code at accept
  // time, so renaming a listed task would silently disarm its gate. Refused.
  test('refuses to rename a task protected by its code', async () => {
    await writeConfig('[protection]\nenabled = true\nprotected_tasks = ["guarded"]\n');
    const task = await startedTask('guarded');
    await expect(handleEditTask(root, { taskId: task.id, code: 'free' })).rejects.toMatchObject({ status: 409 });
    expect((await (await getOrCreateStorage()).getTask(task.id))?.code).toBe('guarded');
  });

  // INVARIANT: create's collision rule holds for an unstarted task's code edit too.
  test('refuses an unstarted code edit that clashes', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Fresh', undefined, undefined, 'fresh');
    await storage.createTask('Other', undefined, undefined, 'taken');
    await expect(handleEditTask(root, { taskId: task.id, code: 'taken' })).rejects.toMatchObject({ status: 409 });
  });

  test('lazy_edit routes a code-only edit of a started task through the daemon rules', async () => {
    process.env.LAZY_ROOT = root;
    const task = await startedTask('mcp-old');
    const storage = await getOrCreateStorage();
    const handler = createEditHandler({ taskId: '', worktreePath: root, storage });

    const ok = await handler({ task_id: task.id, code: 'mcp-new' }) as { changes: string[]; announcements?: string[] };
    expect(ok.changes).toEqual(['code']);
    expect(ok.announcements?.join('\n')).toContain('lazy/mcp-old');

    await expect(handler({ task_id: task.id, code: 'mcp-x', model: 'opus' })).rejects.toThrow();
    await expect(handler({ task_id: task.id, code: '' })).rejects.toThrow();
    expect((await storage.getTask(task.id))?.code).toBe('mcp-new');
  });
});
