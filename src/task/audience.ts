/**
 * THE resolver for "who is this task's work owed to?"
 *
 * The wrap-up that a final triggers — presentation, screenshots, CHANGELOG
 * upkeep, the protected-file push-back — is work owed to a READER, and most
 * tasks do not have a human one. A subtask an agent or a cluster created, ran and
 * accepted is never opened by a person, so doing that work on it is work nobody
 * reads.
 *
 * INVARIANT (final-turn design §13.3): audience is DERIVED FROM THE RUNNER, by
 * this function and nothing else. There is no stored field, no agent-settable
 * flag, and no per-child override — a human who wants to watch a cluster closely
 * says so in the cluster's prompt. In particular `FinalClaim.wrap_up_steps` is an
 * audit record of what RAN and must never be read back as the audience.
 *
 * Nothing reads this yet: it ships in slice 1 because slice 3 (the wrap-up
 * phase) is built on it, and is exercised by its own unit test.
 */

import type { Actor, Turn } from '../types';

/** Who a task's reviewer-facing work is for. */
export type TaskAudience = 'human' | 'agent';

/**
 * The actor kinds that LAUNCH work, in the sense that matters here.
 *
 * `system` and `supervisor` are deliberately absent: auto-resume, sync and the
 * daemon's own recovery turns must never flip a task's audience, or a crash
 * recovery would silently turn a human's task into an agent-audience one (or
 * the reverse).
 */
const LAUNCHING_ACTORS: readonly Actor[] = ['human', 'builder', 'agent'];

function audienceForActor(actor: Actor): TaskAudience {
  return actor === 'agent' ? 'agent' : 'human';
}

export interface AudienceInputs {
  /**
   * The task's session turns in sequence order. Only the actor-bearing
   * human/builder turn each launch writes matters here.
   */
  turns: readonly Pick<Turn, 'role' | 'actor'>[];
  /**
   * Who CREATED the task — the actor on the first `status-changelog.json`
   * entry. The fallback for a task whose turns carry no launching actor yet
   * (never started, or started before actors were recorded).
   *
   * Passed in rather than read off the `Task` record because the record does
   * not carry it: creation attribution lives in the status changelog.
   */
  createdBy?: Actor | null;
}

/**
 * Resolve a task's audience.
 *
 * The actor of the most recent turn that a `human` / `builder` / `agent` actor
 * launched wins; `system` and `supervisor` turns are skipped. With no such turn
 * yet, the creation actor decides. With neither — a task with no records at all
 * — the answer is `human`, which is the SAFE direction: more wrap-up work, never
 * less, and never a presentation silently skipped on a task a person will open.
 */
export function audienceOf(inputs: AudienceInputs): TaskAudience {
  for (let i = inputs.turns.length - 1; i >= 0; i--) {
    const actor = inputs.turns[i]!.actor;
    if (actor && LAUNCHING_ACTORS.includes(actor)) return audienceForActor(actor);
  }
  if (inputs.createdBy && LAUNCHING_ACTORS.includes(inputs.createdBy)) {
    return audienceForActor(inputs.createdBy);
  }
  return 'human';
}
