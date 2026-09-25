/**
 * A reparent moves a task's target; its open PR/MR must move with it.
 *
 * A person may have submitted a subtask into its parent's branch. When the
 * parent is accepted (or closed, or the subtask is `lazy reparent`ed), the
 * subtask's target changes, but its PR/MR keeps the base it was opened with —
 * and a forge merge of it would land the work in the old branch.
 *
 * INVARIANT: after a reparent the DAEMON performs, no open PR/MR a task records
 * merges somewhere the task no longer goes. Each reparented task's PR is
 * RETARGETED onto the new target (GitHub `gh pr edit --base`, GitLab `glab mr
 * update --target-branch`); when the forge refuses, the PR is CLOSED instead
 * (marked first as lazy's own close, ./lazy-closed-review.ts), its record is
 * dropped once the close is confirmed, and a `submitted` task goes back to
 * `blocked`. Either way the task says what happened in a comment.
 *
 * The daemon paths that call this, and so the ones the invariant covers:
 * accept's and close's reparent of children, `lazy reparent`, a parent closed
 * on the forge (remote-sync and syncTaskFromRemote), the zombie finalize, the
 * orphan retarget in unblock and in start, and the stale-parent-chain rewrite
 * in unblock's and sync's parent resolution. Two target writes do NOT call it,
 * because neither runs in the daemon or holds forge credentials: the same
 * parent resolution run inside the agent's MCP process (src/mcp/internal-git.ts)
 * and the CLI's `lazy reopen` orphan retarget. For those the forge accept and
 * remote-sync base checks (./review-base.ts) are the backstop — a merge into
 * the old branch is refused, and a forge merge there never completes the task.
 *
 * Never throws: it runs as follow-through after a merge has landed and after a
 * reparent has been recorded, neither of which it may undo.
 */

import { join } from 'path';
import type { Storage } from '../storage';
import type { Task } from '../types';
import { loadConfig } from '../config/loader';
import { createDriver } from '../remote';
import { isOfflineMode } from '../utils/offline';
import { isTerminalStatus } from '../types';
import { isLinkedTask } from '../task/linked';
import { displayId } from '../task/identity';
import { logger } from '../utils/logger';
import { resolveSubmitTarget } from './submit-target';
import { LAZY_CLOSED_REVIEW_KEY, settleLazyClosedReview } from './lazy-closed-review';

/**
 * Retarget (or, failing that, close) the open PR/MR of every task in `tasks`
 * whose base no longer matches its target. Returns one line per task it acted
 * on, for the caller to show.
 */
export async function retargetReviewsAfterReparent(
  projectRoot: string,
  storage: Storage,
  tasks: Task[],
): Promise<string[]> {
  if (tasks.length === 0) return [];
  const notes: string[] = [];
  let config;
  try {
    config = await loadConfig(projectRoot);
  } catch (err) {
    logger.warn(`retarget after reparent: could not load config: ${err instanceof Error ? err.message : err}`);
    return notes;
  }
  const driver = createDriver(config, { storage, lazyRoot: projectRoot });
  if (!driver.needsSync) return notes;
  const offline = await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline);

  for (const stale of tasks) {
    const task = await storage.getTask(stale.id);
    if (!task || isTerminalStatus(task.status) || isLinkedTask(task) || !driver.hasRemoteRef(task)) continue;
    try {
      const note = await retargetOne(projectRoot, storage, driver, task, offline, config.remote.git_remote);
      if (note) notes.push(note);
    } catch (err) {
      const msg = `Could not retarget or close the PR/MR of ${displayId(task)} after its reparent: ${err instanceof Error ? err.message : err}. Accepting it through the forge stays refused until its base matches.`;
      logger.warn(msg);
      notes.push(msg);
    }
  }
  return notes;
}

async function retargetOne(
  projectRoot: string,
  storage: Storage,
  driver: ReturnType<typeof createDriver>,
  task: Task,
  offline: boolean,
  remote: string,
): Promise<string | null> {
  const target = await resolveSubmitTarget(task, storage);
  let newBase = target.targetBranch;
  if (target.remoteDefault) {
    const { resolveDetachedHead } = await import('../git/operations');
    newBase = await resolveDetachedHead('HEAD', projectRoot, remote);
  }

  if (offline) return await notRetargeted(storage, task, newBase, 'lazy is offline');

  // `null` is "the forge could not be asked" — the task records a PR
  // (`hasRemoteRef` was checked), so it is never "there is no PR". Treating it
  // as "nothing open" skipped the retarget silently and left the person
  // believing the PR had followed the task.
  const state = await driver.getPRState(task);
  if (state === null) return await notRetargeted(storage, task, newBase, 'the forge could not be asked about its state');
  if (state !== 'OPEN') return null;
  const base = await driver.getReviewBase(task);
  if (base === null || base === newBase) return null;

  try {
    await driver.retargetReview(task, newBase);
    const note = `[PR retargeted] ${displayId(task)} was reparented, so its PR/MR now merges into \`${newBase}\` instead of \`${base}\`.`;
    await storage.createComment(task.id, note, 'system');
    return note;
  } catch (err) {
    logger.warn(`Retargeting the PR/MR of ${displayId(task)} onto ${newBase} failed, closing it: ${err instanceof Error ? err.message : err}`);
  }

  // The forge refused the new base. Close the PR rather than leave it merging
  // into a branch the task no longer goes to.
  const sess = await storage.getSessionByTaskId(task.id);
  const url = await driver.getTaskUrl(task);
  // Marked BEFORE the close (./lazy-closed-review.ts): whatever happens next —
  // an unreadable answer, a crash — a later pass that reads CLOSED knows the
  // close was lazy's own and settles the task instead of abandoning it.
  await storage.updateTaskMetadata(task.id, LAZY_CLOSED_REVIEW_KEY, url ?? 'closed');
  if (sess?.git_branch) await driver.cleanup(sess.git_branch);
  const afterClose = await driver.getPRState(task);
  if (afterClose === 'OPEN') {
    // The close did not happen: the PR is live and still recorded, so the
    // marker would be a lie. The wrong-base guards keep it from merging.
    await storage.updateTaskMetadata(task.id, LAZY_CLOSED_REVIEW_KEY, '');
    throw new Error(`the forge would neither retarget nor close ${url ?? 'it'}`);
  }
  // INVARIANT: a close the forge cannot CONFIRM (null — cleanup only warns
  // when its close fails, and the state could not be read) keeps the record
  // AND the marker. Dropping the record here hid a possibly-open PR on the old
  // base from the wrong-base guards (./review-base.ts), which need the record
  // to see it. The marker is what lets the next remote-sync pass that reads
  // CLOSED settle the task as lazy's own close rather than abandon it.
  if (afterClose === null) {
    return await notRetargeted(storage, task, newBase,
      `the forge refused to move its PR/MR${url ? ` (${url})` : ''} off \`${base}\`, and lazy could not confirm it closed ` +
      `the PR instead`);
  }
  const statusNote = await settleLazyClosedReview(storage, task);
  const note = `[PR closed] ${displayId(task)} was reparented onto \`${newBase}\`, and its PR/MR${url ? ` (${url})` : ''} ` +
    `could not be moved off \`${base}\`, so lazy closed it${statusNote}. ` +
    `Submit the task again to open one against \`${newBase}\`.`;
  await storage.createComment(task.id, note, 'system');
  return note;
}

/**
 * The PR could not be moved because lazy could not reach the forge: say so on
 * the task. The forge accept's wrong-base refusal (./review-base.ts) keeps a
 * merge out of the old branch until the base is fixed.
 */
async function notRetargeted(storage: Storage, task: Task, newBase: string, why: string): Promise<string> {
  const note = `[PR not retargeted] ${displayId(task)} now integrates into \`${newBase}\`, but ${why}, ` +
    `so its PR/MR could not be moved there. Until its base is \`${newBase}\`, accepting it through the forge is refused.`;
  await storage.createComment(task.id, note, 'system');
  return note;
}
