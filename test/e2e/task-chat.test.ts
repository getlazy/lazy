/**
 * The task page's Chat tab: a message is an ask — answered by the task's
 * agent in its own session, read-only — and the tab shows the person's words
 * and the answer, never lazy's prompt framing.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { browserSuiteSkipped, screenshotDashboardLive } from '../helpers/page-screenshot';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { checkDaemonHealth } from '../../src/daemon';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { mintDashboardLoginUrl, signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

describe('task Chat tab', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

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

  async function waitForBlockedId(shortId: string): Promise<string> {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(shortId));
      if (hit) return hit.id;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`task ${shortId} never appeared in the review queue`);
  }

  async function showJson(taskId: string): Promise<{ status: string; session: { git_branch: string }; turns: { role: string; content: string; prompt: string | null }[] }> {
    const res = await ctx.lazy(['show', taskId, '--json']);
    expectSuccess(res);
    return JSON.parse(res.stdout);
  }

  // INVARIANT: a chat message is an ASK — it lands in the Chat as the
  // person's own words plus the agent's answer, runs no work turn, and leaves
  // the task exactly where it was. Lazy's framing never reaches the reader.
  test('a message sent from Chat lands there, read-only, without framing', async () => {
    const taskId = await createTask(ctx, 'Chat tab', 'Do work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const fullId = await waitForBlockedId(taskId);
    const before = await showJson(taskId);
    const headBefore = ctx.git('rev-parse', before.session.git_branch).stdout.trim();

    const empty = await (await fetch(`${base}/tasks/${fullId}/chat`)).text();
    expect(empty).toContain('No messages yet');
    expect(empty).toContain('name="return" value="chat"');

    const form = new FormData();
    form.set('content', 'CHAT_MARKER: why this approach?');
    form.set('return', 'chat');
    const post = await fetch(`${base}/tasks/${fullId}/review/ask`, { method: 'POST', body: form, redirect: 'manual' });
    expect(post.status).toBe(303);
    expect(post.headers.get('location') ?? '').toMatch(/\/chat$/);

    // Wait for the answer to land.
    const deadline = Date.now() + 60_000;
    let page = '';
    while (Date.now() < deadline) {
      page = await (await fetch(`${base}/tasks/${fullId}/chat`)).text();
      if (page.includes('lz-chat-agent') && !page.includes('data-chat-pending')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(page).toContain('CHAT_MARKER: why this approach?');
    expect(page).toContain('lz-chat-agent');
    // The thread framing the agent received is not shown.
    expect(page).not.toContain('A reviewer has a question');

    const after = await showJson(taskId);
    expect(after.status).toBe(before.status);
    // Exactly the question and its answer were added, and the branch did not move.
    expect(after.turns.length).toBe(before.turns.length + 2);
    expect(ctx.git('rev-parse', before.session.git_branch).stdout.trim()).toBe(headBefore);
    // The recorded question IS the person's words — the framing lives in `prompt`.
    const askTurn = after.turns[before.turns.length]!;
    expect(askTurn.role).toBe('human');
    expect(askTurn.content).toBe('CHAT_MARKER: why this approach?');
    expect(askTurn.prompt ?? '').toContain('A reviewer has a question');

    // The `show` RPC sends the same Chat as data — the ANSWER, never the rule.
    const target = getDaemonTcpTarget(ctx.root);
    const token = readToken(ctx.root);
    expect(target && token).toBeTruthy();
    const shown = await DaemonClient.fromTarget(target!, token!).rpc('show', ctx.root, { taskId: fullId, sections: ['chat'] }) as {
      sectionsServed: string[]; counts: Record<string, number>; chat: { from: string; text: string }[];
    };
    expect(shown.sectionsServed).toContain('chat');
    expect(shown.counts.chat).toBe(2);
    expect(shown.chat[0]).toMatchObject({ from: 'person', text: 'CHAT_MARKER: why this approach?' });
    expect(shown.chat[1]!.from).toBe('agent');
    expect(shown.chat[1]!.text.length).toBeGreaterThan(0);
    // Unrequested, it is not sent — but its whole size still is.
    const summary = await DaemonClient.fromTarget(target!, token!).rpc('show', ctx.root, { taskId: fullId, sections: [] }) as {
      counts: Record<string, number>; chat: unknown[];
    };
    expect(summary.chat).toEqual([]);
    expect(summary.counts.chat).toBe(2);

    // Current review points at Chat.
    const review = await (await fetch(`${base}/tasks/${fullId}/review`)).text();
    expect(review).toContain('data-lz-asked-in-chat');

    if (process.env.LAZY_SCREENSHOT_KEEP && !(await browserSuiteSkipped('task-chat'))) {
      const { loginUrl } = await mintDashboardLoginUrl(ctx);
      for (const [name, width] of [['dashboard-task-chat', 1280], ['dashboard-task-chat-phone', 390]] as const) {
        const out = join(tmpdir(), `${name}-${process.pid}.png`);
        await screenshotDashboardLive({ loginUrl, url: `${base}/tasks/${fullId}/chat`, out, width, height: 1100 });
        console.log(`chat screenshot: ${out}`);
      }
    }
  }, 180_000);
});
