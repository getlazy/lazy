/**
 * E2E for the task page's Comments and Journal tabs.
 *
 * Both records existed in storage and reached agents through the prompt, but
 * the web task page showed neither. These tests drive the real daemon: a
 * comment and a journal entry are written with the CLI, then read back off the
 * two tabs, and one more comment is posted from the page itself.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { readTaskStatus, taskDirFor } from '../helpers/storage';
import { chmod } from 'fs/promises';

describe('web task page: Comments and Journal tabs', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true, daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1' } });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function blockedTask(goal: string): Promise<string> {
    return blockedTaskFrom(await createTask(ctx, goal, 'Do work'));
  }

  async function blockedTaskFrom(taskId: string): Promise<string> {
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) return hit.id as string;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`task ${taskId} never reached the review queue`);
  }

  test('both tabs are in the strip and render their records', async () => {
    const id = await blockedTask('Notes tabs');
    await ctx.lazy(['comment', id, '-m', '## From the CLI\n\nA queued note.']);
    await ctx.lazy(['journal', id, '-m', '## Rationale\n\nChose K=3 because.']);

    const landing = await (await fetch(`${base}/tasks/${id}`)).text();
    expect(landing).toContain('data-lz-tab="comments"');
    expect(landing).toContain('data-lz-tab="journal"');

    const comments = await (await fetch(`${base}/tasks/${id}/comments`)).text();
    expect(comments).toContain('Comments (1)');
    // Markdown, not an escaped single line.
    expect(comments).toContain('From the CLI');
    expect(comments).toContain('<h2');
    // The agent's turn already ran, so a comment written after it is queued.
    expect(comments).toContain('Queued for the next turn (1)');

    const journal = await (await fetch(`${base}/tasks/${id}/journal`)).text();
    expect(journal).toContain('Journal (1)');
    expect(journal).toContain('Chose K=3 because.');
  });

  function postEdit(id: string, commentId: string, content: string) {
    return fetch(`${base}/tasks/${id}/comments/${commentId}/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ content }).toString(),
      redirect: 'manual',
    });
  }

  // INVARIANT: a comment the agent has not been shown can be edited from the
  // page; the edit form is offered on queued comments only.
  test('editing a queued comment from the page replaces its text', async () => {
    const id = await blockedTask('Edit a queued comment');
    const added = await ctx.lazy(['comment', id, '-m', 'Typo in thsi note']);
    const commentId = added.stdout.match(/Comment ID: (\S+)/)![1];
    const full = (await (await fetch(`${base}/tasks/${id}/comments`)).text()).match(new RegExp(`comments/(${commentId}[0-9a-f-]*)/edit`))![1];

    const res = await postEdit(id, full, 'Typo fixed in this note');
    expect(res.status).toBe(303);
    const html = await (await fetch(`${base}/tasks/${id}/comments`)).text();
    expect(html).toContain('Typo fixed in this note');
    expect(html).not.toContain('Typo in thsi note');
  });

  // INVARIANT: a delivered comment cannot be edited; the refusal says why and
  // hands the submitted text back (never lose human feedback).
  test('editing a delivered comment is refused with the reason and the text kept', async () => {
    const taskId = await createTask(ctx, 'Edit a seen comment', 'Do work');
    const added = await ctx.lazy(['comment', taskId, '-m', 'Guidance the agent read']);
    const commentId = added.stdout.match(/Comment ID: (\S+)/)![1];
    // The first prompt carries queued comments.
    const id = await blockedTaskFrom(taskId);

    const res = await postEdit(id, commentId, 'Rewritten guidance');
    expect(res.status).toBe(409);
    const page = await res.text();
    expect(page).toContain('already been delivered to the agent');
    expect(page).toContain('Rewritten guidance');
    const html = await (await fetch(`${base}/tasks/${id}/comments`)).text();
    expect(html).toContain('Guidance the agent read');
    expect(html).not.toContain(`/comments/${commentId}`);
  });

  // INVARIANT (CLAUDE.md, "A lazy comment never starts a turn"): posting from
  // the web is exactly as inert as `lazy comment` — it persists and returns.
  test('posting a comment from the page saves it and does not start a turn', async () => {
    const id = await blockedTask('Post a comment');
    const before = readTaskStatus(ctx.root, id);
    expect(before).toBe('blocked');

    const body = new URLSearchParams({ content: 'Typed into the page.' });
    const res = await fetch(`${base}/tasks/${id}/comments/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain(`/comments`);

    const html = await (await fetch(`${base}/tasks/${id}/comments`)).text();
    expect(html).toContain('Typed into the page.');
    expect(html).toContain('Comments (1)');

    // Give a stray auto-launch a chance to show itself before asserting.
    await new Promise((r) => setTimeout(r, 2000));
    expect(readTaskStatus(ctx.root, id)).toBe('blocked');
  });

  // INVARIANT (CLAUDE.md, "Never Lose Human Feedback"): a write that FAILS must
  // hand the text back, not swallow it. The browser has already discarded the
  // textarea by the time the response renders, so if this page does not carry
  // the comment the human retyped it from memory or lost it.
  //
  // The failure is induced the way it happens in the wild — the store cannot be
  // written — by making the task's storage directory read-only for the length
  // of the write. Reads keep working, so the refusal page still renders.
  test('a comment that cannot be saved comes back verbatim, and is not silently dropped', async () => {
    const id = await blockedTask('Failed write');
    const dir = taskDirFor(ctx.root, id);
    const typed = '## Superseded\n\nBy task `fix-retry` — keep this text!';

    let res: Response;
    await chmod(dir, 0o500);
    try {
      res = await fetch(`${base}/tasks/${id}/comments/add`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ content: typed }).toString(),
        redirect: 'manual',
      });
    } finally {
      // Before any assertion: a read-only dir left behind breaks cleanup.
      await chmod(dir, 0o700);
    }

    expect(res.status).toBe(500);
    const html = await res.text();
    // The whole point: the text is on the page, verbatim, to be copied out.
    expect(html).toContain('## Superseded');
    expect(html).toContain('keep this text!');
    expect(html).toContain('lazy comment');

    // And it really was not saved — the refusal is honest about that.
    const tab = await (await fetch(`${base}/tasks/${id}/comments`)).text();
    expect(tab).toContain('Comments (0)');
  });

  test('an empty comment is refused, and the tab explains itself when bare', async () => {
    const id = await blockedTask('Empty comment');
    const res = await fetch(`${base}/tasks/${id}/comments/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'content=%20%20',
      redirect: 'manual',
    });
    expect(res.status).toBe(400);

    const html = await (await fetch(`${base}/tasks/${id}/comments`)).text();
    expect(html).toContain('Comments (0)');
    expect(html).toContain('never starts a turn');

    const journal = await (await fetch(`${base}/tasks/${id}/journal`)).text();
    expect(journal).toContain('Journal (0)');
    expect(journal).toContain('out-of-prompt record');
  });
});
