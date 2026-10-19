/**
 * THE resolver for "who is this task's work owed to?"
 *
 * Audience decides WHO answers a task's protected-file questions (deferral,
 * src/protection/deferral.ts) and which review prompt its reviewer gets. It
 * NEVER decides which end-of-work rules run: every task runs the user's whole
 * configured wrap-up (src/daemon/wrap-up-plan.ts, engineer 2026-10-04) —
 * suppressing configured rules by an audience heuristic surprised users.
 *
 * INVARIANT (final-turn design §13.3): audience is DERIVED FROM THE RUNNER, by
 * this function and nothing else. There is no stored field, no agent-settable
 * flag, and no per-child override — a human who wants to watch a cluster closely
 * says so in the cluster's prompt. In particular `FinalClaim.wrap_up_steps` is an
 * audit record of what RAN and must never be read back as the audience.
 *
 * INVARIANT (engineer, 2026-10-04): a CLUSTER's child is ALWAYS agent-audience,
 * whoever launched its latest turn. The cluster's driver runs every child by
 * construction — a cluster's children are the driver's to drive, never a
 * person's directly — and the cluster task is the one a human reads. So this is
 * still "derived from the runner": the parent's type says who runs the child.
 * It is load-bearing because audience decides where a
 * child's protected-file questions are asked (src/protection/deferral.ts). A
 * human-audience child is asked at its OWN accept, which the driver makes, and
 * the driver's approval would then join the cluster's answer as if a person had
 * decided it.
 */

import type { Storage } from '../storage/interface';
import { isClusterTask, type Actor, type Task, type Turn } from '../types';
import { logger } from '../utils/logger';

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
   * The task's session turns in sequence order. Only the LAUNCH turns count —
   * the `role: 'human'` turn each launch writes, whose actor says who started
   * it. An agent's own reply turns are skipped by role: since turn-owner
   * attribution they carry `actor: 'agent'` (the channel), which says nothing
   * about who launched the turn, and reading them made nearly every task that
   * had ever answered look agent-launched.
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
  /**
   * The task's parent is a `cluster` task, which makes it agent-audience
   * whatever its turns say (the cluster invariant at the top of this file).
   * Resolve it with {@link parentIsClusterOf}. Omitted means "not a cluster's
   * child".
   */
  parentIsCluster?: boolean;
}

/**
 * Resolve a task's audience.
 *
 * A cluster's child is `agent`, first and unconditionally. Otherwise the actor
 * of the most recent LAUNCH turn (`role: 'human'`) that a `human` / `builder`
 * / `agent` actor launched wins — an agent's reply turns never count; `system` and `supervisor` turns are skipped. With no such turn yet, the
 * creation actor decides. With neither — a task with no records at all — the
 * answer is `human`, which is the SAFE direction: more wrap-up work, never
 * less, and never a presentation silently skipped on a task a person will open.
 */
export function audienceOf(inputs: AudienceInputs): TaskAudience {
  if (inputs.parentIsCluster) return 'agent';
  for (let i = inputs.turns.length - 1; i >= 0; i--) {
    const turn = inputs.turns[i]!;
    if (turn.role !== 'human') continue;
    const actor = turn.actor;
    if (actor && LAUNCHING_ACTORS.includes(actor)) return audienceForActor(actor);
  }
  if (inputs.createdBy && LAUNCHING_ACTORS.includes(inputs.createdBy)) {
    return audienceForActor(inputs.createdBy);
  }
  return 'human';
}

/**
 * Whether `task`'s parent is a `cluster` task — the
 * {@link AudienceInputs.parentIsCluster} input. Every audience derivation reads
 * it through this one function, so the wrap-up plan, the review prompt and the
 * protected-file resolver cannot disagree about a cluster's child.
 *
 * Best-effort: a parent that cannot be read answers `false`, keeping the
 * turn-derived audience. That is the safe direction for every reader — more
 * wrap-up work, and a protected-file question asked at this task's own accept
 * rather than deferred upward.
 */
export async function parentIsClusterOf(
  storage: Pick<Storage, 'getTask'>,
  task: Pick<Task, 'id' | 'target'>,
): Promise<boolean> {
  // `target` is read defensively: a record without one is a top-level task as
  // far as this question goes, never a crash on a launch path.
  const parentId = task.target?.kind === 'task' ? task.target.parentTaskId : null;
  if (!parentId) return false;
  try {
    const parent = await storage.getTask(parentId);
    return parent !== null && isClusterTask(parent);
  } catch (err) {
    logger.debug(
      `Task ${task.id.substring(0, 8)}: parent ${parentId.substring(0, 8)} unreadable ` +
      `(${err instanceof Error ? err.message : err}); audience is derived from its turns.`,
    );
    return false;
  }
}

/**
 * Who created the task — the actor on its first status-changelog entry, the
 * {@link AudienceInputs.createdBy} fallback.
 *
 * Mirrors `resolveWrapUpPlan` (src/daemon/wrap-up-plan.ts) exactly, so the
 * audience a task's wrap-up ran under and the audience the review prompt and
 * the protected-file resolver read can never disagree: `system`-created tasks
 * answer null and let `audienceOf` fall through to its safe default.
 */
export async function createdByOf(
  storage: Pick<Storage, 'getStatusHistory'>,
  task: Pick<Task, 'id'>,
): Promise<Actor | null | undefined> {
  try {
    const actor = (await storage.getStatusHistory(task.id))[0]?.actor;
    return actor === 'human' || actor === 'builder' || actor === 'agent' ? actor : null;
  } catch (err) {
    // The changelog is a fallback input, not a gate.
    logger.debug(
      `Task ${task.id.substring(0, 8)}: status history unavailable: ` +
      `${err instanceof Error ? err.message : err}; audience falls back to the turns.`,
    );
    return undefined;
  }
}
