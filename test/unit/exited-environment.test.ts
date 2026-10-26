import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileStorage } from '../../src/storage';
import { ENVIRONMENT_REPLACED_KEY, LAST_ENVIRONMENT_REPLACED_KEY, recordRecreationIfRunning, clearEnvironmentReplaced } from '../../src/task/environment-replaced';

let root: string;
let storage: FileStorage;
let taskId: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'exited-environment-'));
  storage = new FileStorage(root, { basePath: join(root, 'store') });
  await storage.initialize();
  taskId = (await storage.createTask('keep my environment')).id;
});
afterEach(async () => { await storage.close(); await rm(root, { recursive: true, force: true }); });

const exited = (oomKilled?: boolean) => ({
  usesSandbox: () => true, isRunning: async () => false,
  getRunInfo: async () => ({ running: false, exitCode: 137, finishedAt: '2026-10-22T10:00:00Z', ...(oomKilled == null ? {} : { oomKilled }) }),
});

describe('exited environment replacement', () => {
  // INVARIANT: a dead container's loss is as valuable to explain as a live
  // container's replacement. Runtime evidence must be saved before removal.
  for (const oom of [true, false, undefined]) {
    test(`records exit evidence with OOM=${oom} before replacing`, async () => {
      await recordRecreationIfRunning(storage, taskId, null, exited(oom), 'task-container');
      const reason = await storage.getTaskMetadata(taskId, ENVIRONMENT_REPLACED_KEY);
      expect(reason).toContain('code 137');
      expect(reason).toContain('2026-10-22T10:00:00Z');
      expect(reason).toContain(oom === true ? 'OOM-killed (out of memory)' : oom === false ? 'not OOM-killed' : 'OOM status unknown');
      expect(await storage.getTaskJournal(taskId)).toHaveLength(1);
      await recordRecreationIfRunning(storage, taskId, null, exited(oom), 'task-container');
      expect(await storage.getTaskJournal(taskId)).toHaveLength(1);
      await clearEnvironmentReplaced(storage, taskId);
      expect(await storage.getTaskMetadata(taskId, ENVIRONMENT_REPLACED_KEY)).toBeFalsy();
      expect(JSON.parse((await storage.getTaskMetadata(taskId, LAST_ENVIRONMENT_REPLACED_KEY))!).reason).toBe(reason);
    });
  }

  test('an unreadable runtime refuses replacement instead of inventing an exit', async () => {
    await expect(recordRecreationIfRunning(storage, taskId, null, {
      ...exited(), probeRunInfo: async () => ({ kind: 'no-answer' as const, reason: 'Docker is unreachable' }),
    }, 'task-container')).rejects.toThrow('Docker is unreachable');
    expect(await storage.getTaskJournal(taskId)).toHaveLength(0);
  });
});
