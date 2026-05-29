import { describe, test, expect } from 'bun:test';
import {
  VALID_TRANSITIONS,
  canTransition,
  transitionsTo,
  transitionsFrom,
  assertValidTransition,
  TERMINAL_STATUSES,
  isTerminalStatus,
  isActiveStatus,
  isBlockedStatus,
} from '../../src/task-state-machine';
import type { TaskStatus } from '../../src/types';

// All statuses that exist in the TaskStatus type
const ALL_STATUSES: TaskStatus[] = [
  'backlog', 'working', 'blocked', 'conflict', 'pairing',
  'interrupted', 'submitted', 'merging', 'zombie', 'complete', 'abandoned',
];

describe('task-state-machine', () => {
  // INVARIANT: Every status has defined transitions (even if empty for terminals)
  test('every TaskStatus has an entry in VALID_TRANSITIONS', () => {
    for (const status of ALL_STATUSES) {
      expect(VALID_TRANSITIONS).toHaveProperty(status);
      expect(Array.isArray(VALID_TRANSITIONS[status])).toBe(true);
    }
  });

  // INVARIANT: No status in the transition table is missing from ALL_STATUSES
  test('transition table only contains known statuses', () => {
    for (const [from, tos] of Object.entries(VALID_TRANSITIONS)) {
      expect(ALL_STATUSES).toContain(from as TaskStatus);
      for (const to of tos) {
        expect(ALL_STATUSES).toContain(to as TaskStatus);
      }
    }
  });

  // INVARIANT: Terminal statuses have no outgoing transitions (except reopen to blocked/backlog)
  test('terminal statuses only transition to blocked or backlog via reopen', () => {
    for (const status of TERMINAL_STATUSES) {
      const transitions = transitionsFrom(status as TaskStatus);
      for (const to of transitions) {
        expect(['blocked', 'backlog']).toContain(to);
      }
    }
  });

  // INVARIANT: conflict cannot transition directly to complete (must go through merging)
  test('conflict tasks cannot skip merging', () => {
    expect(canTransition('conflict', 'complete')).toBe(false);
  });

  // INVARIANT: conflict can transition to merging (accept with --approve-file)
  test('conflict tasks can be accepted via merging', () => {
    expect(canTransition('conflict', 'merging')).toBe(true);
  });

  // INVARIANT: conflict can transition to working (via unblock)
  test('conflict tasks can be unblocked', () => {
    expect(canTransition('conflict', 'working')).toBe(true);
  });

  // INVARIANT: working can go to blocked, conflict, interrupted, or merging.
  // merging is needed for externally merged MRs detected by remote-sync
  // (e.g., agent crashed but human merged the MR on the remote).
  // Still cannot go to pairing, closed, abandoned, or directly to complete.
  test('working cannot transition to pairing, closed, or abandoned', () => {
    expect(canTransition('working', 'pairing')).toBe(false);
    expect(canTransition('working', 'abandoned')).toBe(false);
    expect(canTransition('working', 'complete')).toBe(false);
    // working → merging is valid (external merge detection)
    expect(canTransition('working', 'merging')).toBe(true);
  });

  // INVARIANT: blocked cannot go directly to complete (must go through merging)
  test('blocked cannot transition directly to complete', () => {
    expect(canTransition('blocked', 'complete')).toBe(false);
    // But blocked CAN go to merging
    expect(canTransition('blocked', 'merging')).toBe(true);
  });

  // INVARIANT: interrupted can transition to merging (external merge detection)
  // but not directly to complete (must go through merging first).
  test('interrupted can transition to merging but not directly to complete', () => {
    expect(canTransition('interrupted', 'merging')).toBe(true);
    expect(canTransition('interrupted', 'complete')).toBe(false);
  });

  // INVARIANT: merging either succeeds or fails — no abandoning mid-merge
  test('merging cannot transition to abandoned', () => {
    expect(canTransition('merging', 'abandoned')).toBe(false);
    // But merging CAN go to complete or blocked
    expect(canTransition('merging', 'complete')).toBe(true);
    expect(canTransition('merging', 'blocked')).toBe(true);
  });

  // INVARIANT: canTransition and transitionsTo are consistent (reverse lookup)
  test('transitionsTo is the reverse of transitionsFrom', () => {
    for (const status of ALL_STATUSES) {
      const sources = transitionsTo(status);
      for (const source of sources) {
        expect(canTransition(source, status)).toBe(true);
      }
    }

    // And the forward direction: every transition in transitionsFrom
    // should also appear in transitionsTo for the target
    for (const status of ALL_STATUSES) {
      const targets = transitionsFrom(status);
      for (const target of targets) {
        expect(transitionsTo(target)).toContain(status);
      }
    }
  });

  // INVARIANT: assertValidTransition throws with helpful message
  test('invalid transition error includes current status and valid options', () => {
    expect(() => assertValidTransition('backlog', 'complete')).toThrow(/Invalid status transition/);
    expect(() => assertValidTransition('backlog', 'complete')).toThrow(/backlog/);
    expect(() => assertValidTransition('backlog', 'complete')).toThrow(/complete/);
    // Should mention valid transitions
    expect(() => assertValidTransition('backlog', 'complete')).toThrow(/working/);
  });

  test('assertValidTransition allows same-state (idempotent)', () => {
    for (const status of ALL_STATUSES) {
      // Should not throw — same state is always allowed
      expect(() => assertValidTransition(status, status)).not.toThrow();
    }
  });

  test('assertValidTransition allows valid transitions', () => {
    // backlog → working (start)
    expect(() => assertValidTransition('backlog', 'working')).not.toThrow();
    // working → blocked (reconciler)
    expect(() => assertValidTransition('working', 'blocked')).not.toThrow();
    // working → conflict (reconciler with violations)
    expect(() => assertValidTransition('working', 'conflict')).not.toThrow();
    // blocked → working (unblock)
    expect(() => assertValidTransition('blocked', 'working')).not.toThrow();
    // blocked → merging (accept step 1)
    expect(() => assertValidTransition('blocked', 'merging')).not.toThrow();
    // merging → complete (accept step 2)
    expect(() => assertValidTransition('merging', 'complete')).not.toThrow();
    // complete → blocked (reopen)
    expect(() => assertValidTransition('complete', 'blocked')).not.toThrow();
  });

  test('assertValidTransition rejects invalid transitions', () => {
    // backlog cannot go to merging
    expect(() => assertValidTransition('backlog', 'merging')).toThrow();
    // conflict cannot go to complete (must unblock first)
    expect(() => assertValidTransition('conflict', 'complete')).toThrow();
    // pairing cannot go to complete or merging — human is driving,
    // must end pairing (→ blocked) first
    expect(() => assertValidTransition('pairing', 'complete')).toThrow();
    expect(() => assertValidTransition('pairing', 'merging')).toThrow();
    // working cannot go to pairing
    expect(() => assertValidTransition('working', 'pairing')).toThrow();
    // blocked cannot go directly to complete
    expect(() => assertValidTransition('blocked', 'complete')).toThrow();
  });

  describe('zombie status', () => {
    // INVARIANT: zombie is system-only — any non-terminal → zombie with system actor
    test('system can transition any non-terminal status to zombie', () => {
      const nonTerminal: TaskStatus[] = ['backlog', 'working', 'blocked', 'conflict',
        'pairing', 'interrupted', 'merging', 'zombie'];
      for (const status of nonTerminal) {
        expect(() => assertValidTransition(status, 'zombie', 'system')).not.toThrow();
      }
    });

    // INVARIANT: non-system actors cannot transition to zombie
    test('non-system actors cannot transition to zombie', () => {
      expect(() => assertValidTransition('working', 'zombie')).toThrow(/Only system/);
      expect(() => assertValidTransition('working', 'zombie', 'human')).toThrow(/Only system/);
      expect(() => assertValidTransition('blocked', 'zombie', 'builder')).toThrow(/Only system/);
    });

    // INVARIANT: terminal statuses cannot go to zombie
    test('terminal statuses cannot transition to zombie', () => {
      expect(() => assertValidTransition('complete', 'zombie', 'system')).toThrow(/terminal/);
      expect(() => assertValidTransition('abandoned', 'zombie', 'system')).toThrow(/terminal/);
      // 'closed' is no longer a valid TaskStatus — abandoned covers both
    });

    // INVARIANT: zombie can only go to complete
    test('zombie can only transition to complete', () => {
      expect(canTransition('zombie', 'complete')).toBe(true);
      expect(transitionsFrom('zombie')).toEqual(['complete']);
    });

    // INVARIANT: zombie is not terminal (so sweep can complete it)
    test('zombie is not a terminal status', () => {
      expect(isTerminalStatus('zombie')).toBe(false);
    });
  });

  describe('canTransition', () => {
    test('returns true for valid transitions', () => {
      expect(canTransition('backlog', 'working')).toBe(true);
      expect(canTransition('working', 'blocked')).toBe(true);
      expect(canTransition('blocked', 'merging')).toBe(true);
    });

    test('returns false for invalid transitions', () => {
      expect(canTransition('backlog', 'complete')).toBe(false);
      expect(canTransition('complete', 'working')).toBe(false);
      expect(canTransition('pairing', 'working')).toBe(false);
    });
  });

  describe('status classification', () => {
    test('isTerminalStatus identifies terminal statuses', () => {
      expect(isTerminalStatus('complete')).toBe(true);
      expect(isTerminalStatus('abandoned')).toBe(true);
      expect(isTerminalStatus('working')).toBe(false);
      expect(isTerminalStatus('blocked')).toBe(false);
      expect(isTerminalStatus('conflict')).toBe(false);
      expect(isTerminalStatus('zombie')).toBe(false);
      expect(isTerminalStatus('backlog')).toBe(false);
    });

    test('isActiveStatus identifies active statuses', () => {
      expect(isActiveStatus('working')).toBe(true);
      expect(isActiveStatus('interrupted')).toBe(true);
      expect(isActiveStatus('pairing')).toBe(true);
      expect(isActiveStatus('merging')).toBe(true);

      expect(isActiveStatus('blocked')).toBe(false);
      expect(isActiveStatus('conflict')).toBe(false);
      expect(isActiveStatus('zombie')).toBe(false);
      expect(isActiveStatus('backlog')).toBe(false);
      expect(isActiveStatus('complete')).toBe(false);
    });

    // INVARIANT: isBlockedStatus includes conflict (blocked with violations)
    test('isBlockedStatus includes both blocked and conflict', () => {
      expect(isBlockedStatus('blocked')).toBe(true);
      expect(isBlockedStatus('conflict')).toBe(true);

      expect(isBlockedStatus('working')).toBe(false);
      expect(isBlockedStatus('interrupted')).toBe(false);
      expect(isBlockedStatus('zombie')).toBe(false);
      expect(isBlockedStatus('backlog')).toBe(false);
    });
  });

  describe('transitionsFrom', () => {
    test('returns correct forward transitions', () => {
      expect(transitionsFrom('backlog')).toContain('working');
      expect(transitionsFrom('working')).toContain('blocked');
      expect(transitionsFrom('working')).toContain('conflict');
      expect(transitionsFrom('blocked')).toContain('merging');
    });

    test('terminal statuses only go to blocked or backlog', () => {
      const completeTargets = transitionsFrom('complete');
      expect(completeTargets).toContain('blocked');
      expect(completeTargets).toContain('backlog');
      expect(completeTargets).not.toContain('working');
    });
  });

  describe('transitionsTo', () => {
    test('working can be reached from multiple statuses', () => {
      const sources = transitionsTo('working');
      expect(sources).toContain('backlog');
      expect(sources).toContain('blocked');
      expect(sources).toContain('conflict');
      expect(sources).toContain('interrupted');
    });

    // INVARIANT: complete can only be reached from merging or zombie
    // (blocked must go through merging first; interrupted can't be accepted)
    test('complete can only be reached from merging and zombie', () => {
      const sources = transitionsTo('complete');
      expect(sources).toContain('merging');
      expect(sources).toContain('zombie');
      expect(sources).not.toContain('blocked');
      expect(sources).not.toContain('interrupted');
      expect(sources).not.toContain('conflict');
    });
  });
});
