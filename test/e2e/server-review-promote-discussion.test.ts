/**
 * E2E: promoting a review discussion into a new task.
 *
 * A discussion is where the work a task did NOT do usually gets named — the
 * reviewer asks why something is the way it is, the answer explains, and the
 * next task is sitting there in plain text with nobody to write it down. These
 * cases pin the three things that make writing it down safe: the seeded prompt
 * carries the exchange, the created task is BACKLOG (the web UI never
 * auto-starts work), and the parentage is the reviewer's choice.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, startAndWait } from '../helpers/fixtures';
import { findFullTaskId, taskFilePath } from '../helpers/storage';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

const QUESTION = 'Why is the retry path unbounded? It looks like it can spin forever.';
const ANSWER = 'It inherits the caller timeout; bounding it needs a budget on the queue, which was out of scope.';

describe('promote a review discussion', () => {
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

  /** Seed one answered task-level discussion and return its thread id. */
  function seedDiscussion(taskId: string): string {
    const fullId = findFullTaskId(ctx.root, taskId);
    const threadId = randomUUID();
    const common = { task_id: fullId, thread_id: threadId, file: '(task)', line: 0, side: 'new' };
    writeFileSync(
      taskFilePath(ctx.root, taskId, 'review-comments.json'),
      JSON.stringify({
        review_comments: [
          { ...common, id: threadId, role: 'human', intent: 'ask', ask_state: 'answered', content: QUESTION, created_at: Date.now() - 1000 },
          { ...common, id: randomUUID(), role: 'agent', content: ANSWER, created_at: Date.now() },
        ],
      }, null, 2),
    );
    return threadId;
  }

  test('the discussion offers Promote, seeded with the whole exchange', async () => {
    const taskId = await createTask(ctx, 'Bound the retry path', 'Do work');
    await startAndWait(ctx, taskId);
    seedDiscussion(taskId);

    const page = await fetch(`${base}/tasks/${taskId}/review`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Promote to a task');
    // The seeded prompt is in the form, editable, and carries BOTH halves —
    // the reviewer's question and the agent's own explanation.
    expect(html).toContain('Why is the retry path unbounded?');
    expect(html).toContain('budget on the queue');
    expect(html).toContain('Promoted from a review discussion');
  });

  test('promoting creates an UNSTARTED subtask with the chosen values', async () => {
    const taskId = await createTask(ctx, 'Bound the retry path', 'Do work');
    await startAndWait(ctx, taskId);
    const threadId = seedDiscussion(taskId);

    const form = new FormData();
    form.set('goal', 'Bound the retry path with a queue budget');
    form.set('code', 'promoted-from-discussion');
    form.set('relation', 'subtask');
    form.set('prompt', `${QUESTION}\n\n${ANSWER}\n\nPromoted from a review discussion.`);
    const res = await fetch(`${base}/tasks/${taskId}/review/thread/${threadId}/promote`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    // Post-redirect-get, like every other promote: a refresh must not re-POST.
    expect(res.status).toBe(303);
    expect(res.headers.get('location') ?? '').toContain('promoted=promoted-from-discussion');

    const listed = await ctx.lazy(['list', '--all']);
    expectSuccess(listed);
    expectOutput(listed, 'promoted-from-discussion');

    const shown = JSON.parse((await ctx.lazy(['show', 'promoted-from-discussion', '--json'])).stdout);
    expect(shown.goal).toBe('Bound the retry path with a queue budget');
    // INVARIANT (CLAUDE.md): the web UI never auto-starts work.
    expect(shown.status).toBe('backlog');
    expect(shown.parent_task_id).toBe(findFullTaskId(ctx.root, taskId));
    expect(String(shown.prompt)).toContain('unbounded');
  });

  test('a sibling promotion does not land under the task it came from', async () => {
    const taskId = await createTask(ctx, 'Bound the retry path', 'Do work');
    await startAndWait(ctx, taskId);
    const threadId = seedDiscussion(taskId);

    const form = new FormData();
    form.set('goal', 'Sibling of the retry task');
    form.set('code', 'promoted-sibling');
    form.set('relation', 'peer');
    form.set('prompt', 'Body.');
    const res = await fetch(`${base}/tasks/${taskId}/review/thread/${threadId}/promote`, {
      method: 'POST', body: form, redirect: 'manual',
    });
    expect(res.status).toBe(303);

    const shown = JSON.parse((await ctx.lazy(['show', 'promoted-sibling', '--json'])).stdout);
    expect(shown.parent_task_id ?? null).not.toBe(findFullTaskId(ctx.root, taskId));
  });

  // One promotion per discussion, recorded on the thread's root comment: two
  // reviewers pressing the same button must not quietly make two tasks.
  test('a second promotion is refused, naming the task the first one made', async () => {
    const taskId = await createTask(ctx, 'Bound the retry path', 'Do work');
    await startAndWait(ctx, taskId);
    const threadId = seedDiscussion(taskId);

    const send = async () => {
      const form = new FormData();
      form.set('goal', 'Bound the retry path with a queue budget');
      form.set('prompt', 'Body.');
      form.set('relation', 'subtask');
      return fetch(`${base}/tasks/${taskId}/review/thread/${threadId}/promote`, {
        method: 'POST', body: form, redirect: 'manual',
      });
    };

    expect((await send()).status).toBe(303);
    const second = await send();
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('already promoted');

    // The page now links to the task instead of offering the form again.
    const html = await (await fetch(`${base}/tasks/${taskId}/review`)).text();
    expect(html).toContain('Promoted to');
  });
});
