/**
 * The action POST's referer guard: a malformed Referer header must never turn
 * the POST into a 500. The form the human just submitted carries their typed
 * reason — a parse throw at this point loses it, which is exactly the
 * never-lose-human-feedback invariant. An unparseable referer simply means
 * "not the task's own page" and the redirect falls back to the task itself.
 */

import { describe, test, expect } from 'bun:test';
import type { Task } from '../../src/types';
import type { Storage } from '../../src/storage';
import { createWebRequestHandler } from '../../src/server/index';
import type { TaskActions } from '../../src/server/task-actions';

function task(): Task {
  return {
    id: 'task1234abcd',
    code: 'referer-task',
    goal: 'Guard the referer',
    prompt: '',
    type: 'task',
    status: 'blocked',
    created_at: 1,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
  } as Task;
}

function storageOf(t: Task): Storage {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'getTask') return async () => t;
      if (prop === 'getSessionByTaskId') return async () => null;
      // The route builds the task's own-link segment from the code tables.
      if (prop === 'listTaskCodes') return async () => [{ id: t.id, code: t.code }];
      return async () => [];
    },
  }) as unknown as Storage;
}

const taskActions = { syncTask: async () => ({ message: 'synced clean' }) } as never;

async function postSync(storage: Storage, referer?: string): Promise<Response> {
  const handler = createWebRequestHandler(storage, undefined, {
    taskActions: taskActions as never,
  });
  return handler(new Request('http://localhost/tasks/referer-task/actions/sync', {
    method: 'POST',
    ...(referer !== undefined ? { headers: { referer } } : {}),
    body: new FormData(),
  }));
}

describe('the action POST survives a malformed Referer', () => {
  test('a referer that is not a URL completes — no 500, no lost reason', async () => {
    const res = await postSync(storageOf(task()), 'not a url');
    expect(res.status).toBe(303);
    // The redirect falls back to the task page itself — the same answer an
    // absent referer gets, since an unparseable referer is simply "not this
    // task's page".
    expect(res.headers.get('location')).toBe('http://localhost/tasks/referer-task?flash=synced%20clean');
  });

  test('a relative referer is not a URL either — same fallback', async () => {
    const res = await postSync(storageOf(task()), '/tasks/referer-task/turns');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost/tasks/referer-task?flash=synced%20clean');
  });

  test('a well-formed referer on the task page still wins the exact match', async () => {
    const res = await postSync(storageOf(task()), 'http://localhost/tasks/referer-task/turns');
    expect(res.status).toBe(303);
    // The guard's exact-match semantics are untouched: the referer's own path
    // is where the reader came from, so back they go.
    expect(res.headers.get('location')).toBe('http://localhost/tasks/referer-task/turns?flash=synced%20clean');
  });
});