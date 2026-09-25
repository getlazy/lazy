/**
 * E2E: viewed/open state through card navigation, and Turns tab order.
 *
 * The unit suite can only pin the islands as text (no DOM harness). This file
 * fetches a real Turns page and, when a browser is present, runs the same
 * viewed-cards + navigation islands a reviewer runs, then reads the DOM.
 *
 * The bug this pins: n/p used to expand a viewed card without clearing the
 * checkbox. Navigating to a viewed card must leave it collapsed AND checked;
 * opening it with the chevron must clear the tick.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import {
  dumpDomOfHtml,
  inlineStylesheet,
  browserSuiteSkipped,
} from '../helpers/page-screenshot';
import { bundledStylesheet } from '../../src/server/styles';
import { viewedCardHtml, viewedStateScript } from '../../src/server/viewed-cards';
import { reviewNavigationScript } from '../../src/server/review-navigation';

const PROBE = `<script>
window.addEventListener('load', function () {
  setTimeout(function () {
    function cards() {
      var turns = document.querySelectorAll('.rv-viewable[data-viewed-key^="card:turn:"]');
      if (turns.length >= 2) return Array.prototype.slice.call(turns);
      return Array.prototype.slice.call(document.querySelectorAll('.rv-viewable[data-viewed-key]'));
    }
    function snap(el) {
      var box = el.querySelector('.rv-viewed-box');
      return {
        viewed: el.dataset.viewed === '1',
        collapsed: el.dataset.collapsed === '1',
        checked: !!(box && box.checked),
        current: el.hasAttribute('data-current')
      };
    }
    function key(k) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    }
    var list = cards();
    var result = { count: list.length };
    if (list.length < 2) {
      document.documentElement.setAttribute('data-nav-probe', JSON.stringify(result));
      return;
    }
    list[0].click();
    key('v');
    key('k');
    result.afterNavToViewed = snap(list[0]);
    var toggle = list[0].querySelector('.rv-vw-toggle');
    if (toggle) toggle.click();
    result.afterExplicitOpen = snap(list[0]);
    document.documentElement.setAttribute('data-nav-probe', JSON.stringify(result));
  }, 250);
});
</script>`;

function parseProbe(dom: string): {
  count: number;
  afterNavToViewed?: { viewed: boolean; collapsed: boolean; checked: boolean; current: boolean };
  afterExplicitOpen?: { viewed: boolean; collapsed: boolean; checked: boolean; current: boolean };
} {
  const match = dom.match(/data-nav-probe="([^"]*)"/);
  if (!match) throw new Error(`no data-nav-probe in dumped DOM:\n${dom.slice(0, 800)}`);
  const json = match[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return JSON.parse(json);
}

function fixtureHtml(): string {
  const cards = [0, 1, 2].map((i) => viewedCardHtml({
    key: `turn:${i}`,
    content: `body ${i} ${'x'.repeat(40)}`,
    headHtml: `Turn ${i}`,
    bodyHtml: `<p>body ${i}</p>`,
  })).join('\n');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${bundledStylesheet()}</style></head>
<body>
${cards}
${viewedStateScript('task-nav-probe')}
${reviewNavigationScript()}
${PROBE}
</body></html>`;
}

describe('Turns tab order', () => {
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

  test('the Turns tab is newest-first throughout and states the chunking rule', async () => {
    const taskId = await createTask(ctx, 'Turn order on the Turns tab', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    const deadline = Date.now() + 30_000;
    let id = '';
    while (Date.now() < deadline) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) { id = hit.id as string; break; }
      await new Promise((r) => setTimeout(r, 400));
    }
    expect(id).not.toBe('');

    const html = await (await fetch(`${base}/tasks/${id}/turns`)).text();
    expect(html).toContain('A chunk is what happened since you last acted');
    const seqs = [...html.matchAll(/>Turn #(\d+)<\/a>/g)].map((m) => Number(m[1]));
    expect(seqs.length).toBeGreaterThanOrEqual(2);
    // Newest-first: sequence numbers in the tab are descending.
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i - 1]!).toBeGreaterThan(seqs[i]!);
    }
  }, 60_000);
});

describe('viewed/open state through card navigation', () => {
  let skipped = false;

  beforeAll(async () => {
    skipped = await browserSuiteSkipped('server-card-navigation');
  });

  // Isolated fixture of the two shared islands — names the contract even if
  // a live Turns page grows extra cards around the turns.
  test('the shared islands keep viewed collapsed on next, and un-view on explicit open', async () => {
    if (skipped) return;
    const dom = await dumpDomOfHtml(fixtureHtml());
    const probe = parseProbe(dom);
    expect(probe.count).toBe(3);
    expect(probe.afterNavToViewed).toEqual({
      viewed: true,
      collapsed: true,
      checked: true,
      current: true,
    });
    expect(probe.afterExplicitOpen).toEqual({
      viewed: false,
      collapsed: false,
      checked: false,
      current: true,
    });
  }, 60_000);

  test('the same contract holds on a live Turns page', async () => {
    if (skipped) return;
    const ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    try {
      const health = await checkDaemonHealth(ctx.root);
      expect(health.webPort).toBeGreaterThan(0);
      const { base, fetch } = await signInToDashboard(ctx);
      const taskId = await createTask(ctx, 'Viewed cards stay collapsed on n/p', 'Do work');
      await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
      const deadline = Date.now() + 30_000;
      let id = '';
      while (Date.now() < deadline) {
        const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
        const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
        if (hit) { id = hit.id as string; break; }
        await new Promise((r) => setTimeout(r, 400));
      }
      expect(id).not.toBe('');
      // A second chunk, deliberately: the card on the Turns tab is a CHUNK, so
      // one start is one card and there is nothing to navigate BETWEEN. An
      // unblock is a review intervention, which is what opens the next chunk.
      await ctx.lazyMocked(['unblock', id, '--message', 'one more pass'], MOCK_CLAUDE_SUCCESS);
      const secondDeadline = Date.now() + 30_000;
      while (Date.now() < secondDeadline) {
        const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
        if (queue.some((e: { id: string }) => e.id.startsWith(taskId))) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      const page = await (await fetch(`${base}/tasks/${id}/turns`)).text();
      const html = inlineStylesheet(page, bundledStylesheet()).replace('</body>', `${PROBE}\n</body>`);
      const probe = parseProbe(await dumpDomOfHtml(html));
      expect(probe.count).toBeGreaterThanOrEqual(2);
      expect(probe.afterNavToViewed).toEqual({
        viewed: true,
        collapsed: true,
        checked: true,
        current: true,
      });
      expect(probe.afterExplicitOpen).toEqual({
        viewed: false,
        collapsed: false,
        checked: false,
        current: true,
      });
    } finally {
      await ctx.cleanup();
    }
  }, 90_000);
});
