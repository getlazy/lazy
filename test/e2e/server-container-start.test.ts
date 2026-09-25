/**
 * The two ways a container gets started from the dashboard.
 *
 * `POST /tasks/:id/container/start` is the human-pressed button, which now
 * survives in ONE place — the Services card, where "nothing is published"
 * really is the whole story and there is no terminal to open.
 *
 * `POST /tasks/:id/container/ensure` (with `GET .../container/state` to follow
 * it) is what Watch / Shell / Pair / Chat call for themselves. Opening a
 * terminal into a task IS a request for that task's environment, so the panel
 * brings it up and narrates it rather than reporting "container not running"
 * next to a button.
 *
 * Both go through the daemon's own `ensureTaskContainer` — the same path
 * `lazy shell` uses — behind the dashboard session guard, and both share one
 * in-flight start.
 *
 * COVERAGE LIMIT: the daemon here runs under the module mock, so no container
 * is ever really started; what this suite proves is the ROUTES — the guard, the
 * refusals, the redirect, the JSON contract, and that a page render never
 * triggers a start. The sharing rule itself is unit-tested with a controllable
 * launch in test/unit/container-start.test.ts.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, dashboardFetch, type DashboardFetch } from '../helpers/dashboard-session';

describe('web Start container', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('a down container puts a Start container button on the Services tab', async () => {
    // [serve] is a per-branch fact, read from the task's worktree — so it has
    // to be committed before the task's branch is cut.
    const tomlPath = join(ctx.root, 'lazy.toml');
    await writeFile(tomlPath, `${await readFile(tomlPath, 'utf-8')}\n[serve.services]\nweb = 3000\n`);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'declare serve ports');

    const taskId = await createTask(ctx, 'Start container task', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // The button hangs off the "container not running" state, which the page
    // only knows once the task has a session to look a container up for.
    let html = '';
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/tasks/${taskId}/services`);
      if (res.status === 200) {
        html = await res.text();
        if (html.includes('container/start')) break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(html).toContain('/container/start"');
    expect(html).toContain('Start container');
    expect(html).toContain('Container not running — nothing is published');

    // INVARIANT: exactly one Start control on a page. The Shell tab used to
    // grow its own — plus one on the persistent panel, plus one on the verify
    // card — which is what "it has multiple buttons Start Container" was.
    // The route is the discriminator, not the words: the panel scripts carry
    // the string "Start container" as the label their reconnect button takes
    // ONLY after an auto-start has already failed, which is the one fallback
    // this task keeps.
    const shellTab = await (await fetch(`${base}/tasks/${taskId}/shell`)).text();
    expect(shellTab).not.toContain('container/start');
    // …and the terminal controls are live regardless: they start it themselves.
    expect(shellTab).toContain('data-lz-shell-mode="pair"');
    expect(shellTab).toContain('lzEnsureContainer');
  });

  test('POST kicks the start off and redirects back to the task page', async () => {
    const taskId = await createTask(ctx, 'Start container task');

    const res = await fetch(`${base}/tasks/${taskId}/container/start`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain(`/tasks/${taskId}`);
  });

  // INVARIANT: nothing starts a container from a page render. A dashboard that
  // spun containers up because someone opened a tab would be a resource bomb.
  test('GET is not a way to start anything', async () => {
    const taskId = await createTask(ctx, 'Start container task');

    const res = await fetch(`${base}/tasks/${taskId}/container/start`);
    expect(res.status).toBe(405);
  });

  // INVARIANT: the same guard as every other dashboard route. A start is a
  // side effect on the human's machine, not a public endpoint.
  test('signed out, the route refuses', async () => {
    const taskId = await createTask(ctx, 'Start container task');

    const res = await dashboardFetch(`${base}/tasks/${taskId}/container/start`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(res.status).not.toBe(303);
    expect([401, 403, 302]).toContain(res.status);
  });

  test('a terminal task is refused with a reason, not a launch', async () => {
    const taskId = await createTask(ctx, 'Closed task');
    await ctx.lazy(['close', taskId, '--reason', 'not needed', '--yes']);

    const res = await fetch(`${base}/tasks/${taskId}/container/start`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('reopen it');
  });

  test('an unknown task is a 404', async () => {
    const res = await fetch(`${base}/tasks/deadbeef/container/start`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(res.status).toBe(404);
  });

  describe('the panels’ own ensure route', () => {
    test('POST ensure answers with the start’s live state as JSON', async () => {
      const taskId = await createTask(ctx, 'Ensure task');

      const res = await fetch(`${base}/tasks/${taskId}/container/ensure`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as { phase: string; detail: string; startedAt?: number };
      expect(['starting', 'done', 'failed']).toContain(body.phase);
      expect(typeof body.startedAt).toBe('number');
    });

    // INVARIANT: one start, shared. Two panels opened together must attach to
    // the same launch — the second POST joins rather than starting a second
    // container. `startedAt` is the launch's identity.
    test('two panels asking at once get one start, not two', async () => {
      const taskId = await createTask(ctx, 'Ensure task');

      // Concurrent, the way two panels opened together actually behave: the
      // second request reaches the daemon before the first launch can settle.
      const [a, b] = await Promise.all([
        fetch(`${base}/tasks/${taskId}/container/ensure`, { method: 'POST' }),
        fetch(`${base}/tasks/${taskId}/container/ensure`, { method: 'POST' }),
      ]);
      const first = await a.json() as { startedAt: number };
      const second = await b.json() as { startedAt: number };
      // `startedAt` is the launch's identity — one value means one launch.
      expect(second.startedAt).toBe(first.startedAt);
    });

    // INVARIANT: nothing starts a container from a GET. The state route is how
    // a panel FOLLOWS a start; it must never be how one begins.
    test('GET follows a start and never begins one', async () => {
      const taskId = await createTask(ctx, 'Ensure task');

      const before = await fetch(`${base}/tasks/${taskId}/container/state`);
      expect(before.status).toBe(200);
      expect((await before.json() as { phase: string }).phase).toBe('idle');

      expect((await fetch(`${base}/tasks/${taskId}/container/ensure`)).status).toBe(405);
      expect((await fetch(`${base}/tasks/${taskId}/container/state`, { method: 'POST' })).status).toBe(405);

      // Still nothing recorded: neither call above was a start.
      expect((await (await fetch(`${base}/tasks/${taskId}/container/state`)).json() as { phase: string }).phase)
        .toBe('idle');
    });

    test('a terminal task is refused with a JSON reason', async () => {
      const taskId = await createTask(ctx, 'Closed task');
      await ctx.lazy(['close', taskId, '--reason', 'not needed', '--yes']);

      const res = await fetch(`${base}/tasks/${taskId}/container/ensure`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect((await res.json() as { error: string }).error).toContain('reopen it');
    });

    test('an unknown task is a JSON 404', async () => {
      const res = await fetch(`${base}/tasks/deadbeef/container/ensure`, { method: 'POST' });
      expect(res.status).toBe(404);
      expect(await res.json()).toHaveProperty('error');
    });

    // INVARIANT: the same guard as every other dashboard route — a start is a
    // side effect on the human's machine, reachable from a page an agent's app
    // code could be serving next door.
    test('signed out, ensure refuses', async () => {
      const taskId = await createTask(ctx, 'Ensure task');

      const res = await dashboardFetch(`${base}/tasks/${taskId}/container/ensure`, {
        method: 'POST',
        redirect: 'manual',
      });
      expect([401, 403, 302]).toContain(res.status);
      // And nothing was launched behind the refusal.
      expect((await (await fetch(`${base}/tasks/${taskId}/container/state`)).json() as { phase: string }).phase)
        .toBe('idle');
    });
  });
});
