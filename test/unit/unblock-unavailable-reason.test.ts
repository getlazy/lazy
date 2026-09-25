import { describe, test, expect } from 'bun:test';
import { unblockUnavailableReason } from '../../src/server/review-actions';

describe('unblockUnavailableReason', () => {
  // INVARIANT: the review action row's Unblock is enabled exactly where
  // launchUnblockTask would take it — blocked, conflict, submitted and
  // interrupted (merging too, via its escape hatch) — and disabled with a
  // reason everywhere else. A mismatch either hides a working verb or offers a
  // click the daemon refuses.
  test('the statuses an unblock resumes from are enabled', () => {
    for (const status of ['blocked', 'conflict', 'submitted', 'interrupted', 'merging']) {
      expect(unblockUnavailableReason(status)).toBeNull();
    }
  });

  test('busy, finished and unstarted tasks are refused with a reason naming the status', () => {
    expect(unblockUnavailableReason('working')).toContain('working');
    expect(unblockUnavailableReason('pairing')).toContain('pairing');
    expect(unblockUnavailableReason('complete')).toContain('complete');
    expect(unblockUnavailableReason('abandoned')).toContain('abandoned');
    expect(unblockUnavailableReason('backlog')).toContain('not started');
  });
});
