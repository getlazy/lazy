/**
 * Reconciling a task with what happened to it on the forge.
 *
 * Two host-side operations, both of which need network and git credentials that
 * a task's own container deliberately does not have:
 *
 *  - `runSyncWithRemote` runs at the top of a turn: fetch the task's branch and
 *    any new PR/MR comments, and tell the supervisor whether it has an
 *    `origin/<branch>` to merge before the agent resumes.
 *  - `syncTaskFromRemote` reconciles one task's STATE: import new review
 *    comments, and finalize the task when its PR/MR was merged or closed
 *    somewhere else.
 *
 * The daemon drives both — `runSyncWithRemote` from the turn lifecycle,
 * `syncTaskFromRemote` from the remote-sync reconciler and from the
 * `syncTaskFromRemote` RPC the CLI review flows (`lazy unblock`, `lazy loop`)
 * call. It must only ever run IN the daemon process: a merged PR runs the
 * accept transition under `tryWithTaskLifecycleLock`, an in-process map that
 * excludes nothing from any other process.
 */

import { shortId, displayId, taskRef, getWorktreePath } from './identity';
import { reparentChildren, formatReparentWarning } from './orphan';
import { buildRemoteCommentsContext } from './turn-context';
import { cleanupTaskContainer, cleanupWorktreeAndBranch } from './cleanup';
import { loadConfig } from '../config/loader';
import { createDriver } from '../remote';
import { autoPushEnabled } from '../remote/auto-push';
import { importForgeComments } from '../remote/imported-comments';
import { protocolDir as getProtocolDir, removeProtocolDir } from '../protocol';
import { removeLock } from '../utils/lock';
import { logger } from '../utils/logger';
import { theme } from '../render/theme';
import { getActor } from '../constants';
import { parentTaskIdOf } from '../task-target';
import { isLinkedTask } from './linked';
import { isTerminalStatus } from '../types';
import type { ActorInput, Task } from '../types';
import type { Storage } from '../storage';

/**
 * Sync a single task's state from the remote before showing the review UI.
 *
 * When a remote driver is configured and the task has a remote reference:
 * 1. Fetches PR/MR comments and stores the ones not yet imported as notes
 * 2. Checks remote state (merged/closed externally) and updates task if needed
 *
 * This is a targeted per-task sync — NOT a full `lazy sync`. It only fetches
 * comments and state for the specific task being reviewed.
 *
 * Network failures are non-fatal: logs a warning and continues with stale data.
 */
export async function syncTaskFromRemote(
  task: Task,
  storage: Storage,
  root: string,
  /** Who the rows this writes name — the RPC caller, else the daemon's channel default. */
  actor: ActorInput = getActor(),
): Promise<void> {
  let config;
  try {
    config = await loadConfig(root);
  } catch {
    return;
  }

  try {
    const driver = createDriver(config);

    // If no remote ref exists yet, try to create one so comments can be synced.
    // This mirrors the exportTasks() flow in sync.ts: push branch, then
    // create a PR/MR via markReadyForReview if the task has commits.
    //
    // Nobody asked for that push — it is a side effect of syncing comments, and
    // it also opens a PR — so `<driver>_auto_push = false` suppresses it. The
    // task then simply has no remote ref and the early return below skips
    // comment sync for it, which is the same state as before any turn ran.
    // `lazy submit` remains the explicit way to publish the branch and open the
    // PR, and is deliberately NOT gated.
    if (!driver.hasRemoteRef(task) && autoPushEnabled(config)) {
      const session = await storage.getSessionByTaskId(task.id);
      // INVARIANT: never push or open a PR for a linked task. That branch is
      // someone else's; a later daemon pass attaches a PR if they open one.
      if (isLinkedTask(task)) return;
      // INVARIANT: PRs only for protected branches; subtask→parent merges are
      // local. A child task (stacked on another task) must NEVER get an MR/PR —
      // markReadyForReview would throw for it. Skip the creation attempt: there
      // is no remote ref to create and therefore no MR comments to sync (the
      // early return below then short-circuits comment sync for this task).
      if (session?.git_branch && !parentTaskIdOf(task)) {
        const commits = await storage.getSessionCommits(session.id);
        if (commits.length > 0) {
          try {
            await driver.pushBranch(session.git_branch);
            const prResult = await driver.markReadyForReview(task);
            if (prResult.metadata) {
              for (const [key, value] of Object.entries(prResult.metadata)) {
                await storage.updateTaskMetadata(task.id, key, value);
              }
              // Update the in-memory task metadata so downstream code sees the new ref
              if (!task.metadata) task.metadata = {};
              Object.assign(task.metadata, prResult.metadata);
              if (driver.hasRemoteRef(task)) {
                logger.info(`Created remote ref for task ${shortId(task.id)} during pre-review sync`);
              }
            }
          } catch (err) {
            console.log(theme.warning(`⚠ Warning: Could not push to origin — local and remote branches have diverged.`));
            console.log(`  The remote branch will be merged on next sync-with-upstream.`);
            logger.debug(`Failed to create remote ref during pre-review sync (non-fatal): ${err instanceof Error ? err.message : err}`);
          }
        }
      }
      // If we still don't have a remote ref after trying to create one, skip comment sync
      if (!driver.hasRemoteRef(task)) return;
    }

    // Fetch EVERY visible comment and dedup by id below. There is no
    // timestamp window: a comment's created_at is when it was written, not
    // when it became visible (a line comment drafted in a pending review shows
    // up only when the review is submitted), so any watermark a pass advanced
    // could skip it for good. The agent only ever learns of a forge comment
    // through this import, so an old one is not "already seen" either.
    const comments = await driver.syncComments(task);

    if (comments.length > 0) {
      // Dedup and edit detection by structured identity (forge, kind, id,
      // body hash) — see src/remote/imported-comments.ts.
      const outcome = await importForgeComments(
        storage, task.id, comments, (c) => driver.formatImportedComment(c, task), actor,
      );
      const newCount = outcome.created.length + outcome.revised.length;
      if (newCount > 0) {
        console.log(`Synced ${newCount} new comment${newCount === 1 ? '' : 's'} from remote`);
      }
      if (outcome.updatedInPlace.length > 0) {
        console.log(`Updated ${outcome.updatedInPlace.length} not-yet-delivered comment${outcome.updatedInPlace.length === 1 ? '' : 's'} edited on the remote`);
      }
    }

    // Check remote state (merged/closed externally) via the driver interface
    if (!isTerminalStatus(task.status)) {
      const prState = await driver.getPRState(task);
      if (prState === 'MERGED') {
        const sess = await storage.getSessionByTaskId(task.id);
        const sessionCommits = sess ? await storage.getSessionCommits(sess.id) : [];
        // Same rule as the daemon's remote-sync (src/daemon/review-base.ts): a
        // PR merged into a branch that is not the task's target never completes it.
        const { mergedIntoTaskTarget } = await import('../daemon/remote-sync');
        if (sessionCommits.length > 0 && await mergedIntoTaskTarget(storage, driver, task, root)) {
          // Transition first, follow-through after (accept-merge-is-commit-point),
          // the same pair as every accept exit and the daemon's remote-sync.
          // Only the TRANSITION runs here, under the task's lifecycle lock on a
          // re-read. That lock is an in-process map, so it excludes a live accept,
          // a stranded-merge resume and the remote-sync sweep only because every
          // caller of this function runs in the daemon (the CLI reaches it through
          // the `syncTaskFromRemote` RPC, never by importing it). The
          // record it writes is picked up by the daemon's follow-through sweep,
          // which fast-forwards, tags, notifies, reparents and cleans up with
          // retries — this path used to do those inline, once, and lose them on
          // any failure.
          const { tryWithTaskLifecycleLock } = await import('../daemon/task-lifecycle-lock');
          const { commitAcceptTransition, acceptTargetBranchOf } = await import('../daemon/task-lifecycle');
          const { ACCEPT_IN_FLIGHT_KEY } = await import('../daemon/stranded-merge');
          const { readAcceptIntent } = await import('../daemon/accept-intent');
          await tryWithTaskLifecycleLock(task.id, async () => {
            const fresh = await storage.getTask(task.id);
            if (!fresh || isTerminalStatus(fresh.status)) return;
            console.log(`Remote ref was merged externally — marking task ${displayId(fresh)} complete`);
            const marked = !!fresh.metadata?.[ACCEPT_IN_FLIGHT_KEY];
            const intent = marked ? readAcceptIntent(fresh) : null;
            await commitAcceptTransition(storage, fresh, {
              reason: intent?.reason ?? 'Merged on the remote after the accepting process died (original reason was not recorded).',
              actor,
              commentActor: intent?.actor ?? 'system',
              writeComment: marked,
              dedupeComment: true,
              followThrough: {
                targetBranch: await acceptTargetBranchOf(fresh, storage),
                viaForge: true,
                pushParent: false,
                done: [],
                attempts: 0,
              },
            });
          });
        }
      } else if (prState === 'CLOSED' && (await import('../daemon/lazy-closed-review')).lazyClosedReview(task)) {
        // Lazy's own close, not somebody else's (src/daemon/lazy-closed-review.ts):
        // settle the task — never abandon it, never move its children.
        const { settleLazyClosedReview } = await import('../daemon/lazy-closed-review');
        const statusNote = await settleLazyClosedReview(storage, task);
        console.log(`The PR/MR lazy closed for ${displayId(task)} after a reparent is confirmed closed${statusNote}.`);
        await storage.createComment(task.id,
          `[PR closed] lazy's close of this task's PR/MR is now confirmed by the forge${statusNote}. ` +
          `Submit the task again to open one against its current target.`, 'system');
      } else if (prState === 'CLOSED') {
        console.log(`Remote ref was closed externally — marking task ${displayId(task)} abandoned`);
        await storage.abandonTask(task.id, 'Closed externally via remote', actor);

        // Re-parent unfinished children (same as accept path)
        const closedReparented = await reparentChildren(task, storage);
        const closedReparentMsg = formatReparentWarning(closedReparented, task);
        if (closedReparentMsg) console.log(`${closedReparentMsg}.`);
        const { retargetReviewsAfterReparent } = await import('../daemon/review-retarget');
        for (const note of await retargetReviewsAfterReparent(root, storage, closedReparented)) console.log(note);
      }
    }
  } catch (err) {
    logger.warn(`Failed to sync task from remote (non-fatal): ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Prepare sync-with-remote for a turn: fetch remote branch and PR comments.
 *
 * This is the host-side part of the sync-with-remote phase. It handles the
 * network operations that the supervisor container can't do (no network access,
 * no git credentials, no gh CLI):
 *   - git fetch origin <branch> (updates origin/<branch> ref locally)
 *   - Fetch PR comments via gh API
 *
 * The actual merge of origin/<branch> happens in the supervisor's
 * sync-with-remote phase, where the agent can resolve conflicts.
 *
 * Ordering within a turn:
 *   1. sync-with-remote fetch (this function, host) — fetch remote ref + comments
 *   2. sync-with-remote merge (supervisor) — merge origin/<branch>, agent resolves conflicts
 *   3. sync-with-upstream (supervisor) — merge parent branch
 *   4. work (supervisor) — agent runs
 *   5. post-sync (host) — push results
 *
 * Network failures are non-fatal: warns and continues with stale data.
 * Branch fetching runs for all non-local drivers (the branch may exist on the
 * remote even without an MR/PR). PR comment fetching is skipped when the task
 * has no remote ref (no MR/PR). Skipped entirely when driver is local.
 *
 * Returns the remote branch ref for the supervisor to merge (if ahead),
 * and the PR comments context for prompt injection.
 */
export async function runSyncWithRemote(
  task: NonNullable<Awaited<ReturnType<Storage['getTask']>>>,
  sess: NonNullable<Awaited<ReturnType<Storage['getSessionByTaskId']>>>,
  root: string,
  storage: Storage,
  worktreePath: string,
): Promise<{ remoteCommentsCtx?: string; remoteBranch?: string }> {
  let config;
  try {
    config = await loadConfig(root);
  } catch {
    return {};
  }
  if (config.remote.driver === 'local') {
    return {};
  }

  let remoteBranch: string | undefined;
  let remoteCommentsCtx: string | undefined;

  try {
    const driver = createDriver(config);

    // Phase 1: Fetch remote branch (updates <remote>/<branch> ref, no merge)
    // Always fetch regardless of MR/PR existence — the branch may have been
    // pushed to the remote without creating an MR/PR yet.
    try {
      const hasNewCommits = await driver.fetchBranch(sess.git_branch, worktreePath);
      if (hasNewCommits) {
        // Tell the supervisor to merge <remote>/<branch> in its sync-with-remote phase
        const gitRemote = config.remote.git_remote;
        remoteBranch = `${gitRemote}/${sess.git_branch}`;
        console.log(theme.warning(`⚠ Remote branch is ahead — supervisor will merge before agent resumes.`));
      } else {
        logger.debug('sync-with-remote: remote branch is up-to-date');
      }
    } catch (err) {
      // Non-fatal: warn and continue without remote sync
      logger.warn(`sync-with-remote: failed to fetch remote branch (non-fatal): ${err instanceof Error ? err.message : err}`);
    }

    // Phase 2: Fetch PR comments (only when MR/PR exists)
    if (driver.hasRemoteRef(task)) {
      try {
        const turns = await storage.getSessionTurns(sess.id);
        const lastAgentTurn = turns.filter(t => t.role === 'agent').pop();
        const sinceTimestamp = new Date(lastAgentTurn?.timestamp ?? task.created_at).toISOString();
        const remoteComments = await driver.syncComments(task, sinceTimestamp);
        if (remoteComments.length > 0) {
          logger.info(`sync-with-remote: ${remoteComments.length} new PR comment(s)`);
          for (const c of remoteComments) {
            logger.debug(`PR comment [${c.author}] at ${c.createdAt}: ${c.body.substring(0, 100)}${c.body.length > 100 ? '...' : ''}`);
          }
          remoteCommentsCtx = buildRemoteCommentsContext(remoteComments);
        }
      } catch (err) {
        // Non-fatal: warn and continue without comments
        logger.warn(`sync-with-remote: failed to fetch PR comments (non-fatal): ${err instanceof Error ? err.message : err}`);
      }
    }
  } catch (err) {
    logger.warn(`sync-with-remote: failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }

  return { remoteCommentsCtx, remoteBranch };
}
