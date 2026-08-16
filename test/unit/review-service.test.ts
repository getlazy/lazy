/**
 * Unit tests: the daemon-side review service.
 *
 * The load-bearing behaviour here is CLAUDE.md's "never lose human feedback".
 * postComment() writes the reviewer's words through Storage BEFORE it evaluates
 * whether the agent can be asked at all, so no failure downstream of that write
 * can make the comment disappear.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initDaemonStorage,
  getOrCreateStorage,
  closeAllStorage,
} from '../../src/daemon/rpc-handlers';
import {
  createReviewActions,
  isPendingDelivery,
  buildUnblockPrompt,
} from '../../src/daemon/review-service';
import type { ReviewComment } from '../../src/types';

describe('review service', () => {
  let root: string;
  let prevLazyConfig: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-review-svc-'));
    const configPath = join(root, 'lazy.toml');
    await writeFile(
      configPath,
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    prevLazyConfig = process.env.LAZY_CONFIG;
    process.env.LAZY_CONFIG = configPath;
    initDaemonStorage(root);
  });

  afterEach(async () => {
    await closeAllStorage();
    if (prevLazyConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = prevLazyConfig;
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT (CLAUDE.md): the comment is persisted BEFORE the askability gate
  // is evaluated. A backlog task can never be asked, yet the reviewer's words
  // must survive and be visible, annotated with why they were not delivered.
  test('a comment on a non-askable task is still saved, marked failed with a reason', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Not askable yet');
    const actions = createReviewActions(root);

    const posted = await actions.postComment(task.id, {
      file: 'src/foo.ts',
      line: 3,
      side: 'new',
      content: 'this looks wrong',
    });
    expect(posted.ask_state).toBe('failed');

    const stored = await storage.getTaskReviewComments(task.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe('this looks wrong');
    expect(stored[0].ask_state).toBe('failed');
    // The error must tell the reviewer what to do, not just that it failed.
    expect(stored[0].ask_error).toMatch(/blocked/i);
    expect(stored[0].ask_error).toMatch(/saved/i);
    // The anchor survives the failure — the thread still renders in place.
    expect(stored[0].file).toBe('src/foo.ts');
    expect(stored[0].line).toBe(3);
    expect(stored[0].side).toBe('new');
  });

  test('posting to an unknown task fails before any write', async () => {
    const actions = createReviewActions(root);
    await expect(
      actions.postComment('deadbeef', { file: 'a.ts', line: 1, side: 'new', content: 'x' }),
    ).rejects.toThrow(/not found/i);
  });

  test('the queue lists blocked tasks with their comment counts', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Awaiting review');
    await storage.updateTaskStatus(task.id, 'blocked');
    await storage.createReviewComment(task.id, {
      file: 'a.ts', line: 1, side: 'new', role: 'human', content: 'q', askState: 'pending',
    });

    const queue = await createReviewActions(root).listQueue();
    const entry = queue.find((e) => e.id === task.id);
    expect(entry).toBeDefined();
    expect(entry!.commentCount).toBe(1);
    expect(entry!.pendingAsks).toBe(1);
    // No session was ever started, so the reviewer is told the agent is absent
    // rather than being offered a conversation that cannot happen.
    expect(entry!.hasSession).toBe(false);
  });

  // INVARIANT: a 'comment' is a change request, not a question. It must never be
  // dispatched on its own — that is the legacy `Comment` behaviour (one comment
  // = one agent turn) this model deliberately replaces. A reviewer marking up
  // ten lines produces ONE turn, at unblock time, not ten.
  test('a comment-intent message is queued, never dispatched', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Queued not asked');
    await storage.updateTaskStatus(task.id, 'blocked');
    const actions = createReviewActions(root);

    const posted = await actions.postComment(task.id, {
      file: 'src/foo.ts',
      line: 3,
      side: 'new',
      content: 'rename this',
      intent: 'comment',
    });

    // No ask state at all: nothing was dispatched, so nothing is awaiting an
    // answer and nothing can have failed to be delivered.
    expect(posted.intent).toBe('comment');
    expect(posted.ask_state).toBeUndefined();
    expect(posted.delivery_state).toBe('pending_delivery');

    const [stored] = await storage.getTaskReviewComments(task.id);
    expect(stored.delivery_state).toBe('pending_delivery');
    expect(stored.ask_state).toBeUndefined();
  });

  // Unlike an ask, a comment has no status gate: the reviewer may mark up the
  // diff of a task that is busy or not yet askable, and the notes simply keep
  // until an unblock can carry them.
  test('a comment on a non-askable task queues cleanly instead of failing', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Backlog, still commentable');
    const actions = createReviewActions(root);

    const posted = await actions.postComment(task.id, {
      file: 'a.ts', line: 1, side: 'new', content: 'later', intent: 'comment',
    });
    expect(posted.delivery_state).toBe('pending_delivery');
    expect(posted.ask_state).toBeUndefined();
    expect(posted.ask_error).toBeUndefined();
  });

  test('the queue counts queued comments separately from unanswered asks', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Mixed queue');
    await storage.updateTaskStatus(task.id, 'blocked');
    await storage.createReviewComment(task.id, {
      file: 'a.ts', line: 1, side: 'new', role: 'human', content: 'q',
      intent: 'ask', askState: 'pending',
    });
    for (const content of ['c1', 'c2']) {
      await storage.createReviewComment(task.id, {
        file: 'a.ts', line: 2, side: 'new', role: 'human', content,
        intent: 'comment', deliveryState: 'pending_delivery',
      });
    }
    // Already delivered — it must not be counted again, or the reviewer would
    // be told forever that they have work to send.
    await storage.createReviewComment(task.id, {
      file: 'a.ts', line: 3, side: 'new', role: 'human', content: 'old',
      intent: 'comment', deliveryState: 'delivered',
    });

    const queue = await createReviewActions(root).listQueue();
    const entry = queue.find((e) => e.id === task.id)!;
    expect(entry.pendingAsks).toBe(1);
    expect(entry.pendingComments).toBe(2);
    expect(entry.commentCount).toBe(4);
  });

  test('isPendingDelivery ignores agent replies and delivered comments', async () => {
    const base = {
      id: 'x', task_id: 't', thread_id: 'x', file: 'a.ts', line: 1,
      side: 'new' as const, content: 'c', created_at: 1,
    };
    expect(isPendingDelivery({
      ...base, role: 'human', intent: 'comment', delivery_state: 'pending_delivery',
    })).toBe(true);
    expect(isPendingDelivery({
      ...base, role: 'human', intent: 'comment', delivery_state: 'delivered',
    })).toBe(false);
    expect(isPendingDelivery({ ...base, role: 'human', intent: 'ask', ask_state: 'pending' })).toBe(false);
    // An agent reply on a comment thread is not the reviewer's change request.
    expect(isPendingDelivery({
      ...base, role: 'agent', intent: 'comment', delivery_state: 'pending_delivery',
    })).toBe(false);
  });

  // INVARIANT: a withdrawn comment is retracted, not deleted — the record and
  // its thread survive — but it is excluded from everything that would send it.
  // Withdrawal is the reviewer taking back their OWN words before anyone read
  // them, which is not "losing human feedback": it is the human's own call.
  test('withdrawing a queued comment keeps the record but drops it from the queue', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Withdraw a queued comment');
    await storage.updateTaskStatus(task.id, 'blocked');
    const actions = createReviewActions(root);

    const keep = await actions.postComment(task.id, {
      file: 'a.ts', line: 1, side: 'new', content: 'keep this', intent: 'comment',
    });
    const oops = await actions.postComment(task.id, {
      file: 'a.ts', line: 2, side: 'new', content: 'oops, typo', intent: 'comment',
    });

    const withdrawn = await actions.withdrawComment(task.id, oops.id);
    expect(withdrawn.withdrawn_at).toBeGreaterThan(0);
    expect(withdrawn.content).toBe('oops, typo');

    const stored = await storage.getTaskReviewComments(task.id);
    expect(stored).toHaveLength(2);
    expect(stored.filter(isPendingDelivery).map((c) => c.id)).toEqual([keep.id]);

    const entry = (await actions.listQueue()).find((e) => e.id === task.id)!;
    expect(entry.pendingComments).toBe(1);
    // Still counted as a comment on the task — the record did not vanish.
    expect(entry.commentCount).toBe(2);
  });

  test('a withdrawn comment cannot ride an unblock prompt', () => {
    const base = {
      task_id: 't', file: 'a.ts', line: 1, side: 'new' as const,
      role: 'human' as const, intent: 'comment' as const,
      delivery_state: 'pending_delivery' as const, created_at: 1,
    };
    const live: ReviewComment = { ...base, id: 'a', thread_id: 'a', content: 'live' };
    const gone: ReviewComment = { ...base, id: 'b', thread_id: 'b', content: 'gone', withdrawn_at: 2 };
    const all = [live, gone];
    const prompt = buildUnblockPrompt(all.filter(isPendingDelivery), all, 'go on');
    expect(prompt).toContain('live');
    expect(prompt).not.toContain('gone');
  });

  test('withdrawal is refused for anything the agent has already seen', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Withdraw guards');
    const actions = createReviewActions(root);

    const delivered = await storage.createReviewComment(task.id, {
      file: 'a.ts', line: 1, side: 'new', role: 'human', content: 'sent',
      intent: 'comment', deliveryState: 'delivered',
    });
    // A question already in flight: the ask turn is running and the answer will
    // land, so "withdrawn" would be a lie the reviewer then acts on.
    const inFlight = await storage.createReviewComment(task.id, {
      file: 'a.ts', line: 2, side: 'new', role: 'human', content: 'q', intent: 'ask',
      askState: 'pending',
    });
    // Answered: the conversation happened. Nothing to take back.
    const answered = await storage.createReviewComment(task.id, {
      file: 'a.ts', line: 3, side: 'new', role: 'human', content: 'q2', intent: 'ask',
      askState: 'answered',
    });
    const agentReply = await storage.createReviewComment(task.id, {
      file: 'a.ts', line: 3, side: 'new', role: 'agent', content: 'because',
    });

    await expect(actions.withdrawComment(task.id, delivered.id)).rejects.toThrow(/already delivered/i);
    await expect(actions.withdrawComment(task.id, inFlight.id)).rejects.toThrow(/already been sent/i);
    await expect(actions.withdrawComment(task.id, answered.id)).rejects.toThrow(/already answered/i);
    await expect(actions.withdrawComment(task.id, agentReply.id)).rejects.toThrow(/your own messages/i);
    // A well-formed id that is not on THIS task is a 404, not a cross-task write.
    await expect(actions.withdrawComment(task.id, 'nope')).rejects.toThrow(/not found/i);

    // Every refusal left the record exactly as it was.
    const after = await storage.getTaskReviewComments(task.id);
    expect(after).toHaveLength(4);
    expect(after.every((c) => c.withdrawn_at === undefined || c.withdrawn_at === null)).toBe(true);
  });

  // A failed ask never reached the agent, so it is withdrawable — and doing so
  // is the only way to clear a stale "Re-send to agent" affordance the reviewer
  // no longer wants.
  test('a failed ask can be withdrawn, and cannot then be withdrawn twice', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Withdraw a failed ask');
    const actions = createReviewActions(root);

    // Backlog task: the ask cannot be dispatched, so it is saved as failed.
    const posted = await actions.postComment(task.id, {
      file: 'a.ts', line: 1, side: 'new', content: 'never mind',
    });
    expect(posted.ask_state).toBe('failed');

    const withdrawn = await actions.withdrawComment(task.id, posted.id);
    expect(withdrawn.withdrawn_at).toBeGreaterThan(0);
    // One-way: there is no un-withdraw, and re-withdrawing says so plainly.
    await expect(actions.withdrawComment(task.id, posted.id)).rejects.toThrow(/already withdrawn/i);
  });

  test('isPendingDelivery excludes a withdrawn comment', () => {
    const base = {
      id: 'x', task_id: 't', thread_id: 'x', file: 'a.ts', line: 1,
      side: 'new' as const, content: 'c', created_at: 1,
      role: 'human' as const, intent: 'comment' as const,
      delivery_state: 'pending_delivery' as const,
    };
    expect(isPendingDelivery(base)).toBe(true);
    expect(isPendingDelivery({ ...base, withdrawn_at: 123 })).toBe(false);
  });

  // INVARIANT (CLAUDE.md): "never lose human feedback" includes never making the
  // human RE-TYPE it. An ask posted while the agent was busy is kept verbatim,
  // and retrying re-sends that same comment — it never asks for the words again.
  test('retrying a failed ask reuses the saved question, and re-records why when it still cannot go', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Busy when asked');
    const actions = createReviewActions(root);

    const posted = await actions.postComment(task.id, {
      file: 'src/foo.ts', line: 3, side: 'new', content: 'why this cast?',
    });
    expect(posted.ask_state).toBe('failed');

    // Still not askable: the retry must not throw the question away, and must
    // leave a reason naming the CURRENT status.
    const again = await actions.retryAsk(task.id, posted.id);
    expect(again.ask_state).toBe('failed');
    expect(again.ask_error).toMatch(/blocked/i);
    const [stored] = await storage.getTaskReviewComments(task.id);
    expect(stored.content).toBe('why this cast?');
    expect(stored.ask_state).toBe('failed');
  });

  test('retrying rejects anything that is not a question of yours', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Retry guards');
    const actions = createReviewActions(root);

    const queued = await storage.createReviewComment(task.id, {
      file: 'a.ts', line: 1, side: 'new', role: 'human', content: 'rename', intent: 'comment',
      deliveryState: 'pending_delivery',
    });
    const reply = await storage.createReviewComment(task.id, {
      file: 'a.ts', line: 1, side: 'new', role: 'agent', content: 'done',
    });

    // A queued change request is delivered by unblock, not by an ask — offering
    // to "re-send" it would imply a turn that is never going to happen.
    await expect(actions.retryAsk(task.id, queued.id)).rejects.toThrow(/question you asked/i);
    await expect(actions.retryAsk(task.id, reply.id)).rejects.toThrow(/question you asked/i);
    await expect(actions.retryAsk(task.id, 'nope')).rejects.toThrow(/not found/i);
  });

  test('retrying an ask already in flight is a no-op, not a second dispatch', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('In flight');
    await storage.updateTaskStatus(task.id, 'blocked');
    const actions = createReviewActions(root);
    const inFlight = await storage.createReviewComment(task.id, {
      file: 'a.ts', line: 1, side: 'new', role: 'human', content: 'q', askState: 'pending',
    });

    const result = await actions.retryAsk(task.id, inFlight.id);
    expect(result.ask_state).toBe('pending');
    expect(result.content).toBe('q');
  });

  test('listComments returns the thread in order', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Thread order');
    const actions = createReviewActions(root);
    const root1 = await storage.createReviewComment(task.id, {
      file: 'a.ts', line: 1, side: 'new', role: 'human', content: 'first',
    });
    await new Promise((r) => setTimeout(r, 2));
    await storage.createReviewComment(task.id, {
      threadId: root1.thread_id,
      file: 'a.ts', line: 1, side: 'new', role: 'agent', content: 'second',
    });
    const comments = await actions.listComments(task.id);
    expect(comments.map((c) => c.content)).toEqual(['first', 'second']);
  });

  /**
   * The ⛔/✅ decision is durable state, not form input. These tests pin the
   * two properties the web surface depends on for that to be safe.
   */
  describe('setViolationDecision', () => {
    async function taskWithViolations() {
      const storage = await getOrCreateStorage();
      const task = await storage.createTask('Touched a protected file');
      // backlog → conflict is not a legal transition; go through working.
      await storage.updateTaskStatus(task.id, 'working');
      await storage.updateTaskStatus(task.id, 'conflict');
      const session = await storage.createSession(task.id, 'claude-code', 'lazy/x', 'sha0');
      await storage.createTurn({
        sessionId: session.id,
        sequence: 1,
        role: 'agent',
        content: 'did work',
        violations: [
          { file: 'src/protected.ts', base_sha: 'base1', status: 'pending' },
          { file: 'src/other.ts', base_sha: 'base2', status: 'pending' },
        ],
      });
      return { storage, task, session };
    }

    test('approving one file records it and leaves the others alone', async () => {
      const { task } = await taskWithViolations();
      const actions = createReviewActions(root);

      const after = await actions.setViolationDecision(task.id, 'src/protected.ts', true);

      expect(after.find((v) => v.file === 'src/protected.ts')?.status).toBe('approved');
      expect(after.find((v) => v.file === 'src/other.ts')?.status).toBe('pending');
    });

    // INVARIANT: un-approving writes 'pending', NOT 'rejected'. Every gate in
    // the daemon keys off 'pending' — acceptTaskPreflight refuses only when a
    // violation is pending. Storing 'rejected' here would make the file invisible
    // to that gate, and `lazy accept` would merge the very change the reviewer
    // had just refused.
    test('un-approving returns the file to pending, never to rejected', async () => {
      const { task } = await taskWithViolations();
      const actions = createReviewActions(root);

      await actions.setViolationDecision(task.id, 'src/protected.ts', true);
      const after = await actions.setViolationDecision(task.id, 'src/protected.ts', false);

      expect(after.find((v) => v.file === 'src/protected.ts')?.status).toBe('pending');
      expect(after.map((v) => v.status)).not.toContain('rejected');
    });

    test('the decision survives being read back from storage', async () => {
      const { storage, task, session } = await taskWithViolations();
      const actions = createReviewActions(root);

      await actions.setViolationDecision(task.id, 'src/protected.ts', true);

      const turns = await storage.getSessionTurns(session.id);
      const stored = turns[0].violations ?? [];
      expect(stored.find((v) => v.file === 'src/protected.ts')?.status).toBe('approved');
    });

    test('a file the task never violated is refused rather than silently added', async () => {
      const { task } = await taskWithViolations();
      const actions = createReviewActions(root);

      await expect(
        actions.setViolationDecision(task.id, 'src/never-touched.ts', true),
      ).rejects.toThrow(/not a protected file/);
    });
  });

});

describe('the bundled unblock prompt', () => {
  function c(over: Partial<ReviewComment>): ReviewComment {
    return {
      id: 'c1', task_id: 't1', thread_id: 'c1', file: 'src/foo.ts', line: 2,
      side: 'new', role: 'human', content: 'body', created_at: 1,
      intent: 'comment', delivery_state: 'pending_delivery',
      ...over,
    };
  }

  // INVARIANT: N queued comments produce ONE prompt, and every one of them is
  // in it with its anchor. Dropping a comment here would silently lose human
  // feedback that the reviewer already saw persisted.
  test('carries every queued comment with its anchor, plus the overall message', () => {
    const pending = [
      c({ id: 'a', thread_id: 'a', file: 'src/foo.ts', line: 3, side: 'new', content: 'rename this', anchor_snippet: '+const b = 3;' }),
      c({ id: 'b', thread_id: 'b', file: 'src/bar.ts', line: 9, side: 'old', content: 'why delete?' }),
    ];
    const prompt = buildUnblockPrompt(pending, pending, 'Please address these.');

    expect(prompt).toContain('2 inline comment');
    expect(prompt).toContain('`src/foo.ts` line 3 (added/new side)');
    expect(prompt).toContain('+const b = 3;');
    expect(prompt).toContain('rename this');
    expect(prompt).toContain('`src/bar.ts` line 9 (removed/original side)');
    expect(prompt).toContain('why delete?');
    expect(prompt).toContain('Please address these.');
    // It is a work turn, not another question.
    expect(prompt).toMatch(/commit/i);
  });

  // A comment often means "do what we just agreed" — without the ask exchange
  // that came before it on the same thread, that reads as a non-sequitur.
  test('includes the earlier ask conversation on the same thread', () => {
    const question = c({ id: 'q', thread_id: 'q', intent: 'ask', content: 'why 3?', created_at: 1 });
    const answer = c({ id: 'r', thread_id: 'q', role: 'agent', content: 'off-by-one guard', created_at: 2 });
    const request = c({ id: 'w', thread_id: 'q', content: 'use a named constant', created_at: 3 });

    const prompt = buildUnblockPrompt([request], [question, answer, request], 'go');
    expect(prompt).toContain('Earlier on this thread:');
    expect(prompt).toContain('why 3?');
    expect(prompt).toContain('off-by-one guard');
    // Later messages on the thread are not "earlier" — no time travel.
    const later = c({ id: 'z', thread_id: 'q', content: 'never mind', created_at: 9 });
    expect(buildUnblockPrompt([request], [question, answer, request, later], 'go')).not.toContain('never mind');
  });
});
