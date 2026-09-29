import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { ENVIRONMENT_REPLACED_KEY } from '../../src/task/environment-replaced';
import { HOST_REPLACED_MARKER, REASON_HOST_REPLACED, consumeHostReplacedMarker } from '../../src/task/host-replaced-marker';

function fakeStorage(tasks: Array<{ id: string; status: string }>) {
  const meta = new Map<string, string>();
  return {
    meta,
    listTasks: async () => tasks as never,
    getTaskMetadata: async (id: string, key: string) => meta.get(`${id}:${key}`) ?? null,
    updateTaskMetadata: async (id: string, key: string, value: string) => { meta.set(`${id}:${key}`, value); },
  };
}

describe('consumeHostReplacedMarker', () => {
  // INVARIANT: a machine replaced by a Lazy Teams roll tells every OPEN task's
  // next work turn, once. The supervisor that replaced it cannot write the
  // store, so the marker it leaves in the daemon base dir is the only channel;
  // an agent not told would chase tools that vanished with the old machine.
  test('records the notice on every open task and deletes the marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'host-replaced-'));
    try {
      await writeFile(join(dir, HOST_REPLACED_MARKER), `${REASON_HOST_REPLACED}\n`);
      const storage = fakeStorage([
        { id: 'a', status: 'working' },
        { id: 'b', status: 'blocked' },
        { id: 'c', status: 'complete' },
        { id: 'd', status: 'backlog' },
      ]);

      expect(await consumeHostReplacedMarker(storage, dir)).toBe(2);

      expect(storage.meta.get(`a:${ENVIRONMENT_REPLACED_KEY}`)).toBe(REASON_HOST_REPLACED);
      expect(storage.meta.get(`b:${ENVIRONMENT_REPLACED_KEY}`)).toBe(REASON_HOST_REPLACED);
      expect(storage.meta.has(`c:${ENVIRONMENT_REPLACED_KEY}`)).toBe(false);
      expect(storage.meta.has(`d:${ENVIRONMENT_REPLACED_KEY}`)).toBe(false);
      await expect(access(join(dir, HOST_REPLACED_MARKER))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('does nothing without a marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'host-replaced-'));
    try {
      const storage = fakeStorage([{ id: 'a', status: 'working' }]);
      expect(await consumeHostReplacedMarker(storage, dir)).toBeNull();
      expect(storage.meta.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('adds to a reason already pending rather than replacing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'host-replaced-'));
    try {
      await writeFile(join(dir, HOST_REPLACED_MARKER), 'custom; reason\n');
      const storage = fakeStorage([{ id: 'a', status: 'blocked' }]);
      storage.meta.set(`a:${ENVIRONMENT_REPLACED_KEY}`, 'earlier');
      await consumeHostReplacedMarker(storage, dir);
      expect(storage.meta.get(`a:${ENVIRONMENT_REPLACED_KEY}`)).toBe('earlier; custom, reason');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
