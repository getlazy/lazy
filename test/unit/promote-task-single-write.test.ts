/**
 * INVARIANT: a promotion creates its task in ONE storage write — prompt and the
 * originating task's model/effort land with the row. Separate follow-up writes
 * could leave a promptless backlog task behind when one failed.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDaemonStorage, getOrCreateStorage, closeAllStorage } from '../../src/daemon/rpc-handlers';
import { createPromotedTask } from '../../src/raised/promote-task';
import { currentPromptOf } from '../../src/task-prompt';

describe('createPromotedTask', () => {
  let root: string;
  let prevLazyConfig: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-promote-'));
    const store = join(root, 'store');
    await mkdir(store, { recursive: true });
    const configPath = join(root, 'lazy.toml');
    await writeFile(configPath, `[storage]\nbackend = "external"\nexternal_path = "${store}"\n`);
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

  test('writes the prompt, model and effort with the row', async () => {
    const storage = await getOrCreateStorage();
    const origin = await storage.createTask('Origin', undefined, undefined, 'origin', 'task', 'claude-code', 'human', {
      model: 'm-origin', metadata: { effort: 'high' },
    });
    const updates: string[] = [];
    for (const method of ['updateTaskPrompt', 'updateTaskModel', 'updateTaskMetadata'] as const) {
      const original = (storage as any)[method].bind(storage);
      (storage as any)[method] = async (...args: unknown[]) => { updates.push(method); return original(...args); };
    }

    const task = await createPromotedTask(storage, {
      originatingTask: origin, relation: 'peer', goal: 'Follow up', prompt: 'Do the follow-up.', actor: 'human',
    });

    expect(updates).toEqual([]);
    expect(currentPromptOf(task)).toBe('Do the follow-up.');
    expect(task.model).toBe('m-origin');
    expect(task.metadata?.effort).toBe('high');
  });
});
