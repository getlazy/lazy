import { describe, test, expect } from 'bun:test';
import { recordPushOutcome, readPushFailure, shownPushFailure, PUSH_FAILURE_KEY } from '../../src/daemon/push-failure';
import type { Storage } from '../../src/storage/interface';

function fakeStorage() {
  const task = { id: 't1', code: 'demo', metadata: {} as Record<string, string> };
  const messages: Array<{ title: string; body: string }> = [];
  const storage = {
    getTask: async () => task,
    updateTaskMetadata: async (_id: string, key: string, value: string) => {
      if (value === '') delete task.metadata[key]; else task.metadata[key] = value;
    },
    createSystemMessage: async (m: { title: string; body: string }) => { messages.push(m); return m; },
  } as unknown as Storage;
  return { task, messages, storage };
}

describe('failed branch pushes reach the task', () => {
  // INVARIANT: a failed push is recorded on the task with the forge's words,
  // counted, messaged ONCE per episode, and cleared by the next good push —
  // before this it reached only the daemon log.
  test('records, messages once after repeated failures, clears on success', async () => {
    const { task, messages, storage } = fakeStorage();
    for (let i = 0; i < 4; i++) {
      await recordPushOutcome(storage, 't1', 'lazy/demo', 'remote: Permission to a/b.git denied to octo. (403)');
    }
    // Counted up to the message (3); the 4th identical failure writes nothing.
    expect(readPushFailure(task)).toMatchObject({ branch: 'lazy/demo', attempts: 3, messaged: true });
    expect(readPushFailure(task)!.error).toContain('denied to octo');
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toContain('denied to octo');

    await recordPushOutcome(storage, 't1', 'lazy/demo', null);
    expect(task.metadata[PUSH_FAILURE_KEY]).toBeUndefined();
  });
});

describe('what a push failure stores', () => {
  // INVARIANT: credentials inside a remote URL never reach the store or a
  // system message.
  test('URL userinfo is masked before it is stored', async () => {
    const { task, messages, storage } = fakeStorage();
    for (let i = 0; i < 3; i++) {
      await recordPushOutcome(storage, 't1', 'lazy/demo', "fatal: unable to access 'https://x-access-token:ghp_SECRET123@github.com/a/b.git/': 403");
    }
    const stored = task.metadata[PUSH_FAILURE_KEY];
    expect(stored).not.toContain('ghp_SECRET123');
    expect(stored).toContain('https://***@github.com');
    expect(messages[0].body).not.toContain('ghp_SECRET123');
  });

  // INVARIANT: an unchanged failure, already counted and messaged, writes
  // nothing — the after-turn queue retries every tick.
  test('the same error again writes nothing once it has been messaged', async () => {
    const { storage } = fakeStorage();
    let writes = 0;
    const counting = { ...storage, updateTaskMetadata: async (...a: [string, string, string]) => { writes++; return storage.updateTaskMetadata(...a); } } as unknown as Storage;
    for (let i = 0; i < 10; i++) await recordPushOutcome(counting, 't1', 'lazy/demo', 'remote: Permission to a/b.git denied');
    expect(writes).toBe(3);
  });
});

describe('which push failure a surface shows', () => {
  const record = JSON.stringify({ branch: 'lazy/x', error: 'remote: denied', firstFailedAt: 't', lastFailedAt: 't', attempts: 3, messaged: true });

  // INVARIANT: a push failure is shown only while the task's branch is still
  // pushed. An accepted, closed or rejected task is never pushed again, so the
  // record would never be cleared — and a "not on the forge" banner on merged
  // work is false.
  test('an accepted, closed or rejected task shows none; a live one shows it without bookkeeping', () => {
    for (const status of ['complete', 'abandoned'] as const) {
      expect(shownPushFailure({ status, metadata: { [PUSH_FAILURE_KEY]: record } })).toBeNull();
    }
    for (const status of ['blocked', 'submitted', 'working'] as const) {
      expect(shownPushFailure({ status, metadata: { [PUSH_FAILURE_KEY]: record } }))
        .toEqual({ branch: 'lazy/x', error: 'remote: denied', firstFailedAt: 't', lastFailedAt: 't', attempts: 3 });
    }
  });
});
