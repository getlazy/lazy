/**
 * Builder review-session UI is gone. The task page has no entry, and the
 * leftover /sessions and /tasks/:id/review/session routes cannot start one.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { successScenario } from '../helpers/fake-claude';

describe('builder review session entry removed', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('task page has Reviews tab and no Review with builder button', async () => {
    await ctx.setClaudeScenario(successScenario({ result: 'done', sessionId: 's1' }));
    const taskId = await createTask(ctx, 'drop builder review entry', 'Do work');
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    let fullId = '';
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !fullId) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) fullId = hit.id;
      else await new Promise((r) => setTimeout(r, 400));
    }
    expect(fullId).not.toBe('');

    const page = await (await fetch(`${base}/tasks/${fullId}`)).text();
    expect(page).not.toContain('Review with builder');
    expect(page).toContain('data-lz-tab="reviews"');
    expect(page).toContain('>Reviews<');
    // Agent Review action remains.
    expect(page).toMatch(/data-lz-verb="review"|verb":\s*"review"|Review<\/button>/);

    // INVARIANT: leftover URLs must not offer a working start after the drop.
    const sessions = await fetch(`${base}/sessions`);
    expect(sessions.status).toBe(410);
    const sessionsHtml = await sessions.text();
    expect(sessionsHtml).toContain('Review with builder was removed');
    expect(sessionsHtml).not.toContain('Start session');
    expect(sessionsHtml).not.toContain('/review/session/start');

    const sessionGet = await fetch(`${base}/tasks/${fullId}/review/session`);
    expect(sessionGet.status).toBe(410);
    const sessionHtml = await sessionGet.text();
    expect(sessionHtml).not.toContain('Start session');
    expect(sessionHtml).not.toContain('/review/session/start');

    const start = await fetch(`${base}/tasks/${fullId}/review/session/start`, { method: 'POST' });
    expect(start.status).toBe(410);
    expect(await start.text()).not.toContain('Start session');
  }, 120_000);
});
