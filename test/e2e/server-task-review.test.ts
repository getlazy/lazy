/**
 * Dashboard agent-review: Review on the task page, findings on Summary,
 * (review) on Turns, action-dialog 202.
 *
 * Fake-binary seam so the review turn is a real supervisor + scripted agent,
 * the same way test/e2e/review-verb.test.ts drives `lazy review`.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { successScenario } from '../helpers/fake-claude';
import { ACTION_DIALOG_HEADER } from '../../src/server/action-run';
import { setTaskMetadata } from '../helpers/storage';
import { IMPORT_SOURCE_URL_KEY } from '../../src/task/linked';
import { UNPARSED_REVIEW_LABEL } from '../../src/review/parse-report';
import { anchorDomId } from '../../src/server/review-diff';

const REVIEW_JSON = JSON.stringify({
  verdict: 'needs_work',
  security: 'none found',
  data_integrity: 'none found',
  findings: [
    {
      file: 'widget.ts',
      line: 1,
      severity: 'low',
      category: 'style',
      summary: 'Name the helper.',
    },
  ],
});

describe('dashboard agent review', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;
  let taskId: string;
  let fullId: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));

    taskId = await createTask(ctx, 'Review from the web', 'Do the work');
    await ctx.setClaudeScenario({
      sequence: [
        successScenario({
          result: 'Work done.',
          sessionId: 'fake-sess-work',
          commit: { message: 'add widget', files: [{ path: 'widget.ts', content: 'export const x = 1;\n' }] },
        }),
        successScenario({ result: REVIEW_JSON, sessionId: 'fake-sess-review' }),
      ],
    });
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const body = (await (await fetch(`${base}/api/tasks/${taskId}`)).json()) as {
      task?: { id: string; status: string };
    };
    expect(body.task?.status).toBe('blocked');
    fullId = body.task!.id;
  }, 120_000);

  afterEach(async () => {
    await ctx.cleanup();
  });

  const postReview = (fields: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    fetch(`${base}/tasks/${fullId}/actions/review`, {
      method: 'POST',
      body: new URLSearchParams(fields),
      redirect: 'manual',
      headers,
    });

  test('blocked task offers Review and says findings stay on the page', async () => {
    const html = await (await fetch(`${base}/tasks/${taskId}`)).text();
    expect(html).toContain(`/tasks/${fullId}/actions/review`);
    expect(html).toContain('>Review</button>');
    expect(html).toContain('lazy does not post reviews to a pull or merge request');
    expect(html).toContain('Go to Current review');
  });

  test('POST review stores findings on Summary and labels the turn', async () => {
    const res = await postReview();
    expect(res.status).toBe(303);
    const location = res.headers.get('Location') ?? '';
    // Reviews got their own tab; the redirect names that tab with a flash
    // message instead of anchoring the Summary findings section.
    expect(location).toContain(`/tasks/${fullId}`);
    expect(location).toContain('/reviews');
    expect(location).toContain('flash=');

    const summary = await (await fetch(`${base}/tasks/${taskId}`)).text();
    expect(summary).toContain('id="lz-review-findings"');
    expect(summary).toContain('Reviews');
    expect(summary).toContain('needs_work');
    expect(summary).toContain('Security');
    expect(summary).toContain('Data integrity');
    expect(summary).toContain('Name the helper.');
    expect(summary).toContain(`/tasks/${fullId}/changes#${anchorDomId({ file: 'widget.ts', side: 'new', line: 1 })}`);
    // The Agent report card is still the work turn, not the review JSON.
    expect(summary).toContain('Work done.');

    const turns = await (await fetch(`${base}/tasks/${taskId}/turns`)).text();
    expect(turns).toContain('(review)');
    expect(turns).toContain('Raw review text');
    expect(turns).not.toContain(UNPARSED_REVIEW_LABEL);
  }, 120_000);

  test('action-dialog POST returns 202 and the run settles on the findings', async () => {
    const res = await postReview(
      {},
      { [ACTION_DIALOG_HEADER]: '1', Accept: 'application/json' },
    );
    expect(res.status).toBe(202);
    const started = (await res.json()) as { runId?: string; taskId?: string };
    expect(started.runId).toBeTruthy();
    expect(started.taskId).toBe(fullId);

    const deadline = Date.now() + 120_000;
    let snap: { status?: string; redirect?: string; error?: string } | null = null;
    while (Date.now() < deadline) {
      const poll = await fetch(`${base}/tasks/${started.taskId}/action-runs/${started.runId}`);
      if (poll.status === 404) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      const body = (await poll.json()) as { status?: string; redirect?: string; error?: string };
      snap = body;
      if (body.status === 'done' || body.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(snap?.status).toBe('done');
    expect(snap?.redirect).toContain(`/tasks/${fullId}`);
    expect(snap?.redirect).toContain('/reviews');
  }, 120_000);

  // INVARIANT: the Review dialog offers no choice about posting to the PR,
  // because there is none — lazy writes no reviews to a forge (engineer
  // decision, 2026-09-21). The dialog used to carry a "Post findings" checkbox
  // that defaulted on for the task's own PR; it is gone, and so is the `post`
  // form field behind it. A task WITH a PR is the case that used to differ.
  test('a task with its own PR still offers no post-to-PR choice', async () => {
    setTaskMetadata(ctx.root, taskId, 'github_remote_ref_id', '42');
    setTaskMetadata(ctx.root, taskId, 'github_remote_ref_url', 'https://github.com/o/r/pull/42');

    const own = await (await fetch(`${base}/tasks/${taskId}`)).text();
    expect(own).not.toContain('Post findings');
    expect(own).not.toMatch(/name="post"/);
    expect(own).toContain('lazy does not post reviews to a pull or merge request');

    setTaskMetadata(ctx.root, taskId, IMPORT_SOURCE_URL_KEY, 'https://github.com/o/r/pull/42');
    const linked = await (await fetch(`${base}/tasks/${taskId}`)).text();
    expect(linked).not.toMatch(/name="post"/);
  });
});

describe('dashboard agent review refuses a backlog task', () => {
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

  test('backlog page has no Review form and POST is 409', async () => {
    const taskId = await createTask(ctx, 'Never started');
    const body = (await (await fetch(`${base}/api/tasks/${taskId}`)).json()) as {
      task?: { id: string };
    };
    const id = body.task!.id;
    const html = await (await fetch(`${base}/tasks/${taskId}`)).text();
    expect(html).not.toContain(`/tasks/${id}/actions/review`);

    const res = await fetch(`${base}/tasks/${id}/actions/review`, {
      method: 'POST',
      body: new URLSearchParams(),
      redirect: 'manual',
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('backlog');
  });
});
