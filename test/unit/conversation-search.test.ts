/**
 * Unit tests for shared conversation search — the logic behind
 * `lazy conversations search`, `lazy_conversation_search`, and
 * `/conversations?q=`.
 */

import { describe, test, expect } from 'bun:test';
import {
  searchConversations,
  CONVERSATION_SEARCH_REGEX_DEADLINE_MS,
} from '../../src/conversation/search';
import type { StoredConversation } from '../../src/storage/types';

function makeConversation(
  sessionId: string,
  messages: Array<{ role: 'user' | 'assistant'; text: string }>,
): StoredConversation {
  return {
    sessionId,
    projectPath: 'p',
    cwd: '/repo',
    version: '1',
    gitBranch: 'main',
    startedAt: '2026-08-15T10:00:00Z',
    endedAt: null,
    importedAt: 1,
    summary: `Summary for ${sessionId}`,
    stats: {
      messageCount: messages.length,
      userMessageCount: messages.filter(m => m.role === 'user').length,
      assistantMessageCount: messages.filter(m => m.role === 'assistant').length,
      subagentCount: 0,
      totalTokens: 0,
    },
    totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    messages: messages.map((m, i) => ({
      uuid: `${sessionId}-${i}`,
      parentUuid: null,
      timestamp: '2026-08-15T10:00:00Z',
      role: m.role,
      text: m.text,
      model: null,
      usage: null,
    })),
    subagents: [],
  };
}

describe('searchConversations', () => {
  test('returns excerpts for matching conversations only', async () => {
    const conversations = [
      makeConversation('aaaa', [
        { role: 'user', text: 'Talk about release hubs' },
      ]),
      makeConversation('bbbb', [
        { role: 'user', text: 'Unrelated topic' },
      ]),
    ];

    const hits = await searchConversations(conversations, 'release hub');
    expect(hits).toHaveLength(1);
    expect(hits[0].sessionId).toBe('aaaa');
    expect(hits[0].matches[0].excerpt).toContain('release hubs');
  });

  test('still treats the query as a regex', async () => {
    const conversations = [
      makeConversation('aaaa', [{ role: 'user', text: 'The resurrection guard needs a rebuild.' }]),
      makeConversation('bbbb', [{ role: 'user', text: 'No mention of the topic.' }]),
    ];

    const hits = await searchConversations(conversations, 'guard|rebuild');
    expect(hits).toHaveLength(1);
    expect(hits[0].sessionId).toBe('aaaa');
  });

  test('rejects invalid regex patterns', async () => {
    await expect(searchConversations([], '(unclosed')).rejects.toThrow(/Invalid search pattern/);
  });

  // INVARIANT: a user-supplied conversation search regex must not run
  // unbounded on the caller's thread. Stacked `a*` against a long run of
  // `a` then a non-`a` is the polynomial ReDoS shape: the engine partitions
  // the run across the quantifiers, and each extra `a` multiplies the work.
  // (The textbook exponential `(a+)+$` plateaus around 250ms on JavaScriptCore
  // — still a sync stall, but it never reaches the 1s Worker deadline, so it
  // cannot demonstrate the refusal path on this engine.)
  // n=80 unbounded is many seconds; the deadline is what keeps THIS test fast.
  test('a catastrophically-backtracking pattern is refused instead of hanging', async () => {
    const haystack = 'a'.repeat(80) + '!';
    const conversations = [
      makeConversation('evil', [{ role: 'user', text: haystack }]),
    ];

    const started = performance.now();
    await expect(searchConversations(conversations, 'a*a*a*a*a*a*a*$')).rejects.toThrow(
      /Invalid search pattern[\s\S]*took too long/,
    );
    const elapsed = performance.now() - started;
    // The Worker deadline is the bound; a small margin covers terminate/IPC.
    expect(elapsed).toBeLessThan(CONVERSATION_SEARCH_REGEX_DEADLINE_MS + 500);
  }, 5000);
});
