/**
 * The mechanical per-child fix-round budget for cluster tasks.
 *
 * A cluster's driver runs its children unattended, and step 5 of its contract
 * lets it unblock a child with the review's findings and go round again. Nothing
 * in the contract bounds how many times: a child that keeps not-quite-passing
 * review can absorb an unbounded number of full agent turns with nobody watching
 * the spend. The engineer's rule after the first driver to run under the
 * final-turn flow: "these loops are dangerous and can burn a lot of tokens
 * without mechanical round budgets."
 *
 * So the daemon counts, PER CHILD, how many times its CLUSTER parent has
 * unblocked it since it was last started or accepted, and refuses past
 * `[cluster] max_child_fix_rounds`. The refusal names what the driver may do
 * instead — accept, close, or defer with a blocking raise of its own — because
 * a bound that does not say what to do next just produces a retry.
 *
 * PER CHILD IS THE WHOLE POINT UNDER CONCURRENCY. The counter is a task-metadata
 * key on the CHILD, so N children running at once each carry their own; one
 * stubborn child exhausting its rounds neither spends nor refuses a sibling's.
 * Nothing here is a budget on the cluster as a whole, and adding one would
 * reintroduce by the back door the coupling between siblings that dropping the
 * serial rule removed.
 *
 * WHO IT APPLIES TO, and this is the whole safety argument:
 *   - Only when the task's PARENT is a `cluster`.
 *   - Only when the unblock's actor is `agent` — the driver's own `lazy_unblock`
 *     over MCP. A HUMAN unblock is never refused: it carries feedback somebody
 *     has already typed (CLAUDE.md, "Never Lose Human Feedback"), and refusing
 *     it would discard that. The daemon's own recovery and auto-fix turns
 *     (actor `system`) are not refused either — a bound on the driver's
 *     judgement must not strand a turn the daemon started.
 *   - A human unblock also RESETS the count, like every other counter's human
 *     intervention rule: the human has taken over this child's direction.
 */

import type { Actor, Task } from '../types';
import type { Storage } from '../storage/interface';
import { isClusterTask } from '../types';
import { parentTaskIdOf } from '../task-target';
import { displayId } from '../task/identity';
import { logger } from '../utils/logger';

/**
 * Metadata key counting cluster-parent unblocks of THIS child since its last
 * start/accept.
 *
 * The stored key still says `loop` — the type's name before 2026-09-20. It is
 * private bookkeeping nothing outside this module reads, and renaming it would
 * silently hand every child mid-flight a fresh budget, which is the direction
 * that spends MORE turns. So it stays as written.
 */
export const CLUSTER_FIX_ROUND_KEY = 'loop_fix_round';

/** Current count for a child (0 when unset). */
export async function getClusterFixRound(storage: Storage, taskId: string): Promise<number> {
  const value = await storage.getTaskMetadata(taskId, CLUSTER_FIX_ROUND_KEY);
  return value ? parseInt(value, 10) || 0 : 0;
}

/** Count one more driver-initiated fix round for this child. Returns the new count. */
export async function incrementClusterFixRound(storage: Storage, taskId: string): Promise<number> {
  const next = (await getClusterFixRound(storage, taskId)) + 1;
  await storage.updateTaskMetadata(taskId, CLUSTER_FIX_ROUND_KEY, String(next));
  return next;
}

/**
 * Start a fresh budget for this child.
 *
 * Best-effort at every call site: losing a reset costs the driver rounds it was
 * entitled to, which is the direction that fails safe (fewer turns, never
 * more), and must never fail the start/accept/unblock it rides on.
 */
export async function resetClusterFixRound(storage: Storage, taskId: string): Promise<void> {
  try {
    await storage.updateTaskMetadata(taskId, CLUSTER_FIX_ROUND_KEY, '');
  } catch (err) {
    logger.debug(
      `Task ${taskId.substring(0, 8)}: could not reset the cluster fix-round counter — ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** What {@link checkClusterFixRoundBudget} decides. */
export type ClusterFixRoundDecision =
  | { kind: 'not-applicable' }
  | { kind: 'reset' }
  | { kind: 'allowed'; round: number; budget: number }
  | { kind: 'refused'; message: string };

/**
 * Decide whether this unblock may proceed, WITHOUT writing anything.
 *
 * Split from the write so the caller can refuse before it has touched any
 * state, and count only once it is actually launching — the same shape
 * `shouldAutoReact` / `recordAutoReact` use.
 */
export async function checkClusterFixRoundBudget(opts: {
  storage: Storage;
  task: Task;
  actor: Actor | undefined;
  /** `[cluster] max_child_fix_rounds`; 0 disables the bound. */
  budget: number;
}): Promise<ClusterFixRoundDecision> {
  const { storage, task, actor, budget } = opts;

  // A human taking over this child starts a fresh budget — and is never
  // refused, whatever the count says.
  if (actor === 'human' || actor === 'builder') return { kind: 'reset' };
  if (actor !== 'agent') return { kind: 'not-applicable' };
  if (budget <= 0) return { kind: 'not-applicable' };

  const parentId = parentTaskIdOf(task);
  if (!parentId) return { kind: 'not-applicable' };
  const parent = await storage.getTask(parentId);
  if (!parent || !isClusterTask(parent)) return { kind: 'not-applicable' };

  const round = await getClusterFixRound(storage, task.id);
  if (round < budget) return { kind: 'allowed', round, budget };

  return {
    kind: 'refused',
    message:
      `Cluster ${displayId(parent)} has already sent ${displayId(task)} back ${round} time` +
      `${round === 1 ? '' : 's'}, which is the budget ([cluster] max_child_fix_rounds = ${budget}). ` +
      `Another round is not the answer. Decide instead: accept it if what it has is good enough ` +
      `(lazy_accept), close it if it should not land (lazy_close), or defer it — tag it ` +
      `deferred-by-${displayId(parent)} and raise ONE blocking item saying what decision you ` +
      `need from the operator. A human unblocking this child starts a fresh budget.`,
  };
}
