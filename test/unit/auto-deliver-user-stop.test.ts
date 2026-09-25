import { describe, expect, test } from 'bun:test';
import { deliverCISignals, deliverUpstreamUpdated } from '../../src/daemon/auto-deliver';
import type { Session, Task } from '../../src/types';

function stoppedTask(): Task {
  return {
    id: 'task-stopped',
    code: 'stopped-task',
    goal: 'Stay stopped',
    status: 'blocked',
    created_at: Date.now(),
    updated_at: Date.now(),
  } as unknown as Task;
}

function stoppedStorage() {
  let sessionReads = 0;
  return {
    storage: {
      async getSessionByTaskId(): Promise<Session> {
        sessionReads += 1;
        return { id: 'session-stopped', task_id: 'task-stopped', user_stopped: true } as Session;
      },
    },
    sessionReads: () => sessionReads,
  };
}

describe('auto-delivery user-stop gate', () => {
  // INVARIANT: an upstream change must not restart a task deliberately stopped
  // by a user; returning false leaves the durable signal queued for later.
  test('defers upstream-change delivery for a deliberately stopped task', async () => {
    const fake = stoppedStorage();

    const delivered = await deliverUpstreamUpdated(
      fake.storage as never,
      stoppedTask(),
      '/unused-while-stopped',
      'signal_queue',
    );

    expect(delivered).toBe(false);
    expect(fake.sessionReads()).toBe(1);
  });

  // INVARIANT: a CI failure must not restart a task deliberately stopped by a
  // user; returning false leaves the durable signal queued for later.
  test('defers CI-result delivery for a deliberately stopped task', async () => {
    const fake = stoppedStorage();

    const delivered = await deliverCISignals(
      fake.storage as never,
      stoppedTask(),
      [{ summary: 'pipeline failed' }],
      '/unused-while-stopped',
    );

    expect(delivered).toBe(false);
    expect(fake.sessionReads()).toBe(1);
  });
});
