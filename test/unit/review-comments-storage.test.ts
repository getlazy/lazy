/**
 * Unit tests: the ReviewComment storage entity.
 *
 * Review comments are the durable record behind the web review loop's inline
 * threads. They exist as a SEPARATE store (not `Comment`) and are anchored to
 * (file, line, side) so a reload puts every thread back on the exact diff row
 * it was written against.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';

describe('review comments storage', () => {
  let storage: FileStorage;
  let lazyRoot: string;
  let basePath: string;
  let taskId: string;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-rvc-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-rvc-store-'));
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    const task = await storage.createTask('Review comment test');
    taskId = task.id;
  });

  afterEach(async () => {
    await storage.close();
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  // INVARIANT: the anchor (file + line + side) is part of the durable record,
  // not ephemeral UI state. If it were not persisted, a page reload would
  // orphan every thread — the exact failure inline comments exist to avoid.
  test('persists the anchor and reads it back', async () => {
    await storage.createReviewComment(taskId, {
      file: 'src/foo.ts',
      line: 42,
      side: 'new',
      role: 'human',
      content: 'why 3?',
      anchorSnippet: '+const b = 3;',
    });

    const [c] = await storage.getTaskReviewComments(taskId);
    expect(c.file).toBe('src/foo.ts');
    expect(c.line).toBe(42);
    expect(c.side).toBe('new');
    expect(c.role).toBe('human');
    expect(c.content).toBe('why 3?');
    expect(c.anchor_snippet).toBe('+const b = 3;');
  });

  test('a root comment is its own thread; replies carry the root thread id', async () => {
    const root = await storage.createReviewComment(taskId, {
      file: 'a.ts', line: 1, side: 'new', role: 'human', content: 'q',
    });
    expect(root.thread_id).toBe(root.id);

    const reply = await storage.createReviewComment(taskId, {
      threadId: root.thread_id,
      file: 'a.ts', line: 1, side: 'new', role: 'agent', content: 'a',
    });
    expect(reply.thread_id).toBe(root.id);
    expect(reply.id).not.toBe(root.id);
  });

  test('comments come back oldest first', async () => {
    for (const content of ['one', 'two', 'three']) {
      await storage.createReviewComment(taskId, {
        file: 'a.ts', line: 1, side: 'new', role: 'human', content,
      });
      // Timestamps are millisecond-resolution; keep the ordering unambiguous.
      await new Promise((r) => setTimeout(r, 2));
    }
    const all = await storage.getTaskReviewComments(taskId);
    expect(all.map((c) => c.content)).toEqual(['one', 'two', 'three']);
  });

  // INVARIANT (CLAUDE.md, "never lose human feedback"): a comment whose ask
  // never reached the agent must still exist and be visible. Failure is
  // recorded ON the comment — the comment is never deleted or rolled back.
  test('a failed ask marks the comment without destroying it', async () => {
    const c = await storage.createReviewComment(taskId, {
      file: 'a.ts', line: 1, side: 'new', role: 'human', content: 'keep me',
      askState: 'pending',
    });

    const updated = await storage.updateReviewComment(taskId, c.id, {
      askState: 'failed',
      askError: 'agent session ended',
    });
    expect(updated.ask_state).toBe('failed');
    expect(updated.ask_error).toBe('agent session ended');
    expect(updated.content).toBe('keep me');

    const [reloaded] = await storage.getTaskReviewComments(taskId);
    expect(reloaded.content).toBe('keep me');
    expect(reloaded.ask_state).toBe('failed');
  });

  test('a successful ask clears the error and records the turn', async () => {
    const c = await storage.createReviewComment(taskId, {
      file: 'a.ts', line: 1, side: 'new', role: 'human', content: 'q', askState: 'pending',
    });
    await storage.updateReviewComment(taskId, c.id, { askState: 'failed', askError: 'boom' });
    const ok = await storage.updateReviewComment(taskId, c.id, {
      askState: 'answered', askError: null, turnNumber: 7,
    });
    expect(ok.ask_state).toBe('answered');
    expect(ok.ask_error).toBeUndefined();
    expect(ok.turn_number).toBe(7);
  });

  // INVARIANT: a 'comment'-intent message is a change request that must survive
  // until an unblock turn actually carries it. Persisting the intent and the
  // delivery state is what makes "queued, not yet sent" a durable fact rather
  // than something the browser happens to remember.
  test('a queued comment persists its intent and pending delivery state', async () => {
    await storage.createReviewComment(taskId, {
      file: 'a.ts', line: 3, side: 'new', role: 'human', content: 'rename this',
      intent: 'comment',
      deliveryState: 'pending_delivery',
    });

    const [c] = await storage.getTaskReviewComments(taskId);
    expect(c.intent).toBe('comment');
    expect(c.delivery_state).toBe('pending_delivery');
    expect(c.delivered_turn).toBeUndefined();
    // A queued comment is not a question — it must never look like one awaiting
    // an answer, or the queue would nag for a reply that is never coming.
    expect(c.ask_state).toBeUndefined();
  });

  test('delivery advances to delivered with the turn that carried it', async () => {
    const c = await storage.createReviewComment(taskId, {
      file: 'a.ts', line: 3, side: 'new', role: 'human', content: 'rename this',
      intent: 'comment',
      deliveryState: 'pending_delivery',
    });

    const delivered = await storage.updateReviewComment(taskId, c.id, {
      deliveryState: 'delivered',
      deliveredTurn: 4,
    });
    expect(delivered.delivery_state).toBe('delivered');
    expect(delivered.delivered_turn).toBe(4);
    expect(delivered.content).toBe('rename this');

    const [reloaded] = await storage.getTaskReviewComments(taskId);
    expect(reloaded.delivery_state).toBe('delivered');
    expect(reloaded.delivered_turn).toBe(4);
  });

  // INVARIANT: withdrawal is a state on the record, never a delete. The
  // reviewer's words and the thread they belong to survive — the timestamp is
  // only what excludes them from delivery. A hard delete would destroy the one
  // durable copy of something a human wrote.
  test('withdrawal is recorded on the comment, which survives intact', async () => {
    const c = await storage.createReviewComment(taskId, {
      file: 'a.ts', line: 3, side: 'new', role: 'human', content: 'rename this',
      intent: 'comment',
      deliveryState: 'pending_delivery',
    });

    const withdrawn = await storage.updateReviewComment(taskId, c.id, { withdrawnAt: 1700000000000 });
    expect(withdrawn.withdrawn_at).toBe(1700000000000);
    expect(withdrawn.content).toBe('rename this');
    // Untouched by the withdrawal — it is bookkeeping, not an edit.
    expect(withdrawn.delivery_state).toBe('pending_delivery');

    const all = await storage.getTaskReviewComments(taskId);
    expect(all).toHaveLength(1);
    expect(all[0].withdrawn_at).toBe(1700000000000);
    expect(all[0].content).toBe('rename this');
  });

  test('updating an unknown comment fails loudly rather than silently', async () => {
    await expect(
      storage.updateReviewComment(taskId, 'no-such-id', { askState: 'answered' }),
    ).rejects.toThrow(/not found/i);
  });

  test('a task with no comments returns an empty list, not an error', async () => {
    expect(await storage.getTaskReviewComments(taskId)).toEqual([]);
  });
});
