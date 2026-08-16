import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';

// INVARIANT (one-diff-renderer): the commit detail page renders through the
// SAME renderer as the review surface — light-DOM rows carrying (file, side,
// line), served end to end by the real daemon.
//
// It used to use @pierre/diffs, whose <diffs-container> put every line in a
// Shadow DOM. Nothing outside a shadow root can address a line, so that
// renderer could never carry the per-line anchors inline comments need, and
// the project carried two diff components with two looks. This asserts the
// second one has not come back.
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

  test('renders a commit diff as addressable light-DOM rows', async () => {
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
        const res = await fetch(`${base}${path}`);
        const html = await res.text();
        if (html.includes('<table class="rv-diff">')) {
          target = { path, html };
          break;
        }
      }
      if (!target) await new Promise((r) => setTimeout(r, 300));
    }

    expect(target).not.toBeNull();
    const { html } = target!;

    // Light-DOM rows, addressable per line — the property the shadow-DOM
    // renderer structurally could not provide.
    expect(html).toContain('class="rv-file"');
    expect(html).toMatch(/<tr class="rv-line[^"]*"[^>]*data-file="[^"]+" data-side="(old|new)" data-line="\d+"/);
    expect(html).not.toContain('diffs-container');
    expect(html).not.toContain('customElements.define');

    // Read-only history: no comment affordance, no Viewed tick.
    expect(html).not.toContain('class="rv-add-comment"');
    expect(html).not.toContain('class="rv-viewed-box"');

    // The wrap/scroll control ships and is wired to this page's diff root.
    expect(html).toContain('data-rv-viewopts');
    expect(html).toContain('#commit-diff');
  });

  // The deleted /tasks/:id/pr page must stay deleted: it duplicated the commit
  // list the task page already shows, and the review page is the PR surface now.
  test('the retired /pr page is gone and task detail points at review instead', async () => {
    const taskId = await createTask(ctx, 'PR page retired', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const health = await checkDaemonHealth(ctx.root);
    const base = `http://localhost:${health.webPort}`;

    const prRes = await fetch(`${base}/tasks/${taskId}/pr`);
    expect(prRes.status).toBe(404);

    const taskHtml = await (await fetch(`${base}/tasks/${taskId}`)).text();
    expect(taskHtml).not.toContain(`/tasks/${taskId}/pr`);
    expect(taskHtml).toContain(`/review/${taskId}`);
  });
});
