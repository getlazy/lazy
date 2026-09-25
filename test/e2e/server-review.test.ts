import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess, extractTaskId } from '../helpers/assertions';
import { findFullTaskId, taskFilePath } from '../helpers/storage';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { worktreePathFor } from '../helpers/storage';
import { runMcpSession } from '../helpers/mcp-session';

/**
 * E2E for the web review surface: blocked-task queue → line-anchored diff →
 * inline comment threads → resolution actions.
 *
 * The daemon serves these routes in-process and performs every mutation itself
 * (src/daemon/review-service.ts) — the web layer is never a second writer.
 */
describe('lazy web review surface', () => {
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

  test('the queue lists blocked tasks and links into the review view', async () => {
    const taskId = await createTask(ctx, 'Review queue test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // The task lands in `blocked` once the mock agent's turn is reconciled.
    let html = '';
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/review`);
      expect(res.status).toBe(200);
      html = await res.text();
      if (html.includes(`/review/`) && html.includes('Review queue')) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(html).toContain('Review queue');

    const json = await (await fetch(`${base}/api/review/queue`)).json();
    expect(Array.isArray(json.queue)).toBe(true);
  });

  // The queue's order used to be whatever the service happened to return —
  // unstated on the page and unchangeable from it. It now defaults to last
  // activity (newest first), says so, and every header re-sorts it.
  test('the queue states its order, shows activity and subtasks, and re-sorts on ?sort=', async () => {
    const pollQueue = async (ready: (queue: any[]) => boolean): Promise<any[]> => {
      const deadline = Date.now() + 20_000;
      let queue: any[] = [];
      while (Date.now() < deadline) {
        const res = await fetch(`${base}/api/review/queue`);
        expect(res.status).toBe(200);
        queue = (await res.json()).queue;
        if (ready(queue)) return queue;
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new Error(`queue never reached the expected state: ${JSON.stringify(queue)}`);
    };
    const entryFor = (queue: any[], shortId: string) => queue.find((e: any) => e.id.startsWith(shortId));

    // A release-hub shape: a blocked task with a child AND a grandchild, so its
    // count proves descendants at every depth are counted, not just children.
    const hubId = await createTask(ctx, 'Release hub', 'Hub work');
    await ctx.lazyMocked(['start', hubId, '--yes'], MOCK_CLAUDE_SUCCESS);
    // Wait for the hub to block before starting anything else: two turns racing
    // would make "which task was active most recently" a coin flip.
    await pollQueue((queue) => !!entryFor(queue, hubId));

    const childResult = await ctx.lazy(['create', '--goal', 'Hub child', '--parent', hubId]);
    expectSuccess(childResult);
    const childId = extractTaskId(childResult.stdout);
    expectSuccess(await ctx.lazy(['create', '--goal', 'Hub grandchild', '--parent', childId]));

    // Started second, so it is the more recently active of the two — the two
    // orderings disagree, which is what makes the re-sort observable.
    const loneId = await createTask(ctx, 'Lone blocked task', 'Do work');
    await ctx.lazyMocked(['start', loneId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const queue = await pollQueue(
      (q) => !!entryFor(q, hubId) && !!entryFor(q, loneId) && entryFor(q, hubId).descendantCount === 2,
    );
    const hub = entryFor(queue, hubId);
    const lone = entryFor(queue, loneId);

    // Both new fields come from the daemon's review service; the backlog child
    // and grandchild are counted without appearing in the queue themselves.
    expect(queue).toHaveLength(2);
    expect(hub.descendantCount).toBe(2);
    expect(lone.descendantCount).toBe(0);
    expect(typeof hub.lastActiveAt).toBe('number');
    expect(lone.lastActiveAt).toBeGreaterThan(hub.lastActiveAt);

    // Default: last activity, newest first — stated on the page. (Badge
    // rendering is asserted in test/unit/review-diff.test.ts, which can hand
    // reviewQueueHtml an entry that actually has comments to deliver.)
    const defaultHtml = await (await fetch(`${base}/review`)).text();
    expect(defaultHtml).toContain('Last activity');
    expect(defaultHtml).toContain('Subtasks');
    expect(defaultHtml).toContain('Sorted by <strong>last activity</strong>, newest first');
    expect(defaultHtml.indexOf(`/tasks/${lone.id}`)).toBeLessThan(defaultHtml.indexOf(`/tasks/${hub.id}`));

    // The "show me releases" view: most subtasks first.
    const bySubtasks = await (await fetch(`${base}/review?sort=-subtasks`)).text();
    expect(bySubtasks).toContain('Sorted by <strong>subtasks</strong>, most first');
    expect(bySubtasks).toContain('<td class="rv-queue-count">2</td>');
    expect(bySubtasks).toContain('<td class="rv-queue-count">-</td>');
    expect(bySubtasks.indexOf(`/tasks/${hub.id}`)).toBeLessThan(bySubtasks.indexOf(`/tasks/${lone.id}`));

    // Ascending is the same field without the leading '-'.
    const oldestFirst = await (await fetch(`${base}/review?sort=last_active`)).text();
    expect(oldestFirst).toContain('Sorted by <strong>last activity</strong>, oldest first');
    expect(oldestFirst.indexOf(`/tasks/${hub.id}`)).toBeLessThan(oldestFirst.indexOf(`/tasks/${lone.id}`));

    // A hand-edited URL naming an unknown field lands on the default order
    // rather than erroring or silently rendering an arrow that lies.
    const bogus = await fetch(`${base}/review?sort=nonsense`);
    expect(bogus.status).toBe(200);
    expect(await bogus.text()).toContain('Sorted by <strong>last activity</strong>, newest first');

    // The JSON a client reads is ordered by the same parser as the page.
    const apiSorted = await (await fetch(`${base}/api/review/queue?sort=-subtasks`)).json();
    expect(apiSorted.queue[0].id).toBe(hub.id);
  });

  // INVARIANT: the review diff must render commentable rows in the LIGHT DOM
  // with (file, side, line) anchors. The commit-detail viewer's Shadow DOM
  // rendering cannot carry per-line comment affordances, which is why this
  // surface has its own renderer.
  test('the review page renders an anchored diff plus the resolution actions', async () => {
    const taskId = await createTask(ctx, 'Review diff test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let html = '';
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/tasks/${taskId}/changes`);
      expect(res.status).toBe(200);
      html = await res.text();
      if (html.includes('data-side=')) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    expect(html).toContain('id="rv-root"');
    expect(html).toContain('data-side=');
    expect(html).toContain('data-line=');
    expect(html).toContain('rv-add-comment');
    // The diff is NOT rendered through the shadow-DOM component here.
    expect(html).not.toContain('<diffs-container>');

    // Resolution actions live on Current review — plain form POSTs, JS off.
    const reviewHtml = await (await fetch(`${base}/tasks/${taskId}/review`)).text();
    expect(reviewHtml).toMatch(/action="\/tasks\/[0-9a-f-]+\/review\/unblock"/);
    expect(reviewHtml).toMatch(/action="\/tasks\/[0-9a-f-]+\/review\/accept"/);
    expect(reviewHtml).toContain('data-lz-action-open="unblock"');
    expect(reviewHtml).toContain('id="lz-action-dialog"');
  });

  // A reviewer who steps away needs one place that answers "what moved while I
  // was gone?" — every item a link into the detail page that already exists.
  test('the review page leads with what happened since the reviewer last looked', async () => {
    const taskId = await createTask(ctx, 'Since-last-looked test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let html = '';
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/tasks/${taskId}`);
      expect(res.status).toBe(200);
      html = await res.text();
      // The card itself renders from the first request (it says "nothing" when
      // nothing happened), so wait for the agent's turn to actually land.
      if (/href="\/tasks\/[0-9a-f-]+\/turns\/\d+"/.test(html)) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    expect(html).toContain('Since you last looked');
    // The agent's turn since the reviewer's start is listed, linked to the turn
    // page rather than reprinted.
    expect(html).toMatch(/href="\/tasks\/[0-9a-f-]+\/turns\/\d+"/);
    // It is a viewable card like everything else on the page, so it can be
    // ticked away and comes back when something new happens.
    expect(html).toContain('id="since-last-looked"');

    // The same card appears on the task page.
    const taskHtml = await (await fetch(`${base}/tasks/${taskId}`)).text();
    expect(taskHtml).toContain('Since you last looked');
  });

  // The agent's lazy_justify_maintain skip reasons must render as a LABELLED
  // card the reviewer can place — not orphan prose — using the shared viewable
  // card so it collapses like everything else. "(structured)" is an internal
  // distinction and never appears in user-facing text.
  test('maintained-group skip reasons render as a labelled viewable card', async () => {
    const taskId = await createTask(ctx, 'Maintain skip card test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // Wait for the task to reach the review queue (blocked + reconciled).
    let fullId = '';
    const blockedBy = Date.now() + 30_000;
    while (Date.now() < blockedBy && !fullId) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) fullId = hit.id;
      else await new Promise((r) => setTimeout(r, 400));
    }
    expect(fullId).not.toBe('');

    // Seed the decision the agent's lazy_justify_maintain call would record.
    writeFileSync(
      taskFilePath(ctx.root, taskId, 'file-decisions.json'),
      JSON.stringify({
        file_decisions: [
          {
            id: 'fd-1',
            task_id: fullId,
            scope: 'maintain',
            target: 'docs',
            decision: 'keep',
            reason: 'no internal docs page went stale',
            created_at: Date.now(),
          },
        ],
      }),
    );

    const page = await (await fetch(`${base}/tasks/${fullId}/changes`)).text();
    expect(page).toContain('Maintained files the agent chose not to update');
    expect(page).toContain('1 group skipped');
    expect(page).toContain('<strong>docs</strong>');
    expect(page).toContain('no internal docs page went stale');
    // Shared viewable-card chrome, same as turns/reports/comments.
    expect(page).toContain('data-viewed-key="card:maintain-skips"');
    expect(page).not.toContain('(structured)');
  });

  // INVARIANT (CLAUDE.md, "never lose human feedback"): the comment is durably
  // persisted BEFORE the ask is dispatched. Whatever the agent does — answer,
  // fail, or time out — the comment exists and is visible on reload.
  test('an inline comment is persisted and readable back through the threads API', async () => {
    const taskId = await createTask(ctx, 'Inline comment test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // Wait until the task page is servable (task exists in storage).
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/tasks/${taskId}/review`);
      if (res.status === 200) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    const post = await fetch(`${base}/tasks/${taskId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: 'src/foo.ts',
        line: 12,
        side: 'new',
        content: 'why this value?',
        anchorSnippet: '+const b = 3;',
      }),
    });
    expect(post.status).toBe(201);
    const posted = await post.json();
    expect(posted.comment.content).toBe('why this value?');
    expect(posted.comment.file).toBe('src/foo.ts');
    expect(posted.comment.line).toBe(12);
    expect(posted.comment.side).toBe('new');
    // thread_id defaults to the comment's own id — it is a new thread root.
    expect(posted.comment.thread_id).toBe(posted.comment.id);

    // Durable: a fresh read returns the same anchored comment.
    const threads = await (await fetch(`${base}/api/review/${taskId}/threads`)).json();
    expect(threads.threads).toHaveLength(1);
    expect(threads.threads[0].messages[0].content).toBe('why this value?');
    expect(threads.threads[0].file).toBe('src/foo.ts');
    expect(threads.threads[0].line).toBe(12);

    // A reply joins the same thread rather than starting a new one.
    const reply = await fetch(`${base}/tasks/${taskId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: 'src/foo.ts',
        line: 12,
        side: 'new',
        content: 'follow-up',
        threadId: posted.comment.thread_id,
      }),
    });
    expect(reply.status).toBe(201);
    const threads2 = await (await fetch(`${base}/api/review/${taskId}/threads`)).json();
    expect(threads2.threads).toHaveLength(1);
    expect(threads2.threads[0].messages.map((m: { content: string }) => m.content)).toContain('follow-up');
  });

  test('a malformed comment is rejected with a 400 and no partial write', async () => {
    const taskId = await createTask(ctx, 'Bad comment test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const res = await fetch(`${base}/tasks/${taskId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: '', line: 1, side: 'new', content: '' }),
    });
    expect(res.status).toBe(400);

    const threads = await (await fetch(`${base}/api/review/${taskId}/threads`)).json();
    expect(threads.threads).toHaveLength(0);
  });

  // INVARIANT: a FRESH (task)-sentinel comment is refused — it marks up no code
  // and is exactly what the Unblock tab's message box already is. The one
  // exception is a REPLY on an existing task-level thread (covered below). The
  // guard lives in review-service so both the RPC adapter and this web route
  // share the same protection.
  test('a comment with the (task) sentinel file is rejected through the web route', async () => {
    const taskId = await createTask(ctx, 'Sentinel comment test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const res = await fetch(`${base}/tasks/${taskId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: '(task)', line: 0, side: 'new', content: 'This should be rejected', intent: 'comment' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/comments must anchor to a diff line/i);

    const threads = await (await fetch(`${base}/api/review/${taskId}/threads`)).json();
    expect(threads.threads).toHaveLength(0);
  });

  // This is the loop the POC exists to prove: a human comments on a diff line,
  // the comment reaches the agent as a READ-ONLY ask, and the answer comes back
  // as a threaded reply anchored to the same line.
  test('a comment on a blocked task round-trips to an agent reply in the same thread', async () => {
    const taskId = await createTask(ctx, 'Ask round trip', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // Wait for the task to reach `blocked` — only then is the agent askable.
    let fullId = '';
    const blockedBy = Date.now() + 30_000;
    while (Date.now() < blockedBy && !fullId) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) fullId = hit.id;
      else await new Promise((r) => setTimeout(r, 400));
    }
    expect(fullId).not.toBe('');

    const post = await fetch(`${base}/tasks/${fullId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: 'src/foo.ts', line: 1, side: 'new', content: 'why did you do it this way?',
      }),
    });
    expect(post.status).toBe(201);
    const { comment } = await post.json();
    // The POST returns as soon as the comment is durable — the ask runs in the
    // background, because it can take minutes.
    expect(comment.ask_state).toBe('pending');

    let settled: { role: string; content: string }[] = [];
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const data = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
      const thread = data.threads.find((t: { threadId: string }) => t.threadId === comment.thread_id);
      if (thread && data.pending === 0) {
        settled = thread.messages;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // The human's words are present no matter how the ask resolved — that is
    // the "never lose human feedback" invariant.
    expect(settled.length).toBeGreaterThan(0);
    expect(settled[0].content).toBe('why did you do it this way?');
    // A successful ask appends the agent's answer to the same thread.
    const agentReply = settled.find((m) => m.role === 'agent');
    expect(agentReply).toBeDefined();
    expect(agentReply!.content.length).toBeGreaterThan(0);

    // The ask must not have moved the task out of review — it is read-only and
    // restores the pre-ask status.
    const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
    expect(queue.some((e: { id: string }) => e.id === fullId)).toBe(true);
  }, 120_000);

  // Task-level ask: a question about the work as a whole, not a diff line.
  // Uses reviewAsk with the (task) sentinel anchor and shows the thread on the
  // Ask tab of the action card.
  test('a task-level ask round-trips to an agent reply on the Ask tab', async () => {
    const taskId = await createTask(ctx, 'Task-level ask', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let fullId = '';
    const blockedBy = Date.now() + 30_000;
    while (Date.now() < blockedBy && !fullId) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) fullId = hit.id;
      else await new Promise((r) => setTimeout(r, 400));
    }
    expect(fullId).not.toBe('');

    const post = await fetch(`${base}/tasks/${fullId}/review/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'TASK_Q: why this approach?' }),
    });
    expect(post.status).toBe(201);
    const { comment } = await post.json();
    expect(comment.file).toBe('(task)');
    expect(comment.line).toBe(0);
    expect(comment.ask_state).toBe('pending');

    let settled: { role: string; content: string }[] = [];
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const data = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
      const thread = data.taskThreads.find((t: { threadId: string }) => t.threadId === comment.thread_id);
      if (thread && data.pending === 0) {
        settled = thread.messages;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(settled.length).toBeGreaterThan(0);
    expect(settled[0].content).toBe('TASK_Q: why this approach?');
    const agentReply = settled.find((m) => m.role === 'agent');
    expect(agentReply).toBeDefined();
    expect(agentReply!.content.length).toBeGreaterThan(0);

    const page = await (await fetch(`${base}/tasks/${fullId}/review`)).text();
    expect(page).toContain('data-lz-action-open="ask"');
    expect(page).toContain('TASK_Q: why this approach?');
    expect(page).toContain('action="/tasks/');
    expect(page).toContain('/review/ask"');
  }, 120_000);

  // A reply to an existing task-level thread carries the threadId and joins
  // the same conversation. This tests the Reply button path on the Ask tab.
  test('a reply to a task-level thread joins the existing thread', async () => {
    const taskId = await createTask(ctx, 'Task-level reply', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let fullId = '';
    const blockedBy = Date.now() + 30_000;
    while (Date.now() < blockedBy && !fullId) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) fullId = hit.id;
      else await new Promise((r) => setTimeout(r, 400));
    }
    expect(fullId).not.toBe('');

    // Post the initial task-level question.
    const post = await fetch(`${base}/tasks/${fullId}/review/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'INITIAL_Q: what is the approach?' }),
    });
    expect(post.status).toBe(201);
    const { comment: initial } = await post.json();
    expect(initial.file).toBe('(task)');
    expect(initial.line).toBe(0);
    const threadId = initial.thread_id;

    // Wait for the agent to answer.
    let answered = false;
    const answerDeadline = Date.now() + 60_000;
    while (Date.now() < answerDeadline && !answered) {
      const data = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
      const thread = data.taskThreads.find((t: { threadId: string }) => t.threadId === threadId);
      if (thread && data.pending === 0) answered = true;
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(answered).toBe(true);

    // Now reply to the same thread.
    const reply = await fetch(`${base}/tasks/${fullId}/review/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'FOLLOWUP_Q: can you elaborate?', threadId }),
    });
    expect(reply.status).toBe(201);
    const { comment: followup } = await reply.json();
    expect(followup.file).toBe('(task)');
    expect(followup.line).toBe(0);
    expect(followup.thread_id).toBe(threadId);

    // Wait for the reply to be answered too.
    let replyAnswered = false;
    const replyDeadline = Date.now() + 60_000;
    while (Date.now() < replyDeadline && !replyAnswered) {
      const data = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
      const thread = data.taskThreads.find((t: { threadId: string }) => t.threadId === threadId);
      if (thread && data.pending === 0 && thread.messages.length >= 4) replyAnswered = true;
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(replyAnswered).toBe(true);

    // Verify the thread has all four messages (2 human questions + 2 agent replies).
    const finalData = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
    const finalThread = finalData.taskThreads.find((t: { threadId: string }) => t.threadId === threadId);
    expect(finalThread).toBeDefined();
    expect(finalThread!.messages.length).toBeGreaterThanOrEqual(4);
    expect(finalThread!.messages.map((m: { content: string }) => m.content)).toContain('INITIAL_Q: what is the approach?');
    expect(finalThread!.messages.map((m: { content: string }) => m.content)).toContain('FOLLOWUP_Q: can you elaborate?');
  }, 180_000);

  // The loop this exception exists for: ask a task-level question, read the
  // answer, then reply "alright, do that" as a COMMENT that rides the next
  // unblock — without scrolling into the diff to find a code line to hang it on.
  test('a comment reply on a task-level thread queues and rides the next unblock', async () => {
    const taskId = await createTask(ctx, 'Task-level comment reply', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let fullId = '';
    const blockedBy = Date.now() + 30_000;
    while (Date.now() < blockedBy && !fullId) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) fullId = hit.id;
      else await new Promise((r) => setTimeout(r, 400));
    }
    expect(fullId).not.toBe('');

    const post = await fetch(`${base}/tasks/${fullId}/review/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'TASK_Q: why not a queue here?' }),
    });
    expect(post.status).toBe(201);
    const { comment: question } = await post.json();
    const threadId = question.thread_id;

    // Wait for the agent's answer before replying to it.
    let answered = false;
    const answerDeadline = Date.now() + 60_000;
    while (Date.now() < answerDeadline && !answered) {
      const data = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
      const thread = data.taskThreads.find((t: { threadId: string }) => t.threadId === threadId);
      if (thread && data.pending === 0 && thread.messages.length >= 2) answered = true;
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(answered).toBe(true);

    // The reply is a plain comment on the same anchorless thread.
    const replyRes = await fetch(`${base}/tasks/${fullId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: '(task)', line: 0, side: 'new', threadId,
        content: 'TASK_REPLY: alright, do that', intent: 'comment',
      }),
    });
    expect(replyRes.status).toBe(201);
    const { comment: reply } = await replyRes.json();
    expect(reply.intent).toBe('comment');
    expect(reply.delivery_state).toBe('pending_delivery');
    expect(reply.thread_id).toBe(threadId);

    // It counts as queued everywhere the reviewer is told what will be sent.
    const before = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
    expect(before.pendingDelivery).toBe(1);
    const { queue: q } = await (await fetch(`${base}/api/review/queue`)).json();
    expect(q.find((e: { id: string }) => e.id === fullId).pendingComments).toBe(1);
    const page = await (await fetch(`${base}/tasks/${fullId}/review`)).text();
    expect(page).toContain('1 comment queued');
    expect(page).toContain('carrying the 1 queued comment');
    expect(page).toContain('on the task-level conversation');

    const form = new FormData();
    form.set('message', 'OVERALL: go ahead');
    const res = await fetch(`${base}/tasks/${fullId}/review/unblock`, {
      method: 'POST', body: form, redirect: 'manual',
    });
    expect(res.status).toBe(303);

    let prompt = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !prompt.includes('OVERALL: go ahead')) {
      const show = await ctx.lazy(['show', taskId, '--json']);
      const turns = (JSON.parse(show.stdout).turns ?? []) as Array<{ role: string; prompt: string | null }>;
      const hit = turns.filter((t) => t.role === 'human' && (t.prompt ?? '').includes('OVERALL: go ahead'));
      if (hit.length === 1) prompt = hit[0].prompt ?? '';
      else await new Promise((r) => setTimeout(r, 500));
    }
    // Rendered as a reply on the conversation — never as a bogus file/line
    // header the agent would go hunting for.
    expect(prompt).toContain('Reply on the task-level conversation');
    expect(prompt).toContain('TASK_REPLY: alright, do that');
    expect(prompt).not.toContain('(task)');
    expect(prompt).not.toMatch(/line 0/);
    // The answer it responds to rides along, so "do that" has a referent.
    expect(prompt).toContain('Earlier on this thread:');
    expect(prompt).toContain('TASK_Q: why not a queue here?');

    const after = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
    expect(after.pendingDelivery).toBe(0);
  }, 180_000);

  // INVARIANT: a 'comment' is a change request, not a question. It is persisted
  // and visible immediately but NOT dispatched — one reviewer marking up N lines
  // must produce ONE agent turn at unblock time, not N.
  test('comment-intent messages queue up and are delivered in a single unblock turn', async () => {
    const taskId = await createTask(ctx, 'Batched comments', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let fullId = '';
    const blockedBy = Date.now() + 30_000;
    while (Date.now() < blockedBy && !fullId) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) fullId = hit.id;
      else await new Promise((r) => setTimeout(r, 400));
    }
    expect(fullId).not.toBe('');

    const postComment = async (line: number, content: string) => {
      const res = await fetch(`${base}/tasks/${fullId}/review/comment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: 'src/foo.ts', line, side: 'new', content,
          intent: 'comment', anchorSnippet: `+line ${line}`,
        }),
      });
      expect(res.status).toBe(201);
      return (await res.json()).comment;
    };

    const c1 = await postComment(3, 'C1: rename this symbol');
    const c2 = await postComment(9, 'C2: this branch needs a test');

    // Nothing was dispatched: no ask state at all, just a pending delivery.
    for (const c of [c1, c2]) {
      expect(c.intent).toBe('comment');
      expect(c.ask_state).toBeUndefined();
      expect(c.delivery_state).toBe('pending_delivery');
    }

    // The reviewer can see how much is waiting to be sent, both on the task
    // page and in the queue.
    const threadsBefore = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
    expect(threadsBefore.pendingDelivery).toBe(2);
    expect(threadsBefore.pending).toBe(0);
    // The poll re-renders the queued list from this payload, so it carries the
    // comments in full (not a count) plus the live state for the status bar.
    expect(threadsBefore.queued.map((q: { content: string }) => q.content)).toEqual([
      'C1: rename this symbol',
      'C2: this branch needs a test',
    ]);
    expect(threadsBefore.queued[0]).toMatchObject({ file: 'src/foo.ts', side: 'new', line: 3 });
    expect(threadsBefore.state.status).toBe('blocked');
    expect(threadsBefore.state.askable).toBe(true);
    const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
    expect(queue.find((e: { id: string }) => e.id === fullId).pendingComments).toBe(2);
    const page = await (await fetch(`${base}/tasks/${fullId}/review`)).text();
    expect(page).toContain('C1: rename this symbol');
    expect(page).toContain('2 comments queued');
    // The unblock form says out loud what it is about to send.
    expect(page).toContain('carrying the 2 queued comments');

    // Unblock carries them both.
    const form = new FormData();
    form.set('message', 'OVERALL_MESSAGE: please address the inline notes');
    const res = await fetch(`${base}/tasks/${fullId}/review/unblock`, {
      method: 'POST', body: form, redirect: 'manual',
    });
    expect(res.status).toBe(303);

    // ONE human work turn, carrying both comments with their anchors plus the
    // reviewer's overall message.
    let prompt = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !prompt.includes('OVERALL_MESSAGE')) {
      const show = await ctx.lazy(['show', taskId, '--json']);
      const turns = (JSON.parse(show.stdout).turns ?? []) as Array<{ role: string; prompt: string | null }>;
      const hit = turns.filter((t) => t.role === 'human' && (t.prompt ?? '').includes('OVERALL_MESSAGE'));
      // Exactly one turn carries the batch — never one turn per comment.
      expect(hit.length).toBeLessThanOrEqual(1);
      if (hit.length === 1) prompt = hit[0].prompt ?? '';
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(prompt).toContain('C1: rename this symbol');
    expect(prompt).toContain('C2: this branch needs a test');
    expect(prompt).toContain('`src/foo.ts` line 3');
    expect(prompt).toContain('`src/foo.ts` line 9');
    expect(prompt).toContain('OVERALL_MESSAGE: please address the inline notes');

    // Delivery is recorded only once the turn actually launched, and both
    // comments name the same turn — proof it was a single delivery.
    const threadsAfter = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
    expect(threadsAfter.pendingDelivery).toBe(0);
    const delivered = threadsAfter.threads.flatMap(
      (t: { messages: { delivery_state?: string; delivered_turn?: number }[] }) => t.messages,
    ).filter((m: { delivery_state?: string }) => m.delivery_state === 'delivered');
    expect(delivered).toHaveLength(2);
    expect(delivered[0].delivered_turn).toBe(delivered[1].delivered_turn);
    expect(delivered[0].delivered_turn).toBeGreaterThan(0);
  }, 120_000);

  // REPRODUCES fix-review-decision-delivery-state: the reviewer could not tell
  // whether a comment or a decision had gone with an unblock or was still
  // waiting. Every reviewer-authored item must say one of two things: a loud
  // "Pending — rides the next unblock" before delivery, or a compact
  // "Delivered in turn N (time)" — with the undo affordance gone — after.
  test('delivery state is honest: pending before the unblock, delivered-in-turn with no undo after', async () => {
    const taskId = await createTask(ctx, 'Delivery state', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let fullId = '';
    const blockedBy = Date.now() + 30_000;
    while (Date.now() < blockedBy && !fullId) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) fullId = hit.id;
      else await new Promise((r) => setTimeout(r, 400));
    }
    expect(fullId).not.toBe('');

    // Seed one blocking and one non-blocking raised item, as the agent would
    // have left them. Delivery is the same machinery for both — the flag only
    // decides what gates accept.
    const raisedId = randomUUID();
    const fyiId = randomUUID();
    writeFileSync(
      taskFilePath(ctx.root, taskId, 'raised-items.json'),
      JSON.stringify({
        raised_items: [
          {
            id: raisedId,
            task_id: fullId,
            content: 'Keep the legacy flag?',
            blocking: true,
            created_at: Date.now(),
            status: 'open',
          },
          {
            id: fyiId,
            task_id: fullId,
            content: 'The retry path swallows errors.',
            blocking: false,
            created_at: Date.now(),
            status: 'open',
          },
        ],
      }),
    );

    // A queued comment says it has not gone anywhere yet.
    const post = await fetch(`${base}/tasks/${fullId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: 'src/foo.ts', line: 3, side: 'new',
        content: 'DELIVERY_PROBE: rename this', intent: 'comment',
      }),
    });
    expect(post.status).toBe(201);

    // A raised-item decision made now is durable but pending, with an undo.
    const decide = new FormData();
    decide.set('id', raisedId);
    decide.set(`raised_action[${raisedId}]`, 'respond');
    decide.set(`raised_response[${raisedId}]`, 'Yes — keep it for one release.');
    const decided = await fetch(`${base}/tasks/${fullId}/review/raised`, {
      method: 'POST', body: decide, redirect: 'manual',
    });
    expect(decided.status).toBe(303);

    // A non-blocking decision rides the same route and the same queue.
    const fyiForm = new FormData();
    fyiForm.set('id', fyiId);
    fyiForm.set(`raised_action[${fyiId}]`, 'acknowledge');
    fyiForm.set(`raised_response[${fyiId}]`, 'Tracked elsewhere');
    const fyiRes = await fetch(`${base}/tasks/${fullId}/review/raised`, {
      method: 'POST', body: fyiForm, redirect: 'manual',
    });
    expect(fyiRes.status).toBe(303);

    const before = await (await fetch(`${base}/tasks/${fullId}/review`)).text();
    expect(before).toContain('Pending — rides the next unblock');
    const beforeRaised = await (await fetch(`${base}/tasks/${fullId}/raised`)).text();
    expect(beforeRaised).toContain('rv-raised-undo');
    expect(beforeRaised).toContain('Tracked elsewhere');

    // Unblock delivers the comment and the raised-item decision in one turn.
    const form = new FormData();
    form.set('message', 'DELIVERY_UNBLOCK: address the notes');
    const res = await fetch(`${base}/tasks/${fullId}/review/unblock`, {
      method: 'POST', body: form, redirect: 'manual',
    });
    expect(res.status).toBe(303);

    // The page now states the delivery — turn number included — and offers no
    // undo anywhere: not on the comment, not on the raised decision. The
    // delivered comment lives on Changes (its diff thread), not Current review.
    let after = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      after = await (await fetch(`${base}/tasks/${fullId}/changes`)).text();
      if (after.includes('Delivered in turn')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(after).toContain('Delivered in turn');
    const afterRaised = await (await fetch(`${base}/tasks/${fullId}/raised`)).text();
    expect(afterRaised).not.toContain('rv-raised-undo');
    // The raised decision collapsed to its compact delivered line.
    expect(afterRaised).toContain('rv-raised-delivered');
    expect(afterRaised).toContain('Responded');
    // The delivered comment can no longer be withdrawn — its Withdraw button
    // is replaced by the refusal hint. (The island script contains the raw
    // form markup as a JS string, so assert on the rendered hint, which only
    // the server produces in this combined form.)
    expect(after).toContain('rv-withdraw-why">This comment was already delivered');
    // Both decisions are delivered, so neither is re-decidable.
    expect(afterRaised).toContain('Acknowledged');
    expect(afterRaised).not.toContain('name="raised_action');

    // The threads API agrees: nothing pending, the comment names its turn.
    const threads = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
    expect(threads.pendingDelivery).toBe(0);
    const delivered = threads.threads
      .flatMap((t: { messages: { delivery_state?: string; delivered_turn?: number; delivered_at?: number }[] }) => t.messages)
      .filter((m: { delivery_state?: string }) => m.delivery_state === 'delivered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].delivered_turn).toBeGreaterThan(0);
    expect(delivered[0].delivered_at).toBeGreaterThan(0);

    // The raised item's stored record carries the turn that delivered it.
    let raisedDelivered: { comment_delivered_at?: number; delivered_turn?: number } | undefined;
    const showBy = Date.now() + 20_000;
    while (Date.now() < showBy) {
      const show = await ctx.lazy(['show', taskId, '--json']);
      const raised = (JSON.parse(show.stdout).raised_items ?? []) as Array<{
        id: string; comment_delivered_at?: number; delivered_turn?: number;
      }>;
      raisedDelivered = raised.find((r) => r.id === raisedId && r.comment_delivered_at != null);
      if (raisedDelivered?.delivered_turn != null) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(raisedDelivered?.delivered_turn).toBeGreaterThan(0);
  }, 120_000);

  // Both modes stay legitimate: comment-only-then-unblock is one, and an
  // unblock with nothing queued must keep behaving exactly as it did before the
  // two-intent model existed.
  test('an unblock with no queued comments still delivers just the message', async () => {
    const taskId = await createTask(ctx, 'Plain unblock', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let fullId = '';
    const blockedBy = Date.now() + 30_000;
    while (Date.now() < blockedBy && !fullId) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) fullId = hit.id;
      else await new Promise((r) => setTimeout(r, 400));
    }
    expect(fullId).not.toBe('');

    const form = new FormData();
    form.set('message', 'PLAIN_MESSAGE: just do this');
    const res = await fetch(`${base}/tasks/${fullId}/review/unblock`, {
      method: 'POST', body: form, redirect: 'manual',
    });
    expect(res.status).toBe(303);

    let prompt: string | null = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && prompt === null) {
      const show = await ctx.lazy(['show', taskId, '--json']);
      const turns = (JSON.parse(show.stdout).turns ?? []) as Array<{ role: string; prompt: string | null }>;
      const hit = turns.find((t) => t.role === 'human' && (t.prompt ?? '').includes('PLAIN_MESSAGE'));
      if (hit) prompt = hit.prompt ?? '';
      else await new Promise((r) => setTimeout(r, 500));
    }
    // The bare message reaches the agent as it always did — none of the
    // inline-comment scaffolding is wrapped around it.
    expect(prompt).toContain('PLAIN_MESSAGE: just do this');
    expect(prompt).not.toContain('inline comment');
    expect(prompt).not.toContain("The reviewer's overall message");
  }, 120_000);

  // REPRODUCES fix-cli-unblock-carries-review-comments: only the WEB unblock
  // used to batch pending_delivery comments into the turn prompt — a reviewer
  // who marked up the diff on /review/:id and then unblocked from the terminal
  // launched a turn the agent never saw those comments in, and only a later web
  // unblock would ever deliver them. Every unblock path now runs the same
  // batching code in the daemon.
  test('a CLI unblock carries queued review comments and marks them delivered', async () => {
    const taskId = await createTask(ctx, 'CLI carries comments', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let fullId = '';
    const blockedBy = Date.now() + 30_000;
    while (Date.now() < blockedBy && !fullId) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) fullId = hit.id;
      else await new Promise((r) => setTimeout(r, 400));
    }
    expect(fullId).not.toBe('');

    // Queue a change request via the web API — durable, not dispatched.
    const post = await fetch(`${base}/tasks/${fullId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: 'src/foo.ts', line: 4, side: 'new',
        content: 'CLI_QUEUED: rename this helper',
        intent: 'comment', anchorSnippet: '+line 4',
      }),
    });
    expect(post.status).toBe(201);
    expect((await post.json()).comment.delivery_state).toBe('pending_delivery');

    // Unblock from the terminal, not the web.
    const unblock = await ctx.lazyMocked(
      ['unblock', fullId, '--message', 'CLI_MESSAGE: please handle my notes'],
      MOCK_CLAUDE_SUCCESS,
    );
    expect(unblock.exitCode).toBe(0);
    // The human is told their queued markup rode this unblock.
    expect(unblock.stdout).toContain('Also delivering 1 queued review comment');

    // The ONE human work turn carries the comment with its anchor plus the
    // terminal message.
    let prompt = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !prompt.includes('CLI_MESSAGE')) {
      const show = await ctx.lazy(['show', taskId, '--json']);
      const turns = (JSON.parse(show.stdout).turns ?? []) as Array<{ role: string; prompt: string | null }>;
      const hit = turns.filter((t) => t.role === 'human' && (t.prompt ?? '').includes('CLI_MESSAGE'));
      expect(hit.length).toBeLessThanOrEqual(1);
      if (hit.length === 1) prompt = hit[0].prompt ?? '';
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(prompt).toContain('CLI_QUEUED: rename this helper');
    expect(prompt).toContain('`src/foo.ts` line 4');
    expect(prompt).toContain('CLI_MESSAGE: please handle my notes');

    // The comment is delivered with the turn that carried it, exactly as a
    // web unblock records it.
    const threads = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
    expect(threads.pendingDelivery).toBe(0);
    const delivered = threads.threads
      .flatMap((t: { messages: { delivery_state?: string; delivered_turn?: number; delivered_at?: number }[] }) => t.messages)
      .filter((m: { delivery_state?: string }) => m.delivery_state === 'delivered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].delivered_turn).toBeGreaterThan(0);
    expect(delivered[0].delivered_at).toBeGreaterThan(0);
  }, 120_000);

  // Same invariant over MCP: `lazy_unblock` runs the identical daemon path, and
  // its result reports how many queued comments the turn carried.
  test('an MCP lazy_unblock carries queued review comments and reports the count', async () => {
    const taskId = await createTask(ctx, 'MCP carries comments', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let fullId = '';
    const blockedBy = Date.now() + 30_000;
    while (Date.now() < blockedBy && !fullId) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) fullId = hit.id;
      else await new Promise((r) => setTimeout(r, 400));
    }
    expect(fullId).not.toBe('');

    const post = await fetch(`${base}/tasks/${fullId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: 'src/foo.ts', line: 7, side: 'new',
        content: 'MCP_QUEUED: this branch needs a test',
        intent: 'comment', anchorSnippet: '+line 7',
      }),
    });
    expect(post.status).toBe(201);

    // Builder-kind MCP session (no task identity) — the channel a builder
    // relaying human feedback uses.
    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_unblock',
          arguments: { task_id: fullId, feedback: 'MCP_MESSAGE: address the inline note' },
        },
      },
    ], { timeoutMs: 60_000 });
    const reply = responses.find((r) => r.id === 2);
    expect(reply?.result?.isError).toBeFalsy();
    const payload = JSON.parse(reply!.result!.content![0].text) as {
      deliveredReviewComments: number;
      turnNumber: number;
    };
    expect(payload.deliveredReviewComments).toBe(1);

    let prompt = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !prompt.includes('MCP_MESSAGE')) {
      const show = await ctx.lazy(['show', taskId, '--json']);
      const turns = (JSON.parse(show.stdout).turns ?? []) as Array<{ role: string; prompt: string | null }>;
      const hit = turns.filter((t) => t.role === 'human' && (t.prompt ?? '').includes('MCP_MESSAGE'));
      expect(hit.length).toBeLessThanOrEqual(1);
      if (hit.length === 1) prompt = hit[0].prompt ?? '';
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(prompt).toContain('MCP_QUEUED: this branch needs a test');
    expect(prompt).toContain('`src/foo.ts` line 7');
    expect(prompt).toContain('MCP_MESSAGE: address the inline note');

    const threads = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
    expect(threads.pendingDelivery).toBe(0);
    const delivered = threads.threads
      .flatMap((t: { messages: { delivery_state?: string; delivered_turn?: number }[] }) => t.messages)
      .filter((m: { delivery_state?: string }) => m.delivery_state === 'delivered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].delivered_turn).toBe(payload.turnNumber);
  }, 120_000);

  // INVARIANT: asks have priority. A reviewer who asks a question and then
  // unblocks in the same breath must get the answer to the question BEFORE the
  // work turn starts — otherwise the agent is editing code while the reviewer is
  // still deciding what to ask for, and both turns fight over the worktree lock.
  test('a pending ask completes before the unblock work turn launches', async () => {
    const taskId = await createTask(ctx, 'Ask before unblock', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let fullId = '';
    const blockedBy = Date.now() + 30_000;
    while (Date.now() < blockedBy && !fullId) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) fullId = hit.id;
      else await new Promise((r) => setTimeout(r, 400));
    }
    expect(fullId).not.toBe('');

    const askRes = await fetch(`${base}/tasks/${fullId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'src/foo.ts', line: 1, side: 'new', content: 'A1: why this way?' }),
    });
    expect(askRes.status).toBe(201);
    const ask = (await askRes.json()).comment;
    expect(ask.ask_state).toBe('pending');

    const cRes = await fetch(`${base}/tasks/${fullId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: 'src/foo.ts', line: 5, side: 'new', content: 'C1: change this', intent: 'comment',
      }),
    });
    expect(cRes.status).toBe(201);

    // Unblock immediately, while the ask is still in flight. It must queue
    // behind the ask rather than race it.
    const form = new FormData();
    form.set('message', 'ORDERING_MESSAGE: now do the work');
    const unblockRes = await fetch(`${base}/tasks/${fullId}/review/unblock`, {
      method: 'POST', body: form, redirect: 'manual',
    });
    expect(unblockRes.status).toBe(303);

    // Wait for both to settle: the ask answered, the comment delivered.
    let answer = '';
    let delivered = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && (!answer || !delivered)) {
      const data = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
      const messages: Record<string, unknown>[] = data.threads.flatMap(
        (t: { messages: Record<string, unknown>[] }) => t.messages,
      );
      const reply = messages.find((m) => m.role === 'agent' && m.thread_id === ask.thread_id);
      if (reply) answer = reply.content as string;
      delivered = messages.some((m) => m.delivery_state === 'delivered');
      if (!answer || !delivered) await new Promise((r) => setTimeout(r, 500));
    }
    expect(answer).not.toBe('');
    expect(delivered).toBe(true);

    // The ordering itself, read off the session's own turn sequence: the ask's
    // answer turn is recorded strictly BEFORE the unblock work turn.
    const show = await ctx.lazy(['show', taskId, '--json']);
    const turns = JSON.parse(show.stdout).turns as Array<{
      sequence: number; role: string; content: string; prompt: string | null;
    }>;
    const askTurn = turns.find((t) => t.role === 'agent' && t.content === answer);
    const workTurn = turns.find((t) => (t.prompt ?? '').includes('ORDERING_MESSAGE'));
    expect(askTurn).toBeDefined();
    expect(workTurn).toBeDefined();
    expect(workTurn!.sequence).toBeGreaterThan(askTurn!.sequence);
    // …and it carried the queued comment, not just the message.
    expect(workTurn!.prompt).toContain('C1: change this');
  }, 180_000);

  // INVARIANT (CLAUDE.md, "never lose human feedback"): a question the agent
  // could not be asked is saved with the reason, and the reviewer can re-send it
  // without typing it again. The retry is a plain form POST + redirect so it
  // works with scripting off, exactly like unblock and accept.
  test('a question asked while the agent cannot answer is saved and re-sendable', async () => {
    // Never started: the task sits in `backlog`, which is not askable.
    const taskId = await createTask(ctx, 'Ask retry test', 'Do work');

    const post = await fetch(`${base}/tasks/${taskId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: 'src/foo.ts', line: 1, side: 'new', content: 'RETRY_Q: what does this do?',
      }),
    });
    expect(post.status).toBe(201);
    const { comment } = await post.json();
    expect(comment.ask_state).toBe('failed');

    // The page tells the reviewer it did not go, that it was kept, and offers
    // the one-click re-send. The sticky bar says why the agent is unavailable.
    const page = await (await fetch(`${base}/tasks/${taskId}/changes`)).text();
    expect(page).toContain('RETRY_Q: what does this do?');
    expect(page).toContain('not sent:');
    expect(page).toContain('your question is saved');
    expect(page).toContain(`/comment/${comment.id}/retry"`);
    expect(page).toContain('Re-send to agent');
    const reviewPage = await (await fetch(`${base}/tasks/${taskId}/review`)).text();
    expect(reviewPage).toContain('data-rv-askable="0"');

    // Re-sending while the agent still cannot answer must not lose the question
    // — it re-records the (still current) reason and redirects back.
    const retry = await fetch(`${base}/tasks/${taskId}/review/comment/${comment.id}/retry`, {
      method: 'POST', redirect: 'manual',
    });
    expect(retry.status).toBe(303);
    expect(retry.headers.get('location')).toMatch(/\/tasks\/[^/]+\/review$/);

    const threads = await (await fetch(`${base}/api/review/${taskId}/threads`)).json();
    const saved = threads.threads[0].messages[0];
    expect(saved.content).toBe('RETRY_Q: what does this do?');
    expect(saved.ask_state).toBe('failed');
    expect(saved.ask_error).toBeTruthy();
  });

  // The other half of the retry contract: once the agent CAN answer, the saved
  // question is dispatched as-is and lands in its original thread.
  test('re-sending a saved question once the task is blocked reaches the agent', async () => {
    const taskId = await createTask(ctx, 'Ask retry dispatch', 'Do work');

    const post = await fetch(`${base}/tasks/${taskId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: 'src/foo.ts', line: 1, side: 'new', content: 'LATER_Q: why this way?',
      }),
    });
    expect(post.status).toBe(201);
    const { comment } = await post.json();
    expect(comment.ask_state).toBe('failed');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let fullId = '';
    const blockedBy = Date.now() + 30_000;
    while (Date.now() < blockedBy && !fullId) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) fullId = hit.id;
      else await new Promise((r) => setTimeout(r, 400));
    }
    expect(fullId).not.toBe('');

    const retry = await fetch(`${base}/tasks/${fullId}/review/comment/${comment.id}/retry`, {
      method: 'POST', redirect: 'manual',
    });
    expect(retry.status).toBe(303);

    let reply: { role: string; content: string } | undefined;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !reply) {
      const data = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
      const thread = data.threads.find((t: { threadId: string }) => t.threadId === comment.thread_id);
      reply = thread?.messages.find((m: { role: string }) => m.role === 'agent');
      if (!reply) await new Promise((r) => setTimeout(r, 500));
    }
    expect(reply).toBeDefined();
    expect(reply!.content.length).toBeGreaterThan(0);
  }, 120_000);

  test('retry refuses anything that is not a question of the reviewer’s', async () => {
    const taskId = await createTask(ctx, 'Retry guard test', 'Do work');

    const res = await fetch(`${base}/tasks/${taskId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: 'src/foo.ts', line: 1, side: 'new', content: 'C: change this', intent: 'comment',
      }),
    });
    expect(res.status).toBe(201);
    const { comment } = await res.json();

    // A queued comment is delivered by unblock, not by an ask — re-sending it
    // would dispatch a turn the reviewer never asked for.
    const retry = await fetch(`${base}/tasks/${taskId}/review/comment/${comment.id}/retry`, {
      method: 'POST', redirect: 'manual',
    });
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain('Could not re-send the question');

    // …and the comment is untouched, still waiting for its unblock.
    const threads = await (await fetch(`${base}/api/review/${taskId}/threads`)).json();
    expect(threads.pendingDelivery).toBe(1);
  });

  // INVARIANT: a withdrawn comment never reaches the agent. This is the whole
  // point of the feature — the reviewer's retraction has to hold all the way
  // through to the prompt the agent is actually given, not merely hide the
  // comment on the page.
  test('a withdrawn comment is absent from the unblock the agent receives', async () => {
    const taskId = await createTask(ctx, 'Withdraw before delivery', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let fullId = '';
    const blockedBy = Date.now() + 30_000;
    while (Date.now() < blockedBy && !fullId) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = queue.find((e: { id: string }) => e.id.startsWith(taskId));
      if (hit) fullId = hit.id;
      else await new Promise((r) => setTimeout(r, 400));
    }
    expect(fullId).not.toBe('');

    const postComment = async (line: number, content: string) => {
      const res = await fetch(`${base}/tasks/${fullId}/review/comment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: 'src/foo.ts', line, side: 'new', content,
          intent: 'comment', anchorSnippet: `+line ${line}`,
        }),
      });
      expect(res.status).toBe(201);
      return (await res.json()).comment;
    };

    const keep = await postComment(3, 'KEEP_ME: rename this symbol');
    const oops = await postComment(9, 'WITHDRAWN_ME: posted by mistake');

    // A plain form POST with a redirect, exactly like retry — withdrawing must
    // work with scripting off.
    const withdraw = await fetch(`${base}/tasks/${fullId}/review/comment/${oops.id}/withdraw`, {
      method: 'POST', redirect: 'manual',
    });
    expect(withdraw.status).toBe(303);

    // Gone from the queue, the count, and the queue listing…
    const threads = await (await fetch(`${base}/api/review/${fullId}/threads`)).json();
    expect(threads.pendingDelivery).toBe(1);
    expect(threads.queued.map((q: { id: string }) => q.id)).toEqual([keep.id]);
    const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
    expect(queue.find((e: { id: string }) => e.id === fullId).pendingComments).toBe(1);
    // …but still visible in its thread, marked as withdrawn. Retracted, not deleted.
    const reviewPage = await (await fetch(`${base}/tasks/${fullId}/review`)).text();
    expect(reviewPage).toContain('1 comment queued');
    const changesPage = await (await fetch(`${base}/tasks/${fullId}/changes`)).text();
    expect(changesPage).toContain('WITHDRAWN_ME: posted by mistake');
    expect(changesPage).toContain('withdrawn — never sent to the agent');

    const form = new FormData();
    form.set('message', 'OVERALL_MESSAGE: see the note');
    const res = await fetch(`${base}/tasks/${fullId}/review/unblock`, {
      method: 'POST', body: form, redirect: 'manual',
    });
    expect(res.status).toBe(303);

    let prompt = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !prompt.includes('OVERALL_MESSAGE')) {
      const show = await ctx.lazy(['show', taskId, '--json']);
      const turns = (JSON.parse(show.stdout).turns ?? []) as Array<{ role: string; prompt: string | null }>;
      const hit = turns.filter((t) => t.role === 'human' && (t.prompt ?? '').includes('OVERALL_MESSAGE'));
      if (hit.length === 1) prompt = hit[0].prompt ?? '';
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(prompt).toContain('KEEP_ME: rename this symbol');
    expect(prompt).not.toContain('WITHDRAWN_ME');
  }, 120_000);

  test('withdrawal is refused for a delivered comment and for a foreign id', async () => {
    const taskId = await createTask(ctx, 'Withdraw guards', 'Do work');
    const other = await createTask(ctx, 'Someone else', 'Do work');

    const post = async (id: string, content: string) => {
      const res = await fetch(`${base}/tasks/${id}/review/comment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'a.ts', line: 1, side: 'new', content, intent: 'comment' }),
      });
      expect(res.status).toBe(201);
      return (await res.json()).comment;
    };
    const mine = await post(taskId, 'mine');
    const theirs = await post(other, 'theirs');

    // A comment id that exists but is not on THIS task must not be withdrawable
    // through this task's route.
    const foreign = await fetch(`${base}/tasks/${taskId}/review/comment/${theirs.id}/withdraw`, {
      method: 'POST', redirect: 'manual',
    });
    expect(foreign.status).toBe(200);
    expect(await foreign.text()).toContain('Could not withdraw');
    expect(
      (await (await fetch(`${base}/api/review/${other}/threads`)).json()).pendingDelivery,
    ).toBe(1);

    // Withdrawing twice is refused rather than silently re-stamped.
    expect(
      (await fetch(`${base}/tasks/${taskId}/review/comment/${mine.id}/withdraw`, {
        method: 'POST', redirect: 'manual',
      })).status,
    ).toBe(303);
    const again = await fetch(`${base}/tasks/${taskId}/review/comment/${mine.id}/withdraw`, {
      method: 'POST', redirect: 'manual',
    });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain('already withdrawn');
  });

  test('an unrecognised intent is rejected rather than silently treated as an ask', async () => {
    const taskId = await createTask(ctx, 'Bad intent test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const res = await fetch(`${base}/tasks/${taskId}/review/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'a.ts', line: 1, side: 'new', content: 'x', intent: 'question' }),
    });
    expect(res.status).toBe(400);

    const threads = await (await fetch(`${base}/api/review/${taskId}/threads`)).json();
    expect(threads.threads).toHaveLength(0);
  });

  // INVARIANT: the review page never receives non-diff content as diff. The
  // daemon's `lazy diff` output appends a synthetic
  // `diff --lazy a/comments b/comments` section for comments newer than the
  // last agent turn; feeding that to the page's unified-diff parser renamed
  // the last real file to "comments" and hid its own hunks.
  test('a task comment does not produce a phantom "comments" file on the review page', async () => {
    const taskId = await createTask(ctx, 'Phantom comments file', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // Wait for the mock agent's commit to show up as a real file in the diff.
    let html = '';
    let deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      html = await (await fetch(`${base}/tasks/${taskId}/changes`)).text();
      if (html.includes('data-file="agent-output-')) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    expect(html).toContain('data-file="agent-output-');

    // A comment newer than the last agent turn is what triggers the synthetic
    // section in the daemon's diff output.
    await ctx.lazy(['comment', taskId, '-m', 'please fix the heading']);

    // Precondition: the CLI diff — documented to carry comments — really does
    // emit the synthetic section, so the page assertions below are meaningful
    // and the CLI's behaviour is unchanged by the fix.
    const cli = await ctx.lazy(['diff', taskId, '--full']);
    expect(cli.stdout).toContain('diff --lazy a/comments b/comments');
    expect(cli.stdout).toContain('please fix the heading');

    html = await (await fetch(`${base}/tasks/${taskId}/changes`)).text();

    // The real file is still there, under its real name...
    expect(html).toContain('data-file="agent-output-');
    // ...and there is no file called "comments".
    expect(html).not.toContain('data-file="comments"');
    expect(html).not.toContain('diff --lazy');
    // A leaf task (no accepted children) must not grow a hub Changes list.
    expect(html).not.toContain('Accepted subtasks');
    expect(html).not.toContain('rv-hub-children');
  });

  test('unknown tasks 404 on both the page and the threads API', async () => {
    expect((await fetch(`${base}/tasks/deadbeef/review`)).status).toBe(404);
    expect((await fetch(`${base}/api/review/deadbeef/threads`)).status).toBe(404);
  });
});

/**
 * INVARIANT: a markdown card on the web UI is never a scroll container and is
 * never a preview.
 *
 * The agent report used to be truncated to ~900 characters behind a <details>
 * once it passed ~2000, and `.turn-content` boxed every rendered turn into a
 * 300px scroller inside an already-scrolling page. Both hid the end of exactly
 * the text a reviewer opened the page to read. The report is now shown in full
 * and carries the same "Viewed" tick a file in the diff does — that, not
 * truncation, is how a reviewer makes a long card take less room.
 */
describe('web review surface: markdown cards', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  // Comfortably past both removed thresholds, with a marker at the very end so
  // a truncating page cannot pass by accident.
  const LONG_RESULT = `${'The agent explains itself at length. '.repeat(200)}\n\nFINAL-LINE-OF-THE-REPORT`;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        LAZY_MOCK_SHOULD_COMMIT: '1',
        LAZY_MOCK_CLAUDE_RESPONSE: JSON.stringify({
          result: LONG_RESULT,
          session_id: 'mock-sess-cards',
          usage: { input_tokens: 500, output_tokens: 1000 },
        }),
      },
    });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('a long agent report renders in full and carries the viewed checkbox', async () => {
    const taskId = await createTask(ctx, 'Long report test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let html = '';
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      html = await (await fetch(`${base}/tasks/${taskId}`)).text();
      if (html.includes('card:agent-report')) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    // Shown whole: the last line of a 7000-character report is on the page.
    expect(html).toContain('FINAL-LINE-OF-THE-REPORT');
    // No preview mechanism left to expand.
    expect(html).not.toContain('rv-agent-report-details');

    // The same affordance a file has: a hash-keyed section plus the tick.
    expect(html).toContain('data-viewed-key="card:agent-report"');
    expect(html).toMatch(/data-viewed-key="card:agent-report"[^>]*data-content-hash="[a-z0-9]+"/);
    expect(html).toContain('class="rv-viewed-box"');

    // Without JS the card is simply expanded — the toggle and the tick ship
    // hidden, and nothing is collapsed server-side.
    expect(html).not.toContain('data-collapsed="1"');
  });

  // The card on the Turns tab is a CHUNK — one card holding the turns of one
  // review window, plus the comments and journal entries from the same window.
  // What has not changed is the rule this test exists for: the text arrives
  // whole, in a viewable card, never in a scroll box.
  test('the Turns tab shows chunks as viewable cards, not scroll boxes', async () => {
    const taskId = await createTask(ctx, 'Task page cards', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // Wait for the AGENT turn, not just the human one that opened the task —
    // its text is what must arrive whole.
    let html = '';
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      html = await (await fetch(`${base}/tasks/${taskId}/turns`)).text();
      if (html.includes('FINAL-LINE-OF-THE-REPORT')) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    await ctx.lazy(['comment', taskId, '-m', 'a note for the record']);
    html = await (await fetch(`${base}/tasks/${taskId}/turns`)).text();

    expect(html).toContain('data-viewed-key="card:chunk:');
    expect(html).toContain('class="rv-viewed-box"');
    // The turn's full text, not a clipped one.
    expect(html).toContain('FINAL-LINE-OF-THE-REPORT');
    // The comment is folded into the chunk it belongs to, keeping its anchor
    // so "Since you last looked" can still link straight at it.
    expect(html).toMatch(/id="comment-[^"]+"/);
    expect(html).toContain('a note for the record');
  });
});

/**
 * The "How to verify" block: the agent's verification steps are a first-class
 * structured part of the review (like follow-ups and raised items), with each
 * fenced command rendered as a one-click-copy panel — and an honest empty
 * state when the agent gave none, so the gap is visible rather than hidden.
 */
describe('web review surface: how to verify block', () => {
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

  async function startBlockedTask(goal: string): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    const waited = await ctx.lazy(['wait', taskId]);
    if (waited.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waited.stderr}\n${waited.stdout}`);
    }
    return taskId;
  }

  test('a report with how_to_verify renders the block with copyable command panels', async () => {
    const taskId = await startBlockedTask('Verify block test');
    const worktree = worktreePathFor(ctx.root, taskId);

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [
              { kind: 'what_was_done', body: 'Shipped the thing' },
              {
                kind: 'how_to_verify',
                body: 'Run the suite:\n\n```bash\nbun test test/e2e/server-review.test.ts\n```\n\nThen hit the server:\n\n```console\n$ curl localhost:9999\n$ echo done\n```',
              },
            ],
          },
        },
      },
    ], { timeoutMs: 60_000 });
    expect(responses.find((r) => r.id === 2)?.result?.isError).toBeFalsy();

    const html = await (await fetch(`${base}/tasks/${taskId}/verify`)).text();

    // Current steps are per-step ticks, not one card for the whole set.
    expect(html).toContain('data-verify-current');
    expect(html).toContain('lz-verify-step');
    expect(html).not.toContain('The agent gave no verification steps.');
    // Two fences → two command panels, with language labels and whole-block copy.
    expect(html.match(/rv-cmd-panel/g)?.length).toBe(2);
    expect(html).toContain('rv-cmd-lang">bash<');
    expect(html).toContain('data-copy="bun test test/e2e/server-review.test.ts"');
    // The $-prefixed console block offers per-line copy with the prompt stripped.
    expect(html).toContain('data-copy="curl localhost:9999"');
    // Prose steps went through the markdown renderer.
    expect(html).toContain('<p>Run the suite:</p>');
    // The section left the agent-report card — it renders only in this block.
    expect(html).not.toContain('data-kind="how_to_verify"');
    // Legacy what_was_done stays on Landing as "What was done" — it is the
    // pre-split narrative, not a silent "no behavioral change" claim.
    const landing = await (await fetch(`${base}/tasks/${taskId}`)).text();
    expect(landing).toContain('data-kind="what_was_done"');
    expect(landing).toContain('Shipped the thing');
    expect(landing).not.toContain('Agent declared no behavioral change.');
    const changes = await (await fetch(`${base}/tasks/${taskId}/changes`)).text();
    expect(changes).not.toContain('data-kind="what_was_done"');
  }, 90000);

  test('a shell block offers Run in the task container; a json block does not', async () => {
    const taskId = await startBlockedTask('Verify run button test');
    const worktree = worktreePathFor(ctx.root, taskId);

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [
              {
                kind: 'how_to_verify',
                body: 'Run it:\n\n```bash\nbun test test/e2e/server-review.test.ts\n```\n\nThe config it reads:\n\n```json\n{"a": 1}\n```',
              },
            ],
          },
        },
      },
    ], { timeoutMs: 60_000 });
    expect(responses.find((r) => r.id === 2)?.result?.isError).toBeFalsy();

    const html = await (await fetch(`${base}/tasks/${taskId}/verify`)).text();

    expect(html.match(/rv-cmd-panel/g)?.length).toBe(2);
    // Exactly one Run control: the shell block. The json block gets Copy only.
    expect(html.match(/class="rv-cmd-run"/g)?.length).toBe(1);
    // INVARIANT: Run is live even though no container is running here. The
    // container is Run's own business — it starts it on click and narrates that
    // in the shell it opens — so the page neither probes docker to render this
    // nor disables the button over a state it can fix itself.
    expect(html).not.toContain('class="rv-cmd-run" disabled');
    expect(html).toContain('data-run-label=');
    // The button says what a click does: opens a shell of its own, mounted
    // under this step. Open / Re-run ship hidden until a session is live.
    expect(html).toContain('>Run in shell</button>');
    expect(html).toContain('data-lz-shell-mount');
    expect(html).toContain('data-lz-shell-task=');
    // The shell panel ships with an empty tab strip — sessions, including the
    // one a Run opens, are created on click. Nothing execs on a page render:
    // the server never renders a terminal element (the client script names the
    // attribute because it is what sets it, on click).
    expect(html).not.toContain('data-lz-shell-term=');
    expect(html).toContain('data-lz-shell-sessions></div>');
  }, 90000);

  // INVARIANT: a merely-stopped container is not a reviewer's problem to solve.
  // The verify card used to state "container not running" and grow its own
  // Start button — one of several on the page. Run brings the container up
  // itself now, so the card says nothing about it and offers no button.
  test('a down container is neither reported nor buttoned on the verify card', async () => {
    const taskId = await startBlockedTask('Verify container down test');
    const worktree = worktreePathFor(ctx.root, taskId);

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [
              {
                kind: 'how_to_verify',
                body: 'Run it:\n\n```bash\nbun test test/e2e/server-review.test.ts\n```',
              },
            ],
          },
        },
      },
    ], { timeoutMs: 60_000 });
    expect(responses.find((r) => r.id === 2)?.result?.isError).toBeFalsy();

    const html = await (await fetch(`${base}/tasks/${taskId}/verify`)).text();

    expect(html).not.toContain('rv-verify-shell-down');
    expect(html).not.toContain('Container for this task is not running.');
    expect(html).not.toContain('/container/start"');
    // The steps are still there, with a live Run on them.
    expect(html).toContain('rv-cmd-panel');
    expect(html).not.toContain('class="rv-cmd-run" disabled');
  }, 90000);

  test('no how_to_verify section renders the honest empty state', async () => {
    const taskId = await startBlockedTask('Verify empty state test');

    const html = await (await fetch(`${base}/tasks/${taskId}/verify`)).text();
    expect(html).toContain('data-viewed-key="card:how-to-verify"');
    expect(html).toContain('The agent gave no verification steps.');
  }, 90000);
});

/**
 * Markdown files in the review diff are PRESENTED, not shown as a wall of `+`
 * lines: an added file renders whole, a modified one renders whole with the
 * untouched regions folded away — and the ordinary line diff is one click
 * away for every one of them.
 */
describe('web review surface: rendered markdown files', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  // Long enough that the untouched head of the file clears the fold threshold.
  const BASE_README = [
    '# Test Project',
    '',
    'Paragraph one of the guide.',
    '',
    'Paragraph two of the guide.',
    '',
    'Paragraph three of the guide.',
    '',
    'the paragraph that gets replaced',
    '',
    'Paragraph five of the guide.',
    '',
  ].join('\n');

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

  test('an added file renders as markdown and a modified one folds its unchanged regions', async () => {
    // The pre-image has to exist on the parent branch before the task branches.
    await writeFile(join(ctx.root, 'README.md'), BASE_README);
    ctx.git('add', 'README.md');
    ctx.git('commit', '-m', 'Grow the README');

    const taskId = await createTask(ctx, 'Markdown render test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    const waited = await ctx.lazy(['wait', taskId]);
    expect(waited.exitCode).toBe(0);

    const worktree = worktreePathFor(ctx.root, taskId);
    await mkdir(join(worktree, 'docs'), { recursive: true });
    await writeFile(
      join(worktree, 'docs', 'new-page.md'),
      '# Brand New Page\n\nA sentence the reviewer should read as prose.\n',
    );
    await writeFile(join(worktree, 'README.md'), BASE_README.replace('the paragraph that gets replaced', 'the replacement paragraph'));

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: { name: 'lazy_commit', arguments: { message: 'Add a page, edit the README' } },
      },
    ]);
    expect(responses.find((r) => r.id === 2)?.result?.isError).toBeFalsy();

    const html = await (await fetch(`${base}/tasks/${taskId}/changes`)).text();

    // The added file is presented as prose, with its own badge.
    expect(html).toContain('data-rv-show="presented"');
    expect(html).toContain('markdown · added');
    expect(html).toContain('Brand New Page</h1>');

    // The modified file renders whole, with the untouched head folded.
    expect(html).toContain('markdown · modified');
    expect(html).toContain('data-rv-md-fold');
    expect(html).toMatch(/\d+ unchanged lines/);
    // The replaced paragraph is opened and accented, and the old text is still
    // shown. The accent lands on the paragraph itself, not on the whole region.
    expect(html).toContain('rv-md-changed');
    expect(html).toContain('<p class="rv-md-added">the replacement paragraph</p>');
    expect(html).toContain('the paragraph that gets replaced');

    // MANDATORY escape hatch: every presented file offers the source view, the
    // toolbar offers the switch, and the source rows are still in the page —
    // so with JS off the reviewer sees exactly the diff they always saw.
    expect(html).toContain('data-rv-show-source');
    expect(html).toContain('data-rv-mode="presented"');
    expect(html).toContain('data-rv-show="source"');
    expect(html).toContain('id="l-docs%2Fnew-page.md-new-1"');
  }, 90000);
});
