/**
 * FileStorage.createTask lands whole or not at all, even when the process
 * dies between the renames that move a staged task into place.
 */

import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import * as fsp from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage/file-storage';

describe('FileStorage.createTask atomicity', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
    dir = null;
  });

  // INVARIANT: task.json is the LAST file moved into a new task's directory. A
  // directory without task.json is not a task to any reader, so a create that
  // dies part-way through its renames leaves nothing behind — never a visible
  // task whose prompt history, changelog or tag history is missing.
  test('a create interrupted mid-rename leaves no visible task', async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), 'lazy-create-atomic-'));
    await fsp.mkdir(join(dir, '.lazy'), { recursive: true });
    const storage = new FileStorage(dir);
    const realRename = fsp.rename;
    const moved: string[] = [];
    // Only the final move (staging directory -> task directory) counts; the
    // writes INTO the staging directory rename too.
    const spy = spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      const finalMove = String(from).includes('.tmp.') && !String(to).includes('.tmp.');
      const name = String(to).split('/').pop()!;
      if (finalMove && name === 'tag-history.json') throw new Error('simulated crash');
      if (finalMove) moved.push(name);
      return realRename(from, to);
    });
    try {
      await expect(storage.createTask('Half made', undefined, undefined, 'half-made', undefined, undefined, 'human', {
        prompt: 'Do it.', tags: ['launch'],
      })).rejects.toThrow('simulated crash');
    } finally {
      spy.mockRestore();
    }

    expect(moved).toContain('prompt-history.json');
    expect(moved).not.toContain('task.json');
    expect(await storage.listTasks()).toEqual([]);
    expect((await storage.resolveTask('half-made')).task).toBeNull();
    await storage.close();
  });
});
