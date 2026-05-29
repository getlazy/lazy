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
