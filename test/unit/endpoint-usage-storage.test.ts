import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileStorage } from '../../src/storage/file-storage';
import { DaemonClient } from '../../src/daemon/client';
import { RemoteStorage } from '../../src/storage/remote-storage';
import type { StoredUsageLimitReading } from '../../src/storage/types';

// INVARIANT: deleting one account reading is durable, preserves other readings, and refuses a corrupt store.
test('durable endpoint reading deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'endpoint-reading-delete-'));
  try {
    await mkdir(join(root, '.lazy'));
    const store = new FileStorage(root);
    const reading: StoredUsageLimitReading = { credential: 'credential:member-endpoint:["ada@example.com","work"]', ts: Date.now() - 1000, upstream: 'https://api.anthropic.com', backend: 'anthropic', status: 200, taskId: null, model: null, headers: {} };
    await store.saveUsageLimitReading(reading);
    await store.saveUsageLimitReading({ ...reading, credential: 'credential:other' });
    await store.deleteUsageLimitReading(reading.credential);
    expect((await new FileStorage(root).getUsageLimitReadings()).map(r => r.credential)).toEqual(['credential:other']);
    await store.deleteUsageLimitReading(reading.credential);
    await writeFile(join(root, '.lazy', 'usage-limit-readings.json'), 'broken');
    await expect(store.deleteUsageLimitReading('credential:other')).rejects.toThrow('not valid JSON');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// INVARIANT: usage records are daemon-local; RemoteStorage cannot pretend a delete succeeded.
test('remote usage deletion refuses', async () => {
  const store = new RemoteStorage(DaemonClient.fromTarget('http://127.0.0.1:1', 'not-used'), '/not-used', '/not-used');
  await expect(store.deleteUsageLimitReading('credential:work')).rejects.toThrow('daemon');
});
