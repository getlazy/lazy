/**
 * When a stored worktree snapshot may still be restored.
 *
 * Its own module, and a pure function, because it is a RULE about somebody's
 * unreviewed work rather than a step in the unblock: it decides whether lazy
 * writes files into a worktree a human has since looked at.
 */

import type { Turn } from '../types';

/**
 * Is this snapshot still describing the turn the worktree is sitting at the end
 * of?
 *
 * Snapshots have no lifecycle: one is written only when a turn ends DIRTY,
 * nothing ever marks one consumed, and `getLatestWorktreeSnapshot` returns the
 * newest ever taken in the session. So once a task has had a single dirty turn,
 * that patch stayed the candidate for every later unblock that found a clean
 * worktree — forever.
 *
 * That was harmless only by accident: every stored patch had lost the newline
 * ending its last line and `git apply` rejected all of them as corrupt. Now
 * that a restore can actually write files, an unbounded candidate is a way to
 * RESURRECT work — a human reads an edit at turn 3, decides against it, reverts
 * the file, and at turn 9 an unblock silently puts it back, on its way into the
 * next commit. That is the exact inverse of the loss this mechanism exists to
 * prevent, and it is worse: losing work at least announces itself eventually,
 * while resurrected work arrives wearing the agent's name.
 *
 * So: restorable only while no LATER WORK turn has run. A later work turn means
 * the worktree moved on past the snapshot, whatever the human did in between; a
 * turn that ends clean writes no snapshot of its own, which is precisely how
 * the stale one used to survive.
 *
 * **WORK turns, and only work turns.** This is the whole rule, and getting it
 * wrong in the other direction makes the restore unreachable rather than
 * unbounded. The snapshot is stamped with the WORK turn's sequence
 * (`agentTurnSeq`), but by the time it is captured the wrap-up's nudge pairs
 * have already been recorded — and the agent's half of each pair is a
 * `role: 'agent'` turn at a HIGHER sequence. Counting those made every
 * snapshot stale the instant it was written, on exactly the dirty final turns
 * this mechanism exists for. Ask, review and sync turns are excluded for the
 * same reason: they run DURING or AFTER a turn without the worktree moving on.
 * `turn_type` is absent on a work turn (FileStorage omits the default), so
 * undefined counts as work.
 *
 * `null`/empty turns answer true — a session with no work turn recorded yet
 * cannot have moved on past anything, and the restore's own "is the worktree
 * clean" precondition still applies.
 */
export function snapshotIsRestorable(
  snapshotTurnSequence: number,
  turns: readonly Turn[],
): boolean {
  const isWorkTurn = (t: Turn): boolean =>
    t.role === 'agent' && (t.turn_type === undefined || t.turn_type === 'work');
  const lastWorkSeq = turns.reduce(
    (seq, t) => (isWorkTurn(t) && t.sequence > seq ? t.sequence : seq),
    -1,
  );
  if (lastWorkSeq < 0) return true;
  return snapshotTurnSequence === lastWorkSeq;
}
