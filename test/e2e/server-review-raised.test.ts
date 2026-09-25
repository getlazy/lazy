/**
 * E2E: deciding raised items from the review page.
 *
 * One block, one control, both kinds. This suite was
 * `server-review-followups.test.ts`; every case it made about the follow-ups
 * block is now made about a non-blocking raised item, and the cases that used
 * to be implicit in the two-block split — blocking ordering, the gate tag —
 * are made explicitly.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { findFullTaskId, taskFilePath } from '../helpers/storage';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

describe('review page raised-item decisions', () => {
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

  /** Seed raised items; `blocking` defaults to false — what a follow-up is. */
  function seedRaised(
    taskId: string,
    items: Array<{ content: string; blocking?: boolean }>,
  ): string[] {
    const fullId = findFullTaskId(ctx.root, taskId);
    const ids = items.map(() => randomUUID());
    writeFileSync(
      taskFilePath(ctx.root, taskId, 'raised-items.json'),
      JSON.stringify(
        {
          raised_items: items.map((item, i) => ({
            id: ids[i],
            task_id: fullId,
            content: item.content,
            blocking: item.blocking ?? false,
            status: 'open',
            created_at: Date.now(),
          })),
        },
        null,
        2,
      ),
    );
    return ids;
  }

  test('a non-blocking item offers Decide and is tagged as never gating', async () => {
    const taskId = await createTask(ctx, 'Decide from review', 'Do work');
    const [itemId] = seedRaised(taskId, [{ content: 'The retry path swallows errors' }]);

    const page = await fetch(`${base}/tasks/${taskId}/raised`);
    expect(page.status).toBe(200);
    const html = await page.text();

    expect(html).toContain('The retry path swallows errors');
    expect(html).toContain('FYI');
    // The list is permalinks; Decide lives in the dialog/panel.
    expect(html).toContain(`/raised/${itemId}`);
    const panel = await (await fetch(`${base}/raised/${itemId}`)).text();
    expect(panel).toContain('lz-raised-dialog');
    expect(panel).toContain('name="raised_action');
    // Promote is a card with an editable goal and code, not a bare button.
    expect(panel).toContain('raised_code');
  });

  // INVARIANT: one card list, blocking first — the reviewer reads what stands
  // between them and a merge before what is merely proposed. Two blocks (one
  // per entity) is what the unification replaced.
  test('blocking and non-blocking share one list, blocking first and tagged', async () => {
    const taskId = await createTask(ctx, 'Mixed review', 'Do work');
    const [fyiId, gateId] = seedRaised(taskId, [
      { content: 'An orthogonal proposal for later' },
      { content: 'Should the new flag default on?', blocking: true },
    ]);

    const html = await (await fetch(`${base}/tasks/${taskId}/raised`)).text();
    expect(html).toContain('gates accept');
    expect(html).toContain('FYI');
    expect(html.indexOf(gateId!)).toBeLessThan(html.indexOf(fyiId!));
  });

  test('acknowledging with a note moves the item into the decided list', async () => {
    const taskId = await createTask(ctx, 'Acknowledge from review', 'Do work');
    const [itemId] = seedRaised(taskId, [{ content: 'Docs mention the removed flag' }]);

    const form = new FormData();
    form.set('id', itemId!);
    form.set('raised_action', 'acknowledge');
    form.set('raised_response', 'Tracked in the docs pass');
    const res = await fetch(`${base}/tasks/${taskId}/review/raised`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);

    const html = await (await fetch(`${base}/tasks/${taskId}/raised`)).text();
    expect(html).toContain('Tracked in the docs pass');
    // The decision reads as a badge from the shared vocabulary; the raw stored
    // status (`acknowledged`) is no longer shown to a reader.
    expect(html).toContain('Acknowledged');
  });

  // WHO decided is part of the record, not metadata: a decision gates the
  // merge, so the panel names the decider. The dashboard has no per-user
  // identity, so it is the bare `human` role here — a per-user token adds the
  // person (test/unit/raised-decision-attribution.test.ts).
  test('a decided item names who decided it', async () => {
    const taskId = await createTask(ctx, 'Attributed decision', 'Do work');
    const [itemId] = seedRaised(taskId, [{ content: 'Rename the flag?' }]);

    const form = new FormData();
    form.set('id', itemId!);
    form.set('raised_action', 'dismiss');
    form.set('raised_response', 'Keeping the name');
    expect((await fetch(`${base}/tasks/${taskId}/review/raised`, {
      method: 'POST', body: form, redirect: 'manual',
    })).status).toBe(303);

    const panel = await (await fetch(`${base}/raised/${itemId}`)).text();
    expect(panel).toContain('Decided by human');

    const review = await (await fetch(`${base}/tasks/${taskId}/raised`)).text();
    expect(review).toContain('Decided by human');
  });

  test('promoting from the review page creates a backlog task with the card values', async () => {
    const taskId = await createTask(ctx, 'Promote from review', 'Do work');
    const [itemId] = seedRaised(taskId, [{ content: 'Extract the retry helper' }]);

    const form = new FormData();
    form.set('id', itemId!);
    form.set('raised_action', 'promote_peer');
    form.set('raised_goal', 'Shared retry helper');
    form.set('raised_code', 'review-promoted-task');
    const res = await fetch(`${base}/tasks/${taskId}/review/raised`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    // Post-redirect-get like the other decisions, so a refresh cannot re-POST
    // the promote — the new task's name rides the redirect.
    expect(res.status).toBe(303);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('promoted=review-promoted-task');

    const html = await (await fetch(location)).text();
    expect(html).toContain('review-promoted-task');

    const listed = await ctx.lazy(['list', '--all']);
    expectSuccess(listed);
    expectOutput(listed, 'review-promoted-task');
    expectOutput(listed, 'Shared retry helper');
    expectOutput(listed, 'backlog');
  });

  test('a decision with no action re-renders the page with the reason', async () => {
    const taskId = await createTask(ctx, 'Undecided from review', 'Do work');
    const [itemId] = seedRaised(taskId, [{ content: 'Nothing chosen yet' }]);

    const form = new FormData();
    form.set('id', itemId!);
    const res = await fetch(`${base}/tasks/${taskId}/review/raised`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Choose a decision');
    expect(html).toContain('Nothing chosen yet');
  });

  // Until the comment is delivered the decision is undoable — that is what
  // makes deciding on the review page safe to do early.
  test('an undelivered decision can be undone from the review page', async () => {
    const taskId = await createTask(ctx, 'Undo from review', 'Do work');
    const [itemId] = seedRaised(taskId, [{ content: 'Decided too early' }]);

    const decide = new FormData();
    decide.set('id', itemId!);
    decide.set('raised_action', 'dismiss');
    decide.set('raised_response', 'Not worth it');
    expect((await fetch(`${base}/tasks/${taskId}/review/raised`, {
      method: 'POST', body: decide, redirect: 'manual',
    })).status).toBe(303);

    const undo = new FormData();
    undo.set('id', itemId!);
    const res = await fetch(`${base}/tasks/${taskId}/review/raised/unresolve`, {
      method: 'POST', body: undo, redirect: 'manual',
    });
    expect(res.status).toBe(303);

    const html = await (await fetch(`${base}/tasks/${taskId}/raised`)).text();
    expect(html).toContain(`/raised/${itemId}`);
    // Back to open: Decide is on the item panel, not inlined in the list.
    const panel = await (await fetch(`${base}/raised/${itemId}`)).text();
    expect(panel).toContain('name="raised_action');
    expect(panel).toContain('Decided too early');
    // The decision is gone, so who UNDID it is the attribution left to keep.
    expect(panel).toContain('Reopened by human');
  });
});
