/**
 * Unit tests for the capture no-regression guard.
 *
 * INVARIANT: capture never shortens a stored conversation. Every capture surface
 * (the in-container builder monitor, the CLI, the daemon's own sweep) re-parses
 * whatever JSONL it found and hands the result to storage. A stale copy of a
 * session — frozen at an earlier point, then merely touched — is therefore enough
 * to overwrite hours of conversation the user could otherwise still read via
 * `lazy view`. That happened; this guard is why it cannot happen again.
 *
 * The guard is deliberately NARROW: only a provable prefix (same uuids,
 * position-for-position, fewer of them) is refused. A conversation that genuinely
 * diverged is stored, because there the on-disk truth is what the user wants.
 */

import { describe, test, expect } from 'bun:test';
import {
  isStrictPrefixConversation,
  saveConversationWithoutRegression,
} from '../../src/import/conversation-storage';
import type { StoredConversation } from '../../src/storage/types';
import type { Storage } from '../../src/storage/interface';

function conv(sessionId: string, uuids: string[]): StoredConversation {
  return {
    sessionId,
    messages: uuids.map((uuid, i) => ({
      uuid,
      parentUuid: i > 0 ? uuids[i - 1] : null,
      timestamp: `2026-08-15T10:0${i}:00Z`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `m${i}`,
    })),
  } as unknown as StoredConversation;
}

function stubStorage(preloaded?: StoredConversation) {
  const stub = {
    saveCalls: [] as string[],
    stored: preloaded ?? null,
    async loadConversation(): Promise<StoredConversation | null> {
      return stub.stored;
    },
    async saveConversation(c: StoredConversation): Promise<void> {
      stub.saveCalls.push(c.sessionId);
      stub.stored = c;
    },
  };
  return stub as unknown as typeof stub & Storage;
}

describe('isStrictPrefixConversation', () => {
  test('a shorter conversation with matching uuids is a prefix', () => {
    expect(isStrictPrefixConversation(conv('s', ['a', 'b']), conv('s', ['a', 'b', 'c']))).toBe(true);
  });

  test('an equal-length conversation is not a prefix', () => {
    // Equal length is a legitimate re-save (metadata or usage changed) — allow it.
    expect(isStrictPrefixConversation(conv('s', ['a', 'b']), conv('s', ['a', 'b']))).toBe(false);
  });

  test('a longer conversation is not a prefix', () => {
    expect(isStrictPrefixConversation(conv('s', ['a', 'b', 'c']), conv('s', ['a', 'b']))).toBe(false);
  });

  test('a shorter but DIVERGENT conversation is not a prefix', () => {
    expect(isStrictPrefixConversation(conv('s', ['a', 'x']), conv('s', ['a', 'b', 'c']))).toBe(false);
  });
});

describe('saveConversationWithoutRegression', () => {
  test('refuses to shorten a stored conversation', async () => {
    const storage = stubStorage(conv('s', ['a', 'b', 'c']));
    expect(await saveConversationWithoutRegression(storage, conv('s', ['a', 'b']))).toBe('skipped-regression');
    expect(storage.saveCalls).toEqual([]);
    expect(storage.stored!.messages.length).toBe(3);
  });

  test('stores a conversation that grew', async () => {
    const storage = stubStorage(conv('s', ['a', 'b']));
    expect(await saveConversationWithoutRegression(storage, conv('s', ['a', 'b', 'c']))).toBe('saved');
    expect(storage.stored!.messages.length).toBe(3);
  });

  test('stores a conversation the store has never seen', async () => {
    const storage = stubStorage();
    expect(await saveConversationWithoutRegression(storage, conv('s', ['a']))).toBe('saved');
    expect(storage.saveCalls).toEqual(['s']);
  });

  test('stores a shorter but divergent conversation', async () => {
    const storage = stubStorage(conv('s', ['a', 'b', 'c']));
    expect(await saveConversationWithoutRegression(storage, conv('s', ['z']))).toBe('saved');
    expect(storage.stored!.messages.length).toBe(1);
  });
});
