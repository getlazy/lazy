/**
 * Does the PR/MR a task records merge where the task integrates?
 *
 * A PR's base is a forge-side fact fixed when it was opened. It can drift from
 * the task's target: a person submits a subtask (base = the parent task's
 * branch), then the parent is accepted and the subtask is reparented onto the
 * parent's own target. The PR still points at the old parent branch — remote
 * task branches are never deleted — so a forge merge of it lands the work
 * THERE, not in the task's target, while lazy would call the task complete.
 *
 * INVARIANT: no forge merge path trusts the recorded PR blindly. A forge accept
 * refuses when the base disagrees with the accept's target, and remote-sync
 * never completes a task whose PR was merged into a different branch. The
 * reparent paths retarget the PR (./review-retarget.ts), so this refusal is the
 * backstop for a retarget that failed or a base someone edited by hand.
 *
 * INVARIANT: a LINKED task (`lazy link`) is exempt. Its PR is someone else's,
 * lazy never opened or reparented it, and where its owner merges it is theirs
 * to decide — the retarget and the close-review step skip it for the same
 * reason. Guarding it made remote-sync refuse to complete such a task (with a
 * false "merged into the wrong branch" alert) and `lazy accept` tell a person
 * to change a colleague's PR base.
 */

import type { RepositoryDriver } from '../remote/driver';
import type { Task } from '../types';
import { displayId } from '../task/identity';
import { parentTaskIdOf, targetBranchOf } from '../task-target';
import { isLinkedTask } from '../task/linked';

/**
 * The PR/MR's base when it DIFFERS from `targetBranch`; null when they agree,
 * the task records no PR, or the task is linked (see above — its PR is not
 * lazy's to check). Throws when the forge cannot be asked — a merge that
 * cannot be checked must not go ahead on the assumption it is fine.
 */
export async function mismatchedReviewBase(
  driver: RepositoryDriver,
  task: Task,
  targetBranch: string,
): Promise<string | null> {
  if (isLinkedTask(task) || !driver.hasRemoteRef(task)) return null;
  const base = await driver.getReviewBase(task);
  if (base === null || base === targetBranch) return null;
  return base;
}

/** The refusal a forge accept gives when the PR/MR merges somewhere else. */
export function wrongReviewBaseRefusal(task: Task, base: string, targetBranch: string, url: string | null): string {
  return (
    `The PR/MR for ${displayId(task)}${url ? ` (${url})` : ''} merges into \`${base}\`, but this task now ` +
    `integrates into \`${targetBranch}\` — merging it would land the work in \`${base}\` and leave ` +
    `\`${targetBranch}\` without it. Change the PR/MR's base to \`${targetBranch}\` on the forge, or close ` +
    `it and submit the task again, then accept.`
  );
}

/**
 * The branch a forge accept compares the PR's base against.
 *
 * Normally the accept's own merge target. But a ROOT task with no named
 * target (an unresolved '' or a detached `HEAD`) had its PR opened against the
 * REMOTE'S DEFAULT branch — the drivers resolve it that way, and so does
 * remote-sync — while the accept's merge target falls back to the literal
 * `main`. Comparing against that literal refused, as a wrong base, every such
 * PR in a repo whose default is `master`. Resolved lazily (git/operations is
 * mocked wholesale by several suites), and only in that case.
 */
export async function reviewComparisonTarget(
  task: Task,
  mergeTargetBranch: string,
  projectRoot: string,
  remote: string,
): Promise<string> {
  if (parentTaskIdOf(task)) return mergeTargetBranch;
  const named = targetBranchOf(task);
  if (named && named !== 'HEAD') return mergeTargetBranch;
  const { resolveDetachedHead } = await import('../git/operations');
  return await resolveDetachedHead('HEAD', projectRoot, remote);
}
