/**
 * Construction, projection, and legacy-mapping helpers for {@link TaskTarget}.
 *
 * A task's integration target is a discriminated union (see src/types/index.ts):
 *   - { kind: 'task',   parentTaskId } — stacked on another task; branch derived from parent
 *   - { kind: 'branch', branch }       — top-level; integrates into a named branch
 *
 * This module is the ONE place that knows how the legacy two-field shape
 * `(parent_task_id, metadata.remote_target_branch)` maps to/from the union.
 * The storage boundary (FileStorage) uses `targetFromLegacy`
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
import { looksLikeTaskBranch } from './git/branch-prefix';

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
  if (looksLikeTaskBranch(trimmed)) {
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

/**
 * How many descendants each task has — children, grandchildren, and so on —
 * for every task in `allTasks`, keyed by task id. Tasks with none map to 0.
 *
 * One pass for the whole set: a caller that needs this for a list of tasks must
 * not run {@link collectSubtreeIds} per task, which rebuilds the parent index
 * every time. Pass the FULL task set for the same reason that function
 * documents — descent walks parent links, so a filtered set silently truncates
 * subtrees. Filter the result, not the input.
 *
 * Counted by walking each task UP its ancestor chain and crediting every
 * ancestor, which needs no recursion and is cycle-safe by construction: a
 * corrupt parent link is credited at most once per walk instead of hanging.
 */
export function descendantCounts(allTasks: Task[]): Map<string, number> {
  const parentOf = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const task of allTasks) {
    counts.set(task.id, 0);
    const parentId = parentTaskIdOf(task);
    if (parentId) parentOf.set(task.id, parentId);
  }

  for (const task of allTasks) {
    const seen = new Set<string>([task.id]);
    let ancestorId = parentOf.get(task.id);
    while (ancestorId && !seen.has(ancestorId)) {
      seen.add(ancestorId);
      // A parent outside the set (deleted, or not yet visible) gets no entry —
      // counts only describe the tasks the caller passed in.
      if (counts.has(ancestorId)) counts.set(ancestorId, counts.get(ancestorId)! + 1);
      ancestorId = parentOf.get(ancestorId);
    }
  }
  return counts;
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

/**
 * The named integration branch a top-level task was explicitly created against
 * (`lazy create --parent release-x`), or undefined when the caller must fall
 * back to the repo default.
 *
 * Stricter than {@link targetBranchOf}: a stored `lazy/…` value is a stale task
 * branch left by an earlier reparent, not an integration target — the task
 * launcher has always treated it as "needs runtime resolution", and everything
 * that must agree with the launcher about a task's base ref resolves it the
 * same way.
 */
export function integrationBranchOf(task: Task): string | undefined {
  const stored = targetBranchOf(task);
  return stored && !looksLikeTaskBranch(stored) ? stored : undefined;
}
