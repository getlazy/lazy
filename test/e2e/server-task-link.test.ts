/**
 * Dashboard "Link…" — form, POST, linked marker, action-dialog 202.
 *
 * Mirrors server-task-create.test.ts: the web layer is a client of
 * TaskActions.linkTask (daemon-owned). JS-off POSTs and 303s; JS-on
 * sends X-Lazy-Action-Dialog and polls.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { readTaskJson } from '../helpers/storage';
import { ACTION_DIALOG_HEADER } from '../../src/server/action-run';
import { IMPORT_SOURCE_BRANCH_KEY, IMPORT_SOURCE_URL_KEY } from '../../src/task/linked';

/**
 * Bare origin + a pushed branch so `linkTask` can fetch and create a worktree.
 * Same shape as test/e2e/link.test.ts.
 */
function setupOriginWithBranch(ctx: TestContext, branch: string): void {
  const bareRepo = mkdtempSync(join(tmpdir(), 'lazy-e2e-bare-'));
  Bun.spawnSync(['git', 'init', '--bare', bareRepo]);
  ctx.git('remote', 'add', 'origin', bareRepo);
  ctx.git('branch', branch);
  ctx.git('push', 'origin', branch);
}

describe('dashboard link form', () => {
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

  const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${base}/tasks/link`, {
      method: 'POST',
      body: new URLSearchParams(fields),
      redirect: 'manual',
      headers,
    });

  test('tasks list offers Link next to New task', async () => {
    const html = await (await fetch(`${base}/tasks`)).text();
    expect(html).toContain('href="/tasks/new"');
    expect(html).toContain('href="/tasks/link"');
    expect(html).toContain('Link…');
  });

  test('GET /tasks/link renders the form', async () => {
    const html = await (await fetch(`${base}/tasks/link`)).text();
    expect(html).toContain('Link a branch or PR');
    expect(html).toContain('name="ref"');
    expect(html).toContain('name="parent"');
    expect(html).toContain('name="code"');
    expect(html).toContain('data-lz-action-when="always"');
  });

  test('POST /tasks/link with a branch 303s to the new task', async () => {
    setupOriginWithBranch(ctx, 'feature/auth');

    const res = await post({ ref: 'feature/auth', code: 'web-link-auth' });
    expect(res.status).toBe(303);
    // The redirect names the task by its code; the UUID keeps resolving too.
    expect(res.headers.get('Location')).toContain('/tasks/web-link-auth');

    const task = readTaskJson(ctx.root, 'web-link-auth');
    expect(task.metadata?.[IMPORT_SOURCE_BRANCH_KEY]).toBe('feature/auth');
    expect(task.metadata?.[IMPORT_SOURCE_URL_KEY]).toBe('feature/auth');
    expect(task.code).toBe('web-link-auth');
    expect(task.status).toBe('blocked');
  }, 60_000);

  test('GET the linked task shows the linked marker', async () => {
    setupOriginWithBranch(ctx, 'feature/marker');
    const create = await post({ ref: 'feature/marker' });
    expect(create.status).toBe(303);
    const location = create.headers.get('Location') ?? '';
    const path = new URL(location, 'http://lazy.test').pathname;

    const html = await (await fetch(`${base}${path}`)).text();
    expect(html).toContain('lz-linked');
    expect(html).toContain('linked');
    expect(html).toContain('feature/marker');
  }, 60_000);

  test('empty ref re-renders the form with 400', async () => {
    const res = await post({ ref: '   ' });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('A pull-request URL or branch name is required');
  });

  test('action-dialog POST returns 202 and the run redirects to the task', async () => {
    setupOriginWithBranch(ctx, 'feature/dialog');

    const res = await post(
      { ref: 'feature/dialog' },
      { [ACTION_DIALOG_HEADER]: '1', Accept: 'application/json' },
    );
    expect(res.status).toBe(202);
    const started = (await res.json()) as { runId?: string; taskId?: string };
    expect(started.taskId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(started.taskId).not.toBe('new-link');
    expect(started.runId).toBeTruthy();

    const deadline = Date.now() + 60_000;
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
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(snap?.status).toBe('done');
    expect(snap?.redirect).toMatch(/\/tasks\/[0-9a-f-]+/);
  }, 60_000);

  test('a link run cannot be polled under a different path id', async () => {
    setupOriginWithBranch(ctx, 'feature/secret-run');
    const res = await post(
      { ref: 'feature/secret-run' },
      { [ACTION_DIALOG_HEADER]: '1', Accept: 'application/json' },
    );
    expect(res.status).toBe(202);
    const started = (await res.json()) as { runId?: string; taskId?: string };
    expect(started.runId).toBeTruthy();

    const foreign = await fetch(
      `${base}/tasks/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/action-runs/${started.runId}`,
    );
    expect(foreign.status).toBe(404);

    const own = await fetch(`${base}/tasks/${started.taskId}/action-runs/${started.runId}`);
    expect(own.status).not.toBe(404);
  }, 60_000);

  test('POST a GitHub PR URL links via the forge mock', async () => {
    const branch = 'feature/widgets';
    setupOriginWithBranch(ctx, branch);

    writeFileSync(
      join(ctx.protocolBase, 'mock-import-result.json'),
      JSON.stringify({
        goal: 'Add widgets',
        branch,
        metadata: {
          github_remote_ref_url: 'https://github.com/acme/widgets/pull/42',
          github_remote_ref_id: '42',
          github_remote_ref_state: 'OPEN',
          import_source_url: 'https://github.com/acme/widgets/pull/42',
        },
        comments: [],
      }),
    );

    const res = await post({ ref: 'https://github.com/acme/widgets/pull/42' });
    expect(res.status).toBe(303);
    // The redirect carries the slug derived from the branch; resolve by code.
    const task = readTaskJson(ctx.root, 'feature-widgets');
    expect(task.metadata?.[IMPORT_SOURCE_BRANCH_KEY]).toBe(branch);
    expect(task.metadata?.github_remote_ref_id).toBe('42');
    expect(task.metadata?.github_remote_ref_url).toBe('https://github.com/acme/widgets/pull/42');
    expect(task.status).toBe('blocked');

    const html = await (await fetch(`${base}/tasks/${task.id}`)).text();
    expect(html).toContain('lz-linked');
    expect(html).toContain('#42');
    // INVARIANT: the Review dialog offers no post-to-PR choice, on a LINKED
    // task least of all — that PR belongs to someone else. Lazy writes no
    // reviews or comments to a forge (engineer decision, 2026-09-21), so the
    // checkbox this used to assert ("Post findings to the pull request",
    // present and unchecked for a linked PR) is gone along with the choice.
    expect(html).not.toContain('Post findings');
    expect(html).not.toMatch(/name="post"/);
    expect(html).toContain('lazy does not post reviews to a pull or merge request');
  }, 90_000);
});
