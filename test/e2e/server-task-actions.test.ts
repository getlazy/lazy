/**
 * E2E for the task page's lifecycle actions: start / stop / close / reject /
 * resume / reopen as plain form POSTs on /tasks/:id/actions/:verb, plus the
 * live watch panel that replaced the old auto-refresh mode.
 *
 * The daemon performs every act itself (src/daemon/task-edit-service.ts calls
 * the same functions behind `lazy start` / `stop` / `close` / `resume`) — the
 * web layer never grows a second copy of the state machine, and which buttons
 * the page draws comes from the same predicate the route enforces
 * (src/server/task-verbs.ts).
 *
 * Uses the fake-`claude` binary seam (`fakeClaude: true`) so a task can be
 * held genuinely `working` (a scripted silent agent) long enough to stop it —
 * the module mock's turns finish too fast to catch.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, dashboardFetch, type DashboardFetch } from '../helpers/dashboard-session';
import { successScenario, goSilentScenario } from '../helpers/fake-claude';

describe('lazy web task actions', () => {
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

  const page = async (taskId: string, query = '') =>
    (await fetch(`${base}/tasks/${taskId}${query}`)).text();

  const post = (taskId: string, verb: string, fields: Record<string, string> = {}) =>
    fetch(`${base}/tasks/${taskId}/actions/${verb}`, {
      method: 'POST',
      body: new URLSearchParams(fields),
      redirect: 'manual',
    });

  /** The full task UUID — the page renders full ids in its form actions. */
  async function fullId(taskId: string): Promise<string> {
    const body = (await (await fetch(`${base}/api/tasks/${taskId}`)).json()) as {
      task?: { id: string };
    };
    expect(body.task?.id).toBeTruthy();
    return body.task!.id;
  }

  /** Poll the JSON task detail until the status matches. */
  async function waitForStatus(taskId: string, statuses: string[], timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      const body = (await (await fetch(`${base}/api/tasks/${taskId}`)).json()) as {
        task?: { status: string };
      };
      last = body.task?.status ?? '';
      if (statuses.includes(last)) return last;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`Task ${taskId} never reached ${statuses.join('/')} (last: ${last})`);
  }

  test('backlog offers Start; starting launches a turn; blocked leads with Review and offers resume', async () => {
    await ctx.setClaudeScenario(successScenario({ result: 'done', sessionId: 's1' }));
    const taskId = await createTask(ctx, 'Web-started task', 'Do work');
    const id = await fullId(taskId);

    // The page offers exactly the legal verbs for backlog: start and close —
    // not stop, resume or reject (illegal verbs are not rendered).
    let html = await page(taskId);
    expect(html).toContain(`/tasks/${id}/actions/start`);
    expect(html).toContain(`/tasks/${id}/actions/close`);
    expect(html).not.toContain(`/tasks/${id}/actions/stop`);
    expect(html).not.toContain(`/tasks/${id}/actions/resume`);
    expect(html).not.toContain(`/tasks/${id}/actions/reject`);

    const res = await post(taskId, 'start');
    expect(res.status).toBe(303);

    await waitForStatus(taskId, ['blocked']);

    // Blocked: a prominent Review link plus resume/close — Reject sits on
    // Current review next to Accept. Start is gone (it would be refused).
    html = await page(taskId);
    expect(html).toContain('Go to Current review');
    expect(html).toContain(`/tasks/${id}/actions/resume`);
    expect(html).toContain(`/tasks/${id}/actions/close`);
    expect(html).not.toContain(`/tasks/${id}/actions/start`);
    const review = await (await fetch(`${base}/tasks/${taskId}/review`)).text();
    expect(review).toContain(`/tasks/${id}/actions/reject`);

    // Resume relaunches the agent with no new feedback and comes back blocked.
    const resumed = await post(taskId, 'resume');
    expect(resumed.status).toBe(303);
    await waitForStatus(taskId, ['working', 'blocked']);
    await waitForStatus(taskId, ['blocked']);
  });

  test('a working task shows Stop and stops with the typed reason', async () => {
    // A silent agent holds the task in `working` until we stop it.
    await ctx.setClaudeScenario(goSilentScenario({ silentMs: 120_000 }));
    const taskId = await createTask(ctx, 'Stoppable task', 'Do work');
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    await waitForStatus(taskId, ['working']);
    const id = await fullId(taskId);

    const html = await page(taskId);
    expect(html).toContain(`/tasks/${id}/actions/stop`);
    expect(html).not.toContain(`/tasks/${id}/actions/start`);

    // Reason is required — the daemon requires one, so the route refuses
    // before anything is halted.
    const missing = await post(taskId, 'stop');
    expect(missing.status).toBe(400);

    const res = await post(taskId, 'stop', { reason: 'taking a different approach' });
    expect(res.status).toBe(303);
    await waitForStatus(taskId, ['blocked']);

    // The stop is recorded as a human turn carrying the typed reason.
    const after = await (await fetch(`${base}/tasks/${taskId}/turns`)).text();
    expect(after).toContain('taking a different approach');
  });

  test('close requires a reason, closes, and the closed task offers reopen', async () => {
    const taskId = await createTask(ctx, 'Closable task', 'Do work');

    const missing = await post(taskId, 'close');
    expect(missing.status).toBe(400);
    const missingBody = await missing.text();
    expect(missingBody).toContain('reason is required');

    const res = await post(taskId, 'close', { reason: 'superseded by another task' });
    expect(res.status).toBe(303);
    await waitForStatus(taskId, ['abandoned']);

    const id = await fullId(taskId);
    const html = await page(taskId);
    expect(html).toContain('superseded by another task');
    expect(html).toContain(`/tasks/${id}/actions/reopen`);
    expect(html).not.toContain(`/tasks/${id}/actions/start`);
    expect(html).not.toContain(`/tasks/${id}/actions/close`);

    // A never-started closed task reopens straight back to backlog.
    const reopened = await post(taskId, 'reopen');
    expect(reopened.status).toBe(303);
    await waitForStatus(taskId, ['backlog']);
  });

  test('an illegal verb is a 4xx and an unknown verb a 404', async () => {
    const taskId = await createTask(ctx, 'Illegal-verb task', 'Do work');

    // Stop on a backlog task: refused with the same predicate that decided
    // not to render the button.
    const res = await post(taskId, 'stop', { reason: 'should never work' });
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toContain('Only a running task can be stopped');
    // The typed reason is echoed back, never silently discarded.
    expect(body).toContain('should never work');

    const unknown = await post(taskId, 'destroy');
    expect(unknown.status).toBe(404);

    // GET is not an action.
    const get = await fetch(`${base}/tasks/${taskId}/actions/close`);
    expect(get.status).toBe(405);

    // Status unchanged by any of it.
    await waitForStatus(taskId, ['backlog'], 5_000);
  });

  test('watch offers a live output panel, never a page-refresh loop', async () => {
    const taskId = await createTask(ctx, 'Watched task', 'Do work');

    // INVARIANT: watch is a live stream, not a reload. The old
    // <meta http-equiv="refresh"> mode and its ?watch=1 query answered "has
    // anything changed?" and never "what is the agent doing right now?".
    let html = await page(taskId);
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain('?watch=1');
    expect(html).toContain('data-lz-watch-task');
    expect(html).toContain('/watch/ws');
    // Live-status poll (chrome refresh) is the other half — and still never
    // a whole-page meta refresh.
    expect(html).toContain('data-lz-live-token');
    expect(html).toContain('/live-status');

    // ?watch=1 is no longer special — the page renders exactly the same.
    const withQuery = await page(taskId, '?watch=1');
    expect(withQuery).not.toContain('http-equiv="refresh"');

    // A terminal task has nothing to stream, so it is not offered the panel.
    expect((await post(taskId, 'close', { reason: 'done watching' })).status).toBe(303);
    await waitForStatus(taskId, ['abandoned']);
    html = await page(taskId);
    expect(html).not.toContain('data-lz-watch-task');
    // Terminal tasks also drop the live-status poller — nothing further
    // will change the chrome.
    expect(html).not.toContain('/live-status');
  });

  test('live-status endpoint returns a token that flips when the task blocks', async () => {
    await ctx.setClaudeScenario(successScenario({ result: 'done', sessionId: 's-live' }));
    const taskId = await createTask(ctx, 'Live-status task', 'Do work');

    const beforeRes = await fetch(`${base}/tasks/${taskId}/live-status`);
    expect(beforeRes.status).toBe(200);
    expect(beforeRes.headers.get('Cache-Control')).toBe('no-store');
    const before = (await beforeRes.json()) as {
      token: string;
      status: string;
      display_status: string;
      turns: number;
    };
    expect(before.status).toBe('backlog');
    expect(before.token).toBeTruthy();
    expect(before.turns).toBe(0);

    // Page stamps the same token the endpoint returns.
    const html = await page(taskId);
    expect(html).toContain(`data-lz-live-token="${before.token}"`);

    // A chrome fragment includes the header; a plain fragment does not.
    const id = await fullId(taskId);
    const chromeFrag = await (await fetch(`${base}/tasks/${taskId}?fragment=1&chrome=1`)).text();
    expect(chromeFrag).toContain('lz-landing-header');
    expect(chromeFrag).toContain('data-lz-tab-strip');
    expect(chromeFrag).toContain('data-lz-tab-body');
    const plainFrag = await (await fetch(`${base}/tasks/${taskId}?fragment=1`)).text();
    expect(plainFrag).not.toContain('lz-landing-header');
    expect(plainFrag).toContain('data-lz-tab-strip');

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    await waitForStatus(taskId, ['blocked']);

    const after = (await (await fetch(`${base}/tasks/${taskId}/live-status`)).json()) as {
      token: string;
      status: string;
    };
    expect(after.status).toBe('blocked');
    expect(after.token).not.toBe(before.token);

    // Fresh page after the flip shows the new status in the header and a
    // matching token — what the poller would swap in without a reload.
    const afterPage = await page(taskId);
    expect(afterPage).toContain('>blocked</span>');
    expect(afterPage).toContain(`data-lz-live-token="${after.token}"`);
    expect(afterPage).toContain('Go to Current review');
    // Sanity: the full id still drives the actions on the refreshed chrome.
    expect(afterPage).toContain(`/tasks/${id}/actions/resume`);
  });

  /**
   * INVARIANT: the live poll is sensitive to every region of the page, not
   * just the header. The engineer's loop task stayed `working` while it
   * created and accepted children, so the single header token never moved and
   * the Subtasks tab never refreshed — the page had to be reloaded by hand.
   */
  test('live-status keys move for subtasks, comments and journal with an unchanged header', async () => {
    const taskId = await createTask(ctx, 'Region keys task', 'Do work');

    type Live = { token: string; keys: Record<string, string> };
    const live = async () => (await (await fetch(`${base}/tasks/${taskId}/live-status`)).json()) as Live;

    const before = await live();
    expect(before.keys.header).toBeTruthy();
    expect(before.keys.subtasks).toBe('0:');

    // The page stamps exactly the keys the endpoint serves.
    const html = await page(taskId);
    expect(html).toContain('data-lz-live-keys=');
    expect(html).toContain(`data-lz-live-token="${before.token}"`);

    // A child appears: only the subtasks key moves.
    expectSuccess(await ctx.lazy(['create', '--goal', 'A child', '--parent', taskId]));
    const withChild = await live();
    expect(withChild.keys.subtasks).not.toBe(before.keys.subtasks);
    expect(withChild.keys.header).toBe(before.keys.header);
    expect(withChild.token).not.toBe(before.token);

    // A comment moves only the comments key; a journal entry only journal.
    expectSuccess(await ctx.lazy(['comment', taskId, '-m', 'look at this']));
    const withComment = await live();
    expect(withComment.keys.comments).not.toBe(withChild.keys.comments);
    expect(withComment.keys.subtasks).toBe(withChild.keys.subtasks);
    expect(withComment.keys.header).toBe(before.keys.header);

    expectSuccess(await ctx.lazy(['journal', taskId, '-m', 'chose X over Y']));
    const withJournal = await live();
    expect(withJournal.keys.journal).not.toBe(withComment.keys.journal);
    expect(withJournal.keys.comments).toBe(withComment.keys.comments);
  });

  /**
   * INVARIANT: a background poll must not pay for a body the policy forbids it
   * from swapping. `body=0` is what keeps a Changes-tab reader from triggering
   * a full diff render every three seconds because a subtask changed status.
   */
  test('a chrome fragment with body=0 is header + strip and no tab body', async () => {
    const taskId = await createTask(ctx, 'Body-less fragment task', 'Do work');

    const withBody = await (await fetch(`${base}/tasks/${taskId}?fragment=1&chrome=1`)).text();
    expect(withBody).toContain('lz-landing-header');
    expect(withBody).toContain('data-lz-tab-body');

    const withoutBody = await (await fetch(`${base}/tasks/${taskId}?fragment=1&chrome=1&body=0`)).text();
    expect(withoutBody).toContain('lz-landing-header');
    expect(withoutBody).toContain('data-lz-tab-strip');
    expect(withoutBody).not.toContain('data-lz-tab-body');

    // The strip still carries each tab's live contract, which is how the
    // island decides what to do without knowing which tabs exist.
    expect(withoutBody).toContain('data-lz-tab-regions=');
    expect(withoutBody).toContain('data-lz-tab-policy="pill"');
    expect(withoutBody).toContain('data-lz-tab-policy="never"');
  });

  /**
   * INVARIANT: a body-less poll render must not DROP the strip's queued-comment
   * badge. Current review is `pill` policy, so every background refresh while
   * a reviewer sits on it asks for `body=0` and repaints the strip — and an
   * absent badge reads as "nothing queued", the opposite of true.
   */
  test('the queued-comment badge survives a body=0 render', async () => {
    const taskId = await createTask(ctx, 'Queued badge task', 'Do work');
    const id = await fullId(taskId);

    const posted = await fetch(`${base}/tasks/${taskId}/review/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: 'src/thing.ts',
        line: 3,
        side: 'new',
        content: 'please rename this',
        intent: 'comment',
      }),
    });
    expect(posted.status).toBe(201);

    const badge = /<a[^>]*data-lz-tab="review"[^>]*>[^<]*<span class="lz-tab-badge"[^>]*>(\d+)<\/span>/;

    // The full page and the full chrome fragment both render it.
    const full = await page(taskId, '/review');
    expect(full).toMatch(badge);
    expect(full.match(badge)?.[1]).toBe('1');

    // …and so must the body-less poll render, which is the one that repaints
    // the strip a reviewer is looking at.
    const withoutBody = await (
      await fetch(`${base}/tasks/${id}/review?fragment=1&chrome=1&body=0`)
    ).text();
    expect(withoutBody).not.toContain('data-lz-tab-body');
    expect(withoutBody).toMatch(badge);
    expect(withoutBody.match(badge)?.[1]).toBe('1');
  });

  test('an unauthenticated watch upgrade is refused', async () => {
    const taskId = await createTask(ctx, 'Guarded watch task', 'Do work');

    // INVARIANT: the WS upgraders run AHEAD of the HTTP handler's dashboard
    // gate, so each applies the same guard itself on EVERY upgrade. A watch
    // stream shows an agent's prompts and file contents — no less sensitive
    // than the pages themselves.
    const res = await dashboardFetch(`${base}/tasks/${taskId}/watch/ws`);
    expect(res.status).toBe(401);

    // With a session it gets past the gate — and a non-GET is still refused,
    // which proves the guard ran BEFORE the method check.
    const wrongMethod = await fetch(`${base}/tasks/${taskId}/watch/ws`, { method: 'POST' });
    expect(wrongMethod.status).toBe(405);

    const unknown = await fetch(`${base}/tasks/does-not-exist/watch/ws`);
    expect(unknown.status).toBe(404);
  });
});
