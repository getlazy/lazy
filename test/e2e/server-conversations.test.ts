/**
 * E2E for the web builder-conversations surface: the listing, keyword search,
 * the paged transcript, and the JSON listing.
 *
 * The daemon serves these routes in-process from its own Storage. They are
 * read-only, so — unlike the inbox suite — there is no store state to assert
 * after an action; what matters is that the pages render the captured record
 * faithfully and that the read-only posture actually holds (a POST is refused,
 * and the JSON listing never ships transcripts).
 *
 * Seeding is direct-to-storage because conversations reach the store only via
 * the capture pipeline (the daemon sweep and the builder supervisor) — there is
 * no create surface to drive, so the helper writes what the routes read.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { writeConversationFile, storageDirFor } from '../helpers/storage';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

interface SeedMessage {
  role: 'user' | 'assistant';
  text: string;
  model?: string | null;
}

function seedConversation(options: {
  sessionId?: string;
  summary?: string;
  startedAt?: string;
  endedAt?: string;
  gitBranch?: string | null;
  messages?: SeedMessage[];
}): Record<string, unknown> {
  const messages = (options.messages ?? [
    { role: 'user', text: 'What is left for the release?' },
    { role: 'assistant', text: 'Two tasks are still blocked.', model: 'claude-opus-5' },
  ]) as SeedMessage[];

  const userCount = messages.filter((m) => m.role === 'user').length;
  const assistantCount = messages.filter((m) => m.role === 'assistant').length;

  return {
    sessionId: options.sessionId ?? randomUUID(),
    projectPath: '-tmp-project',
    cwd: '/tmp/project',
    version: '2.0.0',
    gitBranch: options.gitBranch ?? 'main',
    startedAt: options.startedAt ?? '2026-08-30T10:00:00.000Z',
    endedAt: options.endedAt ?? '2026-08-30T11:30:00.000Z',
    importedAt: Date.now(),
    summary: options.summary ?? 'What is left for the release?',
    stats: {
      messageCount: messages.length,
      userMessageCount: userCount,
      assistantMessageCount: assistantCount,
      subagentCount: 0,
      totalTokens: 1234,
    },
    totalUsage: {
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    messages: messages.map((m, i) => ({
      uuid: randomUUID(),
      parentUuid: null,
      timestamp: `2026-08-30T10:${String(i).padStart(2, '0')}:00.000Z`,
      role: m.role,
      text: m.text,
      model: m.model ?? null,
      usage: null,
    })),
    subagents: [],
  };
}

describe('web builder conversations', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('an empty store says so rather than rendering a blank table', async () => {
    const res = await fetch(`${base}/conversations`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('No builder conversations yet');
  });

  test('the listing shows captured conversations newest first', async () => {
    writeConversationFile(ctx.root, seedConversation({
      sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
      summary: 'Older: how do I reparent a task?',
      startedAt: '2026-08-28T09:00:00.000Z',
    }));
    writeConversationFile(ctx.root, seedConversation({
      sessionId: 'bbbbbbbb-2222-4222-8222-222222222222',
      summary: 'Newer: what is left for the release?',
      startedAt: '2026-08-30T09:00:00.000Z',
    }));

    const html = await (await fetch(`${base}/conversations`)).text();
    expect(html).toContain('2 conversations');
    expect(html).toContain('Older: how do I reparent a task?');
    expect(html).toContain('Newer: what is left for the release?');
    // Short ids are what the listing shows, and what the detail route accepts.
    expect(html).toContain('aaaaaaaa');
    expect(html).toContain('bbbbbbbb');
    expect(html.indexOf('bbbbbbbb')).toBeLessThan(html.indexOf('aaaaaaaa'));
  });

  test('a conversation with no summary is titled rather than left blank', async () => {
    writeConversationFile(ctx.root, seedConversation({ summary: '   ' }));
    const html = await (await fetch(`${base}/conversations`)).text();
    expect(html).toContain('(no summary)');
  });

  test('the detail page renders the transcript with human-facing role labels', async () => {
    const sessionId = 'cccccccc-3333-4333-8333-333333333333';
    writeConversationFile(ctx.root, seedConversation({
      sessionId,
      messages: [
        { role: 'user', text: 'Which tasks are blocked?' },
        { role: 'assistant', text: 'Two of them.', model: 'claude-opus-5' },
      ],
    }));

    const html = await (await fetch(`${base}/conversations/${sessionId}`)).text();
    expect(html).toContain('Which tasks are blocked?');
    expect(html).toContain('Two of them.');
    // The stored roles are user/assistant; the page speaks the human's terms.
    expect(html).toContain('>You<');
    expect(html).toContain('>Builder<');
    expect(html).toContain('claude-opus-5');
    expect(html).toContain('2 total');
  });

  test('a unique short id resolves, an unknown one 404s', async () => {
    writeConversationFile(ctx.root, seedConversation({
      sessionId: 'dddddddd-4444-4444-8444-444444444444',
      summary: 'Resolvable by prefix',
    }));

    const short = await fetch(`${base}/conversations/dddddddd`);
    expect(short.status).toBe(200);
    expect(await short.text()).toContain('Resolvable by prefix');

    const missing = await fetch(`${base}/conversations/zzzzzzzz`);
    expect(missing.status).toBe(404);
  });

  // INVARIANT: an ambiguous short id resolves to NOTHING, never to a guess.
  // The listing shows eight characters, so a prefix collision is reachable by
  // ordinary copy-paste; silently opening whichever conversation sorted first
  // would show the human someone else's transcript and look like the right one.
  test('an ambiguous short id refuses rather than guessing', async () => {
    writeConversationFile(ctx.root, seedConversation({
      sessionId: 'eeeeeeee-5555-4555-8555-555555555555',
      summary: 'First collision',
    }));
    writeConversationFile(ctx.root, seedConversation({
      sessionId: 'eeeeeeee-6666-4666-8666-666666666666',
      summary: 'Second collision',
    }));

    const res = await fetch(`${base}/conversations/eeeeeeee`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('more than one');
    expect(html).not.toContain('First collision');
  });

  test('a long transcript pages, and the pages meet without gaps or repeats', async () => {
    const sessionId = 'ffffffff-7777-4777-8777-777777777777';
    const messages: SeedMessage[] = [];
    for (let i = 0; i < 45; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', text: `message-body-${i}` });
    }
    writeConversationFile(ctx.root, seedConversation({ sessionId, messages }));

    const first = await (await fetch(`${base}/conversations/${sessionId}`)).text();
    expect(first).toContain('Showing 1&ndash;40 of 45');
    expect(first).toContain('message-body-0');
    expect(first).toContain('message-body-39');
    expect(first).not.toContain('message-body-40');
    expect(first).toContain('offset=40');
    // Nothing to go back to on the first page.
    expect(first).not.toContain('Earlier');

    const second = await (await fetch(`${base}/conversations/${sessionId}?offset=40`)).text();
    expect(second).toContain('Showing 41&ndash;45 of 45');
    expect(second).toContain('message-body-40');
    expect(second).toContain('message-body-44');
    expect(second).not.toContain('message-body-39');
    expect(second).toContain('Earlier');
    expect(second).not.toContain('Later');
  });

  test('an offset past the end lands on the last message rather than erroring', async () => {
    const sessionId = 'a1b2c3d4-8888-4888-8888-888888888888';
    writeConversationFile(ctx.root, seedConversation({
      sessionId,
      messages: [
        { role: 'user', text: 'only-question' },
        { role: 'assistant', text: 'only-answer' },
      ],
    }));

    const res = await fetch(`${base}/conversations/${sessionId}?offset=9999`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('only-answer');
  });

  test('search finds a passage and links to the conversation holding it', async () => {
    writeConversationFile(ctx.root, seedConversation({
      sessionId: 'aa000000-9999-4999-8999-999999999999',
      summary: 'Release endgame',
      messages: [
        { role: 'user', text: 'What blocks the release?' },
        { role: 'assistant', text: 'The resurrection guard needs a rebuild.' },
      ],
    }));
    writeConversationFile(ctx.root, seedConversation({
      sessionId: 'bb000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      summary: 'Unrelated chatter',
      messages: [{ role: 'user', text: 'Nothing to do with the topic.' }],
    }));

    const html = await (await fetch(`${base}/conversations?q=resurrection`)).text();
    expect(html).toContain('1 conversation matched');
    expect(html).toContain('Release endgame');
    expect(html).toContain('resurrection guard');
    expect(html).not.toContain('Unrelated chatter');
    expect(html).toContain('/conversations/aa000000-9999-4999-8999-999999999999');
  });

  test('a search with no hits says so instead of showing the full list', async () => {
    writeConversationFile(ctx.root, seedConversation({ summary: 'Release endgame' }));
    const html = await (await fetch(`${base}/conversations?q=nothingmatchesthis`)).text();
    expect(html).toContain('No conversation mentions');
    expect(html).not.toContain('Release endgame');
  });

  // A pattern the regex engine rejects is the human's typo, not a server fault:
  // the page must name the problem and keep the box filled in, never 500.
  test('an unusable search pattern is reported, not thrown', async () => {
    writeConversationFile(ctx.root, seedConversation({}));
    const res = await fetch(`${base}/conversations?q=${encodeURIComponent('[unclosed')}`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Invalid search pattern');
    expect(html).toContain('[unclosed');
    expect(html).not.toContain('Server Error');
  });

  // INVARIANT: conversation search matching must not pin the daemon event
  // loop. Stacked `a*` against a long run of `a` is the wedge (the textbook
  // `(a+)+$` plateaus on JavaScriptCore before the 1s deadline). Without the
  // shared-module Worker the search would not yield, and the listing fetch
  // below would wait on it. The listing answering first is the proof the
  // backtracking ran off-thread.
  test('a catastrophic search regex is refused and does not wedge the daemon', async () => {
    writeConversationFile(ctx.root, seedConversation({
      sessionId: 'ee000000-dddd-4ddd-8ddd-dddddddddddd',
      summary: 'Listing still reachable',
      messages: [{ role: 'user', text: `${'a'.repeat(80)}!` }],
    }));

    const evil = fetch(`${base}/conversations?q=${encodeURIComponent('a*a*a*a*a*a*a*$')}`);
    const listing = await fetch(`${base}/conversations`);
    expect(listing.status).toBe(200);
    expect(await listing.text()).toContain('Listing still reachable');

    const evilRes = await evil;
    expect(evilRes.status).toBe(400);
    const html = await evilRes.text();
    expect(html).toContain('Invalid search pattern');
    expect(html).toContain('took too long');
    expect(html).toContain('a*a*a*a*a*a*a*$');
    expect(html).not.toContain('Server Error');
  }, 15_000);

  test('the JSON listing ships metadata and never transcripts', async () => {
    writeConversationFile(ctx.root, seedConversation({
      sessionId: 'cc000000-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      summary: 'Release endgame',
      messages: [{ role: 'user', text: 'secret-transcript-body' }],
    }));

    const res = await fetch(`${base}/api/conversations`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      total: number;
      conversations: Array<Record<string, unknown>>;
    };
    expect(body.total).toBe(1);
    expect(body.conversations[0].session_id).toBe('cc000000-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(body.conversations[0].short_id).toBe('cc000000');
    expect(body.conversations[0].title).toBe('Release endgame');
    expect(body.conversations[0].user_message_count).toBe(1);
    // INVARIANT: the listing endpoint is a metadata projection. Message bodies
    // are only ever served by the detail page, one page at a time.
    expect(JSON.stringify(body)).not.toContain('secret-transcript-body');
  });

  // Direct-to-storage seeding bypasses saveConversation, so the first listing
  // must rebuild the sidecar index from transcript files rather than error.
  test('listing rebuilds a sidecar metadata index from transcript files', async () => {
    writeConversationFile(ctx.root, seedConversation({
      sessionId: 'dd000000-cccc-4ccc-8ccc-cccccccccccc',
      summary: 'Listing title only',
      messages: [{ role: 'user', text: 'secret-transcript-body-must-not-enter-index' }],
    }));

    const indexPath = join(storageDirFor(ctx.root), 'conversations-index.json');
    expect(existsSync(indexPath)).toBe(false);

    const html = await (await fetch(`${base}/conversations`)).text();
    expect(html).toContain('Listing title only');
    expect(html).not.toContain('secret-transcript-body-must-not-enter-index');

    expect(existsSync(indexPath)).toBe(true);
    const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as {
      version: number;
      entries: Array<{ sessionId: string; summary: string }>;
    };
    expect(index.version).toBe(1);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].sessionId).toBe('dd000000-cccc-4ccc-8ccc-cccccccccccc');
    expect(index.entries[0].summary).toBe('Listing title only');
    expect(JSON.stringify(index)).not.toContain('secret-transcript-body-must-not-enter-index');
  });

  test('an out-of-band transcript edit shows up on the next listing', async () => {
    const sessionId = 'ee000000-dddd-4ddd-8ddd-dddddddddddd';
    writeConversationFile(ctx.root, seedConversation({
      sessionId,
      summary: 'Original title',
    }));
    await fetch(`${base}/conversations`);

    writeConversationFile(ctx.root, seedConversation({
      sessionId,
      summary: 'Edited on disk',
    }));
    const html = await (await fetch(`${base}/conversations`)).text();
    expect(html).toContain('Edited on disk');
    expect(html).not.toContain('Original title');
  });

  // INVARIANT: this surface is read-only. Conversations reach the store only
  // through the capture pipeline; the web layer must never become a writer.
  test('the surface refuses writes', async () => {
    const res = await fetch(`${base}/conversations`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  // The one write this surface offers creates a TASK. The conversation record
  // itself is still never written — capture owns it — which is why the
  // promotion link lives on the created task instead.
  describe('promoting part of a transcript', () => {
    const sessionId = 'ab120000-eeee-4eee-8eee-eeeeeeeeeeee';

    function seedDecision(): void {
      writeConversationFile(ctx.root, seedConversation({
        sessionId,
        summary: 'Proxy audit log',
        messages: [
          { role: 'user', text: 'Unrelated: when does the release cut?' },
          { role: 'assistant', text: 'Next week.' },
          { role: 'user', text: 'The proxy audit log should rotate instead of growing forever.' },
          { role: 'assistant', text: 'Agreed — bound it by construction.' },
        ],
      }));
    }

    async function promote(form: Record<string, string>): Promise<Response> {
      return await fetch(`${base}/conversations/${sessionId}/promote`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        redirect: 'manual',
      });
    }

    test('a selected range seeds the form with those messages, and nothing else', async () => {
      seedDecision();
      const html = await (await fetch(`${base}/conversations/${sessionId}?from=3&to=4`)).text();
      expect(html).toContain('Promote messages 3–4 of 4');
      // The seed is the selected exchange verbatim, with provenance.
      expect(html).toContain('should rotate instead of growing forever');
      expect(html).toContain('bound it by construction');
      expect(html).toContain(`Promoted from builder conversation ${sessionId}`);
      // The goal defaults to the human's own sentence.
      expect(html).toContain('value="The proxy audit log should rotate instead of growing forever."');
    });

    test('with nothing selected the page asks for a range rather than offering the lot', async () => {
      seedDecision();
      const html = await (await fetch(`${base}/conversations/${sessionId}`)).text();
      expect(html).toContain('Start here');
      expect(html).toContain('Pick the exchange the task should come from');
      expect(html).not.toContain('Create backlog task');
    });

    test('promoting creates a backlog task and links back from the transcript', async () => {
      seedDecision();
      const res = await promote({
        from: '3',
        to: '4',
        goal: 'Rotate the proxy audit log',
        code: 'rotate-proxy-audit-log',
        prompt: 'Bound the proxy audit log by construction.',
      });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toContain('promoted=rotate-proxy-audit-log');

      const html = await (await fetch(`${base}/conversations/${sessionId}`)).text();
      expect(html).toContain('Already promoted');
      expect(html).toContain('rotate-proxy-audit-log');
      expect(html).toContain('Messages 3–4');

      // Backlog, never started.
      const task = await (await fetch(`${base}/tasks`)).text();
      expect(task).toContain('rotate-proxy-audit-log');
    });

    test('re-posting the same range is refused on the page, with the selection intact', async () => {
      seedDecision();
      expect((await promote({ from: '3', to: '4', code: 'rotate-proxy-audit-log' })).status).toBe(303);

      const res = await promote({ from: '3', to: '4', code: 'another-code' });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('already promoted to task rotate-proxy-audit-log');
      expect(html).toContain('Promote messages 3–4 of 4');
    });

    test('an overlapping selection warns before it is submitted', async () => {
      seedDecision();
      expect((await promote({ from: '3', to: '4', code: 'rotate-proxy-audit-log' })).status).toBe(303);

      const html = await (await fetch(`${base}/conversations/${sessionId}?from=4&to=4`)).text();
      expect(html).toContain('overlap');
      expect(html).toContain('rotate-proxy-audit-log');
      expect(html).toContain('Create backlog task');
    });

    test('a bad code comes back as a message, not a 500', async () => {
      seedDecision();
      const res = await promote({ from: '3', to: '4', code: 'Not A Code' });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Invalid code');
      expect(html).not.toContain('Server Error');
    });
  });

  test('every page links to conversations from the nav', async () => {
    const html = await (await fetch(`${base}/tasks`)).text();
    expect(html).toContain('href="/conversations"');
  });
});
