/**
 * E2E: the web shell surfaced in the daemon dashboard.
 *
 * Coverage here is the parts that need the REAL daemon web server: the vendored
 * xterm.js assets are served locally (no CDN), the Shell control is wired into
 * both the task page and the review page, and the `/tasks/:id/shell/ws` route's
 * pre-resolution refusals (no session, unknown task, wrong method) behave.
 *
 * These run on a `fakeClaude` context, which uses the HOST-PROCESS runner. That
 * makes the availability path DETERMINISTIC and Docker-free: a host-process task
 * has no container, so no terminal can be opened on that runner.
 * The container-resolution and protocol logic that a real Docker shell would use
 * is covered at the unit layer (test/unit/shell-*.test.ts).
 */

import { Window } from 'happy-dom';
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario } from '../helpers/fake-claude';
import {
  signInToDashboard,
  dashboardFetch,
  type DashboardFetch,
} from '../helpers/dashboard-session';
import { XTERM_JS_PATH, XTERM_CSS_PATH } from '../../src/server/xterm';

describe('lazy web shell', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function startedTask(): Promise<string> {
    const taskId = await createTask(ctx, 'Web shell task', 'Do the work');
    await ctx.setClaudeScenario(
      successScenario({ result: 'done', sessionId: 'shell-sess' }),
    );
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    return taskId;
  }

  // INVARIANT: an unavailable action stays clickable and gives the daemon's
  // own refusal on click; a tooltip alone is inaccessible on touch screens.
  test('unavailable dashboard actions explain their refusal on click', async () => {
    const taskId = await createTask(ctx, 'Not started yet', 'Do the work');
    const html = await (await fetch(`${base}/tasks/${taskId}`)).text();
    const win = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true,
      disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
    try {
      win.document.write(html);
      const button = [...win.document.querySelectorAll('button')].find(el => el.hasAttribute('data-control-refusal'));
      expect(button).not.toBeNull();
      expect(button!.disabled).toBe(false);
      const script = [...win.document.querySelectorAll('script')].find(el => el.textContent.includes('function explain(event)'));
      expect(script).toBeDefined();
      win.eval(script!.textContent);
      button!.click();
      expect(button!.parentElement!.querySelector('[role=alert]')?.textContent).toBe(button!.getAttribute('data-control-refusal') ?? undefined);
      expect(win.document.querySelector('button[disabled], input[disabled], select[disabled]')).toBeNull();
    } finally {
      await win.happyDOM.close();
    }
  }, 90_000);

  test('serves the vendored xterm.js and its stylesheet locally (no CDN)', async () => {
    const js = await fetch(`${base}${XTERM_JS_PATH}`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type') ?? '').toContain('javascript');
    const body = await js.text();
    expect(body.length).toBeGreaterThan(10_000);
    expect(body).not.toContain('cdn.jsdelivr.net');

    const css = await fetch(`${base}${XTERM_CSS_PATH}`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type') ?? '').toContain('css');
  }, 90_000);

  test('hides the Shell tab on the host runner, which has no container to enter', async () => {
    const taskId = await startedTask();
    const landing = await (await fetch(`${base}/tasks/${taskId}`)).text();
    const review = await (await fetch(`${base}/tasks/${taskId}/review`)).text();
    // The tab and the persist panel are the same on every tab of the page.
    // A host-process runner cannot open a shell, so we hide the control
    // rather than leave a dead button.
    for (const html of [landing, review]) {
      expect(html).not.toContain('data-lz-tab="shell"');
      expect(html).not.toContain('data-lz-shell-task=');
    }
  }, 90_000);

  // INVARIANT: the shell upgrade requires the SAME signed-in browser session as
  // every dashboard page — the upgrader runs ahead of the HTTP handler's gate,
  // so it must never be the one unauthenticated route on the port.
  test('the shell ws route refuses without a dashboard session', async () => {
    const taskId = await startedTask();
    const res = await dashboardFetch(`${base}/tasks/${taskId}/shell/ws`);
    expect(res.status).toBe(401);
  }, 90_000);

  test('the shell ws route 404s an unknown task', async () => {
    const res = await fetch(`${base}/tasks/does-not-exist/shell/ws`);
    expect(res.status).toBe(404);
  }, 90_000);

  test('the shell ws route rejects a non-GET method', async () => {
    const taskId = await startedTask();
    const res = await fetch(`${base}/tasks/${taskId}/shell/ws`, { method: 'POST' });
    expect(res.status).toBe(405);
  }, 90_000);
});
