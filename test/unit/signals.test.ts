/**
 * Unit tests for the durable signal queue (src/daemon/signals.ts).
 *
 * These tests verify the core invariants:
 * - Signals are persisted to disk and survive "restarts" (re-reads)
 * - Multiple concurrent signals for the same task are all preserved
 * - Signals are consumed (deleted) after delivery
 * - Signal summaries are correctly built for prompt injection
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  emitSignal,
  readSignals,
  hasSignals,
  consumeSignals,
  consumeSignalsById,
  consumeSignalsAtomically,
  buildSignalSummary,
  resetSignalDb,
  type TaskSignal,
} from '../../src/daemon/signals';

// Use a temp directory as protocol base for isolation
let tempDir: string;
const FAKE_TASK_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lazy-signal-test-'));
  // Override the protocol base so signals go to our temp dir
  process.env.LAZY_PROTOCOL_BASE = tempDir;
  // Force re-open of the DB at the new path
  resetSignalDb();
});

afterEach(() => {
  resetSignalDb();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.LAZY_PROTOCOL_BASE;
});

describe('emitSignal', () => {
  // INVARIANT: Signals are durable — written to disk, not held in memory.
  // A daemon restart must not lose pending signals.
  test('writes a signal that survives process restart simulation', () => {
    emitSignal(FAKE_TASK_ID, {
      type: 'comment',
      summary: 'New comment added',
    });

    // Simulate "restart" by closing and re-opening the DB
    resetSignalDb();

    const signals = readSignals(FAKE_TASK_ID);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('comment');
    expect(signals[0].summary).toBe('New comment added');
    expect(signals[0].id).toBeTruthy();
    expect(signals[0].created_at).toBeTruthy();
  });

  test('returns the created signal with id and timestamp', () => {
    const signal = emitSignal(FAKE_TASK_ID, {
      type: 'ci_result',
      summary: 'CI failed: tests',
      details: { exit_code: 1 },
    });

    expect(signal.id).toBeTruthy();
    expect(signal.type).toBe('ci_result');
    expect(signal.summary).toBe('CI failed: tests');
    expect(signal.details).toEqual({ exit_code: 1 });
    expect(signal.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('multiple concurrent signals', () => {
  // INVARIANT: Multiple signals for the same task must all be preserved.
  // When both sync-with-parent AND CI failure arrive, neither is lost.
  test('preserves all signals when multiple arrive concurrently', () => {
    emitSignal(FAKE_TASK_ID, {
      type: 'upstream_change',
      summary: 'Parent branch main has 3 new commits',
    });

    emitSignal(FAKE_TASK_ID, {
      type: 'ci_result',
      summary: 'CI check "tests" failed with exit code 1',
      details: { check_name: 'tests', exit_code: 1 },
    });

    emitSignal(FAKE_TASK_ID, {
      type: 'comment',
      summary: 'New comment from reviewer',
    });

    const signals = readSignals(FAKE_TASK_ID);
    expect(signals).toHaveLength(3);

    const types = signals.map(s => s.type).sort();
    expect(types).toEqual(['ci_result', 'comment', 'upstream_change']);
  });

  // INVARIANT: Multiple signals of the same type are NOT deduplicated at storage level.
  // Deduplication happens at the consumption level (buildSignalSummary or auto-react).
  test('allows duplicate signal types', () => {
    emitSignal(FAKE_TASK_ID, {
      type: 'comment',
      summary: 'First comment',
    });

    emitSignal(FAKE_TASK_ID, {
      type: 'comment',
      summary: 'Second comment',
    });

    const signals = readSignals(FAKE_TASK_ID);
    expect(signals).toHaveLength(2);
    expect(signals[0].summary).toBe('First comment');
    expect(signals[1].summary).toBe('Second comment');
  });
});

describe('readSignals', () => {
  test('returns empty array for task with no signals', () => {
    const signals = readSignals('nonexistent-task-id');
    expect(signals).toEqual([]);
  });

  // INVARIANT: Signals are returned in chronological order (oldest first).
  test('returns signals in chronological order', () => {
    emitSignal(FAKE_TASK_ID, { type: 'upstream_change', summary: 'first' });
    emitSignal(FAKE_TASK_ID, { type: 'ci_result', summary: 'second' });
    emitSignal(FAKE_TASK_ID, { type: 'comment', summary: 'third' });

    const signals = readSignals(FAKE_TASK_ID);
    expect(signals[0].summary).toBe('first');
    expect(signals[1].summary).toBe('second');
    expect(signals[2].summary).toBe('third');
  });
});

describe('hasSignals', () => {
  test('returns false when no signals exist', () => {
    expect(hasSignals('nonexistent-task-id')).toBe(false);
  });

  test('returns true when signals exist', () => {
    emitSignal(FAKE_TASK_ID, { type: 'comment', summary: 'test' });
    expect(hasSignals(FAKE_TASK_ID)).toBe(true);
  });

  test('returns false after all signals are consumed', () => {
    emitSignal(FAKE_TASK_ID, { type: 'comment', summary: 'test' });
    consumeSignals(FAKE_TASK_ID);
    expect(hasSignals(FAKE_TASK_ID)).toBe(false);
  });
});

describe('consumeSignals', () => {
  // INVARIANT: Consumed signals are deleted and cannot be re-delivered.
  test('removes all signals after consumption', () => {
    emitSignal(FAKE_TASK_ID, { type: 'comment', summary: 'one' });
    emitSignal(FAKE_TASK_ID, { type: 'ci_result', summary: 'two' });

    expect(readSignals(FAKE_TASK_ID)).toHaveLength(2);
    consumeSignals(FAKE_TASK_ID);
    expect(readSignals(FAKE_TASK_ID)).toHaveLength(0);
  });

  test('is idempotent — consuming empty queue is safe', () => {
    consumeSignals(FAKE_TASK_ID);
    consumeSignals('nonexistent-task-id');
    // No error thrown
  });
});

describe('consumeSignalsById', () => {
  // INVARIANT: Only specified signals are consumed; others remain.
  // This prevents signal loss when new signals arrive during delivery.
  test('consumes only the specified signal IDs', () => {
    const s1 = emitSignal(FAKE_TASK_ID, { type: 'comment', summary: 'keep this' });
    const s2 = emitSignal(FAKE_TASK_ID, { type: 'ci_result', summary: 'consume this' });
    const s3 = emitSignal(FAKE_TASK_ID, { type: 'upstream_change', summary: 'keep this too' });

    consumeSignalsById(FAKE_TASK_ID, [s2.id]);

    const remaining = readSignals(FAKE_TASK_ID);
    expect(remaining).toHaveLength(2);
    expect(remaining.map(s => s.type).sort()).toEqual(['comment', 'upstream_change']);
  });

  test('is safe with empty signal IDs array', () => {
    emitSignal(FAKE_TASK_ID, { type: 'comment', summary: 'test' });
    consumeSignalsById(FAKE_TASK_ID, []);
    expect(readSignals(FAKE_TASK_ID)).toHaveLength(1);
  });
});

describe('consumeSignalsAtomically', () => {
  // INVARIANT: Callback and signal deletion happen in one transaction.
  test('runs callback and consumes signals atomically', () => {
    const s1 = emitSignal(FAKE_TASK_ID, { type: 'comment', summary: 'test' });
    let callbackRan = false;

    consumeSignalsAtomically(FAKE_TASK_ID, [s1.id], () => {
      callbackRan = true;
    });

    expect(callbackRan).toBe(true);
    expect(readSignals(FAKE_TASK_ID)).toHaveLength(0);
  });

  test('rolls back on callback failure', () => {
    const s1 = emitSignal(FAKE_TASK_ID, { type: 'comment', summary: 'should survive' });

    expect(() => {
      consumeSignalsAtomically(FAKE_TASK_ID, [s1.id], () => {
        throw new Error('callback failed');
      });
    }).toThrow('callback failed');

    // Signal should still exist (transaction rolled back)
    expect(readSignals(FAKE_TASK_ID)).toHaveLength(1);
  });

  test('runs callback without signals', () => {
    let callbackRan = false;
    consumeSignalsAtomically(FAKE_TASK_ID, [], () => {
      callbackRan = true;
    });
    expect(callbackRan).toBe(true);
  });
});

describe('buildSignalSummary', () => {
  test('returns empty string for no signals', () => {
    expect(buildSignalSummary([])).toBe('');
  });

  test('builds summary with upstream changes', () => {
    const signals: TaskSignal[] = [{
      id: '1',
      type: 'upstream_change',
      created_at: new Date().toISOString(),
      summary: 'Parent branch main has 3 new commits',
    }];

    const summary = buildSignalSummary(signals);
    expect(summary).toContain('Upstream changes');
    expect(summary).toContain('3 new commits');
  });

  test('builds summary with multiple signal types', () => {
    const signals: TaskSignal[] = [
      {
        id: '1',
        type: 'upstream_change',
        created_at: new Date().toISOString(),
        summary: 'Parent has new commits',
      },
      {
        id: '2',
        type: 'ci_result',
        created_at: new Date().toISOString(),
        summary: 'Tests failed',
      },
      {
        id: '3',
        type: 'comment',
        created_at: new Date().toISOString(),
        summary: 'Review comment',
      },
    ];

    const summary = buildSignalSummary(signals);
    expect(summary).toContain('## Signals since your last turn');
    expect(summary).toContain('Upstream changes');
    expect(summary).toContain('CI result');
    expect(summary).toContain('New comment');
  });

  test('shows count for multiple comments', () => {
    const signals: TaskSignal[] = [
      { id: '1', type: 'comment', created_at: new Date().toISOString(), summary: 'c1' },
      { id: '2', type: 'comment', created_at: new Date().toISOString(), summary: 'c2' },
      { id: '3', type: 'comment', created_at: new Date().toISOString(), summary: 'c3' },
    ];

    const summary = buildSignalSummary(signals);
    expect(summary).toContain('3 new comments');
  });

  test('uses latest upstream signal when multiple exist', () => {
    const signals: TaskSignal[] = [
      { id: '1', type: 'upstream_change', created_at: '2026-01-01T00:00:00Z', summary: 'old update' },
      { id: '2', type: 'upstream_change', created_at: '2026-01-02T00:00:00Z', summary: 'latest update' },
    ];

    const summary = buildSignalSummary(signals);
    expect(summary).toContain('latest update');
    expect(summary).not.toContain('old update');
  });

  test('builds summary with child_completed signals', () => {
    const signals: TaskSignal[] = [{
      id: '1',
      type: 'child_completed',
      created_at: new Date().toISOString(),
      summary: 'Child task abc12345 is blocked',
    }];

    const summary = buildSignalSummary(signals);
    expect(summary).toContain('Child task completed');
    expect(summary).toContain('abc12345');
  });

  test('builds summary with child_failed signals', () => {
    const signals: TaskSignal[] = [{
      id: '1',
      type: 'child_failed',
      created_at: new Date().toISOString(),
      summary: 'Child task def67890 failed (interrupted)',
    }];

    const summary = buildSignalSummary(signals);
    expect(summary).toContain('Child task failed');
    expect(summary).toContain('def67890');
  });
});

describe('signal durability across daemon restart', () => {
  // INVARIANT: This is the core requirement — signals must not be lost
  // when the daemon restarts.
  test('signals persist across simulated daemon restart (close + reopen DB)', () => {
    // Phase 1: "Daemon instance 1" emits signals
    emitSignal(FAKE_TASK_ID, {
      type: 'upstream_change',
      summary: 'Branch updated',
    });
    emitSignal(FAKE_TASK_ID, {
      type: 'ci_result',
      summary: 'CI failed',
      details: { check: 'tests', exit_code: 1 },
    });

    // Phase 2: "Daemon instance 2" reads signals (simulating restart)
    // Close and reopen the database — no in-memory state carried over
    resetSignalDb();

    const signals = readSignals(FAKE_TASK_ID);
    expect(signals).toHaveLength(2);

    const types = new Set(signals.map(s => s.type));
    expect(types.has('upstream_change')).toBe(true);
    expect(types.has('ci_result')).toBe(true);

    // Verify full signal data is intact
    const ciSignal = signals.find(s => s.type === 'ci_result')!;
    expect(ciSignal.summary).toBe('CI failed');
    expect(ciSignal.details).toEqual({ check: 'tests', exit_code: 1 });
  });
});

describe('signal isolation between tasks', () => {
  test('signals for different tasks are independent', () => {
    const taskA = 'aaaaaaaa-1111-1111-1111-111111111111';
    const taskB = 'bbbbbbbb-2222-2222-2222-222222222222';

    emitSignal(taskA, { type: 'comment', summary: 'for A' });
    emitSignal(taskB, { type: 'ci_result', summary: 'for B' });

    const signalsA = readSignals(taskA);
    const signalsB = readSignals(taskB);

    expect(signalsA).toHaveLength(1);
    expect(signalsA[0].type).toBe('comment');

    expect(signalsB).toHaveLength(1);
    expect(signalsB[0].type).toBe('ci_result');

    // Consuming A's signals doesn't affect B
    consumeSignals(taskA);
    expect(readSignals(taskA)).toHaveLength(0);
    expect(readSignals(taskB)).toHaveLength(1);
  });
});
