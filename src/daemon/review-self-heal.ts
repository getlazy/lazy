/**
 * A task never loses track of its own PR/MR.
 *
 * Opening a PR is a two-system write: the forge creates it, then lazy records
 * it on the task. Anything between the two — a daemon crash, a failed store
 * write, a create whose number could not be parsed — leaves a PR the forge has
 * and lazy does not. So does a PR a person opens by hand. Such a task used to
 * sit `blocked` forever: the sweep only looked for a missing record on
 * `submitted` tasks, so when the PR merged, nothing noticed, and the next sync
 * pulled the task's own work back in from upstream as if it were somebody
 * else's.
 *
 * Two halves:
 *
 *  - {@link createOrAdoptReview} is the one way a NEW PR/MR is opened for a
 *    task. It persists the intent before calling the forge, adopts an open PR
 *    the head branch already has instead of opening a second, and clears the
 *    intent only once the record is written.
 *  - {@link healUnrecordedReviews} runs in every remote-sync pass. For each
 *    live task with a branch and no PR record, it asks the forge by the head
 *    branch (the PR's natural key): merged into the task's target with nothing
 *    left on the branch → the task completes through the ordinary forge-merged
 *    path; merged elsewhere → one alert; open → the record is adopted.
 *
 * Forge writes: none. Everything here READS the forge; the only writes are the
 * task record, a task comment and (for a wrong-base merge) a system message.
 */

import type { Storage } from '../storage';
import type { Task } from '../types';
import { isTerminalStatus } from '../types';
import type { BranchReview, RepositoryDriver } from '../remote/driver';
import { isLinkedTask } from '../task/linked';
import { displayId, shortId } from '../task/identity';
import { logger } from '../utils/logger';
import { runGit } from '../utils/git';
import { loadConfig } from '../config/loader';
import { clearLazyClosedReview } from './lazy-closed-review';
import {
  completeMergedOnForge,
  reportWrongBaseMerge,
  resolveForgeTarget,
  type SyncLogger,
} from './remote-sync';

/**
 * Task metadata: a PR/MR create in flight — JSON `{ branch, base, at }`,
 * written BEFORE the forge is called and cleared once the record is saved.
 * One left behind means the create may have happened with nothing recorded;
 * the heal checks that task on every pass until it is settled.
 */
export const REVIEW_CREATE_INTENT_KEY = 'review_create_intent';

/**
 * Task metadata: the URL of a merged PR/MR for the task's branch that the heal
 * found but could not complete the task on (the branch has more work), so the
 * comment saying so is written once.
 */
export const UNRECORDED_MERGED_NOTED_KEY = 'unrecorded_review_merged_noted';

async function recordReview(storage: Storage, task: Task, metadata: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(metadata)) {
    await storage.updateTaskMetadata(task.id, key, value);
  }
  if (!task.metadata) task.metadata = {};
  Object.assign(task.metadata, metadata);
  await clearLazyClosedReview(storage, task);
}

async function clearIntent(storage: Storage, task: Task): Promise<void> {
  if (!task.metadata?.[REVIEW_CREATE_INTENT_KEY]) return;
  await storage.updateTaskMetadata(task.id, REVIEW_CREATE_INTENT_KEY, '');
  task.metadata[REVIEW_CREATE_INTENT_KEY] = '';
}

export interface CreateOrAdoptOptions {
  /** Explicit base for a NEW PR/MR (an explicit human submit into an intermediate branch). */
  baseBranch?: string;
  /**
   * The caller already looked the head branch up for an open PR/MR and
   * adopted it if there was one (`lazy submit` does, with its own base check).
   */
  alreadyLookedUp?: boolean;
}

/**
 * Open (or mark ready) the task's PR/MR and record it — crash-safe.
 *
 * When the task records none yet: the intent is persisted first, an open PR
 * already on `branch` is adopted rather than duplicated, and only then is the
 * forge asked to create one. The intent is cleared once a record exists; if
 * the process dies anywhere in between, {@link healUnrecordedReviews} finds
 * the PR by its head branch on the next pass. Throws what the forge throws.
 */
export async function createOrAdoptReview(
  storage: Storage,
  driver: RepositoryDriver,
  task: Task,
  branch: string,
  opts: CreateOrAdoptOptions = {},
): Promise<{ adoptedUrl?: string }> {
  const creating = !driver.hasRemoteRef(task);
  if (creating) {
    const intent = JSON.stringify({ branch, base: opts.baseBranch ?? null, at: new Date().toISOString() });
    await storage.updateTaskMetadata(task.id, REVIEW_CREATE_INTENT_KEY, intent);
    if (!task.metadata) task.metadata = {};
    task.metadata[REVIEW_CREATE_INTENT_KEY] = intent;

    if (!opts.alreadyLookedUp) {
      const open = await driver.findOpenReviewForBranch(branch);
      if (open) {
        await recordReview(storage, task, open.metadata);
        await clearIntent(storage, task);
        logger.info(`Adopted the existing PR/MR for ${branch}: ${open.url}`);
        return { adoptedUrl: open.url };
      }
    }
  }

  const prResult = await driver.markReadyForReview(task, opts.baseBranch ? { baseBranch: opts.baseBranch } : undefined);
  if (prResult.metadata && Object.keys(prResult.metadata).length > 0) {
    await recordReview(storage, task, prResult.metadata);
  }

  // A create that returned no usable id (an unparseable reply): ask the forge
  // by the head branch before giving up on the record.
  if (!driver.hasRemoteRef(task)) {
    const recovered = await driver.recoverRemoteRef(task);
    if (recovered) {
      await recordReview(storage, task, recovered);
      logger.warn(`${displayId(task)}: recovered missing remote ref metadata after markReadyForReview`);
    }
  }

  if (driver.hasRemoteRef(task)) await clearIntent(storage, task);
  return {};
}

/** How often a task with no intent and no PR is re-asked about (per daemon process). */
export const HEAL_RECHECK_MS = 15 * 60 * 1000;
const lastChecked = new Map<string, number>();

/** Test seam: forget the per-process recheck throttle. */
export function resetReviewHealThrottle(): void {
  lastChecked.clear();
}

/**
 * Does `branch` add nothing to `<remote>/<target>`? Asked of the trees (a
 * three-way merge that leaves the target's tree unchanged), so a squash merge
 * counts as landed. False whenever git cannot tell.
 */
async function branchFullyOnTarget(root: string, remote: string, branch: string, target: string): Promise<'landed' | 'has-changes' | 'unknown'> {
  const remoteRef = `${remote}/${target}`;
  for (const ref of [remoteRef, branch]) {
    const exists = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root });
    if (exists.exitCode !== 0) return 'unknown';
  }
  const merged = await runGit(['merge-tree', '--write-tree', remoteRef, branch], { cwd: root });
  // Exit 1 = the merge conflicts: the branch certainly changes the target.
  if (merged.exitCode === 1) return 'has-changes';
  if (merged.exitCode !== 0) return 'unknown';
  const tree = await runGit(['rev-parse', '--verify', `${remoteRef}^{tree}`], { cwd: root });
  if (tree.exitCode !== 0) return 'unknown';
  const mergedTree = merged.stdout.split('\n')[0]?.trim();
  if (!mergedTree) return 'unknown';
  return mergedTree === tree.stdout.trim() ? 'landed' : 'has-changes';
}

/**
 * Is the PR/MR's head commit part of THIS branch's history (either way round)?
 * A branch NAME can be reused — a colleague's store, an older one — so a PR
 * found by name is this task's only when its head is related to the branch.
 * Unknown head (the forge did not say) is not proof: null.
 */
async function headRelatedToBranch(root: string, headSha: string | undefined, branch: string): Promise<boolean | null> {
  if (!headSha) return null;
  const known = await runGit(['cat-file', '-e', `${headSha}^{commit}`], { cwd: root });
  if (known.exitCode !== 0) return false;
  const back = await runGit(['merge-base', '--is-ancestor', headSha, branch], { cwd: root });
  if (back.exitCode === 0) return true;
  const fwd = await runGit(['merge-base', '--is-ancestor', branch, headSha], { cwd: root });
  return fwd.exitCode === 0;
}

export interface HealResult {
  adopted: number;
  completed: number;
  wrongBase: number;
  errors: string[];
}

/**
 * Reconcile every live task that has a branch but no PR/MR record against the
 * forge, by head branch. See the file header for the outcomes.
 *
 * A CLOSED PR found this way changes nothing: lazy drops the record of a PR it
 * closed itself after a reparent could not move it, and a branch can carry an
 * old closed PR from an earlier attempt — neither says the task was abandoned.
 */
export async function healUnrecordedReviews(
  storage: Storage,
  driver: RepositoryDriver,
  log: SyncLogger,
  root: string | undefined,
  now: number = Date.now(),
): Promise<HealResult> {
  const result: HealResult = { adopted: 0, completed: 0, wrongBase: 0, errors: [] };
  const remote = root ? (await loadConfig(root)).remote.git_remote : 'origin';

  for (const task of await storage.listTasks()) {
    if (isTerminalStatus(task.status) || task.status === 'pairing' || task.status === 'backlog') continue;
    // A linked task's PR is attached by attachLinkedPullRequests, by ITS branch.
    if (isLinkedTask(task) || driver.hasRemoteRef(task)) continue;
    const session = await storage.getSessionByTaskId(task.id);
    const branch = session?.git_branch;
    if (!branch) continue;

    const hasIntent = !!task.metadata?.[REVIEW_CREATE_INTENT_KEY];
    const seen = lastChecked.get(task.id);
    if (!hasIntent && seen !== undefined && now - seen < HEAL_RECHECK_MS) continue;
    lastChecked.set(task.id, now);

    let found: BranchReview | null;
    try {
      found = await driver.findReviewForBranch(branch);
    } catch (err) {
      result.errors.push(`Could not look up a PR/MR for ${displayId(task)}'s branch ${branch}: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    try {
      if (!found || found.state === 'CLOSED') {
        // Nothing open or merged: a create that left an intent never happened
        // (or produced a PR somebody has since closed).
        await clearIntent(storage, task);
        continue;
      }

      const target = await resolveForgeTarget(storage, task, root);
      if (target === null) continue;

      if (found.state === 'OPEN') {
        if (root && await headRelatedToBranch(root, found.headSha, branch) === false) {
          logger.debug(`${displayId(task)}: open PR/MR ${found.url} shares the branch name ${branch} but not its history — not adopting it`);
          continue;
        }
        if (found.baseBranch && found.baseBranch !== target) {
          logger.warn(`${displayId(task)}: an open PR/MR for ${branch} (${found.url}) merges into ${found.baseBranch}, not ${target} — not adopting it`);
          continue;
        }
        await recordReview(storage, task, found.metadata);
        await clearIntent(storage, task);
        await storage.createComment(task.id,
          `[PR adopted] An open PR/MR for this task's branch existed on the forge without lazy having recorded it: ` +
          `${found.url}. Lazy now tracks it, so its comments, its merge and the PR link work as for any other.`,
          'system');
        log.detail(`  Adopted unrecorded PR/MR for ${displayId(task)}: ${found.url}`);
        result.adopted++;
        continue;
      }

      // MERGED
      if (found.baseBranch && found.baseBranch !== target) {
        await reportWrongBaseMerge(storage, task, found.baseBranch, target, found.url);
        await clearIntent(storage, task);
        result.wrongBase++;
        continue;
      }
      if (!root) continue;
      // INVARIANT: completing on a PR found by NAME needs proof it is this
      // task's own: recorded work, and the PR's head on this branch's history.
      // A just-started branch adds nothing to its target, so the tree check
      // alone would let a same-named PR from elsewhere complete (and clean up)
      // a task that never opened it.
      const commits = await storage.getSessionCommits(session!.id);
      if (commits.length === 0 || await headRelatedToBranch(root, found.headSha, branch) !== true) {
        logger.debug(`${displayId(task)}: merged PR/MR ${found.url} for ${branch} is not provably this task's — leaving the task`);
        continue;
      }
      const landed = await branchFullyOnTarget(root, remote, branch, target);
      if (landed === 'unknown') {
        logger.warn(`${displayId(task)}: merged PR/MR ${found.url} found, but ${branch} could not be compared with ${remote}/${target} — retrying next pass`);
        lastChecked.delete(task.id);
        continue;
      }
      if (landed === 'has-changes') {
        // The PR merged, but the branch has work beyond it: completing would
        // discard that work. Say so once.
        if (task.metadata?.[UNRECORDED_MERGED_NOTED_KEY] !== found.url) {
          await storage.createComment(task.id,
            `[PR merged] This task's own PR/MR ${found.url} was merged into \`${target}\` on the forge, but lazy ` +
            `had not recorded it. The task's branch has changes that are not in \`${target}\`, so lazy left the ` +
            `task open: those changes still need their own review.`,
            'system');
          await storage.updateTaskMetadata(task.id, UNRECORDED_MERGED_NOTED_KEY, found.url);
        }
        continue;
      }
      await recordReview(storage, task, found.metadata);
      await clearIntent(storage, task);
      const outcome = await completeMergedOnForge(storage, driver, task, log, root,
        `This task's own PR/MR (${found.url}) was merged on the forge. Lazy had not recorded that PR, ` +
        `so it completes the task now.`);
      if (outcome === 'merged') {
        log.detail(`  Unrecorded PR/MR for ${displayId(task)} was merged → complete (${found.url})`);
        result.completed++;
      }
    } catch (err) {
      result.errors.push(`Could not reconcile ${displayId(task)} (${shortId(task.id)}) with ${found?.url ?? 'its PR/MR'}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return result;
}
