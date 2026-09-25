/**
 * Review with builder is gone from the dashboard. These routes must not start
 * or continue a builder chat; a stored review-session.json stays readable.
 */

import { describe, test, expect } from 'bun:test';
import { createWebRequestHandler } from '../../src/server/index';
import { REVIEW_WITH_BUILDER_GONE_MESSAGE } from '../../src/server/review-session';
import type { Storage } from '../../src/storage';
import type { ReviewSession } from '../../src/types';
import type { Task } from '../../src/storage';

const TASK_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function task(): Task {
  return {
    id: TASK_ID,
    code: 'demo-task',
    goal: 'Ship the feature',
    prompt: '',
    type: 'task',
    status: 'blocked',
    priority: 'normal',
    created_at: 1,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    metadata: null,
  } as unknown as Task;
}

function archivedSession(): ReviewSession {
  return {
    id: 'rs_archived',
    task_id: TASK_ID,
    status: 'idle',
    resume_session_id: 'claude-s1',
    created_at: 1,
    updated_at: 2,
    messages: [
      {
        id: 'm1',
        role: 'human',
        content: 'What about edge cases?',
        created_at: 1,
        delivery: 'launched',
      },
      {
        id: 'm2',
        role: 'assistant',
        content: 'Looks fine.',
        created_at: 2,
        delivery: 'launched',
      },
    ],
  };
}

function storageOf(opts: { task?: Task | null; session?: ReviewSession | null }): Storage {
  const t = opts.task === undefined ? task() : opts.task;
  const session = opts.session === undefined ? null : opts.session;
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'resolveTask') {
        return async () => ({ task: t, ambiguousMatches: [] });
      }
      if (prop === 'getReviewSessionByTaskId') {
        return async () => session;
      }
      return async () => [];
    },
  }) as unknown as Storage;
}

function handler(storage: Storage) {
  return createWebRequestHandler(storage);
}

async function get(storage: Storage, path: string): Promise<Response> {
  return handler(storage)(new Request(`http://localhost${path}`));
}

async function post(storage: Storage, path: string, body = ''): Promise<Response> {
  return handler(storage)(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }));
}

describe('retired Review-with-builder routes', () => {
  // INVARIANT: /sessions must not list or start builder review sessions.
  // The listing was itself an entry point after the task-page button was dropped.
  test('GET /sessions is gone and offers no start', async () => {
    const res = await get(storageOf({}), '/sessions');
    expect(res.status).toBe(410);
    const body = await res.text();
    expect(body).toContain(REVIEW_WITH_BUILDER_GONE_MESSAGE);
    expect(body).not.toContain('Start session');
    expect(body).not.toContain('/review/session/start');
    expect(body).not.toContain('Builder review sessions');
  });

  // INVARIANT: a task with no stored session cannot start one from this URL.
  test('GET /tasks/:id/review/session without a record is gone and offers no start', async () => {
    const res = await get(storageOf({ session: null }), `/tasks/${TASK_ID}/review/session`);
    expect(res.status).toBe(410);
    const body = await res.text();
    expect(body).toContain(REVIEW_WITH_BUILDER_GONE_MESSAGE);
    expect(body).not.toContain('Start session');
    expect(body).not.toContain('/review/session/start');
    expect(body).not.toContain('class="rs-compose"');
  });

  test('GET /tasks/:id/review/session with a record is a read-only archive', async () => {
    const res = await get(storageOf({ session: archivedSession() }), `/tasks/${TASK_ID}/review/session`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('What about edge cases?');
    expect(body).toContain('Looks fine.');
    expect(body).toContain(REVIEW_WITH_BUILDER_GONE_MESSAGE);
    expect(body).not.toContain('Start session');
    expect(body).not.toContain('/review/session/start');
    expect(body).not.toContain('/review/session/send');
    expect(body).not.toContain('class="rs-compose"');
    expect(body).not.toContain('Retry send');
  });

  // INVARIANT: POST start must not create or resume a builder review session.
  test('POST /tasks/:id/review/session/start is gone', async () => {
    const res = await post(storageOf({ session: null }), `/tasks/${TASK_ID}/review/session/start`);
    expect(res.status).toBe(410);
    const body = await res.text();
    expect(body).toContain(REVIEW_WITH_BUILDER_GONE_MESSAGE);
    expect(body).not.toContain('Start session');
  });

  test('POST /tasks/:id/review/session/send is gone even when a record exists', async () => {
    const res = await post(
      storageOf({ session: archivedSession() }),
      `/tasks/${TASK_ID}/review/session/send`,
      'message=hello',
    );
    expect(res.status).toBe(410);
  });

  test('GET /api/review/:id/session without a record is gone', async () => {
    const res = await get(storageOf({ session: null }), `/api/review/${TASK_ID}/session`);
    expect(res.status).toBe(410);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Review with builder was removed');
  });

  test('GET /api/review/:id/session with a record returns the stored transcript', async () => {
    const res = await get(storageOf({ session: archivedSession() }), `/api/review/${TASK_ID}/session`);
    expect(res.status).toBe(200);
    const body = await res.json() as { messages: Array<{ content: string }> };
    expect(body.messages.map((m) => m.content)).toEqual(['What about edge cases?', 'Looks fine.']);
  });

  test('unknown task is 404, not a start page', async () => {
    const res = await get(storageOf({ task: null }), `/tasks/missing/review/session`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('Start session');
  });
});
