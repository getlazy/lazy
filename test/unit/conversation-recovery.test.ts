import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readdir, writeFile, mkdir, symlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  writeConversationRecoveryFile,
  drainConversationRecovery,
  conversationRecoveryDir,
} from '../../src/import/conversation-recovery';
import type { StoredConversation } from '../../src/storage/types';
import type { Storage } from '../../src/storage';

function conv(sessionId: string, extra: Record<string, unknown> = {}): StoredConversation {
  return {
    sessionId, projectPath: '/p', cwd: '/p', startedAt: 1, endedAt: 2, importedAt: 3, summary: 's',
    stats: { messageCount: 1 },
    messages: [{ uuid: 'u1', parentUuid: null, timestamp: '2026-01-01T00:00:00Z', role: 'user', text: 'hi' }],
    subagents: [],
    ...extra,
  } as unknown as StoredConversation;
}

function fakeStorage(failFor?: string) {
  const saved = new Map<string, StoredConversation>();
  const storage = {
    loadConversation: async (id: string) => saved.get(id) ?? null,
    saveConversation: async (c: StoredConversation) => {
      if (c.sessionId === failFor) throw new Error('store down');
      saved.set(c.sessionId, c);
    },
  } as unknown as Storage;
  return { storage, saved };
}

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'conv-recovery-'));
  await mkdir(join(root, '.lazy'));
  dir = await conversationRecoveryDir(root);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function plant(name: string, body: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), JSON.stringify(body));
}

describe('conversation recovery directory', () => {
  // INVARIANT: a conversation captured while the daemon is down is written to
  // the recovery dir and saved by the daemon later, the file removed only after
  // the save. Otherwise a pairing session with no daemon loses its history.
  test('written file is saved into storage and then removed', async () => {
    await writeConversationRecoveryFile(root, conv('sess-a'), 'Pairing');
    const { storage, saved } = fakeStorage();
    const result = await drainConversationRecovery(storage, root);
    expect(result.recovered).toEqual(['sess-a']);
    expect(saved.get('sess-a')?.messages.length).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });

  // INVARIANT: a failed save never deletes the recovery file — it is retried.
  test('failed save keeps the file and reports the failure', async () => {
    await writeConversationRecoveryFile(root, conv('sess-b'), 'Builder');
    const { storage } = fakeStorage('sess-b');
    await expect(drainConversationRecovery(storage, root)).rejects.toThrow(/stay in place/);
    expect((await readdir(dir)).length).toBe(1);
  });

  test('missing dir is a no-op', async () => {
    const { storage } = fakeStorage();
    expect(await drainConversationRecovery(storage, root)).toEqual({ recovered: [], invalid: [], failed: [] });
  });

  // INVARIANT: the recovery dir is container-writable, so an attribution in a
  // file is never trusted — memberEmail is stored as null, as on the
  // user-token capture route. Otherwise a planted file forges authorship.
  test('memberEmail from the file is never trusted', async () => {
    await plant('conversation-x.json', { format: 'lazy-conversation-recovery', version: 1, label: 'Builder', conversation: conv('sess-c', { memberEmail: 'victim@example.com' }) });
    const { storage, saved } = fakeStorage();
    await drainConversationRecovery(storage, root);
    expect(saved.get('sess-c')?.memberEmail).toBeNull();
  });

  // INVARIANT: malformed or foreign files never reach storage and are set aside
  // once (not warned about every tick); valid siblings are still recovered.
  test('invalid files are set aside, not stored, and not retried', async () => {
    await plant('a-foreign.json', {});
    await plant('b-bad-messages.json', { format: 'lazy-conversation-recovery', conversation: conv('sess-d', { messages: 'nope' }) });
    await plant('c-bad-id.json', { format: 'lazy-conversation-recovery', conversation: conv('../escape') });
    await writeConversationRecoveryFile(root, conv('sess-ok'), 'Pairing');
    const { storage, saved } = fakeStorage();
    const result = await drainConversationRecovery(storage, root);
    expect(result.invalid.length).toBe(3);
    expect([...saved.keys()]).toEqual(['sess-ok']);
    expect((await readdir(dir)).sort()).toEqual(['a-foreign.json.invalid', 'b-bad-messages.json.invalid', 'c-bad-id.json.invalid']);
    expect((await drainConversationRecovery(storage, root)).invalid).toEqual([]);
  });

  // INVARIANT: a symlink in the recovery dir is never followed.
  test('symlinked json is not read', async () => {
    const target = join(root, 'elsewhere.json');
    await writeFile(target, JSON.stringify({ format: 'lazy-conversation-recovery', conversation: conv('sess-link') }));
    await mkdir(dir, { recursive: true });
    await symlink(target, join(dir, 'link.json'));
    const { storage, saved } = fakeStorage();
    const result = await drainConversationRecovery(storage, root);
    expect(saved.size).toBe(0);
    expect(result.invalid.length).toBe(1);
  });
});
