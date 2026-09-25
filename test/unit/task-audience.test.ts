/**
 * `audienceOf` — who a task's reviewer-facing work is for.
 *
 * INVARIANT: audience is DERIVED FROM THE RUNNER, by this function and nothing
 * else. There is no stored field and no agent-settable flag, because the whole
 * point is that it cannot be claimed: a task a loop or an agent started is
 * agent-audience and skips the work owed to a human reader; a task a person or
 * the builder started is human-audience and gets all of it.
 *
 * INVARIANT: `system` and `supervisor` turns never change it. Those are lazy's
 * own recovery turns — auto-resume, sync, the reconciler's relaunches — and a
 * crash recovery that flipped a task's audience would silently move a human's
 * task onto the cheap path (or bill a loop's child for a presentation nobody
 * opens).
 *
 * INVARIANT: with nothing to go on, the answer is `human`. That is the SAFE
 * direction — more wrap-up work, never less — and it is deliberately not
 * "cheapest".
 *
 * Nothing READS this yet: it ships ahead of the wrap-up phase that consumes it,
 * so this test is the only thing exercising it. That is intentional and is why
 * the test covers the rule rather than a caller.
 */

import { describe, test, expect } from 'bun:test';
import type { Actor, Turn } from '../../src/types';
import { audienceOf } from '../../src/task/audience';

function turn(role: Turn['role'], actor?: Actor): Pick<Turn, 'role' | 'actor'> {
  return { role, ...(actor ? { actor } : {}) };
}

describe('audienceOf — the most recent launching actor decides', () => {
  test('a human-launched turn makes it human-audience', () => {
    expect(audienceOf({ turns: [turn('human', 'human'), turn('agent')] })).toBe('human');
  });

  test('a builder-launched turn makes it human-audience', () => {
    // The builder acts for the person at the terminal, so its output has a
    // human reader just as a CLI launch does.
    expect(audienceOf({ turns: [turn('human', 'builder'), turn('agent')] })).toBe('human');
  });

  test('an agent-launched turn makes it agent-audience', () => {
    // A loop or a parent agent started this; nobody is going to open it.
    expect(audienceOf({ turns: [turn('human', 'agent'), turn('agent')] })).toBe('agent');
  });

  test('the LATEST launching actor wins, not the first', () => {
    // A human picking up a loop's child changes who the work is for from that
    // turn onwards.
    expect(audienceOf({
      turns: [turn('human', 'agent'), turn('agent'), turn('human', 'human')],
    })).toBe('human');
  });
});

describe('audienceOf — lazy\'s own turns are skipped', () => {
  test('a system resume after an agent launch does not flip it to human', () => {
    expect(audienceOf({
      turns: [turn('human', 'agent'), turn('agent'), turn('human', 'system')],
    })).toBe('agent');
  });

  test('a supervisor sync turn does not flip it either', () => {
    expect(audienceOf({
      turns: [turn('human', 'agent'), turn('human', 'supervisor'), turn('agent')],
    })).toBe('agent');
  });

  test('a turn with no actor at all is skipped', () => {
    // Agent answers and pre-attribution rows carry no actor. Absent means
    // "unknown", never "human".
    expect(audienceOf({
      turns: [turn('human', 'agent'), turn('agent'), turn('agent')],
    })).toBe('agent');
  });
});

describe('audienceOf — the fallbacks', () => {
  test('with no launching turn, the creation actor decides', () => {
    expect(audienceOf({ turns: [], createdBy: 'agent' })).toBe('agent');
    expect(audienceOf({ turns: [], createdBy: 'human' })).toBe('human');
  });

  test('a launching turn beats the creation actor', () => {
    // A task an agent created but a human then started is work a person is
    // about to read.
    expect(audienceOf({
      turns: [turn('human', 'human')],
      createdBy: 'agent',
    })).toBe('human');
  });

  test('a system creation actor is not a launching actor', () => {
    expect(audienceOf({ turns: [], createdBy: 'system' })).toBe('human');
  });

  test('with nothing known at all, human — the safe direction', () => {
    expect(audienceOf({ turns: [] })).toBe('human');
    expect(audienceOf({ turns: [turn('agent')], createdBy: null })).toBe('human');
  });
});
