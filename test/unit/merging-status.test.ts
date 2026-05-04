import { describe, test, expect } from 'bun:test';
import { TERMINAL_STATUSES, isTerminalStatus } from '../../src/types';
import type { TaskStatus } from '../../src/types';

/**
 * Tests for the 'merging' task status behavior.
 *
 * The 'merging' status represents a task that has been approved by the human
 * but is waiting for the remote merge to complete (e.g., CI pipeline running,
 * required checks pending, auto-merge queued).
 */

describe('merging task status', () => {
  // INVARIANT: 'merging' is NOT a terminal status.
  // Tasks in 'merging' state are still active — the reconciler and sync
  // command need to check on them and transition to 'complete' when the
  // remote merge finishes.
  test('merging is not a terminal status', () => {
    expect(TERMINAL_STATUSES.has('merging' as TaskStatus)).toBe(false);
    expect(isTerminalStatus('merging' as TaskStatus)).toBe(false);
  });

  // INVARIANT: Terminal statuses are exactly: complete, abandoned.
  // No other status should be terminal. This ensures the reconciler
  // processes all non-terminal tasks correctly.
  test('terminal statuses are exactly complete and abandoned', () => {
    expect(TERMINAL_STATUSES.has('complete')).toBe(true);
    expect(TERMINAL_STATUSES.has('abandoned')).toBe(true);
    expect(TERMINAL_STATUSES.size).toBe(2);
  });

  // INVARIANT: 'merging' is a valid TaskStatus value.
  // This test ensures the type system accepts 'merging' as a valid status.
  test('merging is a valid TaskStatus', () => {
    const status: TaskStatus = 'merging';
    expect(status).toBe('merging');
  });
});
