import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { MERMAID_ASSET_PATH } from '../../src/server/mermaid';

/**
 * E2E: mermaid fences in a review diff get a presentation widget, and the
 * vendored library is served locally (no CDN) from /assets/mermaid.js.
 */
describe('lazy web mermaid diff render', () => {
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

  test('serves the vendored mermaid library from /assets/mermaid.js', async () => {
    const res = await fetch(`${base}${MERMAID_ASSET_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('javascript');
    const body = await res.text();
    expect(body.length).toBeGreaterThan(100_000);
    expect(body).toContain('globalThis["mermaid"]');
    // Offline: the page must never need a CDN for this.
    expect(body).not.toContain('cdn.jsdelivr.net');
  });

  // INVARIANT: a complete mermaid fence in the diff gets a light-DOM
  // presentation widget, and the fence lines keep their (file, side, line)
  // anchors — the diagram must not regress per-line commenting.
  test('review page wraps a complete mermaid fence and keeps line anchors', async () => {
    const taskId = await createTask(ctx, 'Mermaid diff render', 'Add a diagram');
    const start = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(start);

    const wait = await ctx.lazy(['wait', taskId]);
    expectSuccess(wait);

    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(
      join(worktreePath, 'flow.md'),
      ['# Flow', '', '```mermaid', 'flowchart TD', '  A-->B', '```', ''].join('\n'),
    );
    expect(ctx.git('-C', worktreePath, 'add', 'flow.md').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add mermaid diagram').exitCode).toBe(0);

    let html = '';
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/tasks/${taskId}/changes`);
      expect(res.status).toBe(200);
      html = await res.text();
      if (html.includes('data-lz-mermaid') && html.includes('flow.md')) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    expect(html).toContain('data-lz-mermaid');
    expect(html).toContain('rv-mermaid-row');
    expect(html).toContain('data-lz-mermaid-src=');
    expect(html).toContain(MERMAID_ASSET_PATH);
    // Enhance script is present so the client can lazy-load the library.
    expect(html).toContain('securityLevel');
    // Anchors survive on the fence source lines.
    expect(html).toContain('data-side=');
    expect(html).toContain('data-line=');
    expect(html).toContain('rv-add-comment');
    expect(html).not.toContain('<diffs-container>');
    expect(html).not.toContain('cdn.jsdelivr.net/npm/mermaid');
  });
});
