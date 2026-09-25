/**
 * Daemon createTask: the one writer behind the web New-task form.
 *
 * INVARIANT: every field is validated before any write, so a bad effort or
 * code cannot leave a half-created task. INVARIANT: a blank code is derived
 * from the goal via deriveCode (the suggestion the form advertises), and an
 * explicit code is validated with validateCode — neither rule is reimplemented
 * in the web layer.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDaemonStorage, getOrCreateStorage, closeAllStorage } from '../../src/daemon/rpc-handlers';
import { createTask } from '../../src/daemon/create-task';
import { RpcError } from '../../src/daemon/rpc-error';
import { currentPromptOf } from '../../src/task-prompt';
import { parentTaskIdOf } from '../../src/task-target';

describe('daemon createTask', () => {
  let root: string;
  let prevLazyConfig: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-createtask-'));
    const store = join(root, 'store');
    await mkdir(store, { recursive: true });
    const configPath = join(root, 'lazy.toml');
    await writeFile(
      configPath,
      `[storage]\nbackend = "external"\nexternal_path = "${store}"\n`,
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

  test('creates a backlog task and derives a code from the goal', async () => {
    const storage = await getOrCreateStorage();
    const result = await createTask(storage, root, {
      goal: 'Add authentication',
      prompt: 'Implement OAuth2',
      type: 'feature',
      effort: 'high',
      actor: 'human',
    });

    expect(result.derivedCode).toBe(true);
    expect(result.displayId).toBe('add-authentication');
    const task = await storage.getTask(result.taskId);
    expect(task?.status).toBe('backlog');
    expect(task?.goal).toBe('Add authentication');
    expect(task?.code).toBe('add-authentication');
    expect(task?.type).toBe('feature');
    expect(task?.metadata?.effort).toBe('high');
    expect(currentPromptOf(task!)).toBe('Implement OAuth2');
    expect(parentTaskIdOf(task!)).toBeNull();
  });

  test('keeps an explicit code and inherits the parent agent', async () => {
    const storage = await getOrCreateStorage();
    const parent = await storage.createTask(
      'Parent',
      undefined,
      undefined,
      'parent-task',
      'task',
      'cursor',
    );

    const result = await createTask(storage, root, {
      goal: 'Child work',
      code: 'child-work',
      parent: parent.code ?? parent.id,
      actor: 'human',
    });

    const child = await storage.getTask(result.taskId);
    expect(result.derivedCode).toBe(false);
    expect(child?.code).toBe('child-work');
    expect(child?.agent_id).toBe('cursor');
    expect(parentTaskIdOf(child!)).toBe(parent.id);
  });

  test('refuses an empty goal without writing a task', async () => {
    const storage = await getOrCreateStorage();
    await expect(createTask(storage, root, { goal: '   ' }))
      .rejects.toMatchObject({ status: 400 });
    expect((await storage.listTasks()).length).toBe(0);
  });

  test('refuses an invalid code before writing', async () => {
    const storage = await getOrCreateStorage();
    await expect(createTask(storage, root, { goal: 'Do it', code: 'Has.Dots' }))
      .rejects.toBeInstanceOf(RpcError);
    expect((await storage.listTasks()).length).toBe(0);
  });

  test('refuses a terminal parent', async () => {
    const storage = await getOrCreateStorage();
    const parent = await storage.createTask('Done parent', undefined, undefined, 'done-parent');
    await storage.updateTaskStatus(parent.id, 'abandoned');

    await expect(createTask(storage, root, {
      goal: 'Orphan child',
      parent: 'done-parent',
    })).rejects.toMatchObject({ status: 400 });
    expect((await storage.listTasks()).map((t) => t.code)).toEqual(['done-parent']);
  });

  test('refuses a parent that looks like a git option', async () => {
    const storage = await getOrCreateStorage();
    let dash: unknown;
    try {
      await createTask(storage, root, {
        goal: 'Do not parse this as git',
        parent: '--output=/tmp/pwned',
      });
    } catch (err) {
      dash = err;
    }
    expect(dash).toBeInstanceOf(RpcError);
    expect((dash as RpcError).status).toBe(400);
    expect((dash as RpcError).message).toContain("cannot start with '-'");

    let help: unknown;
    try {
      await createTask(storage, root, { goal: 'Dash help', parent: '-h' });
    } catch (err) {
      help = err;
    }
    expect(help).toBeInstanceOf(RpcError);
    expect((help as RpcError).status).toBe(400);
    expect((await storage.listTasks()).length).toBe(0);
  });

  test('a taken code is a 400; any other storage failure is not', async () => {
    const storage = await getOrCreateStorage();
    await createTask(storage, root, { goal: 'First', code: 'taken-code' });

    let taken: unknown;
    try {
      await createTask(storage, root, { goal: 'Second', code: 'taken-code' });
    } catch (err) {
      taken = err;
    }
    expect(taken).toBeInstanceOf(RpcError);
    expect((taken as RpcError).status).toBe(400);
    expect((taken as RpcError).message).toContain('already exists');

    const original = storage.createTask.bind(storage);
    storage.createTask = async () => {
      throw new Error('ENOSPC: no space left on device');
    };
    try {
      let wrote: unknown;
      try {
        await createTask(storage, root, { goal: 'Write me' });
      } catch (err) {
        wrote = err;
      }
      expect(wrote).toBeInstanceOf(Error);
      expect(wrote).not.toBeInstanceOf(RpcError);
      expect((wrote as Error).message).toContain('failed to create task: ENOSPC');
    } finally {
      storage.createTask = original;
    }
  });
});
