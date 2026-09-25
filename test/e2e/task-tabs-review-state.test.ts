/**
 * Slice 3: Current review is the one place a turn ends. Landing no longer
 * renders Reject; Sync is on both; accept/unblock/submit/reject are exercised
 * from this tab.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess, extractTaskId } from '../helpers/assertions';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { setTaskStatus, taskFilePath, readTaskJson } from '../helpers/storage';

describe('Current review tab', () => {
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

  test('empty Current review is usable and Landing no longer renders Reject', async () => {
    const id = await blockedTask('Empty review is enough to accept');
    const landing = await (await fetch(`${base}/tasks/${id}`)).text();
    expect(landing).toContain('Go to Current review');
    expect(landing).toContain('>Sync<');
    expect(landing).toContain('data-lz-action-open="submit"');
    expect(landing).toContain('Reparent');
    expect(landing).not.toContain('>Reject');
    const goalAt = landing.indexOf('task-goal');
    const actionsAt = landing.indexOf('action-links');
    expect(goalAt).toBeGreaterThan(-1);
    expect(actionsAt).toBeGreaterThan(goalAt);

    const review = await (await fetch(`${base}/tasks/${id}/review`)).text();
    expect(review).not.toContain('Go to Current review');
    expect(review).toContain('lz-current-review');
    expect(review).toContain('Before you can accept');
    expect(review).toContain('0 comments queued');
    expect(review).toContain('Comment on a line in Changes');
    expect(review).toContain('data-lz-action-open="ask"');
    expect(review).toContain('data-rv-askable=');
    expect(review).toContain('Unblock');
    expect(review).toContain('Accept');
    expect(review).toContain('Submit');
    expect(review).toContain('data-lz-action-open="submit"');
    expect(review).toContain('Reject');
    expect(review).toContain('>Sync<');
    // One action card: Unblock / Ask / Accept / Submit as dialog buttons, plus
    // Reject / Sync beside them. Count the rendered elements, not the script.
    expect(review.match(/class="lz-review-actions"/g)?.length).toBe(1);
    expect(review.match(/class="rv-actions"/g)?.length).toBe(1);
    expect(review).toContain('data-lz-action-open="unblock"');
    expect(review).not.toContain('rv-tablist');
  }, 90_000);

  test('accept refuses with an open blocking item that the checklist names', async () => {
    const id = await blockedTask('Checklist names the gate');
    const raisedId = randomUUID();
    writeFileSync(
      taskFilePath(ctx.root, id, 'raised-items.json'),
      JSON.stringify({
        raised_items: [
          {
            id: raisedId,
            task_id: id,
            content: 'Keep the legacy flag?',
            title: 'Keep the legacy flag?',
            blocking: true,
            created_at: Date.now(),
            status: 'open',
          },
        ],
      }),
    );

    const review = await (await fetch(`${base}/tasks/${id}/review`)).text();
    expect(review).toContain('Keep the legacy flag?');
    expect(review).toContain(`/raised/${raisedId}`);

    const form = new FormData();
    form.set('reason', 'looks good');
    const res = await fetch(`${base}/tasks/${id}/review/accept`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Accept failed');
    expect(body).toContain('open raised item');
    expect(body).toContain('Keep the legacy flag?');
  }, 90_000);

  test('unblock from this tab delivers a queued comment', async () => {
    const id = await blockedTask('Unblock carries the queue');
    const post = await fetch(`${base}/tasks/${id}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: 'src/foo.ts',
        line: 3,
        side: 'new',
        content: 'QUEUE_PROBE: rename this',
        intent: 'comment',
      }),
    });
    expect(post.status).toBe(201);

    const before = await (await fetch(`${base}/tasks/${id}/review`)).text();
    expect(before).toContain('1 comment queued');
    expect(before).toContain('QUEUE_PROBE: rename this');

    const form = new FormData();
    form.set('message', 'OVERALL: go ahead');
    const res = await fetch(`${base}/tasks/${id}/review/unblock`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);

    let prompt = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !prompt.includes('OVERALL: go ahead')) {
      const show = await ctx.lazy(['show', id.slice(0, 8), '--json']);
      const turns = (JSON.parse(show.stdout).turns ?? []) as Array<{ role: string; prompt: string | null }>;
      const hit = turns.filter((t) => t.role === 'human' && (t.prompt ?? '').includes('OVERALL: go ahead'));
      if (hit.length === 1) prompt = hit[0].prompt ?? '';
      else await new Promise((r) => setTimeout(r, 400));
    }
    expect(prompt).toContain('QUEUE_PROBE: rename this');
    expect(prompt).toContain('OVERALL: go ahead');
  }, 90_000);

  test('sync reports upstream without a network fetch', async () => {
    const id = await blockedTask('Sync is local');
    const landing = await (await fetch(`${base}/tasks/${id}`)).text();
    expect(landing).toMatch(/Up to date with|Behind |Unknown:/);

    const res = await fetch(`${base}/tasks/${id}/actions/sync`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('flash=');
  }, 90_000);

  test('submit confirms per tier and reject works from Current review', async () => {
    const id = await blockedTask('Submit and reject from the tab');

    const local = await fetch(`${base}/tasks/${id}/actions/submit`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(local.status).toBe(409);
    expect(await local.text()).toMatch(/remote driver|Submit is not available/i);

    const configPath = join(ctx.root, 'lazy.toml');
    const before = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, before.replace('driver = "local"', 'driver = "github"'));
    expect(readFileSync(configPath, 'utf-8')).not.toBe(before);

    const form = new URLSearchParams();
    const strong = await fetch(`${base}/tasks/${id}/actions/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    // Unknown/unprotected → must type the branch; missing confirm is 400.
    // A preflight refusal (no commits / cannot ask the forge) is 409.
    expect([400, 409]).toContain(strong.status);

    const reject = new URLSearchParams();
    reject.set('reason', 'Not the direction');
    const rejected = await fetch(`${base}/tasks/${id}/actions/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: reject.toString(),
      redirect: 'manual',
    });
    expect(rejected.status).toBe(303);

    const after = await (await fetch(`${base}/tasks/${id}`)).text();
    expect(after.toLowerCase()).toMatch(/reject|abandoned|closed/);
  }, 90_000);

  test('clone from Landing creates a backlog variant with the override goal', async () => {
    const id = await blockedTask('Clone source');
    const form = new URLSearchParams();
    form.set('goal', 'CLONE_OVERRIDE_GOAL');
    const res = await fetch(`${base}/tasks/${id}/actions/clone`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toMatch(/\/tasks\/[0-9a-f-]+/);
    const page = await (await fetch(loc.split('?')[0])).text();
    expect(page).toContain('CLONE_OVERRIDE_GOAL');
    expect(page).toContain('backlog');
  }, 90_000);

  test('clone from Landing can pin to the same base and switch model', async () => {
    const id = await blockedTask('Same-base source');
    const landing = await (await fetch(`${base}/tasks/${id}`)).text();
    expect(landing).toContain('name="same_base"');
    expect(landing).toContain('name="agent"');

    const form = new URLSearchParams();
    form.set('same_base', '1');
    form.set('model', 'claude-sonnet-5');
    const res = await fetch(`${base}/tasks/${id}/actions/clone`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    const cloneId = (res.headers.get('location') ?? '').match(/\/tasks\/([^/?]+)/)?.[1];
    expect(cloneId).toBeTruthy();
    const clone = readTaskJson(ctx.root, decodeURIComponent(cloneId!).substring(0, 8));
    expect(clone.model).toBe('claude-sonnet-5');
    expect(clone.metadata?.pinned_base_sha).toMatch(/^[0-9a-f]{40}$/);
  }, 90_000);

  test('redo from Landing closes the old task and lands on a backlog replacement', async () => {
    const id = await blockedTask('Redo source');
    const form = new URLSearchParams();
    form.set('reason', 'Try a different approach');
    const res = await fetch(`${base}/tasks/${id}/actions/redo`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toMatch(/\/tasks\/[0-9a-f-]+/);
    const newId = loc.match(/\/tasks\/([0-9a-f-]+)/)?.[1];
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(id);

    const oldPage = await (await fetch(`${base}/tasks/${id}`)).text();
    expect(oldPage.toLowerCase()).toMatch(/abandon|closed/);

    const newPage = await (await fetch(`${base}/tasks/${newId}`)).text();
    expect(newPage).toContain('Redo source');
    expect(newPage).toContain('backlog');
  }, 90_000);

  test('reparent from Landing moves a child onto main and launches a sync', async () => {
    const parentId = await blockedTask('Reparent parent');
    const created = await ctx.lazy([
      'create', '--goal', 'Reparent child', '--prompt', 'Child work', '--parent', parentId.slice(0, 8),
    ]);
    expectSuccess(created);
    const childShort = extractTaskId(created.stdout);
    await ctx.lazyMocked(['start', childShort, '--yes'], MOCK_CLAUDE_SUCCESS);
    const deadline = Date.now() + 30_000;
    let childId = '';
    while (Date.now() < deadline) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = (queue as { id: string }[]).find((e) => e.id.startsWith(childShort));
      if (hit) {
        childId = hit.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    expect(childId).toBeTruthy();

    const form = new URLSearchParams();
    form.set('parent', 'main');
    const res = await fetch(`${base}/tasks/${childId}/actions/reparent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('flash=');

    const show = await ctx.lazy(['show', childShort, '--json']);
    const data = JSON.parse(show.stdout) as { parent_task_id: string | null };
    expect(data.parent_task_id).toBeNull();
  }, 90_000);

  test('restructure verbs are disabled on a working task', async () => {
    const id = await blockedTask('Working disables restructure');
    setTaskStatus(ctx.root, id, 'working');
    const landing = await (await fetch(`${base}/tasks/${id}`)).text();
    expect(landing).toContain('title="Task is working. Wait for it to finish or interrupt it first."');
    expect(landing).not.toContain(`action="/tasks/${id}/actions/reparent"`);
    expect(landing).not.toContain(`action="/tasks/${id}/actions/redo"`);
    expect(landing).not.toContain(`action="/tasks/${id}/actions/clone"`);
  }, 90_000);
});
