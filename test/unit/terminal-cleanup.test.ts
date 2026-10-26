import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileStorage } from '../../src/storage/file-storage';
import { TerminalCleanupManager, type TerminalCleanupDeps } from '../../src/daemon/terminal-cleanup';
import type { TerminalCleanupItem } from '../../src/storage/terminal-cleanup-state';

// INVARIANT: finished-task cleanup never deletes live task files, locked
// worktrees, or files beneath an environment whose teardown has not succeeded.
describe('finished-task cleanup', () => {
  let root: string, storage: FileStorage, manager: TerminalCleanupManager;
  let done: string, live: string, items: TerminalCleanupItem[], removed: string[], locked: boolean, members: string[];
  let failure: string | null, endFailure: boolean, ends: number, errors: string[];
  let deps: TerminalCleanupDeps;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'terminal-cleanup-'));
    storage = new FileStorage(root, { basePath: join(root, 'store') });
    await storage.initialize();
    done = (await storage.createTask('closed', undefined, undefined, 'closed')).id;
    live = (await storage.createTask('still working', undefined, undefined, 'live')).id;
    await storage.updateTaskStatus(done, 'abandoned', 'human');
    items = [{ kind: 'worktree', id: '/a/worktree', taskId: done, taskCode: 'closed', name: 'closed', bytes: 8192 }];
    removed = []; locked = false; members = []; failure = null; endFailure = false; ends = 0; errors = [];
    deps = {
      inventory: async () => ({ items: structuredClone(items), errors }),
      locked: async () => locked, members: () => members,
      endMembers: async () => { ends++; if (endFailure) throw new Error('member runtime busy'); members = []; },
      remove: async item => {
        if (failure === item.kind) throw new Error('permission denied while removing resource');
        removed.push(item.kind); items = items.filter(i => i.id !== item.id);
      },
    };
    manager = new TerminalCleanupManager(storage, root, deps);
  });
  afterEach(async () => { await storage.close(); await rm(root, { recursive: true, force: true }); });

  test('preview measures finished resources and excludes non-finished tasks', async () => {
    items.push({ ...items[0], taskId: live, id: '/live', taskCode: 'live' });
    const view = await manager.view();
    expect(view.items.map(i => i.taskId)).toEqual([done]);
    expect(view.plan.reclaimableBytes).toBe(8192);
    expect(view.lastRun).toBeNull();
    expect(removed).toEqual([]);
    await manager.run('Free space', view.plan.id);
    expect(removed).toEqual(['worktree']);
    expect((await manager.view()).lastRun!.removed[0].taskCode).toBe('closed');
  });

  test('live locks and member sessions are shown but never included in Free space', async () => {
    locked = true;
    expect((await manager.view()).items[0].blockedReason).toContain('lock');
    expect((await manager.view()).plan.items).toEqual([]);
    locked = false; members = ['member@example.com'];
    const view = await manager.view();
    expect(view.items[0].blockedReason).toContain('Member');
    await manager.run('Free space', view.plan.id);
    expect(ends).toBe(0);
    expect(removed).toEqual([]);
  });

  test('a new live lock invalidates the preview before mutation', async () => {
    const view = await manager.view();
    locked = true;
    await expect(manager.run('Free space', view.plan.id)).rejects.toThrow('changed');
    expect(removed).toEqual([]);
  });

  test('a lock acquired after preview validation is checked at deletion', async () => {
    const view = await manager.view();
    let checks = 0;
    deps.locked = async () => ++checks >= 3;
    await manager.run('Free space', view.plan.id);
    expect(removed).toEqual([]);
    expect((await storage.getTerminalCleanupState())!.lastRun!.skipped).toHaveLength(1);
  });

  test('a task reopened after inventory cannot be removed', async () => {
    const getTask = storage.getTask.bind(storage);
    storage.getTask = async id => {
      const task = await getTask(id);
      return task ? { ...task, status: 'blocked' } : null;
    };
    await manager.run();
    expect(removed).toEqual([]);
  });

  // INVARIANT: cleanup failures remain visible across restarts, including
  // retry count and first failure, until the resource is actually removed.
  test('repeated failures survive restart and successful removal clears the debt', async () => {
    failure = 'worktree';
    await manager.run();
    const first = (await manager.view()).failures[0];
    expect(first.error).toContain('permission denied');
    expect(first.attempts).toBe(1);
    manager = new TerminalCleanupManager(storage, root, deps);
    await manager.run();
    const second = (await manager.view()).failures[0];
    expect(second.attempts).toBe(2);
    expect(second.since).toBe(first.since);
    expect(second.lastAt >= first.lastAt).toBe(true);
    failure = null;
    await manager.run();
    expect((await manager.view()).failures).toEqual([]);
    expect((await manager.view()).lastRun!.removed).toHaveLength(1);
  });

  test('failed task environment removal keeps its worktree, then retries in dependency order', async () => {
    items.push({ ...items[0], kind: 'task-container', id: 'task-env', bytes: null });
    failure = 'task-container';
    await manager.run();
    expect(removed).toEqual([]);
    expect((await manager.view()).failures[0].item.kind).toBe('task-container');
    failure = null;
    await manager.run();
    expect(removed).toEqual(['task-container', 'worktree']);
  });

  test('task end retries member teardown and keeps files on failure', async () => {
    members = ['member@example.com']; endFailure = true;
    await manager.run();
    expect(ends).toBe(1);
    expect(removed).toEqual([]);
    expect((await manager.view()).failures[0].error).toContain('member runtime busy');
    endFailure = false;
    await manager.run();
    expect(removed).toEqual(['worktree']);
    expect((await manager.view()).failures).toEqual([]);
  });

  test('runtime inspection failures cannot authorize worktree removal or hide prior failure', async () => {
    failure = 'worktree'; await manager.run();
    errors = ['Docker is unavailable'];
    await manager.run();
    expect((await manager.view()).lastRun!.error).toContain('Docker is unavailable');
    expect((await manager.view()).failures).toHaveLength(1);
    expect(removed).toEqual([]);
  });

  test('a failed full scan records its error instead of claiming an empty successful sweep', async () => {
    deps.inventory = async () => { throw new Error('cannot stat worktree'); };
    await manager.run();
    expect((await storage.getTerminalCleanupState())!.lastRun!.error).toContain('cannot stat worktree');
    expect(removed).toEqual([]);
  });

  // INVARIANT: manual cleanup does not erase evidence of the last automatic
  // sweep; an operator must be able to see whether that sweep is working.
  test('manual reclaim preserves the last automatic sweep record', async () => {
    failure = 'worktree'; await manager.run();
    const before = (await manager.view()).lastSweep!;
    failure = null;
    const preview = await manager.view();
    await manager.run('Free space', preview.plan.id);
    const after = await manager.view();
    expect(after.lastSweep).toEqual(before);
    expect(after.lastRun!.reason).toBe('Free space');
    expect(after.lastRun!.removed).toHaveLength(1);
  });
});
