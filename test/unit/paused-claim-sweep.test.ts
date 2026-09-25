/**
 * A live ask/review claim on a task that is NOT `working` must be swept.
 *
 * WHY THIS EXISTS. The reconciler's primary sweep visits `working` tasks only,
 * and `sweepPausedResponses` deliberately skips any task carrying a claim — so a
 * live ask/review claim on a PAUSED task is in a dead zone: nothing settles the
 * answer its container writes, nothing notices its run died, and the claim
 * itself suppresses every automatic launch that reads `isTurnInFlight`,
 * including the auto-review retry. `teams-raised-cluster-row-one-size` sat there
 * on 2026-09-20 after a refused review dispatch reverted the status of a task
 * whose other review had just started: the running review became unsettleable
 * and no later tick would look at the task for 24 hours.
 *
 * `needsPausedClaimSweep` is that sweep's selection rule. The revert is fixed at
 * its source; this net is what makes the next such path cost a delayed turn
 * rather than a wedged task.
 */

import { describe, test, expect } from 'bun:test';
import { needsPausedClaimSweep } from '../../src/utils/reconcile';
import { IN_FLIGHT_ASYNC_BACKSTOP_MS, isInFlightLive } from '../../src/daemon/in-flight-turn';
import type { InFlightTurn, InFlightTurnOwner, Task, TaskStatus } from '../../src/types';

function claim(overrides: Partial<InFlightTurn> = {}): InFlightTurn {
  const now = Date.now();
  return {
    session_id: 'sess-1',
    owner: 'review' as InFlightTurnOwner,
    turn_type: 'review',
    command_id: 'cmd-1',
    turn_sequence: 5,
    human_turn_sequence: 4,
    restore_status: 'blocked',
    started_at: now,
    expires_at: now + IN_FLIGHT_ASYNC_BACKSTOP_MS,
    ...overrides,
  } as InFlightTurn;
}

function task(status: TaskStatus, inFlight: InFlightTurn | undefined): Task {
  return {
    id: 'task-1',
    status,
    goal: 'g',
    ...(inFlight ? { in_flight_turn: inFlight } : {}),
  } as unknown as Task;
}

describe('needsPausedClaimSweep', () => {
  test('a live review claim on a parked task is swept', () => {
    for (const status of ['blocked', 'conflict', 'submitted', 'interrupted'] as TaskStatus[]) {
      expect(needsPausedClaimSweep(task(status, claim()))).toBe(true);
    }
  });

  test('an ask claim too — same dead zone, same owner shape', () => {
    expect(needsPausedClaimSweep(task('blocked', claim({ owner: 'ask', turn_type: 'ask' })))).toBe(true);
  });

  // INVARIANT: `working` belongs to the primary sweep, which settles the claim
  // itself. Two settlers for one record is how a turn gets recorded twice.
  test('a working task is left to the primary sweep', () => {
    expect(needsPausedClaimSweep(task('working', claim()))).toBe(false);
  });

  test('a terminal task is never swept, whatever its record says', () => {
    expect(needsPausedClaimSweep(task('complete', claim()))).toBe(false);
    expect(needsPausedClaimSweep(task('abandoned', claim()))).toBe(false);
  });

  test('no claim, nothing to do', () => {
    expect(needsPausedClaimSweep(task('blocked', undefined))).toBe(false);
  });

  // An EXPIRED record is `expiredSyncRestore`'s business (restore, never
  // interrupt), and a SETTLED one past its grace is pickup debris. Neither is a
  // turn this sweep may act on.
  test('an expired claim is left to the restore path', () => {
    expect(needsPausedClaimSweep(task('blocked', claim({ expires_at: Date.now() - 1 })))).toBe(false);
  });

  test('a claim already settled and past its pickup grace is debris', () => {
    const settled = claim({
      outcome: { kind: 'completed', settled_at: Date.now() - 10 * 60 * 1000 },
    } as Partial<InFlightTurn>);
    expect(needsPausedClaimSweep(task('blocked', settled))).toBe(false);
  });

  // INVARIANT: a SETTLED record is never this sweep's business, and the pickup
  // grace is exactly when that is easiest to get wrong. `isInFlightLive` stays
  // TRUE for a record carrying an outcome until IN_FLIGHT_SETTLED_GRACE_MS
  // elapses — that grace is what keeps auto-resume and auto-deliver off a task
  // whose outcome a waiter has not read yet. Selecting inside it meant a review
  // that settled cleanly and parked its task was re-swept on the next tick,
  // found nothing to settle, fell through to the abandon path, and after the
  // run-death grace logged a false "never answered" while releasing the claim
  // and deleting the review mailbox the grace was still protecting.
  test('a claim settled but still WITHIN its pickup grace is left alone', () => {
    const justSettled = claim({
      outcome: { kind: 'completed', settled_at: Date.now() - 1_000 },
    } as Partial<InFlightTurn>);
    // The premise: this record still reads as live, which is why the outcome
    // check has to be its own.
    expect(isInFlightLive(justSettled)).toBe(true);
    expect(needsPausedClaimSweep(task('blocked', justSettled))).toBe(false);

    // Including the error ending, which is the one a review crash produces.
    const settledError = claim({
      outcome: { kind: 'error', message: 'spend limit', settled_at: Date.now() - 1_000 },
    } as Partial<InFlightTurn>);
    expect(needsPausedClaimSweep(task('submitted', settledError))).toBe(false);
  });

  // INVARIANT: only the statuses the sweep can HOP FROM. Settling goes through
  // `working`, and neither of these has an edge to it — the hop would throw and
  // the claim would survive anyway. `pairing` is also a correctness case rather
  // than a wasted tick: a human is in that session, and their task's claim is
  // not this net's to settle under them.
  test('pairing and merging are excluded — no edge to working, and a human is in the pairing session', () => {
    expect(needsPausedClaimSweep(task('pairing', claim()))).toBe(false);
    expect(needsPausedClaimSweep(task('merging', claim()))).toBe(false);
  });

  // The other owners have (or had) a waiter of their own; this net does not
  // invent a second settler for them.
  test('a wrap_up claim is not this sweep\'s business', () => {
    expect(needsPausedClaimSweep(task('blocked', claim({ owner: 'wrap_up' as InFlightTurnOwner })))).toBe(false);
  });
});
