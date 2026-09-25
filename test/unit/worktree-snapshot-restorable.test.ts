/**
 * When `lazy unblock` may put a stored worktree snapshot back.
 *
 * Snapshots have no lifecycle — one is written only when a turn ends dirty,
 * nothing marks one consumed, and the restore asks for "the latest". For years
 * that was invisible, because every stored patch was unappliable (a trimmed
 * trailing newline, fixed alongside this). With restore actually working, the
 * unbounded candidate becomes a way to RESURRECT work a human deliberately
 * threw away — the exact inverse of the loss the mechanism exists to prevent.
 */

import { describe, test, expect } from 'bun:test';
import { snapshotIsRestorable } from '../../src/task/worktree-snapshot';
import type { Turn } from '../../src/types';

/** A work turn — `turn_type` absent, exactly as FileStorage omits the default. */
function workTurn(sequence: number): Turn {
  return { sequence, role: 'agent' } as Turn;
}

function humanTurn(sequence: number): Turn {
  return { sequence, role: 'human' } as Turn;
}

/**
 * A wrap-up nudge pair, as `recordSupervisedTurns` actually writes it: a
 * `human`-role prompt authored by the SUPERVISOR, then the agent's reply at the
 * next sequence — `role: 'agent'`, `turn_type: 'nudge'`.
 *
 * Modelling this as two human turns is what let the bound ship broken: the
 * agent half is the one that looks like a later work turn, and a fixture
 * without it exercises none of the rule it claims to pin.
 */
function nudgePair(promptSequence: number): Turn[] {
  return [
    { sequence: promptSequence, role: 'human', actor: 'supervisor', turn_type: 'nudge' } as Turn,
    { sequence: promptSequence + 1, role: 'agent', turn_type: 'nudge' } as Turn,
  ];
}

describe('snapshotIsRestorable', () => {
  // INVARIANT: the snapshot of the turn the worktree is still sitting at the
  // end of is restorable. This is the case the mechanism exists for — the turn
  // ended dirty, the human unblocks, the container is recreated and the loose
  // edits come back with it.
  test('the last work turn\'s own snapshot restores', () => {
    expect(snapshotIsRestorable(4, [humanTurn(3), workTurn(4)])).toBe(true);
  });

  /**
   * INVARIANT: the wrap-up's own nudge pairs do NOT age the snapshot they were
   * recorded alongside. The snapshot carries the WORK turn's sequence, but it
   * is captured after the nudge pairs are written — and the agent half of a
   * pair is a `role: 'agent'` turn at a higher sequence. Counting it made every
   * snapshot stale the instant it was written, on exactly the dirty final turns
   * this mechanism exists for: `commit_leftovers` runs on those turns, and
   * `present` runs on every human-audience park, so in practice the restore was
   * dead. The bound is against work moving on, not against a turn describing
   * itself.
   */
  test('the turn\'s own wrap-up nudges do not age its snapshot', () => {
    const turns = [workTurn(4), ...nudgePair(5), ...nudgePair(7)];
    expect(snapshotIsRestorable(4, turns)).toBe(true);
  });

  // INVARIANT: a snapshot the worktree has moved on past is NOT restored. Turn
  // 3 ends dirty; the human reads the edit, decides against it and reverts it;
  // turns 4..8 run and end clean, so none of them writes a snapshot of its own
  // and the turn-3 patch is still "the latest". Restoring it at turn 9 would
  // silently put the discarded edit back, on its way into the next commit.
  test('a snapshot from an earlier turn does not restore', () => {
    const turns = [workTurn(3), humanTurn(4), workTurn(8)];
    expect(snapshotIsRestorable(3, turns)).toBe(false);
  });

  // ...and a later work turn ages it even when nudge pairs sit in between,
  // which is the combination the two rules above have to get right together.
  test('a later work turn ages it, nudge pairs notwithstanding', () => {
    const turns = [workTurn(3), ...nudgePair(4), humanTurn(6), workTurn(7), ...nudgePair(8)];
    expect(snapshotIsRestorable(3, turns)).toBe(false);
    expect(snapshotIsRestorable(7, turns)).toBe(true);
  });

  // HUMAN AND SUPERVISOR TURNS DO NOT AGE A SNAPSHOT. Unblock feedback, the
  // nudge prompts and sync turns all land after the work turn that wrote the
  // snapshot — counting them would make the mechanism restore nothing, ever.
  test('turns recorded after the work turn do not age its snapshot', () => {
    const turns = [workTurn(4), humanTurn(5), humanTurn(6)];
    expect(snapshotIsRestorable(4, turns)).toBe(true);
  });

  // Neither do the read-only visitors. An ask or a review runs against the
  // worktree without moving it on, and both record agent turns.
  test('ask and review turns do not age a snapshot', () => {
    const turns = [
      workTurn(4),
      { sequence: 5, role: 'agent', turn_type: 'ask' } as Turn,
      { sequence: 6, role: 'agent', turn_type: 'review' } as Turn,
    ];
    expect(snapshotIsRestorable(4, turns)).toBe(true);
  });

  // A session with no work turn recorded yet cannot have moved on past
  // anything; the restore's own "only into a CLEAN worktree" precondition is
  // what protects that case.
  test('no work turn yet is not a reason to refuse', () => {
    expect(snapshotIsRestorable(1, [])).toBe(true);
    expect(snapshotIsRestorable(1, [humanTurn(1)])).toBe(true);
  });
});
