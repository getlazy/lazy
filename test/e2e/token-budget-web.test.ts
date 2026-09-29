/**
 * The dashboard's token-budget box, rendered in headless Chrome against a real
 * daemon: the DOM a person's browser builds must carry the credential's
 * window, the tokens spent in it and the estimate of what is left.
 */
import { describe, test, beforeAll, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { signInToDashboard } from '../helpers/dashboard-session';
import { browserSuiteSkipped, dumpDomOfHtml, inlineStylesheet, screenshotDashboardPage } from '../helpers/page-screenshot';
import { bundledStylesheet } from '../../src/server/styles';
import { seedBudgetAudit } from '../helpers/budget-audit';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';

let skipped = false;
beforeAll(async () => {
  skipped = await browserSuiteSkipped('token-budget-web');
});

describe('dashboard token-budget box', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: the dashboard shows the same budget `lazy stats budget` does —
  // one daemon view — in tokens and percentages, never money.
  test('the budget box shows the window, the spend in it and what is left', async () => {
    if (skipped) return;
    // One real (mocked-agent) turn, so the per-task and per-day tables have a row.
    const taskId = await createTask(ctx, 'Spend some tokens', 'Do metered work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);
    await seedBudgetAudit(ctx.root);
    const { base, fetch: authed } = await signInToDashboard(ctx);
    const res = await authed(`${base}/`);
    expect(res.status).toBe(200);
    const dom = await dumpDomOfHtml(await res.text());

    const box = /<div class="detail-section" id="token-budget">([\s\S]*?)<\/div>/.exec(dom)?.[1];
    expect(box).toBeDefined();
    expect(dom.indexOf('id="token-budget"')).toBeGreaterThan(dom.indexOf('View all tasks'));
    const visibilityDom = await dumpDomOfHtml(inlineStylesheet(await (await authed(`${base}/`)).text(), bundledStylesheet()).replace('</body>', `
      <script>
        window.scrollTo(0, document.documentElement.scrollHeight);
        const budget = document.getElementById('token-budget');
        const bounds = budget.getBoundingClientRect();
        const point = document.elementFromPoint(bounds.left + bounds.width / 2,
          Math.max(bounds.top, 0) + Math.min(bounds.bottom - Math.max(bounds.top, 0), 20) / 2);
        budget.dataset.visibleAtBottom = String(point === budget || budget.contains(point));
      </script></body>`));
    expect(visibilityDom).toContain('data-visible-at-bottom="true"');
    const row = /<tr data-credential="credential:CLAUDE_CODE_OAUTH_TOKEN" data-window="unified-5h">([\s\S]*?)<\/tr>/.exec(box!)?.[1];
    expect(row).toBeDefined();
    expect(row).toContain('5-hour window');
    expect(row).toContain('<td class="budget-used">30%</td>');
    expect(row).toContain('30.0k');
    expect(row).toContain('~70.0k tokens left');
    expect(box).not.toMatch(/\$|USD/);
    const today = new Date().toISOString().slice(0, 10);
    expect(dom).toMatch(new RegExp(`<tr data-day="${today}">\\s*<td>${today}</td><td>[1-9]\\d*</td>`));
    // createTask returns the short id; the row carries the full one.
    expect(dom).toContain(`<tr data-task="${taskId}`);

    const out = process.env.LAZY_SHOT_DIR
      ? join(process.env.LAZY_SHOT_DIR, 'token-budget-box.png')
      : join(ctx.root, 'token-budget-box.png');
    await screenshotDashboardPage({ fetch: authed, base, path: '/', out, height: 3200 });
    expect(await Bun.file(out).exists()).toBe(true);
  });
});
