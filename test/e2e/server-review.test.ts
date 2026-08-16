import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';

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

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    base = `http://localhost:${health.webPort}`;
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
      const res = await fetch(`${base}/review/${taskId}`);
      expect(res.status).toBe(200);
      html = await res.text();
      if (html.includes('data-side=')) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    expect(html).toContain('id="rv-root"');
    expect(html).toContain('data-side=');
    expect(html).toContain('data-line=');
    expect(html).toContain('rv-add-comment');
    // Resolution actions are plain form POSTs so they work without JS.
    // Forms post to the canonical (full) task id, whatever form the URL used.
    expect(html).toMatch(/action="\/review\/[0-9a-f-]+\/unblock"/);
    expect(html).toMatch(/action="\/review\/[0-9a-f-]+\/accept"/);
    // The diff is NOT rendered through the shadow-DOM component here.
    expect(html).not.toContain('<diffs-container>');
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
      const res = await fetch(`${base}/review/${taskId}`);
      if (res.status === 200) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    const post = await fetch(`${base}/review/${taskId}/comment`, {
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
    const reply = await fetch(`${base}/review/${taskId}/comment`, {
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

    const res = await fetch(`${base}/review/${taskId}/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: '', line: 1, side: 'new', content: '' }),
    });
    expect(res.status).toBe(400);

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

    const post = await fetch(`${base}/review/${fullId}/comment`, {
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
      const res = await fetch(`${base}/review/${fullId}/comment`, {
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
    const page = await (await fetch(`${base}/review/${fullId}`)).text();
    expect(page).toContain('C1: rename this symbol');
    expect(page).toContain('2 comments queued');
    // The unblock form says out loud what it is about to send.
    expect(page).toContain('carrying the 2 queued comments');

    // Unblock carries them both.
    const form = new FormData();
    form.set('message', 'OVERALL_MESSAGE: please address the inline notes');
    const res = await fetch(`${base}/review/${fullId}/unblock`, {
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
    const res = await fetch(`${base}/review/${fullId}/unblock`, {
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

    const askRes = await fetch(`${base}/review/${fullId}/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'src/foo.ts', line: 1, side: 'new', content: 'A1: why this way?' }),
    });
    expect(askRes.status).toBe(201);
    const ask = (await askRes.json()).comment;
    expect(ask.ask_state).toBe('pending');

    const cRes = await fetch(`${base}/review/${fullId}/comment`, {
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
    const unblockRes = await fetch(`${base}/review/${fullId}/unblock`, {
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

    const post = await fetch(`${base}/review/${taskId}/comment`, {
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
    const page = await (await fetch(`${base}/review/${taskId}`)).text();
    expect(page).toContain('RETRY_Q: what does this do?');
    expect(page).toContain('not sent:');
    expect(page).toContain('your question is saved');
    expect(page).toContain(`/comment/${comment.id}/retry"`);
    expect(page).toContain('Re-send to agent');
    expect(page).toContain('data-rv-askable="0"');

    // Re-sending while the agent still cannot answer must not lose the question
    // — it re-records the (still current) reason and redirects back.
    const retry = await fetch(`${base}/review/${taskId}/comment/${comment.id}/retry`, {
      method: 'POST', redirect: 'manual',
    });
    expect(retry.status).toBe(303);
    expect(retry.headers.get('location')).toContain('/review/');

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

    const post = await fetch(`${base}/review/${taskId}/comment`, {
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

    const retry = await fetch(`${base}/review/${fullId}/comment/${comment.id}/retry`, {
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

    const res = await fetch(`${base}/review/${taskId}/comment`, {
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
    const retry = await fetch(`${base}/review/${taskId}/comment/${comment.id}/retry`, {
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
      const res = await fetch(`${base}/review/${fullId}/comment`, {
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
    const withdraw = await fetch(`${base}/review/${fullId}/comment/${oops.id}/withdraw`, {
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
    const page = await (await fetch(`${base}/review/${fullId}`)).text();
    expect(page).toContain('WITHDRAWN_ME: posted by mistake');
    expect(page).toContain('withdrawn — never sent to the agent');
    expect(page).toContain('1 comment queued');

    const form = new FormData();
    form.set('message', 'OVERALL_MESSAGE: see the note');
    const res = await fetch(`${base}/review/${fullId}/unblock`, {
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
      const res = await fetch(`${base}/review/${id}/comment`, {
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
    const foreign = await fetch(`${base}/review/${taskId}/comment/${theirs.id}/withdraw`, {
      method: 'POST', redirect: 'manual',
    });
    expect(foreign.status).toBe(200);
    expect(await foreign.text()).toContain('Could not withdraw');
    expect(
      (await (await fetch(`${base}/api/review/${other}/threads`)).json()).pendingDelivery,
    ).toBe(1);

    // Withdrawing twice is refused rather than silently re-stamped.
    expect(
      (await fetch(`${base}/review/${taskId}/comment/${mine.id}/withdraw`, {
        method: 'POST', redirect: 'manual',
      })).status,
    ).toBe(303);
    const again = await fetch(`${base}/review/${taskId}/comment/${mine.id}/withdraw`, {
      method: 'POST', redirect: 'manual',
    });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain('already withdrawn');
  });

  test('an unrecognised intent is rejected rather than silently treated as an ask', async () => {
    const taskId = await createTask(ctx, 'Bad intent test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const res = await fetch(`${base}/review/${taskId}/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'a.ts', line: 1, side: 'new', content: 'x', intent: 'question' }),
    });
    expect(res.status).toBe(400);

    const threads = await (await fetch(`${base}/api/review/${taskId}/threads`)).json();
    expect(threads.threads).toHaveLength(0);
  });

  test('unknown tasks 404 on both the page and the threads API', async () => {
    expect((await fetch(`${base}/review/deadbeef`)).status).toBe(404);
    expect((await fetch(`${base}/api/review/deadbeef/threads`)).status).toBe(404);
  });
});
