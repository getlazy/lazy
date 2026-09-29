/**
 * The Accept dialog's "merge without delivering the queued comments" box, in a
 * real browser.
 *
 * Accept refuses while human feedback is undelivered (src/task/queued-feedback.ts);
 * the box is the web twin of `--allow-queued-comments`. The engineer hit an
 * Accept dialog that offered no box while the daemon refused — the page had
 * been rendered before the comment was queued, and the box was baked into the
 * dialog's template at render time. Only a browser can show that: the dialog
 * is cloned from a <template> on click and the live poll is what must keep it
 * current.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { seedFinal } from '../helpers/final';
import { mintDashboardLoginUrl } from '../helpers/dashboard-session';
import { findFullTaskId, readTaskStatus } from '../helpers/storage';
import { browserSuiteSkipped, launchBrowser, type Browser } from '../helpers/cdp-browser';

/** Same fixture as accept-queued-comments.test.ts: a parked task with a commit to merge. */
async function createStartedTaskWithCommit(ctx: TestContext, goal: string): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Some work');
  expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  }));
  const waited = await ctx.lazy(['wait', taskId]);
  if (waited.exitCode !== 0) throw new Error(`wait failed for ${taskId}: ${waited.stderr}`);
  const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');
  expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
  expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature').exitCode).toBe(0);
  await seedFinal(ctx, taskId);
  return taskId;
}

/** Open the Accept dialog and report what its override box looks like. */
const OPEN_ACCEPT = `(() => {
  const btn = document.querySelector('[data-lz-action-open="accept"]');
  if (!btn || btn.hidden) return { opened: false };
  btn.click();
  const dialog = document.getElementById('lz-action-dialog');
  const box = dialog && dialog.querySelector('input[name="allow_queued_comments"]');
  const label = box && box.closest('label');
  const wrap = box && box.closest('[data-rv-queued-feedback]');
  const shown = !!box && !(wrap && wrap.hidden) && !!(label && label.offsetParent !== null);
  return { opened: !!(dialog && dialog.open), box: !!box, shown, text: label ? label.textContent.replace(/\\s+/g, ' ').trim() : '' };
})()`;

/** Tick the box in the open dialog and submit its Accept form. */
const TICK_AND_ACCEPT = `(() => {
  const dialog = document.getElementById('lz-action-dialog');
  const box = dialog.querySelector('input[name="allow_queued_comments"]');
  box.checked = true;
  dialog.querySelector('form.rv-accept-form').requestSubmit();
  return true;
})()`;

async function waitForStatus(ctx: TestContext, taskId: string, want: string, ms = 30_000): Promise<string> {
  const until = Date.now() + ms;
  let status = readTaskStatus(ctx.root, taskId);
  while (status !== want && Date.now() < until) {
    await Bun.sleep(250);
    status = readTaskStatus(ctx.root, taskId);
  }
  return status;
}

describe.skipIf(browserSuiteSkipped('accept-dialog-queued-box'))('Accept dialog offers the queued-comments override', () => {
  let ctx: TestContext;
  let browser: Browser;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    browser = await launchBrowser([]);
  });

  afterEach(async () => {
    await browser.close();
    await ctx.cleanup();
  });

  // INVARIANT: every page that renders Accept offers the "merge without
  // delivering" box whenever accept would refuse on queued human feedback —
  // otherwise the browser has no way past a refusal the CLI clears with
  // --allow-queued-comments.
  test('every Accept page shows the box for feedback queued before load, and ticking it merges', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Queued before load');
    expectSuccess(await ctx.lazy(['comment', taskId, '-m', 'also handle the empty case']));
    const fullId = findFullTaskId(ctx.root, taskId)!;
    const { base, loginUrl } = await mintDashboardLoginUrl(ctx);
    await browser.goto(loginUrl);

    // The task page's Current review tab, and the standalone review route
    // (which re-renders through the same page — asserted, not assumed).
    for (const path of [`/tasks/${fullId}/review`, `/review/${fullId}`, `/tasks/${taskId}/review`]) {
      await browser.goto(`${base}${path}`);
      const dialog = await browser.evaluate<{ opened: boolean; box: boolean; shown: boolean; text: string }>(OPEN_ACCEPT);
      expect({ path, ...dialog }).toMatchObject({ path, opened: true, box: true, shown: true });
      expect(dialog.text).toContain('1 queued comment');
    }

    await browser.evaluate(TICK_AND_ACCEPT);
    expect(await waitForStatus(ctx, taskId, 'complete')).toBe('complete');
  }, 180_000);

  // INVARIANT: a page opened BEFORE the feedback was queued still offers the
  // box once the live poll sees it. The box used to be baked into the dialog's
  // template at render time, so the page the reviewer already had open offered
  // Accept with no way past the refusal it was about to get.
  test('a page opened before the comment was queued offers the box after the live poll', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Queued after load');
    const fullId = findFullTaskId(ctx.root, taskId)!;
    const { base, loginUrl } = await mintDashboardLoginUrl(ctx);
    await browser.goto(loginUrl);
    await browser.goto(`${base}/tasks/${fullId}/review`);

    expectSuccess(await ctx.lazy(['comment', taskId, '-m', 'queued while the page was open']));

    // The island polls every 10s when nothing is in flight.
    const until = Date.now() + 25_000;
    let dialog = await browser.evaluate<{ opened: boolean; box: boolean; shown: boolean; text: string }>(OPEN_ACCEPT);
    while (!dialog.shown && Date.now() < until) {
      await browser.evaluate(`document.getElementById('lz-action-dialog').close()`);
      await Bun.sleep(500);
      dialog = await browser.evaluate(OPEN_ACCEPT);
    }
    expect(dialog).toMatchObject({ opened: true, box: true, shown: true });
    expect(dialog.text).toContain('1 queued comment');

    await browser.evaluate(TICK_AND_ACCEPT);
    expect(await waitForStatus(ctx, taskId, 'complete')).toBe('complete');
  }, 180_000);

  // INVARIANT: a comment written ON the page (a review comment, queued for the
  // next Unblock) also brings the box without a reload — the page's own write
  // is the reviewer's likeliest path to queued feedback.
  test('a review comment written on the open page brings the box after the live poll', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Queued on page');
    const fullId = findFullTaskId(ctx.root, taskId)!;
    const { base, loginUrl } = await mintDashboardLoginUrl(ctx);
    await browser.goto(loginUrl);
    await browser.goto(`${base}/tasks/${fullId}/review`);

    const status = await browser.evaluate<number>(`fetch('/tasks/${fullId}/review/comment', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'feature.txt', line: 1, side: 'new', content: 'written on the page', intent: 'comment' }),
    }).then((r) => r.status)`);
    expect(status).toBe(201);

    const until = Date.now() + 25_000;
    let dialog = await browser.evaluate<{ opened: boolean; box: boolean; shown: boolean; text: string }>(OPEN_ACCEPT);
    while (!dialog.shown && Date.now() < until) {
      await browser.evaluate(`document.getElementById('lz-action-dialog').close()`);
      await Bun.sleep(500);
      dialog = await browser.evaluate(OPEN_ACCEPT);
    }
    expect(dialog).toMatchObject({ opened: true, box: true, shown: true });
    expect(dialog.text).toContain('1 queued comment');

    await browser.evaluate(TICK_AND_ACCEPT);
    expect(await waitForStatus(ctx, taskId, 'complete')).toBe('complete');
  }, 180_000);

  // INVARIANT: a refused accept inside the dialog offers the override in place
  // (the poll can lag the comment by seconds) — never only the CLI flag.
  test('an accept refused on queued feedback offers "merge without delivering" in the dialog', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Refused in dialog');
    const fullId = findFullTaskId(ctx.root, taskId)!;
    const { base, loginUrl } = await mintDashboardLoginUrl(ctx);
    await browser.goto(loginUrl);
    await browser.goto(`${base}/tasks/${fullId}/review`);
    expectSuccess(await ctx.lazy(['comment', taskId, '-m', 'queued a moment ago']));

    await browser.evaluate(`(() => {
      document.querySelector('[data-lz-action-open="accept"]').click();
      document.querySelector('#lz-action-dialog form.rv-accept-form').requestSubmit();
    })()`);

    const until = Date.now() + 30_000;
    let retry = false;
    while (!retry && Date.now() < until) {
      await Bun.sleep(250);
      retry = await browser.evaluate<boolean>(
        `!!document.querySelector('#lz-action-remedy:not([hidden]) input[name="allow_queued_comments"][value="1"]')`,
      );
    }
    expect(retry).toBe(true);
    expect(readTaskStatus(ctx.root, taskId)).not.toBe('complete');

    await browser.evaluate(`document.querySelector('#lz-action-remedy form').requestSubmit()`);
    expect(await waitForStatus(ctx, taskId, 'complete')).toBe('complete');
  }, 180_000);
});
