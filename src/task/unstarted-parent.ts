/**
 * "Has this task's parent got a branch yet?"
 *
 * A task stacked on a parent that has never started has nothing to merge from:
 * the parent's branch is cut when it starts. Sync (and reparent's sync) asks
 * this BEFORE fetching, so it can say exactly that instead of chasing a branch
 * that does not exist yet and reporting a network failure. The task's sync
 * stays queued (`pending_sync`) and runs as soon as the parent starts
 * (src/daemon/parent-started-sync.ts).
 */

import type { Storage } from '../storage';
import type { Task } from '../types';
import { parentTaskIdOf } from '../task-target';
import { getBranchName } from './identity';
import { runGit } from '../utils/git';

/**
 * The direct parent when it has not started and has no branch yet, else null.
 * "Not started" is `backlog` AND no local branch: a pinned clone cuts its
 * branch before it starts, and that branch is something to merge.
 */
export async function unstartedParentOf(storage: Storage, task: Task, projectRoot: string): Promise<Task | null> {
  const parentId = parentTaskIdOf(task);
  if (!parentId) return null;
  const parent = await storage.getTask(parentId);
  if (!parent || parent.status !== 'backlog') return null;
  const branch = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${getBranchName(parent)}`], { cwd: projectRoot });
  return branch.exitCode === 0 ? null : parent;
}
