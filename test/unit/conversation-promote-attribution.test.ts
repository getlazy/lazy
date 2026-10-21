/**
 * A task promoted out of a builder conversation names the PERSON who promoted it.
 *
 * Driven through `handleRpc` with a user-kind caller — the way Lazy Teams'
 * conversation promote form reaches the daemon on a member's actor token — and,
 * on a laptop, through the storage proxy `lazy conversations promote` uses.
 * A Task record carries no person, so the attribution lands where it can: the
 * task's creation entry in its status history.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDaemonStorage, getOrCreateStorage, closeAllStorage, handleRpc } from '../../src/daemon/rpc-handlers';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';
import { spawnSync } from 'bun';
import type { StoredConversation } from '../../src/storage/types';
import type { PromoteConversationResult } from '../../src/types';

enableInProcessTestMode();

const ADA = { kind: 'user' as const, email: 'ada@example.com', name: 'Ada' };
const SESSION = '3f9a01b2-1111-2222-3333-444444444444';

function conversation(): StoredConversation {
  const msg = (role: 'user' | 'assistant', text: string, n: number) => ({
    uuid: `${role}-${n}`, parentUuid: null, timestamp: '2026-09-01T10:00:00.000Z', role, text, model: null, usage: null,
  });
  return {
    sessionId: SESSION,
    projectPath: '-tmp-project',
    cwd: '/tmp/project',
    version: '2.0.0',
    gitBranch: 'main',
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T11:00:00.000Z',
    importedAt: 1,
    summary: 'A builder session',
    stats: { messageCount: 2, userMessageCount: 1, assistantMessageCount: 1 } as StoredConversation['stats'],
    totalUsage: { inputTokens: 0, outputTokens: 0 } as StoredConversation['totalUsage'],
    messages: [msg('user', 'The audit log should rotate.', 1), msg('assistant', 'Agreed.', 2)],
    subagents: [],
  };
}

describe('conversation promote attribution', () => {
  let root: string;
  let unpinConfig: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-conv-promote-attrib-'));
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    unpinConfig = pinConfig(root);
  });

  afterEach(async () => {
    delete process.env.LAZY_MANAGED;
    delete process.env.LAZY_MANAGED_STORAGE_PATH;
    await closeAllStorage();
    unpinConfig();
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: a conversation promoted on a member's token names that member on
  // the new task's creation entry, exactly as a raised-item promotion does.
  // Without it a hosted team cannot tell who turned a conversation into a task.
  test("a member's promote names the member on the task's creation", async () => {
    process.env.LAZY_MANAGED = '1';
    process.env.LAZY_MANAGED_STORAGE_PATH = join(root, 'store');
    initDaemonStorage(root);
    const storage = await getOrCreateStorage();
    await storage.saveConversation(conversation());

    const result = await handleRpc('conversationPromote', root, { sessionId: SESSION, from: 1 }, undefined, ADA) as PromoteConversationResult;

    const history = await storage.getStatusHistory(result.task.id);
    expect(history[0]).toMatchObject({ status: 'backlog', actor: 'human', actor_email: 'ada@example.com', actor_name: 'Ada' });
  });

  // INVARIANT: the request still cannot name somebody else.
  test('a member cannot promote under another person', async () => {
    process.env.LAZY_MANAGED = '1';
    process.env.LAZY_MANAGED_STORAGE_PATH = join(root, 'store');
    initDaemonStorage(root);
    const storage = await getOrCreateStorage();
    await storage.saveConversation(conversation());
    await expect(handleRpc('conversationPromote', root, {
      sessionId: SESSION, from: 1, actor: { role: 'human', email: 'bob@example.com' },
    }, undefined, ADA)).rejects.toMatchObject({ status: 403 });
  });

  // INVARIANT: on a laptop, `lazy conversations promote` (the storage proxy)
  // names the daemon's git identity on the creation entry — the same person
  // every other attributed write on that install names.
  test('a laptop promote through the storage proxy names the git identity', async () => {
    spawnSync(['git', 'init', '-q'], { cwd: root });
    spawnSync(['git', 'config', 'user.email', 'lin@example.com'], { cwd: root });
    spawnSync(['git', 'config', 'user.name', 'Lin'], { cwd: root });
    initDaemonStorage(root);
    const storage = await getOrCreateStorage();
    await storage.saveConversation(conversation());

    const result = await handleRpc('storage', root, {
      method: 'promoteConversation', args: { sessionId: SESSION, options: { from: 1, actor: 'human' } },
    }) as PromoteConversationResult;

    const history = await storage.getStatusHistory(result.task.id);
    expect(history[0]).toMatchObject({ actor: 'human', actor_email: 'lin@example.com', actor_name: 'Lin' });
  });
});
