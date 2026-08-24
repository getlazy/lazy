/**
 * Construction, projection, and legacy-mapping helpers for {@link TaskTarget}.
 *
 * A task's integration target is a discriminated union (see src/types/index.ts):
 *   - { kind: 'task',   parentTaskId } — stacked on another task; branch derived from parent
 *   - { kind: 'branch', branch }       — top-level; integrates into a named branch
 *
 * This module is the ONE place that knows how the legacy two-field shape
 * `(parent_task_id, metadata.remote_target_branch)` maps to/from the union.
 * The storage boundary (FileStorage / PostgresStorage) uses `targetFromLegacy`
 * on read and `targetToLegacy` on write; nothing else should reconstruct the
 * mapping by hand.
 *
 * Legacy → union mapping (see `targetFromLegacy`):
 *   - parent_task_id set                       → { kind: 'task', parentTaskId }
 *   - parent_task_id null, remote_target_branch → { kind: 'branch', branch }
 *   - parent_task_id null, no branch / 'lazy/…' → { kind: 'branch', branch } held
 *     verbatim (possibly '' or a stale 'lazy/…' ref). This is the only place a
 *     branch variant may legally hold such a value: it is a "needs runtime
 *     resolution" sentinel that `resolveParentBranchWithFallback` heals (via
 *     getCurrentBranch) and writes back as a corrected target. The smart
 *     constructor `branchTarget` rejects these so fresh application-constructed
 *     targets can never carry them.
 *
 * The `github_pr_target_branch` legacy metadata alias is NOT an integration
 * target — it is PR/MR bookkeeping read by the remote drivers. It is preserved
 * in metadata and is not folded into TaskTarget.
 */

import type { Task, TaskTarget } from './types';

const LAZY_REF_PREFIX = 'lazy/';

/**
 * Smart constructor for the `task` variant (stacked on another task).
 * Throws if the parent id is empty.
 */
export function taskTarget(parentTaskId: string): TaskTarget {
  if (!parentTaskId) {
    throw new Error('TaskTarget: parentTaskId must be a non-empty task id');
  }
  return { kind: 'task', parentTaskId };
}

/**
 * Smart constructor for the `branch` variant (top-level, integrates into a
 * named branch). Validates at the construction boundary that the branch is a
 * real integration branch — never empty and never a `lazy/...` task ref (which
 * would smuggle a task-branch reference into the branch slot, exactly the
 * illegal state this union exists to prevent).
 */
export function branchTarget(branch: string): TaskTarget {
  const trimmed = branch.trim();
  if (trimmed === '') {
    throw new Error('TaskTarget: branch must be a non-empty branch name');
  }
  if (trimmed.startsWith(LAZY_REF_PREFIX)) {
    throw new Error(
      `TaskTarget: branch must be a real integration branch, not a lazy task ref ('${branch}')`,
    );
  }
  return { kind: 'branch', branch: trimmed };
}

/**
 * Pure legacy → canonical mapping used at the storage deserialization boundary.
 *
 * Lenient by design: it does NOT reject empty / `lazy/...` branches, because
 * existing task.json files may carry them and the runtime resolver heals them.
 * Application code constructing fresh targets must use `branchTarget`, which is
 * strict.
 */
export function targetFromLegacy(
  parentTaskId: string | null | undefined,
  remoteTargetBranch: string | null | undefined,
): TaskTarget {
  if (parentTaskId) {
    return { kind: 'task', parentTaskId };
  }
  return { kind: 'branch', branch: remoteTargetBranch ?? '' };
}

/**
 * Canonical → legacy projection. Storage writes both the canonical `target`
 * and the derived legacy fields so on-disk task.json stays readable by older
 * code paths during the transition and the two never diverge.
 */
export function targetToLegacy(target: TaskTarget): {
  parent_task_id: string | null;
  remote_target_branch: string | null;
} {
  if (target.kind === 'task') {
    return { parent_task_id: target.parentTaskId, remote_target_branch: null };
  }
  return { parent_task_id: null, remote_target_branch: target.branch || null };
}

/**
 * Projection for the common "what's my parent task id (or null if top-level)"
 * read. Discriminates on `kind` so callers never touch the branch slot when
 * the target is a task.
 */
export function parentTaskIdOf(task: Task): string | null {
  return task.target.kind === 'task' ? task.target.parentTaskId : null;
}

/**
 * Collect the ids of a task's whole subtree — the task itself plus every
 * descendant (children, grandchildren, ...).
 *
 * `allTasks` should be the FULL task set, not a pre-filtered view: descent
 * walks parent links, so a filtered set whose intermediate task was excluded
 * (e.g. a completed task between an active release and its active
 * grandchildren) would silently truncate the subtree. Callers filter the
 * result, not the input.
 */
export function collectSubtreeIds(rootId: string, allTasks: Task[]): Set<string> {
  const childrenByParent = new Map<string, Task[]>();
  for (const task of allTasks) {
    const parentId = parentTaskIdOf(task);
    if (!parentId) continue;
    const siblings = childrenByParent.get(parentId);
    if (siblings) siblings.push(task);
    else childrenByParent.set(parentId, [task]);
  }

  const ids = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const child of childrenByParent.get(current) ?? []) {
      // Guard against a cyclic parent link so a corrupt store can't hang us.
      if (ids.has(child.id)) continue;
      ids.add(child.id);
      queue.push(child.id);
    }
  }
  return ids;
}

/** Result of pruning a task set to a depth limit. See {@link pruneTasksToDepth}. */
export interface DepthPruneResult {
  /** The tasks that survive the limit, in the input order. */
  kept: Task[];
  /**
   * For each kept task sitting at the limit, how many of its descendants (in
   * the input set) were elided. Only boundary tasks appear — a task above the
   * limit has all its children kept, so nothing is hidden under it directly.
   */
  hidden: Map<string, number>;
  /** Total number of elided tasks (the sum of `hidden`'s values). */
  hiddenTotal: number;
}

/**
 * Prune a task set to the first `levels` levels of the hierarchy it forms.
 *
 * DEPTH IS COUNTED WITHIN THE GIVEN SET, 1-BASED: a task whose parent is not in
 * the set is level 1, its children level 2, and so on. That is deliberately the
 * same rule `buildTaskTree` uses to decide what is a display root, so the number
 * a user passes always matches the rows they see — including after a subtree
 * filter, where the filter's task is the level-1 root, and in an `active` view
 * where a terminal parent is absent and its active children are the roots.
 *
 * Counting against the FULL hierarchy instead would hide such children with
 * nothing visible to hang an "N hidden" note on, which is exactly the silent
 * truncation this function's `hidden` map exists to prevent.
 *
 * `levels` must be a positive integer; callers validate user input before
 * calling (this throws on a bad value rather than guessing).
 */
export function pruneTasksToDepth(tasks: Task[], levels: number): DepthPruneResult {
  if (!Number.isInteger(levels) || levels < 1) {
    throw new Error(`pruneTasksToDepth: levels must be a positive integer, got ${levels}`);
  }

  const present = new Set(tasks.map(t => t.id));
  const childrenByParent = new Map<string, Task[]>();
  const roots: Task[] = [];
  for (const task of tasks) {
    const parentId = parentTaskIdOf(task);
    if (parentId && present.has(parentId)) {
      const siblings = childrenByParent.get(parentId);
      if (siblings) siblings.push(task);
      else childrenByParent.set(parentId, [task]);
    } else {
      roots.push(task);
    }
  }

  const keptIds = new Set<string>();
  const hidden = new Map<string, number>();
  let hiddenTotal = 0;

  /** Count every descendant of `id` within the set (cycle-safe). */
  const countDescendants = (id: string, seen: Set<string>): number => {
    let count = 0;
    for (const child of childrenByParent.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      count += 1 + countDescendants(child.id, seen);
    }
    return count;
  };

  const queue: Array<{ task: Task; level: number }> = roots.map(task => ({ task, level: 1 }));
  while (queue.length > 0) {
    const { task, level } = queue.pop()!;
    // Guard against a cyclic parent link so a corrupt store can't hang us.
    if (keptIds.has(task.id)) continue;
    keptIds.add(task.id);

    if (level >= levels) {
      const elided = countDescendants(task.id, new Set([task.id]));
      if (elided > 0) {
        hidden.set(task.id, elided);
        hiddenTotal += elided;
      }
      continue;
    }
    for (const child of childrenByParent.get(task.id) ?? []) {
      queue.push({ task: child, level: level + 1 });
    }
  }

  return { kept: tasks.filter(t => keptIds.has(t.id)), hidden, hiddenTotal };
}

/**
 * Projection for "what named branch does this top-level task integrate into".
 * Returns undefined when the task is stacked on another task (kind === 'task')
 * or when the branch slot is an unresolved sentinel ('' — see module docs),
 * so callers can apply their own fallback (getCurrentBranch / 'main').
 */
export function targetBranchOf(task: Task): string | undefined {
  return task.target.kind === 'branch' && task.target.branch
    ? task.target.branch
    : undefined;
}
