import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';

// INVARIANT: The commit detail page renders diffs through @pierre/diffs SSR
// (renderDiff in src/server/diff.ts). The rendered page must wrap each file's
// diff in a <diffs-container> web component, include the companion registration
// script, and honor the side-by-side/unified view toggle. These assertions
// guard the diff-viewer integration ported from add-server-diffs.
describe('lazy server diff rendering', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // Run a real daemon so `start` produces a task with real commits, and pass
    // LAZY_MOCK_SHOULD_COMMIT into the DAEMON's env (the daemon — not the CLI —
    // runs the mock agent, so per-CLI-call env would not reach it).
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('renders a commit diff with @pierre/diffs in both views', async () => {
    const taskId = await createTask(ctx, 'Diff rendering test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // The daemon serves the web dashboard; ask it for its bound web port.
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    const base = `http://localhost:${health.webPort}`;

    // The task starts with an empty "Initialize task" commit (no diff). Poll the
    // task page until the daemon has reconciled the mock agent's *content*
    // commit, then pick the commit whose detail page actually renders a diff —
    // the empty init commit renders an empty-state instead.
    let target: { path: string; html: string } | null = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !target) {
      const taskRes = await fetch(`${base}/tasks/${taskId}`);
      expect(taskRes.status).toBe(200);
      const taskHtml = await taskRes.text();
      const paths = [...taskHtml.matchAll(/href="(\/tasks\/[^"]+\/commits\/[^"]+)"/g)].map((m) => m[1]);
      for (const path of paths) {
        const res = await fetch(`${base}${path}?view=side-by-side`);
        const html = await res.text();
        if (html.includes('<diffs-container>')) {
          target = { path, html };
          break;
        }
      }
      if (!target) await new Promise((r) => setTimeout(r, 300));
    }

    expect(target).not.toBeNull();
    const { path: commitPath, html: splitHtml } = target!;

    // Side-by-side view: diff renders via the @pierre/diffs web component, with
    // the registration script and the active-view marker present.
    expect(splitHtml).toContain('<diffs-container>');
    expect(splitHtml).toContain('class="diff-file"');
    expect(splitHtml).toContain("customElements.define('diffs-container'");
    expect(splitHtml).toContain('class="diff-view-toggle"');
    expect(splitHtml).toMatch(/view=side-by-side"[^>]*class="active"/);

    // Unified view: same component, unified toggle active.
    const unifiedRes = await fetch(`${base}${commitPath}?view=unified`);
    expect(unifiedRes.status).toBe(200);
    const unifiedHtml = await unifiedRes.text();
    expect(unifiedHtml).toContain('<diffs-container>');
    expect(unifiedHtml).toMatch(/view=unified"[^>]*class="active"/);
  });
});
