/**
 * The from-source dev web server (src/dev/web-server.ts).
 *
 * Two things are under test, and they are the two claims the server makes:
 *   1. It is a CLIENT of the running daemon. A review action performed on its
 *      page lands in the REAL store — proven by reading it back through a
 *      different client (the daemon's own dashboard), never by inspecting the
 *      store this process could have written itself.
 *   2. It serves the stylesheet from disk, so a CSS edit is visible on the next
 *      request with no restart of anything.
 *
 * Plus the refusal: with no daemon it does not start and says how to fix that.
 *
 * DAEMON ISOLATION: the suite owns exactly the daemon `setupTestLazy` starts
 * for it and reaps nothing else — daemon state is per-project-root and every
 * root here is a fresh temp dir. The dev server binds a PROBED free port well
 * above the shared 26024+ window, so it can never squat a port another suite's
 * daemon is walking towards.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { startDevWebServer, DevWebServerError } from '../../src/dev/web-server';

/** A port in a range nothing else in this repo binds. */
function probeFreePort(): number {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 41000 + Math.floor(Math.random() * 8000);
    try {
      const probe = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('') });
      probe.stop(true);
      return port;
    } catch {
      // taken — try another
    }
  }
  throw new Error('could not find a free port for the dev web server');
}

describe('dev web server (daemon client)', () => {
  let ctx: TestContext;
  let server: { stop: (closeActive?: boolean) => void } | null = null;
  let base = '';

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const started = await startDevWebServer({ projectRoot: ctx.root, port: probeFreePort() });
    server = started.server;
    base = started.url;
  });

  afterEach(async () => {
    server?.stop(true);
    server = null;
    await ctx.cleanup();
  });

  test('serves the dashboard from source against the running daemon', async () => {
    const response = await fetch(`${base}/api/tasks`);
    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });

  // The load-bearing one. A write performed on the dev server's page must be
  // in the real store — so it is read back through the DAEMON's own dashboard,
  // a different client entirely. If the dev server were writing anywhere else
  // (its own store, nowhere at all), this fails.
  test('a review comment posted here is visible through the daemon dashboard', async () => {
    const taskId = await createTask(ctx, 'Dev server review target');

    const posted = await fetch(`${base}/review/${taskId}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: 'src/example.ts',
        line: 12,
        side: 'new',
        content: 'posted from the dev web server',
        // 'comment' rather than 'ask': a change request is durable with no
        // agent involvement, so the assertion is about storage, not dispatch.
        intent: 'comment',
      }),
    });
    expect(posted.status).toBe(201);
    const { comment } = (await posted.json()) as { comment: { id: string; content: string } };
    expect(comment.content).toBe('posted from the dev web server');

    // Read it back through the daemon's dashboard.
    const dashboardUrlCmd = await ctx.lazy(['daemon', 'dashboard-url']);
    expect(dashboardUrlCmd.exitCode).toBe(0);
    const daemonBase = dashboardUrlCmd.stdout.trim();
    expect(daemonBase).toBeTruthy();

    const threads = await fetch(`${daemonBase}/api/review/${taskId}/threads`);
    expect(threads.status).toBe(200);
    expect(JSON.stringify(await threads.json())).toContain('posted from the dev web server');
  });

  // Rejected at the daemon's RPC boundary, not silently coerced: the review RPC
  // commands are an external surface and parse their inputs.
  test('an invalid comment is rejected rather than stored', async () => {
    const taskId = await createTask(ctx, 'Dev server validation target');
    const response = await fetch(`${base}/review/${taskId}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'src/example.ts', line: 12, side: 'sideways', content: 'x' }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  test('serves the stylesheet as a file', async () => {
    const response = await fetch(`${base}/assets/app.css`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/css');
    // no-store, so a plain reload — not a hard refresh — shows an edit.
    expect(response.headers.get('cache-control')).toContain('no-store');
    const css = await response.text();
    // A rule from diff.css, i.e. the sheet really is the composed one and not
    // just app.css. `.rv-file` is the shared diff renderer's file box.
    expect(css).toContain('.rv-file');
  });

  // THE DX BAR: edit CSS, refresh, see it. No dev-server restart, no daemon
  // restart — the same in-process server answers both requests.
  test('a stylesheet edit is served without restarting anything', async () => {
    const cssPath = join(import.meta.dir, '..', '..', 'src', 'server', 'styles', 'app.css');
    const original = await readFile(cssPath, 'utf-8');
    const marker = '.dev-web-server-live-edit-probe { color: rebeccapurple; }';
    try {
      expect(await (await fetch(`${base}/assets/app.css`)).text()).not.toContain(marker);
      await writeFile(cssPath, `${original}\n${marker}\n`, 'utf-8');
      expect(await (await fetch(`${base}/assets/app.css`)).text()).toContain(marker);
    } finally {
      await writeFile(cssPath, original, 'utf-8');
    }
  });
});

describe('dev web server without a daemon', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: the dev server has no local fallback. It reads and writes over
  // RPC, so "no daemon" is a stated dependency it refuses on — never a silent
  // degrade to opening the store itself, which would also be impossible against
  // a remote daemon.
  test('refuses to start and names the fix', async () => {
    let error: unknown = null;
    try {
      await startDevWebServer({ projectRoot: ctx.root, port: probeFreePort() });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(DevWebServerError);
    expect((error as Error).message).toContain('lazy daemon start');
  });
});
