/**
 * The Clusters page end to end: `/clusters` lists cluster TASKS with the progress
 * derived from their children, and offers the ordinary create form pinned to
 * type `cluster`.
 *
 * Distinct from test/e2e/server-web-loop.test.ts, which asserts that the OLD
 * `/loop` review-queue page (the browser half of `lazy loop`) stays hidden.
 * Renaming the type to `cluster` is half of why those two are no longer easy to
 * confuse.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { setTaskStatus } from '../helpers/storage';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

describe('web clusters page', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  const shortIdOf = (stdout: string): string => stdout.match(/ID:\s+([a-f0-9]{8})/)![1];

  async function seedCluster(): Promise<void> {
    expectSuccess(await ctx.lazy([
      'create', '--goal', 'Fix everything the API review found', '--prompt', 'Run the children',
      '--type', 'cluster', '--code', 'api-review-fixes',
    ]));
    const child = async (goal: string, code: string): Promise<string> => {
      const r = await ctx.lazy([
        'create', '--goal', goal, '--prompt', `${goal} work`,
        '--parent', 'api-review-fixes', '--code', code,
      ]);
      expectSuccess(r);
      return shortIdOf(r.stdout);
    };
    const done = await child('Validate the pagination cursor', 'fix-cursor');
    const running = await child('Reject unknown query params', 'fix-query-params');
    const deferred = await child('Re-model the error envelope', 'rework-errors');
    await child('Document the rate limit headers', 'document-rate-limits');
    setTaskStatus(ctx.root, done, 'complete');
    setTaskStatus(ctx.root, running, 'working');
    expectSuccess(await ctx.lazy(['tag', deferred, 'deferred-by-api-review-fixes']));
  }

  test('lists cluster tasks with derived k-of-n, their children, and a create form', async () => {
    await seedCluster();
    // A plain task must not show up here: this page is about the cluster TYPE.
    expectSuccess(await ctx.lazy(['create', '--goal', 'An ordinary task', '--code', 'plain-one']));

    const res = await fetch(`${base}/clusters`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('api-review-fixes');
    expect(html).toContain('<strong>1/4</strong> accepted');
    expect(html).toContain('fix-query-params');
    expect(html).toContain('rework-errors');
    expect(html).toContain('>deferred<');
    // One card, for the one cluster — the plain task is not a cluster and gets no
    // card. (Its code still appears in the create form's parent datalist,
    // which is why this counts cards rather than searching the whole page.)
    expect(html.match(/class="lz-cluster-card"/g) ?? []).toHaveLength(1);
    expect(html).not.toContain('>An ordinary task<');

    // The create form is the shared one, POSTing to the shared route.
    expect(html).toContain('action="/tasks/new"');
    expect(html).toContain('Create cluster');
    expect(html).toContain('<option value="cluster" selected>cluster</option>');
  }, 90_000);

  test('creating a cluster from the page makes a task of type cluster', async () => {
    const body = new FormData();
    body.set('goal', 'Work through the backlog serially');
    body.set('code', 'made-from-clusters-page');
    body.set('type', 'cluster');
    const res = await fetch(`${base}/tasks/new`, { method: 'POST', body, redirect: 'manual' });
    expect(res.status).toBe(303);

    const show = await ctx.lazy(['show', 'made-from-clusters-page', '--json']);
    expectSuccess(show);
    expect(JSON.parse(show.stdout).type).toBe('cluster');
  }, 90_000);

  test('an empty project gets the explainer, not a bare empty table', async () => {
    const html = await (await fetch(`${base}/clusters`)).text();
    expect(html).toContain('No cluster tasks yet');
    expect(html).toContain('run at the same time');
  }, 60_000);

  test('the nav reaches it second, with Inbox last and no Search link', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const nav = html.match(/<nav class="nav">[\s\S]*?<\/nav>/)?.[0] ?? '';
    const hrefs = [...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.slice(0, 3)).toEqual(['/', '/', '/clusters']);
    expect(hrefs[hrefs.length - 1]).toBe('/messages');
    expect(nav).not.toContain('>Search</a>');
    expect(nav).toContain('action="/search"');
  }, 60_000);

  test('only GET is answered', async () => {
    const res = await fetch(`${base}/clusters`, { method: 'POST', body: new FormData() });
    expect(res.status).toBe(405);
  }, 60_000);
});
