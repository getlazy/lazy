import { test, expect } from 'bun:test';
import { findPendingFeedback } from '../../src/utils/feedback-redelivery';
import type { Turn } from '../../src/types';

const turn = (sequence: number, extra: Partial<Turn>): Turn =>
  ({ id: `t${sequence}`, sequence, role: 'human', content: `c${sequence}`, ...extra }) as Turn;

// INVARIANT: feedback saved while its launch was refused is owed to the next
// UNBLOCK, never to a resume — a resume redelivering it would present a refused
// member's words as the interrupted turn's instruction and deliver them twice.
test('a withheld turn is never the pending feedback a resume redelivers', () => {
  const turns = [
    turn(2, { feedback_delivery: 'pending' }),
    turn(4, { feedback_delivery: 'pending', feedback_withheld: true }),
  ];
  const pending = findPendingFeedback(turns);
  expect(pending?.turn.sequence).toBe(2);
  expect(pending?.olderPendingCount).toBe(0);
  expect(findPendingFeedback([turns[1]])).toBeNull();
});
