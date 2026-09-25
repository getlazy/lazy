import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { PROSE_REPORT_FILE, proseAnchorLine } from '../../src/review/prose-anchor';

/**
 * E2E for prose anchors on the web review surface: ask or comment on any line
 * of the agent's prose (report sections, follow-ups, raised items) with the
 * same Ask/Comment pair a diff line has.
 *
 * The anchor is a pseudo-file plus a content hash of the block text, stored
 * through the ordinary review-comment machinery — an ask goes through the ask
 * path now, a comment queues and rides the next unblock, where the agent gets
 * the QUOTED text, never the pseudo-file/hash as a fake file/line.
 */
describe('web review prose anchors', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  // The mock agent's report prose — the block the anchors in these tests point at.
  const REPORT_TEXT = 'I have completed the task. All changes have been committed.';
  const REPORT_LINE = proseAnchorLine('', REPORT_TEXT);

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function startBlockedTask(goal: string): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    let fullId = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !fullId) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) fullId = hit.id;
      else await new Promise((r) => setTimeout(r, 400));
    }
    expect(fullId).not.toBe('');
    return fullId;
  }

  // The report card must be marked for the island to split into anchorable
  // blocks — without the data-rv-prose attribute there is nothing to click.
  test('the review page marks the agent report as anchorable prose', async () => {
    const fullId = await startBlockedTask('Prose markup test');
    const html = await (await fetch(`${base}/tasks/${fullId}`)).text();
    expect(html).toContain(`data-rv-prose="${PROSE_REPORT_FILE}"`);
    // The island ships the client mirror of the anchor hash and the prose form.
    expect(html).toContain('proseAnchorLine');
    expect(html).toContain('rv-prose-add');
  });

  // The engineer's loop this feature exists for: click a sentence of the
  // report, say "make a follow-up for this" as a COMMENT, and have the next
  // unblock deliver it with the sentence quoted — no scrolling, no re-quoting.
  test('a comment on a report line queues and the unblock prompt quotes the text', async () => {
    const fullId = await startBlockedTask('Prose comment test');

    const post = await fetch(`${base}/tasks/${fullId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: PROSE_REPORT_FILE,
        line: REPORT_LINE,
        side: 'new',
        content: 'PROSE_C: make a follow-up for this',
        intent: 'comment',
        anchorSnippet: REPORT_TEXT,
      }),
    });
    expect(post.status).toBe(201);
    const { comment } = await post.json();
    expect(comment.intent).toBe('comment');
    expect(comment.delivery_state).toBe('pending_delivery');

    // Counted and listed as queued, with the quote instead of a file:line link.
    const threads = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
    expect(threads.pendingDelivery).toBe(1);
    expect(threads.queued[0].anchor_snippet).toBe(REPORT_TEXT);
    const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
    expect(queue.find((e: { id: string }) => e.id === fullId).pendingComments).toBe(1);
    const page = await (await fetch(`${base}/tasks/${fullId}/review`)).text();
    expect(page).toContain('on the report');
    expect(page).toContain('PROSE_C: make a follow-up for this');

    const form = new FormData();
    form.set('message', 'OVERALL: proceed');
    const res = await fetch(`${base}/tasks/${fullId}/review/unblock`, {
      method: 'POST', body: form, redirect: 'manual',
    });
    expect(res.status).toBe(303);

    let prompt = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !prompt.includes('OVERALL: proceed')) {
      const show = await ctx.lazy(['show', fullId, '--json']);
      const turns = (JSON.parse(show.stdout).turns ?? []) as Array<{ role: string; prompt: string | null }>;
      const hit = turns.filter((t) => t.role === 'human' && (t.prompt ?? '').includes('OVERALL: proceed'));
      if (hit.length === 1) prompt = hit[0].prompt ?? '';
      else await new Promise((r) => setTimeout(r, 500));
    }
    // The agent gets the quoted line — never the pseudo-file or the hash as a
    // fake file/line it would go hunting for.
    expect(prompt).toContain('On your report, the line:');
    expect(prompt).toContain(`> ${REPORT_TEXT}`);
    expect(prompt).toContain('PROSE_C: make a follow-up for this');
    expect(prompt).not.toContain(PROSE_REPORT_FILE);
    expect(prompt).not.toContain(`line ${REPORT_LINE}`);

    const after = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
    expect(after.pendingDelivery).toBe(0);
  }, 180_000);

  // "why?" on a report line is an ASK: dispatched through the ask path now,
  // answered in a read-only turn, and the thread survives a reload — rendered
  // with the quoted line so the conversation keeps its referent.
  test('an ask on a report line is answered and the thread reattaches after reload', async () => {
    const fullId = await startBlockedTask('Prose ask test');

    const post = await fetch(`${base}/tasks/${fullId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: PROSE_REPORT_FILE,
        line: REPORT_LINE,
        side: 'new',
        content: 'PROSE_Q: why?',
        intent: 'ask',
        anchorSnippet: REPORT_TEXT,
      }),
    });
    expect(post.status).toBe(201);
    const { comment } = await post.json();
    expect(comment.ask_state).toBe('pending');

    // Wait for the agent's answer on the same thread.
    let answered = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !answered) {
      const data = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
      const thread = data.threads.find((t: { threadId: string }) => t.threadId === comment.thread_id);
      if (thread && data.pending === 0 && thread.messages.length >= 2) answered = true;
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(answered).toBe(true);

    // Reload: the server-rendered page carries the thread with its quote (the
    // no-JS fallback the island upgrades by moving it under the exact block).
    const page = await (await fetch(`${base}/tasks/${fullId}/review`)).text();
    expect(page).toContain('rv-prose-thread');
    expect(page).toContain(REPORT_TEXT);
    expect(page).toContain('PROSE_Q: why?');
    // The answer thread also survives in the API with the prose anchor intact.
    const data = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
    const thread = data.threads.find((t: { threadId: string }) => t.threadId === comment.thread_id);
    expect(thread.file).toBe(PROSE_REPORT_FILE);
    expect(thread.line).toBe(REPORT_LINE);
  }, 180_000);
});
