/**
 * Filing a review clears its Asks from the Current review page — and keeps
 * them, in full, under "Filed asks".
 *
 * Asks are answered as they are posted, so nothing they already carry says
 * "that round of review is over". The unblock that submits the review is that
 * boundary; before it existed the page listed every question ever asked as if
 * each were still open business.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { browserSuiteSkipped, screenshotDashboardLive } from '../helpers/page-screenshot';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { checkDaemonHealth } from '../../src/daemon';
import { mintDashboardLoginUrl, signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

describe('review asks are filed by the unblock that submits the review', () => {
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

  // INVARIANT: filing MOVES an ask, it never discards it (CLAUDE.md, "Never
  // Lose Human Feedback"). The question and the agent's answer stay on the
  // page — what changes is that they stop counting as the reviewer's open
  // business.
  test('an answered ask leaves the Asks list on unblock and stays readable', async () => {
    const taskId = await createTask(ctx, 'Ask filing', 'Do work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const fullId = await waitForBlockedId(taskId);

    const post = await fetch(`${base}/tasks/${fullId}/review/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'ASK_MARKER: why this approach?' }),
    });
    expect(post.status).toBe(201);

    // Wait for the answer — an ask still in flight is never filed.
    const deadline = Date.now() + 60_000;
    let answered = false;
    while (Date.now() < deadline && !answered) {
      const data = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
      answered = data.pending === 0 && data.taskThreads.length > 0;
      if (!answered) await new Promise((r) => setTimeout(r, 500));
    }
    expect(answered).toBe(true);

    const before = await (await fetch(`${base}/tasks/${fullId}/review`)).text();
    expect(before).toContain('<h2 data-rv-asks-count>Asks (1)</h2>');
    // (the inlined poll island contains the words; match the rendered summary)
    expect(before).not.toContain('Filed asks (1)');

    // File the review: the unblock that carries it is the submission.
    expectSuccess(await ctx.lazy(['unblock', taskId, '-m', 'Looks good, one tweak']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const after = await (await fetch(`${base}/tasks/${fullId}/review`)).text();
    expect(after).toContain('<h2 data-rv-asks-count>Asks (0)</h2>');
    expect(after).toContain('Filed asks (1)');
    // Moved, not lost — the question is still on the page.
    expect(after).toContain('ASK_MARKER: why this approach?');

    // And the live poll splits them the same way the server rendered them.
    const threads = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
    expect(threads.taskThreads).toHaveLength(1);
    expect(threads.taskThreads[0].filed).toBe(true);

    // Optional capture of the page in exactly this state, for a turn report.
    // LIVE, not the file:// capture: the point of the frame is what the page
    // looks like AFTER its own poll has replaced the threads container, which
    // a static copy cannot show.
    if (process.env.LAZY_SCREENSHOT_KEEP && !(await browserSuiteSkipped('review-ask-filing'))) {
      const out = join(tmpdir(), `lazy-asks-filed-${process.pid}.png`);
      const { loginUrl } = await mintDashboardLoginUrl(ctx);
      await screenshotDashboardLive({
        loginUrl,
        url: `${base}/tasks/${fullId}/review`,
        out,
      });
      console.log(`current review screenshot: ${out}`);
    }
  }, 180_000);
});
