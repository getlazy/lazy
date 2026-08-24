/**
 * Unit tests for the slow-lane auto-resume queue (src/daemon/auto-resume-queue.ts).
 *
 * INVARIANT: Round-robin fairness — at most one task advances per project-wide
 * gap, oldest-attempt-first, so one flapping task can never starve the queue.
 * See listSlowLaneQueue's ordering and processAutoResumeQueue's gap gate.
 *
 * INVARIANT: A task only enters the slow lane after its fast-lane circuit
 * breaker (MAX_CONSECUTIVE_INTERRUPTIONS) has tripped — listSlowLaneQueue must
 * not surface a freshly-interrupted task that the fast lane would still retry
 * immediately.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getSlowLaneState,
  recordSlowLaneAttempt,
  resetSlowLaneState,
  getLastProjectAutoResumeAt,
  listSlowLaneQueue,
} from '../../src/daemon/auto-resume-queue';
import { MAX_CONSECUTIVE_INTERRUPTIONS } from '../../src/utils/auto-resume';
import type { Storage } from '../../src/storage/interface';
import type { Task, Session } from '../../src/types';
import type { ResolvedConfig } from '../../src/config/types';

/**
 * Minimal in-memory storage mock covering exactly what auto-resume-queue.ts
 * reads: per-task metadata, listTasks, and getSessionByTaskId. Mirrors the
 * lighter mocks in test/unit/auto-turn-budget.test.ts / turn-budget.test.ts.
 */
function createMockStorage(tasks: Task[], sessions: Map<string, Session>): Storage {
  const metadata = new Map<string, Map<string, string>>();

  return {
    async getTaskMetadata(taskId: string, key: string): Promise<string | null> {
      return metadata.get(taskId)?.get(key) ?? null;
    },
    async updateTaskMetadata(taskId: string, key: string, value: string): Promise<void> {
      if (!metadata.has(taskId)) metadata.set(taskId, new Map());
      metadata.get(taskId)!.set(key, value);
    },
    async listTasks(): Promise<Task[]> {
      return tasks;
    },
    async getSessionByTaskId(taskId: string): Promise<Session | null> {
      return sessions.get(taskId) ?? null;
    },
  } as any;
}

function makeTask(id: string, status: Task['status'] = 'interrupted'): Task {
  return { id, status } as Task;
}

/** A session that has already tripped the fast-lane circuit breaker. */
function makeTrippedSession(overrides?: Partial<Session>): Session {
  return {
    ended_at: null,
    consecutive_interruptions: MAX_CONSECUTIVE_INTERRUPTIONS,
    user_stopped: false,
    ...overrides,
  } as Session;
}

function testConfig(overrides?: Partial<ResolvedConfig['daemon']>): ResolvedConfig {
  return {
    daemon: {
      auto_resume: true,
      auto_resume_interval_minutes: 30,
      auto_resume_gap_minutes: 5,
      auto_resume_max_attempts: 24,
      ...overrides,
    },
  } as ResolvedConfig;
}

describe('slow-lane per-task state', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createMockStorage([], new Map());
  });

  const TASK_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  // INVARIANT: A task never attempted starts with a clean slate.
  test('state starts empty', async () => {
    const state = await getSlowLaneState(storage, TASK_ID);
    expect(state).toEqual({ attempts: 0, lastAttemptAt: null, exhausted: false });
  });

  // INVARIANT: Each recorded attempt bumps the count and stamps the timestamp.
  test('recordSlowLaneAttempt increments and stamps', async () => {
    const s1 = await recordSlowLaneAttempt(storage, TASK_ID, 1000, 24);
    expect(s1).toEqual({ attempts: 1, lastAttemptAt: 1000, exhausted: false });

    const s2 = await recordSlowLaneAttempt(storage, TASK_ID, 2000, 24);
    expect(s2).toEqual({ attempts: 2, lastAttemptAt: 2000, exhausted: false });

    const readBack = await getSlowLaneState(storage, TASK_ID);
    expect(readBack).toEqual(s2);
  });

  // INVARIANT: Reaching auto_resume_max_attempts marks the task exhausted —
  // retries stop for good, not just "no longer eligible this round".
  test('exhausted flips true once max attempts is reached', async () => {
    const s1 = await recordSlowLaneAttempt(storage, TASK_ID, 1000, 2);
    expect(s1.exhausted).toBe(false);

    const s2 = await recordSlowLaneAttempt(storage, TASK_ID, 2000, 2);
    expect(s2.exhausted).toBe(true);

    const readBack = await getSlowLaneState(storage, TASK_ID);
    expect(readBack.exhausted).toBe(true);
  });

  // INVARIANT: A fresh chance (successful turn) fully clears slow-lane state,
  // including the exhausted flag — the task can re-enter the slow lane later
  // with a clean attempt count if it starts crashing again.
  test('resetSlowLaneState clears attempts, timestamp, and exhausted', async () => {
    await recordSlowLaneAttempt(storage, TASK_ID, 1000, 1); // exhausts immediately
    expect((await getSlowLaneState(storage, TASK_ID)).exhausted).toBe(true);

    await resetSlowLaneState(storage, TASK_ID);
    expect(await getSlowLaneState(storage, TASK_ID)).toEqual({ attempts: 0, lastAttemptAt: null, exhausted: false });
  });
});

describe('project-wide auto-resume gap file', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'lazy-auto-resume-queue-test-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  // INVARIANT: No file yet means "never attempted" (null), not an error.
  test('null when never attempted', async () => {
    expect(await getLastProjectAutoResumeAt(dataDir)).toBeNull();
  });

  // INVARIANT: A corrupted/unreadable file degrades to "never attempted"
  // rather than throwing — observability must never crash the reconciler.
  test('degrades to null on a corrupt file', async () => {
    const { writeFile, mkdir } = await import('fs/promises');
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'auto-resume-queue.json'), 'not json');
    expect(await getLastProjectAutoResumeAt(dataDir)).toBeNull();
  });
});

describe('listSlowLaneQueue', () => {
  const TASK_A = makeTask('task-a');
  const TASK_B = makeTask('task-b');

  // INVARIANT: Only tasks whose fast-lane breaker has tripped are queued —
  // a freshly-interrupted task (below the threshold) is the fast lane's job.
  test('excludes a task below the circuit-breaker threshold', async () => {
    const sessions = new Map([
      ['task-a', makeTrippedSession({ consecutive_interruptions: MAX_CONSECUTIVE_INTERRUPTIONS - 1 })],
    ]);
    const storage = createMockStorage([TASK_A], sessions);
    const queue = await listSlowLaneQueue(storage, testConfig(), 10_000);
    expect(queue).toEqual([]);
  });

  // INVARIANT: Only 'interrupted' tasks are candidates.
  test('excludes a task that is not in interrupted status', async () => {
    const notInterrupted = makeTask('task-a', 'blocked');
    const sessions = new Map([['task-a', makeTrippedSession()]]);
    const storage = createMockStorage([notInterrupted], sessions);
    const queue = await listSlowLaneQueue(storage, testConfig(), 10_000);
    expect(queue).toEqual([]);
  });

  // INVARIANT: A human `lazy stop` gates the slow lane exactly like the fast
  // lane — user_stopped means "wait for a human", not "keep retrying".
  test('excludes a user-stopped task', async () => {
    const sessions = new Map([['task-a', makeTrippedSession({ user_stopped: true })]]);
    const storage = createMockStorage([TASK_A], sessions);
    const queue = await listSlowLaneQueue(storage, testConfig(), 10_000);
    expect(queue).toEqual([]);
  });

  // INVARIANT: A task that already exhausted its slow-lane attempts is gone
  // for good, not just deprioritized.
  test('excludes an exhausted task', async () => {
    const sessions = new Map([['task-a', makeTrippedSession()]]);
    const storage = createMockStorage([TASK_A], sessions);
    await recordSlowLaneAttempt(storage, 'task-a', 1000, 1); // maxAttempts=1 -> exhausted
    const queue = await listSlowLaneQueue(storage, testConfig(), 10_000);
    expect(queue).toEqual([]);
  });

  // INVARIANT: Round-robin order — never-attempted tasks sort first, then
  // oldest-last-attempt-first, so no single task can hog every retry slot.
  test('orders never-attempted first, then oldest last-attempt first', async () => {
    const sessions = new Map([
      ['task-a', makeTrippedSession()],
      ['task-b', makeTrippedSession()],
    ]);
    const storage = createMockStorage([TASK_A, TASK_B], sessions);
    // task-a already attempted once at t=5000; task-b never attempted.
    await recordSlowLaneAttempt(storage, 'task-a', 5000, 24);

    const queue = await listSlowLaneQueue(storage, testConfig(), 10_000);
    expect(queue.map(e => e.task.id)).toEqual(['task-b', 'task-a']);
  });

  // INVARIANT: intervalEligibleAt is lastAttemptAt + interval for a task
  // that's been attempted, or `now` (immediately eligible) if never attempted.
  test('computes intervalEligibleAt from the configured interval', async () => {
    const sessions = new Map([['task-a', makeTrippedSession()]]);
    const storage = createMockStorage([TASK_A], sessions);
    await recordSlowLaneAttempt(storage, 'task-a', 1_000_000, 24);

    const config = testConfig({ auto_resume_interval_minutes: 10 });
    const now = 1_000_000 + 60_000; // 1 minute after the attempt
    const queue = await listSlowLaneQueue(storage, config, now);
    expect(queue).toHaveLength(1);
    expect(queue[0].intervalEligibleAt).toBe(1_000_000 + 10 * 60_000);
    expect(queue[0].attempts).toBe(1);
    expect(queue[0].maxAttempts).toBe(24);
  });

  // INVARIANT: A never-attempted task still owes a full interval before its
  // first slow-lane retry, counted from when it ENTERED the queue (the
  // interruption that tripped the circuit breaker, session.interrupt_at) —
  // not from whenever listSlowLaneQueue happens to be called. Otherwise a
  // task could sit queued for most of the interval and then retry seconds
  // after being listed, defeating "retried every N minutes".
  test('a never-attempted task becomes eligible one full interval after entering the queue', async () => {
    const enteredQueueAt = 100_000;
    const sessions = new Map([['task-a', makeTrippedSession({ interrupt_at: enteredQueueAt })]]);
    const storage = createMockStorage([TASK_A], sessions);
    const config = testConfig({ auto_resume_interval_minutes: 30 });

    const now = enteredQueueAt + 60_000; // 1 minute after entering — not yet eligible
    const queue = await listSlowLaneQueue(storage, config, now);
    expect(queue[0].intervalEligibleAt).toBe(enteredQueueAt + 30 * 60_000);
  });

  // INVARIANT: If the session predates interrupt_at tracking (legacy data),
  // fall back to `now` rather than crashing or waiting forever.
  test('falls back to now for entry time when session.interrupt_at is missing', async () => {
    const sessions = new Map([['task-a', makeTrippedSession()]]);
    const storage = createMockStorage([TASK_A], sessions);
    const now = 42_000;
    const config = testConfig({ auto_resume_interval_minutes: 10 });
    const queue = await listSlowLaneQueue(storage, config, now);
    expect(queue[0].intervalEligibleAt).toBe(now + 10 * 60_000);
  });
});
