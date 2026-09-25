/**
 * Which run speaks for a `working` task (src/utils/working-run.ts).
 *
 * INVARIANT: the read surfaces and the reconciler resolve the SAME run. A live
 * ask/review claim that names a run is that run — its runner, its name, and
 * (for a review) its own mailbox; anything else is the work run on the
 * session's runner. When they resolved different runs, a live reviewer on a
 * task whose work container was gone rendered `working(not-alive)` for its whole
 * run while the reconciler, correctly, waited on it.
 */

import { describe, test, expect } from 'bun:test';
import { resolveWorkingRun, resolveWorkRun, computeTaskWorkingSubstate, probeWorkingRun } from '../../src/utils/working-run';
import { beginLaunch, endLaunch } from '../../src/runner/launch-in-flight';
import { protocolDir, reviewProtocolDir } from '../../src/protocol/io';
import type { Runner } from '../../src/runner';
import type { InFlightTurn, Session, Task } from '../../src/types';

const TASK_ID = '0123abcd-0000-4000-8000-000000000000';

const runner = {
  type: 'docker',
  runNameForTask: (ref: string) => `lazy-${ref}`,
  isRunning: async () => false,
} as unknown as Runner;

function task(claim: Partial<InFlightTurn> | null): Task {
  return {
    id: TASK_ID,
    metadata: {},
    in_flight_turn: claim
      ? {
          session_id: 's',
          owner: 'review',
          turn_type: 'review',
          turn_sequence: 4,
          restore_status: 'blocked',
          started_at: Date.now() - 1_000,
          expires_at: Date.now() + 60_000,
          ...claim,
        } as InFlightTurn
      : null,
  } as unknown as Task;
}

const session = { container_name: 'lazy-0123abcd', runner_type: 'docker' } as Pick<Session, 'container_name' | 'runner_type'>;

describe('resolveWorkingRun', () => {
  test('a live review claim with a run name is the review run, read from the review mailbox', async () => {
    const run = await resolveWorkingRun('/nowhere', task({ run_name: 'lazy-review-0123abcd', runner_type: 'docker' }), session, runner);
    expect(run.runName).toBe('lazy-review-0123abcd');
    expect(run.protoDir).toBe(reviewProtocolDir(TASK_ID));
    expect(run.claim?.owner).toBe('review');
  });

  test('a live ask claim is its run, read from the task mailbox it shares with the work run', async () => {
    const run = await resolveWorkingRun('/nowhere', task({ owner: 'ask', turn_type: 'ask', run_name: 'lazy-0123abcd' }), session, runner);
    expect(run.runName).toBe('lazy-0123abcd');
    expect(run.protoDir).toBe(protocolDir(TASK_ID));
  });

  test('a claim with no run name yet (launch in progress) falls back to the work run', async () => {
    const run = await resolveWorkingRun('/nowhere', task({}), session, runner);
    expect(run.runName).toBe('lazy-0123abcd');
    expect(run.protoDir).toBe(protocolDir(TASK_ID));
    expect(run.claim).toBeNull();
  });

  test('an expired claim does not speak for the task', async () => {
    const run = await resolveWorkingRun('/nowhere', task({ run_name: 'lazy-review-0123abcd', expires_at: Date.now() - 1 }), session, runner);
    expect(run.runName).toBe('lazy-0123abcd');
  });

  test('no claim: the session container, else the runner name for the task', async () => {
    expect((await resolveWorkingRun('/nowhere', task(null), session, runner)).runName).toBe('lazy-0123abcd');
    const unnamed = await resolveWorkRun('/nowhere', task(null), { container_name: null, runner_type: null }, runner);
    expect(unnamed.runName).toBe('lazy-0123abcd');
    expect(unnamed.runner).toBe(runner);
  });
});

describe('computeTaskWorkingSubstate', () => {
  // INVARIANT: no run + a launch in flight in this daemon is `launching`; no run
  // and no launch is `not-alive`. Both are the reconciler's own reading: it
  // skips the first and acts on the second.
  test('a run being launched is launching, the same run with no launch is not-alive', async () => {
    beginLaunch('lazy-0123abcd', TASK_ID);
    try {
      expect(await computeTaskWorkingSubstate('/nowhere', task(null), session, runner)).toEqual({ kind: 'launching' });
    } finally {
      endLaunch('lazy-0123abcd', TASK_ID);
    }
    expect(await computeTaskWorkingSubstate('/nowhere', task(null), session, runner)).toEqual({ kind: 'not-alive' });
  });
});

describe('probeWorkingRun when the runtime does not answer', () => {
  // INVARIANT: a lookup the runtime never answered is "liveness unknown", never
  // `not-alive` — read surfaces and `lazy daemon health` share this answer, so
  // neither calls a run dead that nothing confirmed dead.
  test('no answer yields unknown liveness and no substate', async () => {
    const silent = {
      ...runner,
      probeRunInfo: async () => ({ kind: 'no-answer', reason: 'docker inspect did not answer within 10s' }),
    } as unknown as Runner;
    const probe = await probeWorkingRun('/nowhere', task(null), session, silent);
    expect(probe.livenessUnknown).toBe('docker inspect did not answer within 10s');
    expect(probe.substate).toBeNull();
  });

  test('an answered "no such run" is still not-alive', async () => {
    const answers = { ...runner, probeRunInfo: async () => ({ kind: 'answered', info: null }) } as unknown as Runner;
    const probe = await probeWorkingRun('/nowhere', task(null), session, answers);
    expect(probe.livenessUnknown).toBeUndefined();
    expect(probe.substate).toEqual({ kind: 'not-alive' });
    expect(probe.info).toBeNull();
  });
});

describe('probeWorkingRun asks the extra lookup only for a run that looks dead', () => {
  test('a live run is never inspected', async () => {
    let probed = 0;
    const live = { ...runner, isRunning: async () => true, probeRunInfo: async () => { probed++; return { kind: 'answered', info: null }; } } as unknown as Runner;
    const probe = await probeWorkingRun('/nowhere', task(null), session, live);
    expect(probed).toBe(0);
    expect(probe.alive).toBe(true);
    expect(probe.livenessUnknown).toBeUndefined();
  });

  // INVARIANT: when the runtime's two answers disagree (not listed as running,
  // yet inspects as running), nothing confirmed the run dead — liveness unknown.
  test('a not-listed run that inspects as running is unknown, not not-alive', async () => {
    const torn = { ...runner, probeRunInfo: async () => ({ kind: 'answered', info: { running: true, exitCode: null, finishedAt: null } }) } as unknown as Runner;
    const probe = await probeWorkingRun('/nowhere', task(null), session, torn);
    expect(probe.livenessUnknown).toContain('disagreed');
    expect(probe.substate).toBeNull();
  });
});
