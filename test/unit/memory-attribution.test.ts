/**
 * Shared memory names the PERSON who wrote it, and only people write it.
 *
 * Driven through `handleRpc` with a user-kind caller — the way Lazy Teams
 * reaches the daemon on a member's actor token — because the person must come
 * from the token (`applyCallerActor`), never from anything the request says.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDaemonStorage, getOrCreateStorage, closeAllStorage, handleRpc } from '../../src/daemon/rpc-handlers';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';
import type { MemoryRecord, MemoryEvent } from '../../src/types';

enableInProcessTestMode();

const ADA = { kind: 'user' as const, email: 'ada@example.com', name: 'Ada' };
const BOB = { kind: 'user' as const, email: 'bob@example.com', name: 'Bob' };

describe('memory write attribution', () => {
  let root: string;
  let unpinConfig: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-memory-attrib-'));
    process.env.LAZY_MANAGED = '1';
    process.env.LAZY_MANAGED_STORAGE_PATH = join(root, 'store');
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    unpinConfig = pinConfig(root);
    initDaemonStorage(root);
  });

  afterEach(async () => {
    delete process.env.LAZY_MANAGED;
    delete process.env.LAZY_MANAGED_STORAGE_PATH;
    await closeAllStorage();
    unpinConfig();
    await rm(root, { recursive: true, force: true });
  });

  const save = (caller: typeof ADA, body: string) =>
    handleRpc('saveMemoryRecord', root, {
      name: 'team-style', type: 'feedback', description: 'How we work', body,
    }, undefined, caller) as Promise<MemoryRecord>;

  // INVARIANT: a write on a member's token names that member in the record and
  // in its append-only history. Without it a shared install cannot tell which
  // member changed what gets injected into every future prompt.
  test('create, update and remove each name the member who did it', async () => {
    const created = await save(ADA, 'v1');
    expect(created.created_by).toBe('human');
    expect(created.created_by_email).toBe('ada@example.com');
    expect(created.created_by_name).toBe('Ada');
    expect(created.updated_by_email).toBe('ada@example.com');

    const updated = await save(BOB, 'v2');
    expect(updated.created_by_email).toBe('ada@example.com');
    expect(updated.updated_by_email).toBe('bob@example.com');
    expect(updated.updated_by_name).toBe('Bob');

    const removed = await handleRpc('deleteMemoryRecord', root, { name: 'team-style' }, undefined, ADA) as MemoryRecord;
    expect(removed.deleted_by_email).toBe('ada@example.com');

    const storage = await getOrCreateStorage();
    const events: MemoryEvent[] = await storage.getMemoryHistory('team-style');
    expect(events.map(e => [e.action, e.actor, e.actor_email, e.actor_name])).toEqual([
      ['create', 'human', 'ada@example.com', 'Ada'],
      ['update', 'human', 'bob@example.com', 'Bob'],
      ['delete', 'human', 'ada@example.com', 'Ada'],
    ]);
  });

  // INVARIANT: a write that names nobody does not inherit the previous
  // writer's name — a wrong byline is worse than none.
  test("an unattributed update clears the previous writer's person", async () => {
    await save(ADA, 'v1');
    const storage = await getOrCreateStorage();
    const next = await storage.saveMemory(
      { name: 'team-style', type: 'feedback', description: 'How we work', body: 'v2' },
      'human',
    );
    expect(next.updated_by).toBe('human');
    expect(next.updated_by_email).toBeUndefined();
    expect(next.created_by_email).toBe('ada@example.com');
  });

  // INVARIANT: a request cannot name somebody else — the person rides the
  // token, and naming a different one is refused.
  test('a member cannot write under another person', async () => {
    await expect(handleRpc('saveMemoryRecord', root, {
      name: 'x', type: 'project', description: 'd', body: 'b',
      actor: { role: 'human', email: 'bob@example.com' },
    }, undefined, ADA)).rejects.toMatchObject({ status: 403 });
  });

  // INVARIANT: only people write shared memory. Memory is injected into every
  // future prompt, so an agent-writable store is a prompt-injection channel —
  // the memory commands refuse the agent role outright, not only the MCP tool.
  test('the agent role is refused by every memory command', async () => {
    delete process.env.LAZY_MANAGED;
    for (const [command, params] of [
      ['saveMemoryRecord', { name: 'x', type: 'project', description: 'd', body: 'b' }],
      ['deleteMemoryRecord', { name: 'x' }],
      ['compactMemory', { mode: 'mechanical' }],
      ['clearMemoryCompact', {}],
    ] as const) {
      await expect(
        (await import('../../src/daemon/rpc-memory'))[
          command === 'saveMemoryRecord' ? 'handleSaveMemoryRecord'
            : command === 'deleteMemoryRecord' ? 'handleDeleteMemoryRecord'
              : command === 'compactMemory' ? 'handleCompactMemory' : 'handleClearMemoryCompact'
        ](root, { ...params, actor: 'agent' }),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  // INVARIANT: the injected-context answer comes from the daemon, whole — the
  // same payload the dashboard renders — so a client never re-derives sizes or
  // which records a compact misses.
  test('memoryStatus answers sizes, coverage gaps and the banner text', async () => {
    await save(ADA, 'v1');
    const storage = await getOrCreateStorage();
    await storage.saveMemoryCompact(
      { content: '- team-style', method: 'mechanical', covered: [{ name: 'team-style', revision: 1 }] },
      'human',
    );
    await save(ADA, 'v2');
    await storage.saveMemory({ name: 'gone', type: 'project', description: 'old', body: 'b' }, 'human');

    const status = await handleRpc('memoryStatus', root, {}) as Record<string, unknown>;
    expect(status.liveCount).toBe(2);
    expect(typeof status.bytes).toBe('number');
    expect(typeof status.plainBytes).toBe('number');
    expect(typeof status.warnBytes).toBe('number');
    expect(status.stale).toBe(true);
    expect((status.newer as Array<{ name: string }>).map(r => r.name).sort()).toEqual(['gone', 'team-style']);
    expect(status.removed).toEqual([]);
    expect(String(status.bannerText)).toContain('Injected context:');
    expect(String(status.sizeLine)).toContain('without a compact');
  });
});
