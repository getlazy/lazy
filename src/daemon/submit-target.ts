/**
 * Submit's target — where the PR/MR goes, whether this caller may open it,
 * and whether one already exists. Shared by the preflight (which every client
 * asks before its confirmation prompt) and `submitTask` itself, so the two can
 * never disagree about a refusal.
 *
 * INVARIANT (CLAUDE.md "PRs only for protected branches", as amended
 * 2026-09-24): lazy never opens a PR/MR for an INTERMEDIATE branch — a task
 * stacked on another task, or a `lazy/...` target — on its own. Accept merges
 * those locally and no automatic path creates one. An explicit submit by a
 * PERSON — the human channel: `lazy submit`, the dashboard's Submit, Teams —
 * is the one exception: that is the request, and it is honoured, with the
 * parent task's branch as the base. The MCP door (`lazy_submit`, builder and
 * task agents alike) keeps the refusal: an agent cannot tell a person's
 * explicit ask from its own initiative, and a PR notifies everyone watching
 * the repository.
 */

import type { Storage } from '../storage';
import type { RepositoryDriver, OpenReview } from '../remote/driver';
import type { Task, ActorInput } from '../types';
import { actorRole } from '../actor-ref';
import { parentTaskIdOf, targetBranchOf } from '../task-target';
import { looksLikeTaskBranch } from '../git/branch-prefix';
import { getBranchNameFromId, displayId } from '../task/identity';
import { runGit } from '../utils/git';
import { logger } from '../utils/logger';

export interface SubmitTarget {
  /** The branch the PR/MR merges into. */
  targetBranch: string;
  /** A task branch (the parent task's, or a `lazy/...` target), never protected. */
  intermediate: boolean;
  /**
   * A root task with no named target (unresolved, or a detached-HEAD `HEAD`):
   * it integrates into the REMOTE'S default branch, which the drivers resolve
   * at PR-creation time. `targetBranch` is then only a display fallback
   * (`main`) and must never be compared against a real branch name —
   * {@link reviewComparisonBranch} resolves the default's real name for that.
   */
  remoteDefault: boolean;
}

/** Structural — no network call, so a forge failure can never misroute it. */
export async function resolveSubmitTarget(task: Task, storage: Storage): Promise<SubmitTarget> {
  const parentId = parentTaskIdOf(task);
  if (parentId) {
    return { targetBranch: await getBranchNameFromId(parentId, storage), intermediate: true, remoteDefault: false };
  }
  const named = targetBranchOf(task);
  if (!named || named === 'HEAD') {
    return { targetBranch: 'main', intermediate: false, remoteDefault: true };
  }
  return { targetBranch: named, intermediate: looksLikeTaskBranch(named), remoteDefault: false };
}

/** Only a person's explicit submit may open a PR/MR into an intermediate branch. */
export function mayOpenIntermediateReview(actor: ActorInput | undefined): boolean {
  return actorRole(actor) === 'human';
}

/** The refusal an agent or the builder gets for an intermediate target. */
export function intermediateSubmitRefusal(task: Task, targetBranch: string): string {
  return (
    `Task ${displayId(task)} integrates into \`${targetBranch}\`, an intermediate task branch — ` +
    `lazy does not open merge requests for it on its own. Run \`lazy accept ${displayId(task)}\` ` +
    `to merge it locally into \`${targetBranch}\`, or ask a person to run ` +
    `\`lazy submit ${displayId(task)}\` if a reviewer needs a PR/MR for it.`
  );
}

/**
 * The refusal when the base branch is not on the remote. Submit never pushes
 * the PARENT: its owner (an agent mid-turn, or a person mid-manual-work) decides
 * when that branch is published.
 *
 * INVARIANT: worded for every surface that shows it — the CLI, the dashboard
 * and Lazy Teams, whose members have no shell — so it names no command. The
 * same holds for {@link mismatchedReviewRefusal}.
 */
export function baseNotOnRemoteRefusal(task: Task, targetBranch: string, remote: string): string {
  return (
    `Cannot open a PR/MR for ${displayId(task)}: its base branch \`${targetBranch}\` is not on ${remote} yet, ` +
    `and submitting never pushes a parent task's branch. A task's branch is pushed when its turn ends, so ` +
    `submit again once the parent task's current turn is over, or once someone has pushed ` +
    `\`${targetBranch}\` to ${remote}.`
  );
}

/** A hand-opened PR/MR whose base is not the task's target is not adopted. */
export function mismatchedReviewRefusal(task: Task, review: OpenReview, targetBranch: string): string {
  return (
    `An open PR/MR already exists for ${displayId(task)}'s branch (${review.url}), but it merges into ` +
    `\`${review.baseBranch}\` while this task integrates into \`${targetBranch}\`. Change its base to ` +
    `\`${targetBranch}\` on the forge, or close it, and then submit again.`
  );
}

/**
 * An open PR/MR for the task's branch that lazy does not know about yet —
 * usually one a person opened by hand on the forge. Null when the task already
 * records one, or there is none.
 */
export async function findUnrecordedReview(
  driver: RepositoryDriver,
  task: Task,
  branch: string,
): Promise<OpenReview | null> {
  if (driver.hasRemoteRef(task)) return null;
  return await driver.findOpenReviewForBranch(branch);
}

/**
 * The branch a hand-opened PR/MR's base is compared against: the target, or —
 * for a root task integrating into the remote's default branch
 * ({@link SubmitTarget.remoteDefault}) — that default's real NAME, resolved the
 * way the retarget and the forge accept resolve it (`resolveDetachedHead`),
 * never the display fallback `main`, which refused an adoptable PR into
 * `master`.
 */
export async function reviewComparisonBranch(
  target: SubmitTarget,
  projectRoot: string,
  remote: string,
): Promise<string> {
  if (!target.remoteDefault) return target.targetBranch;
  const { resolveDetachedHead } = await import('../git/operations');
  return await resolveDetachedHead('HEAD', projectRoot, remote);
}

/**
 * Does a hand-opened PR/MR's base disagree with the branch the task integrates
 * into ({@link reviewComparisonBranch})? Not compared when the forge did not
 * report a base.
 */
export function reviewBaseMismatch(review: OpenReview, comparisonBranch: string): boolean {
  if (!review.baseBranch) return false;
  return review.baseBranch !== comparisonBranch;
}

/**
 * Where the PR/MR the task already RECORDS merges, against where the task
 * integrates now. `none` = no recorded PR; `match`; `mismatch` = it still
 * merges into an older target (a reparent whose retarget was skipped, refused
 * or unconfirmed); `unreadable` = the forge could not say. Read-only.
 */
export type RecordedReviewBase =
  | { kind: 'none' }
  | { kind: 'match' }
  | { kind: 'mismatch'; base: string; comparison: string }
  | { kind: 'unreadable'; comparison: string; reason: string };

export async function recordedReviewBase(
  driver: RepositoryDriver,
  task: Task,
  target: SubmitTarget,
  projectRoot: string,
  remote: string,
): Promise<RecordedReviewBase> {
  if (!driver.hasRemoteRef(task)) return { kind: 'none' };
  const comparison = await reviewComparisonBranch(target, projectRoot, remote);
  let base: string | null;
  try {
    base = await driver.getReviewBase(task);
  } catch (err) {
    return { kind: 'unreadable', comparison, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!base) return { kind: 'unreadable', comparison, reason: 'the forge reported no base' };
  return base === comparison ? { kind: 'match' } : { kind: 'mismatch', base, comparison };
}

function recordedReviewUrl(task: Task): string {
  const m = task.metadata ?? {};
  return m.github_remote_ref_url || m.gitlab_remote_ref_url || m.remote_ref_url || m.github_pr_url || 'its PR/MR';
}

/** The recorded PR/MR's base could not be read: submit refuses rather than report a PR it cannot vouch for. */
export function recordedBaseUnreadableRefusal(task: Task, comparison: string, reason: string): string {
  return (
    `Cannot submit ${displayId(task)}: could not read which branch its PR/MR (${recordedReviewUrl(task)}) ` +
    `merges into (${reason}). It may still merge into a branch this task no longer integrates into, rather than ` +
    `\`${comparison}\`. Submit again once the forge answers.`
  );
}

/**
 * A LINKED task's PR/MR (`lazy link`) belongs to someone else: lazy never
 * changes its base, so a base that differs from where the task integrates
 * refuses the submit instead.
 */
export function linkedReviewBaseRefusal(task: Task, base: string, comparison: string): string {
  return (
    `Cannot submit ${displayId(task)}: its PR/MR (${recordedReviewUrl(task)}) was linked, not opened by lazy, ` +
    `and it merges into \`${base}\` while the task integrates into \`${comparison}\`. A linked PR/MR's base is ` +
    `its owner's to change — lazy never moves it. Ask the owner to change its base to \`${comparison}\`, ` +
    `or change where the task integrates, then submit again.`
  );
}

/** The forge would not move the recorded PR/MR onto the task's current target. */
export function recordedRetargetRefusal(task: Task, base: string, comparison: string, reason: string): string {
  return (
    `Cannot submit ${displayId(task)}: its PR/MR (${recordedReviewUrl(task)}) merges into \`${base}\`, but the task ` +
    `now integrates into \`${comparison}\`, and the forge refused to change its base (${reason}). ` +
    `Change the PR/MR's base to \`${comparison}\` on the forge, then submit again.`
  );
}

/**
 * Warning when the remote base lacks commits this task's branch was built on:
 * the PR/MR would show them as part of the task's change until the parent is
 * pushed. Best-effort and never throws — it can only add a warning.
 */
export async function staleBaseWarning(
  projectRoot: string,
  taskBranch: string,
  targetBranch: string,
  remoteHead: string,
  remote: string,
): Promise<string | null> {
  try {
    const mb = await runGit(['merge-base', taskBranch, targetBranch], { cwd: projectRoot });
    if (mb.exitCode !== 0) return null;
    const check = await runGit(['merge-base', '--is-ancestor', mb.stdout.trim(), remoteHead], { cwd: projectRoot });
    // 0: contained. 1: not contained. Anything else: the remote SHA is not in
    // this clone yet, so the question cannot be answered here.
    if (check.exitCode !== 1) return null;
    return (
      `\`${targetBranch}\` on ${remote} is behind the commits this task was built on, so the PR/MR also ` +
      `shows the parent's unpushed work until \`${targetBranch}\` is pushed.`
    );
  } catch (err) {
    logger.debug(`staleBaseWarning: could not compare ${taskBranch} with ${remote}/${targetBranch}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
