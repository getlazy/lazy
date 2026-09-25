/**
 * Unit tests: the ReviewSession storage entity.
 *
 * Review sessions are the durable transcript behind the web "Review with builder"
 * conversation — one session per task in v1, with compose-box messages appended
 * before any failable builder launch.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';

describe('review session storage', () => {
  let storage: FileStorage;
  let lazyRoot: string;
  let basePath: string;
  let taskId: string;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-rs-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-rs-store-'));
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    const task = await storage.createTask('Review session test');
    taskId = task.id;
  });

  afterEach(async () => {
    await storage.close();
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  test('createReviewSession mints rs_ id and starts idle with no messages', async () => {
    const session = await storage.createReviewSession(taskId);
    expect(session.id).toMatch(/^rs_[0-9a-f-]{36}$/);
    expect(session.task_id).toBe(taskId);
    expect(session.status).toBe('idle');
    expect(session.resume_session_id).toBeNull();
    expect(session.messages).toEqual([]);
    expect(session.created_at).toBeGreaterThan(0);
    expect(session.updated_at).toBe(session.created_at);
  });

  test('v1 allows only one session per task', async () => {
    await storage.createReviewSession(taskId);
    await expect(storage.createReviewSession(taskId)).rejects.toThrow(/already exists/i);
  });

  test('getReviewSessionByTaskId returns the session or null', async () => {
    expect(await storage.getReviewSessionByTaskId(taskId)).toBeNull();

    const created = await storage.createReviewSession(taskId);
    const loaded = await storage.getReviewSessionByTaskId(taskId);
    expect(loaded?.id).toBe(created.id);
    expect(loaded?.status).toBe('idle');
  });

  // INVARIANT (CLAUDE.md, "never lose human feedback"): compose-box text is
  // durable before launch — append persists with delivery pending even when the
  // builder turn has not started yet.
  test('appendReviewSessionMessage persists human text as pending before launch', async () => {
    const session = await storage.createReviewSession(taskId);
    const message = await storage.appendReviewSessionMessage(session.id, {
      role: 'human',
      content: 'What changed in src/foo.ts?',
    });

    expect(message.role).toBe('human');
    expect(message.content).toBe('What changed in src/foo.ts?');
    expect(message.delivery).toBe('pending');

    const reloaded = await storage.getReviewSessionByTaskId(taskId);
    expect(reloaded?.messages).toHaveLength(1);
    expect(reloaded?.messages[0].content).toBe('What changed in src/foo.ts?');
    expect(reloaded?.messages[0].delivery).toBe('pending');
  });

  test('updateReviewSessionMessage advances delivery without destroying content', async () => {
    const session = await storage.createReviewSession(taskId);
    const message = await storage.appendReviewSessionMessage(session.id, {
      role: 'human',
      content: 'keep me',
    });

    const failed = await storage.updateReviewSessionMessage(session.id, message.id, {
      delivery: 'failed',
    });
    expect(failed.delivery).toBe('failed');
    expect(failed.content).toBe('keep me');

    const launched = await storage.updateReviewSessionMessage(session.id, message.id, {
      delivery: 'launched',
    });
    expect(launched.delivery).toBe('launched');
    expect(launched.content).toBe('keep me');

    const [reloaded] = await storage.listReviewSessionMessages(session.id);
    expect(reloaded.delivery).toBe('launched');
    expect(reloaded.content).toBe('keep me');
  });

  test('updateReviewSession changes status and resume_session_id', async () => {
    const session = await storage.createReviewSession(taskId);

    const inFlight = await storage.updateReviewSession(session.id, { status: 'turn_in_flight' });
    expect(inFlight.status).toBe('turn_in_flight');

    const resumed = await storage.updateReviewSession(session.id, {
      status: 'idle',
      resumeSessionId: 'claude-session-abc',
    });
    expect(resumed.status).toBe('idle');
    expect(resumed.resume_session_id).toBe('claude-session-abc');

    const cleared = await storage.updateReviewSession(session.id, { resumeSessionId: null });
    expect(cleared.resume_session_id).toBeNull();
  });

  test('messages come back oldest first', async () => {
    const session = await storage.createReviewSession(taskId);
    for (const content of ['one', 'two', 'three']) {
      await storage.appendReviewSessionMessage(session.id, { role: 'human', content });
      await new Promise((r) => setTimeout(r, 2));
    }

    const messages = await storage.listReviewSessionMessages(session.id);
    expect(messages.map((m) => m.content)).toEqual(['one', 'two', 'three']);
  });

  test('assistant messages default to launched delivery', async () => {
    const session = await storage.createReviewSession(taskId);
    const reply = await storage.appendReviewSessionMessage(session.id, {
      role: 'assistant',
      content: 'Here is my read.',
    });
    expect(reply.delivery).toBe('launched');
  });

  test('updating an unknown message fails loudly rather than silently', async () => {
    const session = await storage.createReviewSession(taskId);
    await expect(
      storage.updateReviewSessionMessage(session.id, 'no-such-id', { delivery: 'launched' }),
    ).rejects.toThrow(/not found/i);
  });

  test('updating an unknown session fails loudly rather than silently', async () => {
    await expect(
      storage.updateReviewSession('rs_no-such-session', { status: 'idle' }),
    ).rejects.toThrow(/not found/i);
  });
});
