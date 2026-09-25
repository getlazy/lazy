/**
 * E2E for the task page (/tasks/:id) as a first-class reading surface.
 *
 * It is built from the very same viewable cards the review page uses, so it
 * gets the same page-navigation island: j/k move between sections, v ticks the
 * current one. It used to emit only the viewed-state island, so the shortcuts
 * silently did nothing on a page full of shortcut-bearing cards.
 *
 * And the cards must RENDER their markdown: an agent's closing verification
 * table showed up as literal pipes, because the renderer had no table support.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

const TURN_TEXT = [
  'Verification:',
  '',
  '| Check | Result |',
  '|-------|:------:|',
  '| typecheck | pass |',
].join('\n');

describe('web task page navigation and markdown', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        LAZY_MOCK_SHOULD_COMMIT: '1',
        LAZY_MOCK_CLAUDE_RESPONSE: JSON.stringify({
          result: TURN_TEXT,
          session_id: 'mock-sess-tbl',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
    });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function blockedTask(goal: string): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) return hit.id as string;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`task ${taskId} never reached the review queue`);
  }

  test('the task page ships the help control and navigation island, not unlabeled prev/next', async () => {
    const id = await blockedTask('Task page navigation');
    const html = await (await fetch(`${base}/tasks/${id}`)).text();

    // Help, shipped hidden for the no-JS case and unhidden by the island.
    expect(html).toContain('data-rv-nav');
    expect(html).toContain('data-rv-nav-help');
    expect(html).not.toContain('data-rv-nav-prev');
    expect(html).not.toContain('data-rv-nav-next');
    // The island itself, driving the same viewable-section contract as review.
    expect(html).toContain("'.rv-viewable[data-viewed-key]'");
    expect(html).toContain("setAttribute('data-current', '')");
    // Summary shows the last-turn report as a viewable card (not the Turns list).
    expect(html).toContain('data-viewed-key="card:');
  });

  test('a markdown table in a turn renders as HTML, not literal pipes', async () => {
    const id = await blockedTask('Task page markdown table');
    const html = await (await fetch(`${base}/tasks/${id}`)).text();

    expect(html).toContain('<table class="md-table">');
    expect(html).toContain('<th>Check</th>');
    expect(html).toContain('<td>typecheck</td>');
    expect(html).not.toContain('| Check | Result |');
  });
});
