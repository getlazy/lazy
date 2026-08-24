/**
 * Unit coverage for the stranded-`merging` recovery decisions.
 *
 * The e2e suite (test/e2e/merging-escape.test.ts) proves the wedge and the
 * escape end to end. These tests pin the three judgement calls that the e2e path
 * cannot reach from a CLI subprocess: which resting status a recovery picks,
 * when the automatic sweep is allowed to act, and the owner-liveness primitive
 * the whole design rests on.
 */

import { describe, test, expect } from 'bun:test';
import { TaskMutex } from '../../src/utils/task-mutex';
import {
  strandedMergeRestingStatus,
  shouldSweepStrandedMerge,
} from '../../src/daemon/stranded-merge';

function turnWithViolation() {
  return {
    role: 'agent',
    content: 'did work',
    violations: [{ file: 'src/a.ts', base_sha: 'abc', status: 'pending' }],
  } as any;
}

describe('stranded merge: resting status', () => {
  // INVARIANT: violations are the source of truth. A task that still owes a
  // decision on file-permission violations MUST rest as `conflict`, whatever the
  // accept recorded — the label is derived from the pending set, never asserted
  // independently of it. Getting this wrong silently destroys committed agent
  // work (fix-ask-nukes-violations).
  test('pending violations win over the recorded prior status', () => {
    expect(strandedMergeRestingStatus([turnWithViolation()], 'submitted')).toBe('conflict');
    expect(strandedMergeRestingStatus([turnWithViolation()], 'blocked')).toBe('conflict');
  });

  // INVARIANT: accept restores the TRUE prior status. A task that was `submitted`
  // has an open PR awaiting review; resting it at `blocked` would erase that.
  test('a task that was submitted before the accept goes back to submitted', () => {
    expect(strandedMergeRestingStatus([], 'submitted')).toBe('submitted');
  });

  test('anything else rests at blocked, including an absent marker', () => {
    expect(strandedMergeRestingStatus([], 'blocked')).toBe('blocked');
    expect(strandedMergeRestingStatus([], 'conflict')).toBe('blocked');
    expect(strandedMergeRestingStatus([], null)).toBe('blocked');
  });
});

describe('stranded merge: what the automatic sweep may touch', () => {
  // The marker is stamped by the LOCAL merge phase and cleared by it. Present
  // with no owner means that merge died.
  test('sweeps a dead local merge (marker present) even with a remote driver', () => {
    expect(shouldSweepStrandedMerge({ hasInFlightMarker: true, remoteDriverCanFinishMerge: true })).toBe(true);
  });

  // INVARIANT: a legitimately forge-pending merge is NOT wreckage. `merging` with
  // no marker and a remote driver means driver.merge() handed the PR to the forge
  // and remote-sync is polling it — sweeping that would undo a real merge in
  // flight. Only an explicit human reject/close/submit may move it.
  test('leaves a forge-pending merge alone', () => {
    expect(shouldSweepStrandedMerge({ hasInFlightMarker: false, remoteDriverCanFinishMerge: true })).toBe(false);
  });

  // With the local driver there is no forge that could ever finish the merge, so
  // a markerless `merging` task has nothing coming for it either.
  test('sweeps a markerless merging task when no remote driver could finish it', () => {
    expect(shouldSweepStrandedMerge({ hasInFlightMarker: false, remoteDriverCanFinishMerge: false })).toBe(true);
  });
});

describe('task mutex: owner liveness', () => {
  // The whole recovery design rests on this: an accept holds the task's
  // lifecycle lock for its entire orchestration, so "merging with no lock held"
  // is exactly "the merge has no owner". A dead daemon cannot hold a lock.
  test('isLocked reports a held lock and clears when it drains', async () => {
    const mutex = new TaskMutex();
    expect(mutex.isLocked('t1')).toBe(false);

    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const running = mutex.withLock('t1', () => held);

    expect(mutex.isLocked('t1')).toBe(true);
    expect(mutex.isLocked('t2')).toBe(false);

    release();
    await running;
    expect(mutex.isLocked('t1')).toBe(false);
  });

  // A human escaping a wedged task must not block behind a merge that may run
  // for minutes — it refuses with an explanation instead.
  test('tryWithLock refuses instead of queueing behind a live operation', async () => {
    const mutex = new TaskMutex();
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const running = mutex.withLock('t1', () => held);

    const refused = await mutex.tryWithLock('t1', async () => 'should not run');
    expect(refused.ran).toBe(false);

    release();
    await running;

    const ran = await mutex.tryWithLock('t1', async () => 'ok');
    expect(ran).toEqual({ ran: true, value: 'ok' });
  });
});
