/**
 * `resolveFinalState` — whether a task has been declared done, and whether that
 * declaration still stands.
 *
 * INVARIANT: only an agent WORK turn that PRODUCED COMMITS un-finals. All three
 * must hold — `role === 'agent'`, `turn_type` is 'work' (absent counts as
 * 'work'), and the turn moved the branch. Everything else carries the final
 * forward: sync, ask, review and pre-accept turns, the supervised wrap-up and
 * nudge invocations, and a work turn that committed nothing.
 *
 * Why this rule and not `final.sha === HEAD`: the wrap-up steps commit by
 * design and run AFTER the claim is recorded, so under strict SHA equality
 * every task whose wrap-up changed anything became un-acceptable the instant
 * its wrap-up succeeded — and the remedy for that would commit again. A loop,
 * whose contract mandates a sync before each child, would pay a whole turn
 * for obeying its own contract. Neither is visible from the resolver's code,
 * which is why it is written down here. A rule that makes the contradiction
 * impossible beats one that needs a carve-out to avoid it.
 *
 * INVARIANT: a claim whose SHA is behind the head is reported with a LABEL,
 * never with a refusal. Honesty is bought without taking the decision away from
 * the reviewer.
 *
 * INVARIANT: the predicate lives in `resolveFinalState` and nowhere else. If a
 * second copy of "what un-finals" appears at a call site, this test is the
 * record of why that is wrong.
 */

import { describe, test, expect } from 'bun:test';
import type { FinalClaim, Turn, TurnType } from '../../src/types';
import {
  resolveFinalState,
  finalHeadMovedLabel,
  turnUnFinals,
} from '../../src/task/final-state';

const CLAIM_SHA = 'aaaaaaaa1111111111111111111111111111aaaa';

function claim(overrides: Partial<FinalClaim> = {}): FinalClaim {
  return {
    sha: CLAIM_SHA,
    actor: 'agent',
    at: 5_000,
    wrap_up_steps: [],
    ...overrides,
  };
}

let seq = 0;

function turn(
  role: Turn['role'],
  opts: {
    turnType?: TurnType;
    startSha?: string | null;
    endSha?: string | null;
    final?: FinalClaim;
    actor?: Turn['actor'];
  } = {},
): Turn {
  seq += 1;
  return {
    id: `turn-${seq}`,
    session_id: 'session',
    sequence: seq,
    role,
    content: '',
    timestamp: 1_000 + seq,
    usage: null,
    start_sha: opts.startSha ?? null,
    start_sha_work: null,
    end_sha_work: null,
    end_sha: opts.endSha ?? null,
    ...(opts.turnType ? { turn_type: opts.turnType } : {}),
    ...(opts.final ? { final: opts.final } : {}),
    ...(opts.actor ? { actor: opts.actor } : {}),
  };
}

/** A turn that moved the branch from the claim's SHA to `to`. */
function moving(role: Turn['role'], to: string, turnType?: TurnType): Turn {
  return turn(role, { turnType, startSha: CLAIM_SHA, endSha: to });
}

describe('resolveFinalState — nothing declared', () => {
  test('no turns at all', () => {
    expect(resolveFinalState([])).toBeNull();
  });

  test('turns but no claim', () => {
    expect(resolveFinalState([turn('human'), turn('agent')])).toBeNull();
  });
});

describe('resolveFinalState — the claim stands', () => {
  test('a declaring turn with nothing after it', () => {
    const state = resolveFinalState([turn('human'), turn('agent', { final: claim() })]);
    expect(state?.claim.sha).toBe(CLAIM_SHA);
    expect(state?.head_moved).toBe(false);
    expect(finalHeadMovedLabel(state!)).toBeNull();
  });

  test('the NEWEST claim wins when an agent declared twice', () => {
    const older = claim({ at: 1_000, note: 'first' });
    const newer = claim({ at: 9_000, note: 'second', sha: 'bbbb2222' });
    const state = resolveFinalState([
      turn('agent', { final: older }),
      turn('agent', { turnType: 'nudge', final: newer }),
    ]);
    expect(state?.claim.note).toBe('second');
  });

  test('the note and actor ride along for a surface to render', () => {
    const state = resolveFinalState([
      turn('agent', { final: claim({ note: 'docs left stale on purpose', actor: 'human' }) }),
    ]);
    expect(state?.claim.note).toBe('docs left stale on purpose');
    expect(state?.claim.actor).toBe('human');
  });
});

describe('resolveFinalState — what does NOT un-final', () => {
  // Each of these moves the branch. None of them is an agent work turn, so the
  // claim stands and the reviewer is told the head moved instead.
  const carriesForward: Array<[string, Turn]> = [
    // A sync launch turn is recorded with role 'human' and actor 'supervisor' —
    // 'supervisor' is an actor, not a role, and a non-'agent' role can never
    // un-final regardless of turn_type.
    ['a sync turn', moving('human', 'ssss1111', 'sync')],
    ['an agent conflict-resolution reply inside a sync', moving('agent', 'ssss2222', 'sync')],
    ['an ask turn', moving('agent', 'kkkk1111', 'ask')],
    ['a review turn', moving('agent', 'rrrr1111', 'review')],
    ['a pre-accept turn', moving('agent', 'pppp1111', 'pre_accept')],
    ['a wrap-up turn', moving('agent', 'wwww1111', 'wrap_up')],
    ['a supervised wrap-up / nudge invocation', moving('agent', 'nnnn1111', 'nudge')],
    ['a human turn that moved the branch', moving('human', 'hhhh1111')],
  ];

  for (const [label, later] of carriesForward) {
    test(`${label} leaves the final standing, with a label`, () => {
      const state = resolveFinalState([turn('agent', { final: claim() }), later]);
      expect(state).not.toBeNull();
      expect(state!.head_moved).toBe(true);
      expect(state!.moved_by).toHaveLength(1);
      expect(finalHeadMovedLabel(state!)).toContain('head has since moved');
      expect(turnUnFinals(later)).toBe(false);
    });
  }

  test('an agent work turn that committed NOTHING leaves it standing and un-moved', () => {
    const noop = turn('agent', { startSha: CLAIM_SHA, endSha: CLAIM_SHA });
    const state = resolveFinalState([turn('agent', { final: claim() }), noop]);
    expect(state).not.toBeNull();
    expect(state!.head_moved).toBe(false);
    expect(turnUnFinals(noop)).toBe(false);
  });

  test('an agent work turn with UNKNOWN SHAs does not un-final', () => {
    // "I cannot tell whether the branch moved" must never be reported as
    // un-final, or every turn recorded before the four-SHA model would cancel
    // a claim made after it.
    const unknown = turn('agent', { startSha: null, endSha: null });
    const state = resolveFinalState([turn('agent', { final: claim() }), unknown]);
    expect(state).not.toBeNull();
    expect(turnUnFinals(unknown)).toBe(false);
  });

  test("the declaring turn's own later commits move the head but do not cancel it", () => {
    // `lazy_final` is called mid-turn, so the agent may commit after it. That is
    // a real head move the reviewer is owed — and the same turn, so not an
    // un-final.
    const declaring = turn('agent', {
      startSha: 'oldoldold',
      endSha: 'cccc3333',
      final: claim(),
    });
    const state = resolveFinalState([declaring]);
    expect(state).not.toBeNull();
    expect(state!.head_moved).toBe(true);
    expect(state!.head_sha).toBe('cccc3333');
  });
});

describe('resolveFinalState — what DOES un-final', () => {
  test('an agent work turn that produced commits', () => {
    const work = moving('agent', 'dddd4444');
    expect(turnUnFinals(work)).toBe(true);
    expect(resolveFinalState([turn('agent', { final: claim() }), work])).toBeNull();
  });

  test("a turn with no turn_type counts as 'work'", () => {
    // The field's own convention: absent means 'work'. A stored turn from
    // before turn types existed must not be read as a non-work turn.
    const untyped = turn('agent', { startSha: CLAIM_SHA, endSha: 'eeee5555' });
    expect(untyped.turn_type).toBeUndefined();
    expect(turnUnFinals(untyped)).toBe(true);
    expect(resolveFinalState([turn('agent', { final: claim() }), untyped])).toBeNull();
  });

  test('a work turn BEFORE the claim is irrelevant', () => {
    const state = resolveFinalState([
      moving('agent', 'ffff6666'),
      turn('agent', { final: claim() }),
    ]);
    expect(state).not.toBeNull();
  });

  test('declaring again after a work turn restores the final', () => {
    const state = resolveFinalState([
      turn('agent', { final: claim({ note: 'first' }) }),
      moving('agent', 'dddd4444'),
      turn('agent', { final: claim({ sha: 'dddd4444', note: 'second' }) }),
    ]);
    expect(state?.claim.note).toBe('second');
    expect(state?.head_moved).toBe(false);
  });
});

describe('the head-moved label', () => {
  test('names what moved it and the SHA that was declared', () => {
    const state = resolveFinalState([
      turn('agent', { final: claim() }),
      moving('human', 'ssss1111', 'sync'),
    ]);
    const label = finalHeadMovedLabel(state!);
    expect(label).toContain(CLAIM_SHA.slice(0, 8));
    expect(label).toContain('a sync');
  });

  test('lists each distinct cause once', () => {
    const state = resolveFinalState([
      turn('agent', { final: claim() }),
      turn('human', { turnType: 'sync', startSha: CLAIM_SHA, endSha: 's1', actor: 'supervisor' }),
      turn('human', { turnType: 'sync', startSha: 's1', endSha: 's2', actor: 'supervisor' }),
      turn('agent', { turnType: 'nudge', startSha: 's2', endSha: 's3' }),
    ]);
    const label = finalHeadMovedLabel(state!)!;
    expect(label.match(/a sync/g)).toHaveLength(1);
    expect(label).toContain('a supervised follow-up');
    expect(state!.head_sha).toBe('s3');
  });
});
