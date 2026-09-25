/**
 * THE rule for "does this task present by its own work, or by its children?"
 *
 * A HUB is a task whose branch is mostly its children's accepted work — a
 * release hub, a cluster. Asking a model to walk a reviewer through one is
 * asking for a walkthrough of every feature it contains, so a hub is presented
 * by its children instead, derived from the merge history with no agent turn
 * (`loadPresentedRegions`). What decides which of the two a task gets is here,
 * and nowhere else: the wrap-up plan reads it to drop the presentation step,
 * and the regions loader reads it to route to the derived map. Those two
 * disagreeing is not a cosmetic bug — it is a task that authors no walkthrough
 * and is then told it has none.
 *
 * INVARIANT (review 36b9c014): the trigger is a LANDED child, not a child.
 * "Has at least one subtask" is far too wide for "is mostly its children's
 * work": a feature task with 90% of its own direct work and one helper subtask
 * would stop authoring a walkthrough for the rest of its life — and, because an
 * authored walkthrough outranks the derived map, would keep serving the one it
 * filed before the subtask existed while turns of later work piled up under
 * "Other changes". Nothing on the surface would say the map was older than the
 * branch. So the derived map takes over only when child work is ACTUALLY part
 * of the branch, which is the only state in which it has anything to show.
 *
 * The three cases this draws apart, all common:
 *   - a child still IN FLIGHT (backlog through submitted) — nothing of its work
 *     is on this branch yet, so the task presents its own work as a leaf does;
 *   - a child CLOSED or rejected (`abandoned`) — its work never lands, so it
 *     never makes a hub, in flight or not. The same reasoning
 *     `cluster-progress.ts` applies to its k-of-n (a closed child leaves the
 *     denominator), applied one question earlier;
 *   - a child LANDED (`complete`) — its work is on the branch, which is the
 *     whole reason the derived map has something to show.
 */

import type { Task } from '../types';
import { isClusterTask } from '../types';

/**
 * Children that bear on hub-ness: everything except the ones that will never
 * land. Exported because the derived map lists the ones still outstanding and
 * must not name an abandoned child among them.
 */
export function hubRelevantChildren<T extends Pick<Task, 'status'>>(
  children: readonly T[],
): T[] {
  return children.filter((child) => child.status !== 'abandoned');
}

/** Children whose work is already on this branch. */
export function isChildLanded(child: Pick<Task, 'status'>): boolean {
  return child.status === 'complete';
}

/**
 * Children that can still land, and so are honestly described as outstanding.
 * Excludes both the landed and the abandoned.
 */
export function outstandingChildren<T extends Pick<Task, 'status'>>(
  children: readonly T[],
): T[] {
  return hubRelevantChildren(children).filter((child) => !isChildLanded(child));
}

/**
 * Whether this task presents by its children.
 *
 * A `cluster` counts from its FIRST turn, before it has landed anything: a
 * cluster's whole contract is to drive children, so the turns where it has none
 * yet are not a task that will present its own work — it is a hub that has not
 * started. Without that arm a cluster would buy a walkthrough of the empty
 * branch it is about to fill, and another after each child, of a map it is
 * about to invalidate.
 */
export function isHubTask<T extends Pick<Task, 'status'>>(
  task: Pick<Task, 'type'>,
  children: readonly T[],
): boolean {
  return isClusterTask(task) || children.some(isChildLanded);
}
