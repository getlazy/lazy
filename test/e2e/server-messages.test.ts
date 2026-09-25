/**
 * E2E for the web system-messages inbox: listing, the all view, the detail page
 * (which marks read), and the two write actions — plus the nav count badges the
 * inbox badge grew into, which are served from one endpoint for all four.
 *
 * The daemon serves these routes in-process and performs every mutation through
 * its own Storage (src/daemon/message-service.ts) — the web layer never becomes
 * a second writer. The assertions therefore check the STORE after each action,
 * not just the rendered page.
 *
 * Seeding is direct-to-storage for the same reason as test/e2e/messages.test.ts:
 * there is no human create surface, so the helpers write what the routes read.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { randomUUID } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import {
  readSystemMessagesFile,
  writeSystemMessagesFile,
  writeConversationFile,
  writeRaisedItemsFile,
  setTaskStatus,
  type StoredSystemMessage,
  type StoredRaisedItem,
} from '../helpers/storage';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, dashboardFetch, type DashboardFetch } from '../helpers/dashboard-session';
import { CONVERSATIONS_SEEN_KEY } from '../../src/server/templates';

function seedMessage(overrides: Partial<StoredSystemMessage> = {}): StoredSystemMessage {
  return {
    id: randomUUID(),
    created_at: Date.now(),
    source: 'daemon',
    title: 'Weekly tool-call report',
    body: '## Findings\n\nNothing alarming this week.',
    kind: 'report',
    ...overrides,
  };
}

/** Form POST exactly as the browser would send it, without following redirects. */
async function postAction(fetch: DashboardFetch, base: string, id: string, action: 'read' | 'dismiss', all = false) {
  const body = new URLSearchParams();
  if (all) body.set('all', '1');
  return fetch(`${base}/messages/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  });
}

describe('web system-messages inbox', () => {
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

  test('an empty inbox says so and points at the all view', async () => {
    const res = await fetch(`${base}/messages`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('No system messages');
    expect(html).toContain('/messages?all=1');
  });

  test('the inbox lists undismissed messages and hides dismissed ones until asked', async () => {
    const open = seedMessage({ title: 'Open report' });
    const filed = seedMessage({
      title: 'Filed report',
      created_at: Date.now() - 60_000,
      read_at: Date.now() - 50_000,
      dismissed_at: Date.now() - 40_000,
      dismissed_by: 'human',
    });
    writeSystemMessagesFile(ctx.root, [open, filed]);

    const inbox = await (await fetch(`${base}/messages`)).text();
    expect(inbox).toContain('Open report');
    expect(inbox).not.toContain('Filed report');
    expect(inbox).toContain('1 unread');

    const all = await (await fetch(`${base}/messages?all=1`)).text();
    expect(all).toContain('Open report');
    expect(all).toContain('Filed report');
    // Dismissing must never read as deletion.
    expect(all).toContain('kept on record');
  });

  // INVARIANT: read and dismissed are two different states with two different
  // effects (read leaves the builder's launch context; dismissed also leaves the
  // default listing). The inbox renders the shared vocabulary from
  // src/messages/index.ts so it can never describe them differently to the CLI.
  test('the inbox spells out what read and dismissed mean', async () => {
    writeSystemMessagesFile(ctx.root, [seedMessage()]);
    const html = await (await fetch(`${base}/messages`)).text();
    expect(html).toContain('unread');
    expect(html).toContain('read');
    expect(html).toContain('dismissed');
    expect(html).toContain("builder's launch context");
    expect(html).toContain('never deleted');
  });

  test('opening a message renders its body and marks it read', async () => {
    const message = seedMessage({ body: '## Findings\n\nAll quiet.' });
    writeSystemMessagesFile(ctx.root, [message]);

    const res = await fetch(`${base}/messages/${message.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Weekly tool-call report');
    expect(html).toContain('All quiet.');
    // Markdown is rendered, not shown as source.
    expect(html).toContain('Findings</h2>');

    const stored = readSystemMessagesFile(ctx.root).find((m) => m.id === message.id)!;
    expect(stored.read_at).toBeGreaterThan(0);
    expect(stored.dismissed_at).toBeUndefined();
  });

  test('mark read is idempotent — the first read timestamp never moves', async () => {
    const message = seedMessage();
    writeSystemMessagesFile(ctx.root, [message]);

    const first = await postAction(fetch, base, message.id, 'read');
    expect(first.status).toBe(303);
    expect(first.headers.get('location')).toContain('/messages');
    const readAt = readSystemMessagesFile(ctx.root).find((m) => m.id === message.id)!.read_at;
    expect(readAt).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 10));
    expect((await postAction(fetch, base, message.id, 'read')).status).toBe(303);
    expect(readSystemMessagesFile(ctx.root).find((m) => m.id === message.id)!.read_at).toBe(readAt);

    // Read is not dismissed: it stays in the default inbox.
    expect(await (await fetch(`${base}/messages`)).text()).toContain(message.title);
  });

  test('dismiss files the message away without deleting it, and records the human', async () => {
    const message = seedMessage({ title: 'Dismiss me' });
    writeSystemMessagesFile(ctx.root, [message]);

    const res = await postAction(fetch, base, message.id, 'dismiss', true);
    expect(res.status).toBe(303);
    // The view the human was in is preserved across the redirect.
    expect(res.headers.get('location')).toContain('all=1');

    const stored = readSystemMessagesFile(ctx.root).find((m) => m.id === message.id)!;
    expect(stored.dismissed_at).toBeGreaterThan(0);
    expect(stored.dismissed_by).toBe('human');

    expect(await (await fetch(`${base}/messages`)).text()).not.toContain('Dismiss me');
    expect(await (await fetch(`${base}/messages?all=1`)).text()).toContain('Dismiss me');
  });

  test('the JSON index carries the unread count and no bodies', async () => {
    const unread = seedMessage({ title: 'Unread one' });
    const read = seedMessage({ title: 'Read one', read_at: Date.now(), created_at: Date.now() - 1000 });
    writeSystemMessagesFile(ctx.root, [unread, read]);

    const res = await fetch(`${base}/api/messages`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      unread: number;
      messages: Array<{ id: string; title: string; body?: string }>;
    };
    expect(payload.unread).toBe(1);
    expect(payload.messages).toHaveLength(2);
    // The badge polls this from every page — bodies are never shipped for a count.
    expect(payload.messages.every((m) => m.body === undefined)).toBe(true);
  });

  test('the dashboard surfaces unread messages without navigating to the inbox', async () => {
    writeSystemMessagesFile(ctx.root, [seedMessage({ title: 'Noticed on the dashboard' })]);
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('Noticed on the dashboard');
    expect(html).toContain('/messages');
  });

  test('a malformed id is refused and an unknown one is a 404', async () => {
    expect((await fetch(`${base}/messages/not-a-hex-id`)).status).toBe(400);
    expect((await fetch(`${base}/messages/${randomUUID()}`)).status).toBe(404);
    // Actions on an unknown id fail the same way — no silent no-op.
    expect((await postAction(fetch, base, randomUUID(), 'dismiss')).status).toBe(404);
  });

  test('a unique id prefix resolves, an ambiguous one is refused', async () => {
    const a = seedMessage({ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Prefix A' });
    const b = seedMessage({ id: 'aaaaaaaa-0000-4000-8000-000000000002', title: 'Prefix B' });
    writeSystemMessagesFile(ctx.root, [a, b]);

    const unique = await fetch(`${base}/messages/aaaaaaaa-0000-4000-8000-000000000001`);
    expect(unique.status).toBe(200);
    expect(await unique.text()).toContain('Prefix A');

    const ambiguous = await fetch(`${base}/messages/aaaaaaaa`);
    expect(ambiguous.status).toBe(400);
  });
});

/**
 * The shape these tests receive. The route itself may answer `null` for any
 * count it could not produce (a failing read, or no review action port) — the
 * daemon here injects the port and its reads succeed, so that half is covered
 * over a stub Storage in test/unit/server-nav-counts.test.ts instead.
 */
interface NavCounts {
  unread: number;
  review: number;
  /** Live loop TASKS — the Loops page's badge. */
  clusters: number;
  /** Two numbers, one badge: only blocking items hold up an accept. */
  raisedBlocking: number;
  raisedNonBlocking: number;
  /** Pre-unification key, kept for one release. */
  followups: number;
  conversations: number;
  conversationsLatestAt: number;
}

function seedRaised(taskId: string, overrides: Partial<StoredRaisedItem> = {}): StoredRaisedItem {
  return {
    id: randomUUID(),
    task_id: taskId,
    content: 'The retry path swallows errors.',
    blocking: false,
    status: 'open',
    created_at: Date.now(),
    ...overrides,
  };
}

function seedConversation(importedAt: number, summary: string): Record<string, unknown> {
  return {
    sessionId: randomUUID(),
    projectPath: '-tmp-project',
    cwd: '/tmp/project',
    version: '2.0.0',
    gitBranch: 'main',
    startedAt: '2026-08-30T10:00:00.000Z',
    endedAt: '2026-08-30T11:30:00.000Z',
    importedAt,
    summary,
    stats: { messageCount: 1, userMessageCount: 1, assistantMessageCount: 0, subagentCount: 0, totalTokens: 10 },
    totalUsage: { inputTokens: 10, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    messages: [
      {
        uuid: randomUUID(),
        parentUuid: null,
        timestamp: '2026-08-30T10:00:00.000Z',
        role: 'user',
        text: summary,
        model: null,
        usage: null,
      },
    ],
    subagents: [],
  };
}

describe('web nav count badges', () => {
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

  const counts = async (query = ''): Promise<NavCounts> => {
    const res = await fetch(`${base}/api/nav-counts${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as NavCounts;
  };

  test('a fresh project reports zero everywhere and offers no conversation mark', async () => {
    expect(await counts()).toEqual({
      unread: 0,
      review: 0,
      clusters: 0,
      raisedBlocking: 0,
      raisedNonBlocking: 0,
      followups: 0,
      conversations: 0,
      conversationsLatestAt: 0,
    });
  });

  // INVARIANT: each badge is the number ITS OWN page shows. A badge that
  // disagrees with the page it points at is worse than no badge — the human
  // clicks through to find the queue empty and stops trusting the nav. The
  // counts therefore come from the same queries those pages run, which is what
  // the cross-checks at the bottom of this test pin down.
  test('every badge is the count its own page shows', async () => {
    writeSystemMessagesFile(ctx.root, [
      seedMessage({ title: 'Unread one' }),
      seedMessage({ title: 'Read one', read_at: Date.now(), created_at: Date.now() - 1000 }),
    ]);

    const waiting = await createTask(ctx, 'Waiting for review');
    const alsoWaiting = await createTask(ctx, 'Also waiting for review');
    const untouched = await createTask(ctx, 'Still in the backlog');
    setTaskStatus(ctx.root, waiting, 'blocked');
    setTaskStatus(ctx.root, alsoWaiting, 'conflict');

    // Two open non-blocking items, one open blocking one, and one already
    // decided: only the open ones count, the same rule the raised-items page
    // applies — and the two open kinds are counted separately.
    writeRaisedItemsFile(ctx.root, waiting, [
      seedRaised(waiting, { content: 'The retry path swallows errors.' }),
      seedRaised(waiting, { content: 'The importer has no timeout.' }),
      seedRaised(waiting, { content: 'Should the flag default on?', blocking: true }),
      seedRaised(waiting, { content: 'Already looked at.', status: 'dismissed' }),
    ]);

    writeConversationFile(ctx.root, seedConversation(Date.now() - 5000, 'Release planning'));
    writeConversationFile(ctx.root, seedConversation(Date.now(), 'Docker runner debugging'));

    const loop = await ctx.lazy(['create', '--goal', 'Drive the fixes', '--type', 'cluster', '--code', 'a-live-loop']);
    expect(loop.exitCode).toBe(0);

    const nav = await counts();
    expect(nav.unread).toBe(1);
    expect(nav.clusters).toBe(1);
    expect(nav.review).toBe(2);
    expect(nav.raisedNonBlocking).toBe(2);
    expect(nav.raisedBlocking).toBe(1);
    expect(nav.conversations).toBe(2);

    // The pages themselves, asked the same question.
    const queue = (await (await fetch(`${base}/api/review/queue`)).json()) as { queue: unknown[] };
    expect(queue.queue).toHaveLength(nav.review);
    const reviewPage = await (await fetch(`${base}/review`)).text();
    expect(reviewPage).toContain(waiting);
    expect(reviewPage).toContain(alsoWaiting);
    expect(reviewPage).not.toContain(untouched);
    // The page words it with the gate badges; both numbers still have to be
    // the badge's numbers, which is what this cross-check is for.
    const raisedPage = await (await fetch(`${base}/raised`)).text();
    expect(raisedPage).toContain(`: ${nav.raisedBlocking} open,`);
    expect(raisedPage).toContain(`: ${nav.raisedNonBlocking} open across the project`);
    expect(await (await fetch(`${base}/messages`)).text()).toContain(`${nav.unread} unread`);
    expect(await (await fetch(`${base}/clusters`)).text()).toContain(`${nav.clusters} open`);
  });

  // Conversations have no read state in the store, so "new since you last
  // looked" is the BROWSER's mark: it sends back the newest importedAt it was
  // shown. No mark means that browser has never looked — so everything is new,
  // which is what makes the badge discoverable on a first visit.
  test('conversations stay new until the browser sends back the mark it was given', async () => {
    const older = Date.now() - 10_000;
    const newer = Date.now() - 5000;
    writeConversationFile(ctx.root, seedConversation(older, 'Captured earlier'));
    writeConversationFile(ctx.root, seedConversation(newer, 'Captured later'));

    const first = await counts();
    expect(first.conversations).toBe(2);
    expect(first.conversationsLatestAt).toBe(newer);

    // Having looked, the browser reports the mark this server handed it back.
    expect((await counts(`?conversationsSince=${first.conversationsLatestAt}`)).conversations).toBe(0);

    const latest = Date.now();
    writeConversationFile(ctx.root, seedConversation(latest, 'Captured since'));
    const after = await counts(`?conversationsSince=${first.conversationsLatestAt}`);
    expect(after.conversations).toBe(1);
    expect(after.conversationsLatestAt).toBe(latest);
  });

  // A mark that cannot be trusted must not silently zero the badge: a garbage
  // value falls back to "you have never looked", which over-counts at worst.
  test('an unusable mark counts every conversation rather than none', async () => {
    writeConversationFile(ctx.root, seedConversation(Date.now(), 'Only one'));
    expect((await counts('?conversationsSince=tomorrow')).conversations).toBe(1);
    expect((await counts('?conversationsSince=-1')).conversations).toBe(1);
    expect((await counts('?conversationsSince=')).conversations).toBe(1);
  });

  // The badge script runs on EVERY page, so this endpoint is the dashboard's
  // most-requested route. It answers with numbers — never message bodies, queue
  // rows, or transcripts riding along for a count.
  test('the endpoint ships counts only, and refuses to be written to', async () => {
    writeSystemMessagesFile(ctx.root, [seedMessage({ title: 'Do not ship my body' })]);
    const waiting = await createTask(ctx, 'Queued for review');
    setTaskStatus(ctx.root, waiting, 'blocked');
    writeConversationFile(ctx.root, seedConversation(Date.now(), 'Do not ship my transcript'));

    const res = await fetch(`${base}/api/nav-counts`);
    const body = await res.text();
    expect(Object.keys(JSON.parse(body) as NavCounts).sort()).toEqual([
      'clusters',
      'conversations',
      'conversationsLatestAt',
      'followups',
      'raisedBlocking',
      'raisedNonBlocking',
      'review',
      'unread',
    ]);
    expect(body).not.toContain('Do not ship my body');
    expect(body).not.toContain('Do not ship my transcript');
    expect(body).not.toContain('Queued for review');

    const written = await fetch(`${base}/api/nav-counts`, { method: 'POST' });
    expect(written.status).toBe(405);

    // Summing every surface into one number per badge is exactly the kind of
    // route that must not slip out from behind the sign-in gate.
    expect((await dashboardFetch(`${base}/api/nav-counts`)).status).toBe(401);
  });

  // The no-script path is the pages themselves: the badges are empty spans that
  // CSS hides until something fills them, so scripting off loses the numbers and
  // nothing else. ONE fetch fills them all, however many there are — the Clusters
  // badge must not arrive as a second request on every page load.
  test('the nav carries one empty badge per counted link and one fetch to fill them', async () => {
    const html = await (await fetch(`${base}/`)).text();
    for (const id of ['nav-unread', 'nav-review', 'nav-clusters', 'nav-raised', 'nav-conversations']) {
      expect(html).toContain(`<span class="nav-badge" id="${id}"></span>`);
    }
    // The hidden loop REVIEW-QUEUE page never got a badge. The cluster-TASKS
    // badge is a different link, id="nav-clusters", and is asserted above.
    expect(html).not.toContain('id="nav-loop"');
    expect(html.split('/api/nav-counts').length - 1).toBe(1);
    expect(html).toContain(CONVERSATIONS_SEEN_KEY);
  });
});
