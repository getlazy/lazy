/**
 * `lazy stop` routes by the in-flight CLAIM, and the claim outranks the status.
 *
 * WHY THIS EXISTS. A live ask/review claim on a task whose status says `blocked`
 * is a real state — the turn is running, or it died and nothing released its
 * record — and while the routing was gated on `working` there was no way out of
 * it. `teams-raised-cluster-row-one-size` sat in exactly that state on
 * 2026-09-20: `lazy_review` refused with "already has a synchronous turn in
 * flight", `lazy_stop` refused with "blocked, not working", and the only exit
 * was the 24-hour backstop.
 *
 * The daemon now reaches the same ending on its own (`sweepPausedSyncClaims`);
 * this rule is the human's door to it, so it is asserted directly rather than
 * left implicit in a branch.
 */

import { describe, test, expect } from 'bun:test';
import { stoppableClaimOf } from '../../src/daemon/in-flight-turn';
import { IN_FLIGHT_ASYNC_BACKSTOP_MS } from '../../src/daemon/in-flight-turn';
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

function task(status: TaskStatus, inFlight?: InFlightTurn): Task {
  return {
    id: 'task-1',
    status,
    goal: 'g',
    ...(inFlight ? { in_flight_turn: inFlight } : {}),
  } as unknown as Task;
}

describe('stoppableClaimOf', () => {
  // INVARIANT: the claim outranks the status. A parked task carrying a live
  // review claim is the wedge this verb has to be able to open.
  test('a live review claim is stoppable whatever the status says', () => {
    for (const status of ['working', 'blocked', 'conflict', 'submitted', 'interrupted'] as TaskStatus[]) {
      expect(stoppableClaimOf(task(status, claim()))).not.toBeNull();
    }
  });

  test('an ask claim too — same asynchronous shape, same dead end without it', () => {
    expect(stoppableClaimOf(task('blocked', claim({ owner: 'ask', turn_type: 'ask' })))).not.toBeNull();
  });

  // INVARIANT: no claim means the ORDINARY stop path, which still refuses a task
  // that is not `working` — `lazy close` is the verb for those, and nothing
  // about this change loosens that.
  test('no claim, no claim route', () => {
    expect(stoppableClaimOf(task('blocked'))).toBeNull();
    expect(stoppableClaimOf(task('working'))).toBeNull();
  });

  test('an expired claim is not stoppable — its restore path owns it', () => {
    expect(stoppableClaimOf(task('blocked', claim({ expires_at: Date.now() - 1 })))).toBeNull();
  });

  test('a claim that already has an outcome is over', () => {
    const settled = claim({
      outcome: { kind: 'completed', settled_at: Date.now() },
    } as Partial<InFlightTurn>);
    expect(stoppableClaimOf(task('working', settled))).toBeNull();
  });

  // `wrap_up` and `pre_accept` run inside a call that owns their ending; a
  // second ender for one of those is how a turn gets recorded twice.
  test('a wrap_up claim is not this verb\'s business', () => {
    expect(stoppableClaimOf(task('working', claim({ owner: 'wrap_up' as InFlightTurnOwner })))).toBeNull();
  });
});
