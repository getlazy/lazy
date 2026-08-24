/**
 * Unit tests: `conflict` is DERIVED from the pending violation set, never
 * asserted or cleared independently of it.
 *
 * THE BUG (fix-ask-nukes-violations). A task in `conflict` had one pending
 * file-permission violation. A `lazy_ask` — documented read-only — ran against
 * it, and afterwards the task read `blocked` while the violation was still
 * pending. The two had fallen out of sync, and the resulting state was
 * literally unexpressible:
 *
 *   - `lazy_unblock` WITH `approved_files` was REFUSED ("this task has no file
 *     permission violations") because that guard read `task.status`;
 *   - `lazy_unblock` WITHOUT it was ACCEPTED, and the daemon's revert — which
 *     reads the violation SET, not the status — then destroyed the agent's
 *     committed work, with a success response and no warning.
 *
 * The model this file pins down: the pending set is the source of truth and
 * `conflict` is a derived label on a paused task. Every path that parks a task
 * as paused derives the label through `parkTaskPaused`, so no side-channel turn
 * (an ask, a sync, a pairing teardown, a stop) can clear a label the pending
 * set still earns.
 *
 * INVARIANTS this file encodes:
 *
 *   1. A turn that ran no permission check reports nothing, and "reported
 *      nothing" is never read as "there is nothing" — a pending set survives.
 *   2. Only pending violations earn `conflict`; resolved ones (approved or
 *      rejected) do not keep a task parked there forever.
 *   3. A freshly detected set earns `conflict` even before it is written to a
 *      turn.
 *   4. Re-deriving the label must always be a legal transition, in BOTH
 *      directions — otherwise the derivation throws instead of correcting.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createStorage, type Storage } from '../../src/storage';
import { pausedStatusFor, parkTaskPaused } from '../../src/utils/paused-status';
import { canTransition } from '../../src/task-state-machine';
import type { Turn, FileViolation } from '../../src/types';

function agentTurn(sequence: number, violations?: FileViolation[]): Turn {
  return {
    id: `t${sequence}`,
    session_id: 's1',
    sequence,
    role: 'agent',
    content: `turn ${sequence}`,
    timestamp: 1000 + sequence,
    ...(violations ? { violations } : {}),
  } as Turn;
}

const PENDING: FileViolation[] = [
  { file: 'test/unit/foo.test.ts', base_sha: 'abc123', status: 'pending' },
];

describe('pausedStatusFor', () => {
  test('a pending violation set means conflict', () => {
    expect(pausedStatusFor([agentTurn(1, PENDING)])).toBe('conflict');
  });

  test('nothing pending means blocked', () => {
    expect(pausedStatusFor([agentTurn(1)])).toBe('blocked');
    expect(pausedStatusFor([])).toBe('blocked');
  });

  // INVARIANT 1: a turn that ran no permission check reports nothing, and that
  // is not evidence of absence. This is the exact shape of the incident: the
  // ask turn detected no violations because an ask detects nothing at all.
  test('a turn that detected nothing cannot clear a pending set', () => {
    const turns = [agentTurn(1, PENDING), agentTurn(2)];

    expect(pausedStatusFor(turns)).toBe('conflict');
    // Omitted `detected` (no check ran) and an explicit empty set (a check ran
    // and found nothing NEW) both leave the recorded pending set standing —
    // only resolving the violations themselves clears them.
    expect(pausedStatusFor(turns, undefined)).toBe('conflict');
    expect(pausedStatusFor(turns, [])).toBe('conflict');
  });

  // INVARIANT 2: resolved violations are not pending, so they do not pin a task
  // in `conflict` after the reviewer has ruled.
  test('approved and rejected violations do not earn conflict', () => {
    const resolved: FileViolation[] = [
      { file: 'a.test.ts', base_sha: 'aaa', status: 'approved' },
      { file: 'b.test.ts', base_sha: 'bbb', status: 'rejected' },
    ];
    expect(pausedStatusFor([agentTurn(1, resolved)])).toBe('blocked');
  });

  // INVARIANT 3: the reconciler parks a task in the same breath as it records
  // the turn, so the freshly detected set must count before it is readable from
  // storage.
  test('a freshly detected set earns conflict before it is on a turn', () => {
    expect(pausedStatusFor([agentTurn(1)], PENDING)).toBe('conflict');
  });
});

describe('parkTaskPaused', () => {
  let testDir: string;
  let storage: Storage;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-paused-status-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });
    storage = await createStorage(testDir, { backend: 'external' });
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  async function workingTaskWith(violations?: FileViolation[]): Promise<string> {
    const task = await storage.createTask('Do the thing');
    const session = await storage.createSession(task.id, 'claude', 'lazy/t', 'HEAD');
    await storage.createTurn({
      sessionId: session.id, sequence: 1, role: 'agent', content: 'work turn',
      ...(violations ? { violations } : {}),
    });
    await storage.updateTaskStatus(task.id, 'working');
    return task.id;
  }

  test('parks a violation-free task as blocked', async () => {
    const taskId = await workingTaskWith();
    expect(await parkTaskPaused(storage, taskId, 'system')).toBe('blocked');
    expect((await storage.getTask(taskId))!.status).toBe('blocked');
  });

  // The load-bearing case: a side-channel turn (ask/sync/pair/stop) finishes on
  // a task that still owes a decision. Before the fix these call sites wrote
  // 'blocked' unconditionally and the label was gone.
  test('parks a task with a pending set as conflict, not blocked', async () => {
    const taskId = await workingTaskWith(PENDING);
    expect(await parkTaskPaused(storage, taskId, 'system')).toBe('conflict');
    expect((await storage.getTask(taskId))!.status).toBe('conflict');
  });

  test('re-parking an already-parked conflict task is a no-op, not a throw', async () => {
    const taskId = await workingTaskWith(PENDING);
    await parkTaskPaused(storage, taskId, 'system');
    // A second park (e.g. reconciler sweep after a stop) must not blow up on an
    // invalid conflict → conflict transition.
    expect(await parkTaskPaused(storage, taskId, 'system')).toBe('conflict');
  });

  // A park that cannot read the turns must not strand the task in `working`.
  // Falling back to `blocked` is exactly what every one of these call sites did
  // before — and the unblock gate still enforces the pending set from storage,
  // so the fallback costs a label, never data.
  test('falls back to blocked when the session cannot be read', async () => {
    const task = await storage.createTask('No session at all');
    await storage.updateTaskStatus(task.id, 'working');
    expect(await parkTaskPaused(storage, task.id, 'system')).toBe('blocked');
  });
});

// INVARIANT 4: deriving the label is a correction, and a correction can point
// either way. `blocked → conflict` (a park that re-reads a set an earlier path
// dropped) and `conflict → blocked` (the reviewer resolved everything) must both
// be legal, or `parkTaskPaused` throws instead of fixing the drift. Removing
// either transition re-opens this bug.
describe('re-deriving the paused label is always a legal transition', () => {
  test('blocked and conflict convert to each other', () => {
    expect(canTransition('blocked', 'conflict')).toBe(true);
    expect(canTransition('conflict', 'blocked')).toBe(true);
  });

  // A pairing session ends by parking the task; if the agent left violations
  // behind, that park is `conflict`.
  test('pairing can park into either paused status', () => {
    expect(canTransition('pairing', 'blocked')).toBe(true);
    expect(canTransition('pairing', 'conflict')).toBe(true);
  });
});
