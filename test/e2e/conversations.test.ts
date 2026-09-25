/**
 * E2E coverage for `lazy conversations` — list, search, and show against a
 * seeded store.
 *
 * Seeding is direct-to-storage on purpose: capture/import have their own suites;
 * here we only need a couple of stored conversations to exercise the human
 * browsing surface.
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import {
  expectSuccess,
  expectFailure,
  expectOutput,
  expectError,
  expectOutputExcludes,
} from '../helpers/assertions';
import { writeConversationFile } from '../helpers/storage';

function seedConversation(
  sessionId: string,
  overrides: {
    summary?: string;
    startedAt?: string;
    endedAt?: string;
    messages?: Array<{ role: 'user' | 'assistant'; text: string }>;
  } = {},
) {
  const messages = (overrides.messages ?? [
    { role: 'user' as const, text: 'How should we ship conversations CLI?' },
    { role: 'assistant' as const, text: 'Add lazy conversations list/search/show.' },
  ]).map((m, i) => ({
    uuid: `${sessionId}-${m.role[0]}${i}`,
    parentUuid: null,
    timestamp: `2026-08-15T10:0${i}:00Z`,
    role: m.role,
    text: m.text,
    model: m.role === 'assistant' ? 'claude-opus-4-8' : null,
    usage: null,
  }));

  return {
    sessionId,
    projectPath: 'encoded-path',
    cwd: '/repo',
    version: '1.0.0',
    gitBranch: 'main',
    startedAt: overrides.startedAt ?? '2026-08-15T10:00:00Z',
    endedAt: overrides.endedAt ?? '2026-08-15T11:00:00Z',
    importedAt: Date.now(),
    summary: overrides.summary ?? 'Ship conversations CLI',
    stats: {
      messageCount: messages.length,
      userMessageCount: messages.filter(m => m.role === 'user').length,
      assistantMessageCount: messages.filter(m => m.role === 'assistant').length,
      subagentCount: 0,
      totalTokens: 42,
    },
    totalUsage: { input_tokens: 10, output_tokens: 5 },
    messages,
    subagents: [],
  };
}

describe('lazy conversations', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('empty store points at builder and import', async () => {
    const result = await ctx.lazy(['conversations']);
    expectSuccess(result);
    expectOutput(result, 'No captured builder conversations yet');
    expectOutput(result, 'lazy builder');
    expectOutput(result, 'lazy import-conversation');
  });

  test('list → search → show lifecycle', async () => {
    const older = seedConversation('11111111-2222-3333-4444-555555555555', {
      summary: 'Older builder session',
      startedAt: '2026-08-10T10:00:00Z',
      messages: [
        { role: 'user', text: 'Discuss release timing' },
        { role: 'assistant', text: 'Ship after capture is reliable.' },
      ],
    });
    const newer = seedConversation('abcdef01-2222-3333-4444-555555555555', {
      summary: 'Newer design decision',
      startedAt: '2026-08-20T10:00:00Z',
      messages: [
        { role: 'user', text: 'conversations CLI should be read-only' },
        { role: 'assistant', text: 'Yes — list, search, and show only.' },
      ],
    });
    writeConversationFile(ctx.root, older);
    writeConversationFile(ctx.root, newer);

    const list = await ctx.lazy(['conversations', 'list']);
    expectSuccess(list);
    expectOutput(list, '2 captured conversation(s)');
    // INVARIANT: list is sorted most-recent-first (storage contract).
    if (list.stdout.indexOf('abcdef01') >= list.stdout.indexOf('11111111')) {
      throw new Error(`Expected newer conversation before older in list output:\n${list.stdout}`);
    }
    expectOutput(list, 'Newer design decision');

    const search = await ctx.lazy(['conversations', 'search', 'read-only']);
    expectSuccess(search);
    expectOutput(search, 'abcdef01');
    expectOutput(search, '[human]');
    expectOutputExcludes(search, '11111111');

    const inlineSearch = await ctx.lazy(['conversations', '--search', 'release timing']);
    expectSuccess(inlineSearch);
    expectOutput(inlineSearch, '11111111');

    const show = await ctx.lazy(['conversations', 'show', 'abcdef01']);
    expectSuccess(show);
    expectOutput(show, 'conversations CLI should be read-only');
    expectOutput(show, 'list, search, and show only');
  });

  test('list paging hints when --limit is smaller than total', async () => {
    writeConversationFile(ctx.root, seedConversation('aaaaaaaa-2222-3333-4444-555555555555'));
    writeConversationFile(ctx.root, seedConversation('bbbbbbbb-2222-3333-4444-555555555555', {
      summary: 'Second conversation',
      startedAt: '2026-08-16T10:00:00Z',
    }));

    const page = await ctx.lazy(['conversations', 'list', '--limit', '1']);
    expectSuccess(page);
    expectOutput(page, 'Showing 1 of 2');
    expectOutput(page, '--offset 1');
  });

  test('show of an unknown id fails with a pointer to list', async () => {
    const result = await ctx.lazy(['conversations', 'show', 'ffffffff']);
    expectFailure(result);
    expectError(result, 'No conversation matches');
  });

  test('a non-hex session id is rejected at the boundary', async () => {
    const result = await ctx.lazy(['conversations', 'show', 'not%an-id']);
    expectFailure(result);
    expectError(result, 'Invalid session id');
  });

  describe('promote', () => {
    const sessionId = 'aabbccdd-2222-3333-4444-555555555555';

    async function seedDecision(): Promise<void> {
      writeConversationFile(ctx.root, seedConversation(sessionId, {
        summary: 'Proxy audit log',
        messages: [
          { role: 'user', text: 'Unrelated: when does the release cut?' },
          { role: 'assistant', text: 'Next week.' },
          { role: 'user', text: 'The proxy audit log should rotate instead of growing forever.' },
          { role: 'assistant', text: 'Agreed — bound it by construction, rotation plus a hard cap.' },
        ],
      }));
    }

    test('seeds a backlog task from the named messages and nothing else', async () => {
      await seedDecision();

      const promoted = await ctx.lazy([
        'conversations', 'promote', 'aabbccdd',
        '--from', '3', '--to', '4', '--code', 'rotate-proxy-audit-log', '--yes',
      ]);
      expectSuccess(promoted);
      expectOutput(promoted, 'Created backlog task');
      expectOutput(promoted, 'not started');

      const show = await ctx.lazy(['show', 'rotate-proxy-audit-log']);
      expectSuccess(show);
      // Verbatim, and only the selected exchange: the unrelated opening pair
      // is what a whole-transcript seed would have dragged in.
      expectOutput(show, 'should rotate instead of growing forever');
      expectOutput(show, 'bound it by construction');
      expectOutputExcludes(show, 'when does the release cut');
      expectOutput(show, `Promoted from builder conversation ${sessionId}`);

      const list = await ctx.lazy(['list']);
      expectSuccess(list);
      expectOutput(list, 'backlog');
    });

    // INVARIANT: the same range cannot be promoted twice. The durable link
    // lives on the created TASK (metadata), not on the conversation record —
    // capture rewrites that record whenever the session grows — so a second
    // promote is refused by reading the tasks back.
    test('refuses a range that already became a task, naming it', async () => {
      await seedDecision();
      expectSuccess(await ctx.lazy([
        'conversations', 'promote', 'aabbccdd', '--from', '3', '--to', '4',
        '--code', 'rotate-proxy-audit-log', '--yes',
      ]));

      const again = await ctx.lazy([
        'conversations', 'promote', 'aabbccdd', '--from', '3', '--to', '4', '--yes',
      ]);
      expectFailure(again);
      expectError(again, 'already promoted to rotate-proxy-audit-log');
    });

    test('an overlapping — but different — range is allowed, with a warning', async () => {
      await seedDecision();
      expectSuccess(await ctx.lazy([
        'conversations', 'promote', 'aabbccdd', '--from', '3', '--to', '4',
        '--code', 'rotate-proxy-audit-log', '--yes',
      ]));

      const overlapping = await ctx.lazy([
        'conversations', 'promote', 'aabbccdd', '--from', '4', '--to', '4',
        '--goal', 'Cap the audit log size', '--code', 'cap-audit-log', '--yes',
      ]);
      expectSuccess(overlapping);
      expectOutput(overlapping, 'overlaps');
      expectOutput(overlapping, 'Created backlog task');
    });

    test('a range the transcript does not have is refused, not clamped', async () => {
      await seedDecision();
      const result = await ctx.lazy([
        'conversations', 'promote', 'aabbccdd', '--from', '3', '--to', '99', '--yes',
      ]);
      expectFailure(result);
      expectError(result, '4 messages');
    });

    test('promoting without naming a range says how to name one', async () => {
      await seedDecision();
      const result = await ctx.lazy(['conversations', 'promote', 'aabbccdd', '--yes']);
      expectFailure(result);
      expectError(result, '--from');
    });

    test('show numbers the messages the range refers to', async () => {
      await seedDecision();
      const show = await ctx.lazy(['conversations', 'show', 'aabbccdd']);
      expectSuccess(show);
      expectOutput(show, '#3');
    });
  });

  test('unknown subcommand fails with usage', async () => {
    const result = await ctx.lazy(['conversations', 'frobnicate']);
    expectFailure(result);
    expectError(result, 'Unknown conversations subcommand');
  });

  // Same unusable-pattern path as a syntax error: a catastrophic regex must
  // fail fast with the shared message, not hang the CLI process.
  test('a catastrophically-backtracking search pattern is refused', async () => {
    writeConversationFile(ctx.root, seedConversation('aaaaaaaa-2222-3333-4444-555555555555', {
      messages: [{ role: 'user', text: `${'a'.repeat(80)}!` }],
    }));

    const result = await ctx.lazy(['conversations', 'search', 'a*a*a*a*a*a*a*$']);
    expectFailure(result);
    expectError(result, 'Invalid search pattern');
    expectError(result, 'took too long');
  }, 15_000);
});
