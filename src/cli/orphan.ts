/**
 * Orphan detection and retargeting for child tasks.
 *
 * When a parent task is accepted (merged), its branch is deleted. Any child
 * tasks that targeted the parent's branch become "orphaned" — they can't merge
 * or sync upstream because the target branch is gone.
 *
 * This module provides:
 * - Detection: is a child task orphaned?
 * - Retargeting: update the child to target the parent's upstream branch
 */

import type { Task } from '../types';
import { isTerminalStatus } from '../types';
import { branchExists } from '../git/operations';
import type { Storage } from '../storage/interface';
import { getBranchNameFromId } from './helpers';
import { getActor } from '../constants';

export interface OrphanCheckResult {
  /** True if the task is a child whose parent is in a terminal state and parent's branch is gone */
  isOrphaned: boolean;
  /** The parent task (if it exists and was looked up) */
  parentTask: Task | null;
  /** The branch the child should be retargeted to (parent's target branch) */
  retargetBranch: string | null;
}

/**
 * Check if a task is an orphaned child.
 *
 * A child is orphaned when:
 * 1. It has a parent_task_id
 * 2. The parent task is in a terminal state (complete, abandoned, closed)
 * 3. The parent's branch no longer exists
 */
export async function checkOrphanedChild(
  task: Task,
  storage: Storage,
  root: string,
): Promise<OrphanCheckResult> {
  if (!task.parent_task_id) {
    return { isOrphaned: false, parentTask: null, retargetBranch: null };
  }

  const parentTask = await storage.getTask(task.parent_task_id);
  if (!parentTask) {
    // Parent task not found in storage — treat as orphaned, target main
    return { isOrphaned: true, parentTask: null, retargetBranch: 'main' };
  }

  if (!isTerminalStatus(parentTask.status)) {
    return { isOrphaned: false, parentTask, retargetBranch: null };
  }

  // Parent is in terminal state. Check if the branch still exists.
  let parentBranchName: string;
  try {
    parentBranchName = await getBranchNameFromId(task.parent_task_id, storage);
  } catch {
    // Can't determine parent's branch name — treat as orphaned
    return { isOrphaned: true, parentTask, retargetBranch: parentTask.metadata?.remote_target_branch ?? 'main' };
  }

  if (branchExists(parentBranchName, root)) {
    // Parent's branch still exists (maybe not cleaned up yet). Not orphaned.
    return { isOrphaned: false, parentTask, retargetBranch: null };
  }

  // Parent is terminal and branch is gone. Determine the retarget branch.
  // Use the parent's target branch (what the parent was merging into), defaulting to main.
  let retargetBranch = parentTask.metadata?.remote_target_branch ?? 'main';

  // If the retarget branch also doesn't exist (chained accepts), fall back to main
  if (!branchExists(retargetBranch, root)) {
    retargetBranch = 'main';
  }

  return { isOrphaned: true, parentTask, retargetBranch };
}

/**
 * Retarget an orphaned child task to a new upstream branch.
 *
 * This:
 * 1. Stores the original parent_task_id in metadata for history
 * 2. Clears parent_task_id (so downstream code uses remote_target_branch)
 * 3. Sets remote_target_branch to the retarget branch
 * 4. Adds a comment recording the retarget
 *
 * After retargeting, the next sync-with-upstream will merge the new target
 * branch into the child's worktree, and the agent resolves any conflicts.
 */
export async function retargetOrphanedChild(
  task: Task,
  storage: Storage,
  retargetBranch: string,
): Promise<void> {
  // Preserve history
  if (task.parent_task_id) {
    await storage.updateTaskMetadata(task.id, 'original_parent_task_id', task.parent_task_id);
  }

  // Clear parent relationship so all code paths fall through to remote_target_branch
  await storage.updateTaskParent(task.id, null);

  // Set the new target branch
  await storage.updateTaskMetadata(task.id, 'remote_target_branch', retargetBranch);

  // Record the retarget as a comment for the session history
  const parentRef = task.parent_task_id ? task.parent_task_id.substring(0, 8) : 'unknown';
  await storage.createComment(
    task.id,
    `[Retargeted] Parent task ${parentRef} was accepted. Retargeted from parent's branch to ${retargetBranch}.`,
    getActor(),
  );
}

/**
 * Get active (non-terminal) child tasks for a given parent task.
 */
export async function getActiveChildren(
  parentTaskId: string,
  storage: Storage,
): Promise<Task[]> {
  const children = await storage.getChildTasks(parentTaskId);
  return children.filter(c => !isTerminalStatus(c.status));
}

/**
 * Re-parent non-terminal children of an accepted task to the accepted task's parent.
 *
 * When a parent is accepted, its branch is merged and deleted. Any unfinished
 * children would become orphans. This function proactively re-parents them to
 * the grandparent (or makes them top-level if the accepted task had no parent).
 *
 * Only updates parent_task_id — does NOT touch worktrees. The next
 * sync-with-upstream on each child will handle merging the new parent branch.
 *
 * Returns the list of re-parented children (for logging).
 */
export async function reparentChildren(
  acceptedTask: Task,
  storage: Storage,
): Promise<Task[]> {
  const activeChildren = await getActiveChildren(acceptedTask.id, storage);
  if (activeChildren.length === 0) return [];

  const newParentId = acceptedTask.parent_task_id ?? null;

  for (const child of activeChildren) {
    await storage.updateTaskParent(child.id, newParentId);

    const acceptedRef = acceptedTask.code ?? acceptedTask.id.substring(0, 8);
    const newParentRef = newParentId ? newParentId.substring(0, 8) : 'top-level';
    await storage.createComment(
      child.id,
      `[Re-parented] Parent task ${acceptedRef} was accepted. Re-parented to ${newParentRef}.`,
      getActor(),
    );
  }

  return activeChildren;
}
