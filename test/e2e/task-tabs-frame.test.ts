/**
 * Slice 1 of the tabbed task page: ten real routes, JS-off pages, 308s from
 * the old /review/:id tree, status-driven Landing, and server-side ticks.
 *
 * A real navigation closes every web shell; in-place switching is a later
 * assertion (the island is present). These cases fetch as a browser with
 * scripting off.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { setTaskMetadata, setTaskStatus } from '../helpers/storage';

const TABS = [
  { slug: '', label: 'Summary' },
  { slug: 'changes', label: 'Changes' },
  { slug: 'verify', label: 'Verify' },
  { slug: 'turns', label: 'Turns' },
  { slug: 'commits', label: 'Commits' },
  { slug: 'subtasks', label: 'Subtasks' },
  { slug: 'raised', label: 'Raised' },
  { slug: 'stats', label: 'Stats' },
  { slug: 'services', label: 'Services' },
  { slug: 'review', label: 'Current review' },
] as const;

describe('tabbed task page frame', () => {
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

  async function blockedTask(goal: string): Promise<string> {
    const shortId = await createTask(ctx, goal, 'Do work');
    await ctx.lazyMocked(['start', shortId, '--yes'], MOCK_CLAUDE_SUCCESS);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = (queue as { id: string }[]).find((e) => e.id.startsWith(shortId));
      if (hit) return hit.id;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`task ${shortId} never reached the review queue`);
  }

  function tabUrl(taskId: string, slug: string): string {
    return slug ? `${base}/tasks/${taskId}/${slug}` : `${base}/tasks/${taskId}`;
  }

  test('every tab is a real server-rendered page with scripting off', async () => {
    const id = await blockedTask('Tab frame JS-off');
    for (const tab of TABS) {
      const res = await fetch(tabUrl(id, tab.slug));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('data-lz-tab-strip');
      expect(html).toContain(`>${tab.label}`);
      expect(html).toContain('aria-current="page"');
      // Real links, not buttons — JS-off is a navigation.
      expect(html).toContain(`href="/tasks/${id}/changes"`);
      expect(html).toContain(`href="/tasks/${id}/review"`);
    }
    // Shell is a real page even when the strip hides it (no-container runner).
    const shell = await fetch(`${base}/tasks/${id}/shell`);
    expect(shell.status).toBe(200);
    const shellHtml = await shell.text();
    expect(shellHtml).toContain('data-lz-tab-strip');
    expect(shellHtml).toContain('data-lz-tab-body');
    // /tasks/:id/commits is the Commits tab (not a redirect).
    const commits = await fetch(`${base}/tasks/${id}/commits`);
    expect(commits.status).toBe(200);
    const commitsHtml = await commits.text();
    expect(commitsHtml).toContain('data-lz-tab="commits"');
    expect(commitsHtml).toContain('aria-current="page"');
    expect(commitsHtml).toContain('>Commits');
  }, 90_000);

  test('Stats derives a real task\'s time and says what is not recorded', async () => {
    const id = await blockedTask('Stats tab over a real turn');
    const html = await (await fetch(`${base}/tasks/${id}/stats`)).text();

    // The turn the mock agent ran is counted, and the time split comes from
    // the status history the daemon actually wrote.
    expect(html).toContain('Where the time went');
    expect(html).toContain('Agent running');
    expect(html).toContain('Awaiting a human');
    expect(html).toContain('Status changes');

    // A test task has no proxy traffic, so the tools section must say that
    // rather than render an empty box or a fabricated one.
    // Pre-existing staleness, unrelated to the tab strip: the Tools section
    // now says a test task has no tool statistics at all (it never ran through
    // the proxy), which is a different sentence from the zero-requests one
    // this assertion was written against.
    expect(html).toContain('No tool statistics were recorded for this task');
    // And no cost, because there is no price table to compute one from.
    expect(html).toContain('no price table');
  }, 90_000);

  test('old /review/:id links and form POSTs still work through 308s', async () => {
    const id = await blockedTask('Review 308s');
    const page = await fetch(`${base}/review/${id}`, { redirect: 'manual' });
    expect(page.status).toBe(308);
    expect(page.headers.get('location')).toContain(`/tasks/${id}/review`);

    const draft = await fetch(`${base}/review/${id}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: { feedback: 'kept through the 308' } }),
      redirect: 'manual',
    });
    expect(draft.status).toBe(308);
    expect(draft.headers.get('location')).toContain(`/tasks/${id}/review/draft`);

    // POST the body at the Location the 308 named — a browser would follow
    // automatically; this harness's signed-in fetch does not replay the
    // cookie onto the redirected request.
    const dest = draft.headers.get('location');
    expect(dest).toBeTruthy();
    const saved = await fetch(dest!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: { feedback: 'kept through the 308' } }),
    });
    expect(saved.status).toBe(200);
    const review = await (await fetch(`${base}/tasks/${id}/review`)).text();
    expect(review).toContain('kept through the 308');
  }, 90_000);

  test('Landing body differs by status', async () => {
    const backlogId = await createTask(ctx, 'Landing backlog body', 'Write the prompt we show');
    const backlog = await (await fetch(`${base}/tasks/${backlogId}`)).text();
    expect(backlog).toContain('Landing backlog body');
    expect(backlog).toContain('Prompt');
    expect(backlog).not.toContain('lz-progress');
    expect(backlog).not.toContain('lz-outcome');

    const workingId = await createTask(ctx, 'Landing working body', 'Do work');
    setTaskStatus(ctx.root, workingId, 'working');
    const working = await (await fetch(`${base}/tasks/${workingId}`)).text();
    expect(working).toContain('lz-progress');
    expect(working).toContain('Working');

    const blockedId = await blockedTask('Landing blocked body');
    const blocked = await (await fetch(`${base}/tasks/${blockedId}`)).text();
    expect(blocked).toContain('Since you last looked');
    expect(blocked).toContain('Go to Current review');

    const doneId = await createTask(ctx, 'Landing terminal body', 'Done');
    setTaskStatus(ctx.root, doneId, 'complete');
    const done = await (await fetch(`${base}/tasks/${doneId}`)).text();
    expect(done).toContain('lz-outcome');
    expect(done).toContain('Accepted');
  }, 90_000);

  test('viewed ticks persist across a reload in a fresh browser context', async () => {
    const id = await blockedTask('Server-side ticks');
    const landing = await (await fetch(`${base}/tasks/${id}`)).text();
    const hashMatch = landing.match(/data-viewed-key="([^"]+)"[^>]*data-content-hash="([^"]+)"/);
    expect(hashMatch).toBeTruthy();
    const key = hashMatch![1];
    const hash = hashMatch![2];

    const saved = await fetch(`${base}/tasks/${id}/review/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: { viewedFiles: { [key]: hash } } }),
    });
    expect(saved.status).toBe(200);

    // A second signed-in fetch is a new document with empty localStorage —
    // the tick must come from the review draft, not the browser.
    const reload = await (await fetch(`${base}/tasks/${id}`)).text();
    expect(reload).toContain(`"${key}"`);
    expect(reload).toContain(hash);
    expect(reload).not.toContain('lazy:reviewed:');
  }, 90_000);

  test('a stored PR is a header link and a task-list icon', async () => {
    const id = await createTask(ctx, 'Has a pull request', 'Do work');
    setTaskMetadata(ctx.root, id, 'github_remote_ref_url', 'https://github.com/acme/repo/pull/412');
    setTaskMetadata(ctx.root, id, 'github_remote_ref_id', '412');

    const landing = await (await fetch(`${base}/tasks/${id}`)).text();
    expect(landing).toContain('https://github.com/acme/repo/pull/412');
    expect(landing).toContain('PR #412');

    const list = await (await fetch(`${base}/tasks`)).text();
    expect(list).toContain('lz-forge-icon');
    expect(list).toContain('https://github.com/acme/repo/pull/412');

    const bare = await createTask(ctx, 'No pull request', 'Do work');
    const bareList = await (await fetch(`${base}/tasks`)).text();
    expect(bareList).toContain(`/tasks/`);
    // The no-PR row still has the empty forge cell.
    expect(bareList).toContain('lz-forge-col');
    const show = await ctx.lazy(['show', id]);
    expect(show.stdout).toContain('PR:');
    expect(show.stdout).toContain('https://github.com/acme/repo/pull/412');
    void bare;
  }, 60_000);

  test('in-place switching island is on the page', async () => {
    const id = await createTask(ctx, 'Tab island', 'Do work');
    const html = await (await fetch(`${base}/tasks/${id}`)).text();
    expect(html).toContain('lzSwitchTaskTab');
    expect(html).toContain("searchParams.set('fragment'");
    expect(html).toContain('data-lz-tab-index');
    expect(html).toContain('<h3>Tabs</h3>');
    const fragment = await fetch(`${base}/tasks/${id}/changes?fragment=1`);
    expect(fragment.status).toBe(200);
    const body = await fragment.text();
    expect(body).toContain('data-lz-tab-strip');
    expect(body).toContain('data-lz-tab-body');
    expect(body).not.toContain('<!DOCTYPE html>');
  }, 60_000);

  test('header is one button row: Summary, Watch, no prev/next, no builder explainer', async () => {
    const id = await blockedTask('Header polish');
    const html = await (await fetch(`${base}/tasks/${id}`)).text();

    expect(html).toContain('>Summary');
    expect(html).not.toContain('>Landing');
    expect(html).toContain('title="Summary (1)"');

    expect(html).toContain('data-rv-nav-help');
    expect(html).not.toContain('data-rv-nav-prev');
    expect(html).not.toContain('data-rv-nav-next');

    // Watch sits in the header action row, above the tab strip — not under it.
    const watchAt = html.indexOf('data-lz-watch-open');
    const stripAt = html.indexOf('data-lz-tab-strip');
    expect(watchAt).toBeGreaterThan(-1);
    expect(stripAt).toBeGreaterThan(watchAt);

    // Agent Review remains; the builder-review entry was removed (reviews-as-raises).
    expect(html).not.toContain('Review with builder');
    expect(html).not.toContain('On-demand builder review');
    expect(html).toContain('>Edit task</a>');
    expect(html).toContain('data-lz-tab="reviews"');

    // Navigation progress: present on the page, driven by the tab island.
    expect(html).toContain('data-lz-nav-progress');
    expect(html).toContain('lzNavProgress');
    expect(html).toContain('lz-tab-pending');
  }, 90_000);
});
