/**
 * The review queue's per-task reads run together.
 *
 * Awaiting comments and the session one blocked task at a time made the review
 * page cost N file reads in a row. Bounded concurrency is the fix; a cache is
 * not.
 */

import { describe, test, expect } from 'bun:test';
import { reviewQueueEntries } from '../../src/daemon/review-service';
import type { Task } from '../../src/types';

describe('reviewQueueEntries', () => {
  // INVARIANT: comment and session reads for the queue overlap. A sequential
  // loop keeps one read in flight; this must keep more than one.
  test('reads several blocked tasks at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tasks = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`, code: null, goal: 'g', status: 'blocked', type: 'task',
      created_at: i, completed_at: null,
    })) as Task[];
    const storage = {
      getTaskReviewComments: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlight -= 1;
        return [];
      },
      getSessionByTaskId: async () => null,
    };

    const entries = await reviewQueueEntries(tasks, new Map(), storage);

    expect(entries).toHaveLength(8);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
