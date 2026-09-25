/**
 * Daemon remote sync — periodic synchronization of all tasks with the remote.
 *
 * Runs as part of the daemon's reconcile loop to:
 *   - Fetch upstream state (git fetch, fast-forward target branches)
 *   - Detect externally merged/closed PRs and update task state
 *   - Fetch PR comments from remote
 *   - Fetch CI failure results
 *   - Push unpushed task branches
 *   - Refresh PR/MR descriptions when new work has landed
 *
 * All remote-specific logic lives behind the RepositoryDriver interface.
 * This module orchestrates the sync flow without knowing whether the
 * remote is GitHub, GitLab, or any other forge.
 */

import { shortId, displayId, getWorktreePath, taskRef } from '../task/identity';
import { loadConfig } from '../config/loader';
import { createDriver, type RepositoryDriver } from '../remote';
import { importForgeComments } from '../remote/imported-comments';
import { autoPushEnabled, autoPushConfigKey } from '../remote/auto-push';
import { regenerateFidelity, writeFidelityBody, synthesisSuccessCount, type FidelityRemoteOutcome } from '../synthesis/fidelity';
import { getSummarizer } from '../synthesis/summarizer';
import { syncTaskFromRemote } from '../task/sync-remote';
import { cleanupWorktreeAndBranch, cleanupTaskContainer } from '../task/cleanup';
import { theme } from '../render/theme';
import { logger } from '../utils/logger';
import { localBranchExists } from '../git/operations';
import { isTerminalStatus, type Task } from '../types';
import { targetBranchOf } from '../task-target';
import { isLinkedTask, linkedBranchOf, LINK_IDENTITY_KEYS } from '../task/linked';
import { removeLock } from '../utils/lock';
import { protocolDir, removeProtocolDir } from '../protocol';
import { getActor } from '../constants';
import { reparentChildren, formatReparentWarning } from '../task/orphan';
import { emitSignal } from './signals';
import type { Storage } from '../storage';
import { parkTaskPaused } from '../utils/paused-status';
import { daemonBesideLaunchPaused, type TaskUsagePause } from './usage-pause';
import { lazyClosedReview, settleLazyClosedReview } from './lazy-closed-review';
import { describeUsagePause } from '../usage-pause/policy';

/**
 * SyncLogger abstracts how sync progress is reported.
 *
 * The daemon uses a debug-level implementation that writes to the internal
 * logger without cluttering stdout.
 */
export interface SyncLogger {
  /** A phase header (e.g., "Detecting external changes...") */
  phase(message: string): void;
  /** A detail line within a phase (e.g., "  3 PR(s) merged externally") */
  detail(message: string): void;
  /** An error within a phase (non-fatal) */
  error(message: string): void;
  /** Sync completed successfully */
  done(message: string): void;
}

/** Debug-level logger for background sync (daemon reconcile loop). */
class DebugSyncLogger implements SyncLogger {
  phase(message: string): void {
    logger.debug(`Sync: ${message}`);
  }
  detail(message: string): void {
    logger.debug(`Sync: ${message}`);
  }
  error(message: string): void {
    logger.warn(`Sync: ${message}`);
  }
  done(message: string): void {
    logger.debug(`Sync: ${message}`);
  }
}

/** The debug-level SyncLogger instance for the daemon reconcile loop. */
export const debugSyncLogger = new DebugSyncLogger();

/**
 * For linked tasks that have a branch but no PR/MR yet, look up an open
 * pull request by the adopted git branch and persist its metadata.
 *
 * Exported for tests that drive a fake forge. Never overwrites
 * import_source_url / import_source_branch — those record what was linked.
 */
export async function attachLinkedPullRequests(
  storage: Storage,
  driver: RepositoryDriver,
  log?: SyncLogger,
): Promise<{ attached: number }> {
  let attached = 0;
  if (!driver.findPullRequestForBranch) return { attached };

  const allTasks = await storage.listTasks();
  for (const task of allTasks) {
    if (isTerminalStatus(task.status)) continue;
    if (!isLinkedTask(task)) continue;
    if (driver.hasRemoteRef(task)) continue;

    const branch = linkedBranchOf(task);
    if (!branch) continue;

    try {
      const found = await driver.findPullRequestForBranch(branch);
      if (!found) continue;
      for (const [key, value] of Object.entries(found.metadata)) {
        if ((LINK_IDENTITY_KEYS as readonly string[]).includes(key)) continue;
        await storage.updateTaskMetadata(task.id, key, value);
      }
      if (!task.metadata) task.metadata = {};
      for (const [key, value] of Object.entries(found.metadata)) {
        if ((LINK_IDENTITY_KEYS as readonly string[]).includes(key)) continue;
        task.metadata[key] = value;
      }
      if (found.comments && found.comments.length > 0) {
        // Same engine as every sync pass, so these carry the ids later
        // passes dedup against.
        await importForgeComments(
          storage, task.id, found.comments, (c) => driver.formatImportedComment(c, task), getActor(),
        );
      }
      attached++;
      log?.detail(`  Linked task ${displayId(task)}: attached pull request for ${branch}`);
    } catch (err) {
      // Once per pass, per task: a broken token must not look like "no PR".
      const lookupError = err instanceof Error ? err.message : String(err);
      logger.warn(
        `Linked PR discovery failed for ${displayId(task)} on branch '${branch}': ${lookupError}`,
      );
    }
  }
  return { attached };
}

/**
 * Detect externally merged or closed PRs/MRs and update task state.
 * Only checks tasks that have a remote reference (PR, MR, etc.).
 * Uses the driver's getPRState() to check remote state without
 * knowing the specifics of the remote system.
 */
async function detectExternalChanges(storage: Storage, driver: RepositoryDriver, log: SyncLogger, root?: string): Promise<{ merged: number; closed: number; spurious: number; pipelineFailed: number; errors: string[] }> {
  const result = { merged: 0, closed: 0, spurious: 0, pipelineFailed: 0, errors: [] as string[] };

  const allTasks = await storage.listTasks();

  for (const task of allTasks) {
    // Check all non-terminal tasks for external state changes.
    // Previously this was an allowlist of blocked/conflict/submitted/merging, which
    // missed working/interrupted tasks — causing reparent-on-merge to not fire
    // when an MR was merged externally while the task was still working (e.g., crashed).
    // Skip: terminal (already done), pairing (human is driving — wait for pairing to
    // end, then the normal blocked → merging path handles it), backlog (no session/branch).
    if (isTerminalStatus(task.status) || task.status === 'pairing' || task.status === 'backlog') continue;

    if (!driver.hasRemoteRef(task)) {
      // Submitted tasks without a remote ref are anomalous — the MR/PR was created
      // but its metadata wasn't persisted. Try to recover by looking it up by branch name.
      if (task.status === 'submitted') {
        try {
          const recovered = await driver.recoverRemoteRef(task);
          if (recovered) {
            for (const [key, value] of Object.entries(recovered)) {
              await storage.updateTaskMetadata(task.id, key, value);
            }
            // Update in-memory metadata so the rest of the loop can use it
            if (!task.metadata) task.metadata = {};
            Object.assign(task.metadata, recovered);
            logger.warn(`Task ${shortId(task.id)}: recovered missing remote ref metadata (${Object.keys(recovered).join(', ')})`);
          } else {
            logger.warn(`Task ${shortId(task.id)}: submitted but has no remote ref — cannot detect merge. Re-run 'lazy submit' to fix.`);
            continue;
          }
        } catch (err) {
          logger.warn(`Task ${shortId(task.id)}: failed to recover remote ref: ${err instanceof Error ? err.message : err}`);
          continue;
        }
      } else {
        continue;
      }
    }

    try {
      const prState = await driver.getPRState(task);
      if (!prState) continue;

      if (prState === 'MERGED') {
        // Check if this is a real merge or spurious (zero unique commits)
        const session = await storage.getSessionByTaskId(task.id);
        const sessionCommits = session ? await storage.getSessionCommits(session.id) : [];

        if (sessionCommits.length === 0) {
          // Spurious merge: task has zero session commits, the "merge" is meaningless
          logger.debug(`Task ${shortId(task.id)}: remote ref merged spuriously (0 session commits), ignoring`);
          result.spurious++;
          continue;
        }

        // INVARIANT (./review-base.ts): a PR merged into a branch that is not
        // the task's target did not land the work where the task integrates —
        // a subtask's PR still based on its old parent's branch after the
        // parent was accepted. Never complete the task on it: say so, once.
        if (!await mergedIntoTaskTarget(storage, driver, task, root)) continue;

        // Transition first, follow-through after (accept-merge-is-commit-point),
        // exactly as every accept exit does. Under the task's lifecycle lock and
        // on a re-read: a live accept or a daemon resume of this task owns it
        // otherwise, and racing it doubled the [Accepted] comment and ran
        // follow-through twice at once. The lock not being free means "not now";
        // the next sync pass looks again.
        const { ACCEPT_IN_FLIGHT_KEY } = await import('./stranded-merge');
        const { readAcceptIntent } = await import('./accept-intent');
        const { commitAcceptTransition, runAcceptFollowThrough, acceptTargetBranchOf } = await import('./task-lifecycle');
        const { tryWithTaskLifecycleLock } = await import('./task-lifecycle-lock');
        const finished = await tryWithTaskLifecycleLock(task.id, async () => {
          const fresh = await storage.getTask(task.id);
          if (!fresh || isTerminalStatus(fresh.status)) return false;
          // A MARKED task is an accept that died after handing the merge to the
          // forge: the human's saved reason goes on the [Accepted] comment. An
          // unmarked one was already commented when the forge took the merge, or
          // was merged outside lazy entirely.
          const marked = !!fresh.metadata?.[ACCEPT_IN_FLIGHT_KEY];
          const intent = marked ? readAcceptIntent(fresh) : null;
          if (fresh.status === 'merging') {
            log.detail(`  Merge completed → task ${theme.taskId(displayId(fresh))} complete`);
          } else {
            log.detail(`  Remote ref merged externally → task ${theme.taskId(displayId(fresh))} complete`);
          }
          const followThrough = {
            targetBranch: await acceptTargetBranchOf(fresh, storage),
            viaForge: true,
            pushParent: false,
            done: [],
            attempts: 0,
          };
          await commitAcceptTransition(storage, fresh, {
            reason: intent?.reason ?? 'Merged on the remote after the accepting process died (original reason was not recorded).',
            actor: getActor(),
            commentActor: intent?.actor ?? 'system',
            writeComment: marked,
            dedupeComment: true,
            followThrough,
          });
          if (!root) return true; // the daemon's follow-through sweep picks the record up
          const followWarnings: string[] = [];
          try {
            const outcome = await runAcceptFollowThrough(root, fresh.id, { warnings: followWarnings, storage, record: { ...followThrough, done: [] } });
            if (outcome.pending.length > 0) {
              log.detail(`  Follow-through pending for ${displayId(fresh)}: ${outcome.error} — the daemon retries`);
            }
          } catch (err) {
            logger.warn(`Task ${shortId(fresh.id)}: follow-through after the remote merge failed (the daemon retries): ${err instanceof Error ? err.message : err}`);
          }
          for (const w of followWarnings) log.detail(`  ${w}`);
          return true;
        });
        if (!finished.ran) {
          logger.debug(`Task ${shortId(task.id)}: remote merge seen, but an accept owns the task right now — leaving it to that accept`);
          continue;
        }
        if (!finished.value) continue;

        result.merged++;
      } else if (prState === 'CLOSED' && lazyClosedReview(task)) {
        // INVARIANT (./lazy-closed-review.ts): lazy closed this PR itself,
        // after a reparent could not move it. The task lives on — settle it
        // (drop the record, a still-submitted task back to blocked); never
        // abandon it, never move its children away.
        const statusNote = await settleLazyClosedReview(storage, task);
        log.detail(`  PR/MR lazy closed after a reparent confirmed closed → ${theme.taskId(displayId(task))} settled`);
        await storage.createComment(task.id,
          `[PR closed] lazy's close of this task's PR/MR is now confirmed by the forge${statusNote}. ` +
          `Submit the task again to open one against its current target.`, 'system');
        continue;
      } else if (prState === 'CLOSED') {
        if (task.status === 'merging') {
          // Merging task's PR/MR was closed remotely — return to blocked so human can act
          log.detail(`  Remote ref closed while merging → task ${theme.taskId(displayId(task))} blocked`);
          await parkTaskPaused(storage, task.id, getActor());
          await storage.createComment(task.id, 'Merge cancelled: PR/MR was closed on the remote while waiting for merge.', getActor());
        } else {
          log.detail(`  Remote ref closed externally → task ${theme.taskId(displayId(task))} closed`);
          await storage.abandonTask(task.id, 'Closed externally via remote', getActor());

          // Re-parent unfinished children (same as accept path)
          const closedReparented = await reparentChildren(task, storage);
          const closedReparentMsg = formatReparentWarning(closedReparented, task);
          if (closedReparentMsg) {
            log.detail(`  ${closedReparentMsg} of ${displayId(task)}.`);
          }
          if (root) {
            const { retargetReviewsAfterReparent } = await import('./review-retarget');
            for (const note of await retargetReviewsAfterReparent(root, storage, closedReparented)) log.detail(`  ${note}`);
          }
        }
        result.closed++;
      }
      // OPEN state — for merging tasks, check if the pipeline/checks have failed
      if (prState === 'OPEN' && task.status === 'merging') {
        try {
          const checksStatus = await driver.getChecksStatus(task);
          if (checksStatus.status === 'failed') {
            const failedNames = checksStatus.failed.map(f => f.name).join(', ');
            log.detail(`  Pipeline failed for merging task ${theme.taskId(displayId(task))} → blocked`);
            await parkTaskPaused(storage, task.id, getActor());
            const failedDetails = checksStatus.failed
              .map(f => f.url ? `${f.name} (${f.url})` : f.name)
              .join(', ');
            await storage.createComment(task.id, `Pipeline/checks failed: ${failedDetails}. Task moved back to blocked.`, getActor());
            result.pipelineFailed++;
          }
        } catch (err) {
          logger.debug(`Failed to check pipeline status for merging task ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      result.errors.push(`Failed to check remote state for task ${displayId(task)}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return result;
}

/** Task metadata: the wrong base a merged PR was already reported for (reported once). */
export const FORGE_MERGED_WRONG_BASE_KEY = 'forge_merged_wrong_base';

/**
 * Did the task's MERGED PR land in the task's own target? False when it merged
 * into another branch (reported once, as a system message) and when the forge
 * or the target cannot be read (retried on the next pass). A task whose target
 * cannot be resolved without a project root is not second-guessed.
 */
export async function mergedIntoTaskTarget(
  storage: Storage,
  driver: RepositoryDriver,
  task: Task,
  root: string | undefined,
): Promise<boolean> {
  const { acceptTargetBranchOf } = await import('./task-lifecycle');
  const { mismatchedReviewBase } = await import('./review-base');
  let target = await acceptTargetBranchOf(task, storage);
  if (target === 'HEAD') {
    if (!root) return true;
    const { resolveDetachedHead } = await import('../git/operations');
    const config = await loadConfig(root);
    target = await resolveDetachedHead(target, root, config.remote.git_remote);
  }
  let base: string | null;
  try {
    base = await mismatchedReviewBase(driver, task, target);
  } catch (err) {
    logger.warn(`Task ${shortId(task.id)}: its PR/MR was merged, but its base could not be read, so the task is not completed yet: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  if (base === null) return true;
  logger.warn(`Task ${shortId(task.id)}: its PR/MR was merged into ${base}, not ${target} — not completing the task`);
  if (task.metadata?.[FORGE_MERGED_WRONG_BASE_KEY] !== base) {
    const url = await driver.getTaskUrl(task);
    await storage.createSystemMessage({
      source: 'daemon',
      kind: 'alert',
      title: `A pull request for ${displayId(task)} was merged into the wrong branch`,
      body:
        `The PR/MR${url ? ` ${url}` : ''} was merged on the forge into \`${base}\`, but **${displayId(task)}** ` +
        `integrates into \`${target}\`, so its work is not in \`${target}\`. Lazy has not marked the task ` +
        `complete, and will not on this merge. Get the work into \`${target}\` on the forge — for example a ` +
        `new PR/MR from the task's branch into \`${target}\` — then close the task.`,
    });
    await storage.updateTaskMetadata(task.id, FORGE_MERGED_WRONG_BASE_KEY, base);
  }
  return false;
}

/**
 * Export direction: push unpushed branches. PR creation is handled by `lazy submit`.
 */
async function exportTasks(storage: Storage, root: string, driver: RepositoryDriver, log: SyncLogger): Promise<{ pushed: number; errors: string[] }> {
  const result = { pushed: 0, errors: [] as string[] };

  const allTasks = await storage.listTasks();

  for (const task of allTasks) {
    // Only export tasks that have sessions (i.e., work has been done).
    // Includes 'pairing' so commits made during a pairing session get pushed
    // promptly rather than waiting for the session to end.
    if (
      task.status !== 'blocked' &&
      task.status !== 'conflict' &&
      task.status !== 'submitted' &&
      task.status !== 'pairing'
    )
      continue;

    const session = await storage.getSessionByTaskId(task.id);
    if (!session?.git_branch) continue;

    // INVARIANT: never push a linked task's branch. That branch belongs to
    // someone else; sync/merge into it is only an explicit human act.
    if (isLinkedTask(task)) continue;

    try {
      // Check if branch exists locally
      if (!await localBranchExists(session.git_branch, root)) continue;

      // Push branch
      try {
        await driver.pushBranch(session.git_branch);
        result.pushed++;
      } catch (err) {
        result.errors.push(`Failed to push ${session.git_branch}: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      // PR creation is now handled exclusively by `lazy submit`.
      // Sync only pushes branches — it does not create remote refs/PRs.
    } catch (err) {
      result.errors.push(`Failed to export task ${displayId(task)}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return result;
}

/**
 * Compute a deterministic signature from a set of CI failures.
 * Used to deduplicate CI failure comments — same signature means same failures.
 */
export function ciFailureSignature(failed: Array<{ name: string; url?: string }>): string {
  return failed
    .map(f => f.url ? `${f.name}|${f.url}` : f.name)
    .sort()
    .join('\n');
}

/**
 * Format a CI failure comment for a single job.
 * Includes the job name, URL, and truncated log output in a collapsible section.
 */
function formatCIFailureComment(job: import('../remote/driver').CIJobFailure): string {
  let comment = `CI failure: **${job.name}**`;
  if (job.url) {
    comment += `\nURL: ${job.url}`;
  }
  if (job.log) {
    comment += `\n\n<details><summary>Log output (last 200 lines)</summary>\n\n\`\`\`\n${job.log}\n\`\`\`\n\n</details>`;
  }
  return comment;
}

/**
 * Import direction: fetch CI check results from remote for all active tasks.
 * Only creates comments for failures — successful runs are ignored.
 * Creates one comment per failed job with log output so the agent can
 * diagnose and fix failures without browser access.
 *
 * Deduplicates using a stored failure signature to avoid re-commenting
 * on the same set of failures across multiple sync runs.
 */
async function fetchCIFailures(storage: Storage, driver: RepositoryDriver, log: SyncLogger): Promise<{ commented: number; errors: string[] }> {
  const result = { commented: 0, errors: [] as string[] };

  const allTasks = await storage.listTasks();

  for (const task of allTasks) {
    if (!driver.hasRemoteRef(task)) continue;
    if (task.status !== 'blocked' && task.status !== 'conflict' && task.status !== 'submitted') continue;

    try {
      const failedJobs = await driver.getFailedCIJobs(task);

      if (failedJobs.length === 0) {
        // No failures — clear the stored signature so re-failures get reported
        const lastSynced = driver.getLastCIFailureSynced(task);
        if (lastSynced) {
          await storage.updateTaskMetadata(task.id, driver.ciFailureSyncedKey(), '');
        }
        continue;
      }

      // Build a signature from the current failure set for dedup
      const signature = ciFailureSignature(failedJobs);
      const lastSynced = driver.getLastCIFailureSynced(task);

      if (lastSynced === signature) {
        // Same failures as last time — don't re-comment
        continue;
      }

      // New or changed failures — create one comment per failed job
      for (const job of failedJobs) {
        await storage.createComment(task.id, formatCIFailureComment(job), getActor(), 'remote');
      }

      // Emit ci_result signal unconditionally — state checks belong in the
      // delivery/consumption phase, not at emission time.
      const failedNames = failedJobs.map(j => j.name).join(', ');
      emitSignal(task.id, {
        type: 'ci_result',
        summary: `CI failed: ${failedNames}`,
        details: { signature, job_count: failedJobs.length },
      });
      logger.debug(`Sync: emitted ci_result signal for task ${shortId(task.id)} (${failedJobs.length} failed job(s))`);

      await storage.updateTaskMetadata(task.id, driver.ciFailureSyncedKey(), signature);
      result.commented += failedJobs.length;
    } catch (err) {
      result.errors.push(`Failed to check CI for task ${displayId(task)}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return result;
}

/**
 * A refresh that did not reach the PR/MR, carried between sync passes so the
 * next one can retry without redoing work it has already paid for.
 *
 * In memory, for the life of the daemon process: this is a retry optimisation,
 * not state anyone needs to survive a restart (a restart just means the next
 * pass re-synthesizes once). It is deliberately NOT Storage — nothing durable
 * depends on it, and a description body written to task metadata on every
 * failing tick would be persistent bloat for a transient condition.
 *
 * EVERY FIELD BELOW STATES WHAT IT IS KEYED ON AND WHEN THAT KEY CHANGES.
 * Three defects in this area were all the same mistake — state keyed on
 * something that moved underneath it (`storage.listTasks()` for the prune, the
 * watermark for the synthesis budget, and a cached body carried across a
 * watermark rebind). The split below is structural, not a convention: the
 * watermark-scoped fields live inside `forSeq`, which is replaced WHOLESALE
 * when the watermark moves and can never be spread across a rebind.
 */
interface PendingFidelity {
  /**
   * WATERMARK-SCOPED. Keyed on `forSeq.seq`; the key changes every time a new
   * turn lands on the task. Undefined when there is nothing cached.
   *
   * Replace this object as a unit or drop it — never rebind `seq` while
   * keeping the rest. A body synthesized for seq 1 relabelled as covering
   * seq 2 gets written on a later pass and the watermark advances to 2, so the
   * description shows work up to turn 1 while the store records turn 2 as
   * reflected: turn 2's work is lost permanently. That is the exact false
   * "this is reflected" record this whole task exists to eliminate, which is
   * why the fields cannot be reached without going through `forSeq`.
   */
  forSeq?: {
    /** The watermark `summary` covers. */
    seq: number;
    /** Synthesized body whose forge write failed, retried VERBATIM next pass. */
    summary: string;
    /**
     * `writeFailureSignature()` of the write warning already reported for THIS
     * body. A write failure retries forever by design, so without this an
     * unfixable one (deleted PR, revoked token) would raise the same error line
     * on every tick for as long as the task sits in review. Reported once, then
     * again only when the signature CHANGES — a different failure is news.
     * Scoped here because a different body failing to write is a different
     * event.
     *
     * A SIGNATURE, not the message: forge errors carry volatile detail (the
     * resolved IP in an ECONNREFUSED, a request id in a 5xx), so comparing
     * whole strings made every tick "a different failure" and reported it.
     */
    reportedWriteSignature?: string;
  };

  /**
   * TASK-SCOPED, current episode. Keyed on the task; the key changes only when
   * an episode ends — a synthesis success (entry deleted) or a re-arm (reset
   * to 0). Deliberately NOT keyed on the watermark: scoping it there made the
   * budget re-arm on every new turn, so an active task paid the full budget
   * per turn against a summarizer that was never coming back.
   */
  synthesisAttempts: number;

  /**
   * TASK-SCOPED. Keyed on the task; holds `synthesisSuccessCount()` as at the
   * moment the budget was spent. The breaker is TRIPPED while that snapshot
   * still equals the live count — i.e. while nothing has demonstrated that
   * synthesis works. Cleared on a synthesis success for this task.
   *
   * Watching the process-wide count is the CHEAP re-arm: synthesis runs on one
   * builder target with one credential, so a success on any task or any accept
   * proves the capability is back without spending anything. It is not the
   * only one — see `trippedPasses` for why it cannot be.
   */
  synthesisGaveUpAt?: number;

  /**
   * TASK-SCOPED. How many sweep passes this task has been skipped for while
   * tripped, since the last attempt. Reset to 0 whenever an attempt is made.
   *
   * This is the INDEPENDENT re-arm, and without it the breaker has none in its
   * commonest failure mode. An unavailable summarizer (expired credential, no
   * model configured, provider outage) fails for every task alike, so once
   * every task in the sweep has spent its budget there is nobody left who can
   * succeed — `synthesisSuccessCount()` can never move again, every task stays
   * tripped for the life of the daemon process, and fixing the credential
   * changes nothing because nothing ever attempts a synthesis to notice. The
   * operator-facing line promised recovery that could not arrive.
   *
   * So once every `FIDELITY_SYNTHESIS_PROBE_EVERY_PASSES` passes the task
   * attempts one synthesis anyway. That bounds the cost at one one-shot per
   * task per that many passes — the same cost class as the budget it already
   * spent, amortised — while making recovery reachable with no signal from
   * anywhere else.
   *
   * A failure on such a pass is NOT evidence about the task: nothing
   * demonstrated that the capability works, so it must not count towards
   * `taskLocalProbes`. See `rearmedBySuccess` at the failure site.
   */
  trippedPasses?: number;

  /**
   * TASK-SCOPED. How many times this task has failed synthesis in a pass it
   * reached only because the capability had demonstrably worked since it last
   * gave up — i.e. how many independent PROBES point at a cause that is THIS
   * task's own (a malformed turn record `gatherEvents` throws on, an oversized
   * bundle, a prompt the model rejects) rather than availability.
   *
   * ONE probe is not evidence. The failures this machinery exists to survive —
   * rate limits, timeouts, an overloaded model — are precisely the ones that
   * fail some calls and succeed others, so "a sibling succeeded and then we
   * failed once" is exactly what an intermittent outage looks like. Each probe
   * costs one one-shot, so the bar is two rather than many.
   */
  taskLocalProbes?: number;

  /**
   * TASK-SCOPED. Set once `taskLocalProbes` reaches the bar: the process-wide
   * success count at which this task gets one more attempt anyway.
   *
   * The classification must have a way back. It is a likelihood, not a
   * determination, and a genuinely task-local cause can be FIXED — a turn
   * record repaired, history trimmed, the summarizer's model changed — with
   * nothing in the daemon to notice. So instead of staying tripped for the life
   * of the process, the task stops honouring a sibling's success only until the
   * capability has demonstrated itself `TASK_LOCAL_RETRY_AFTER_SUCCESSES` more
   * times, then probes again.
   *
   * That horizon is NOT the binding bound any more, and reading it as one
   * overstates it: the periodic probe (`trippedPasses`) reaches a latched task
   * too, so whichever comes first wins. On a busy project that is the horizon;
   * at around one success per pass — a quiet project, and this area's unit
   * suite — it is the probe. Either way the cost is bounded and small, one
   * one-shot per whichever interval arrives first, and the dead end is gone.
   */
  taskLocalRetryAt?: number;
}

/*
 * There is deliberately no "already reported the give-up" flag here. The write
 * path needs `reportedWriteSignature` because it RETRIES every pass and so
 * re-reaches its reporting site; the give-up has no equivalent, because it is
 * reported only at the moment of tripping and a tripped task does not reach any
 * reporting: on most passes it returns from the branch above, and on the pass
 * its periodic probe comes due it re-reaches the failure site but takes the
 * probe-failed branch, which is deliberately silent (a still-down summarizer is
 * not news). The one give-up that can be reached twice
 * — the task-local reclassification — is guarded by `taskLocalRetryAt`, which
 * is load-bearing for the breaker anyway. A flag would have been a second,
 * unread copy of a guarantee the control flow already provides.
 */

const pendingFidelity = new Map<string, PendingFidelity>();

/**
 * Drop all carried retry state. Pure cache invalidation — the worst it can
 * cost is one re-synthesis on the next pass — so it is safe anywhere; tests
 * call it between cases so one case's failed write cannot silently satisfy the
 * next one's retry path.
 */
export function clearPendingFidelity(): void {
  pendingFidelity.clear();
}

/**
 * How many times the sweep may attempt SYNTHESIS for a TASK before tripping
 * that task's breaker (`PendingFidelity.synthesisGaveUpAt`) with a loud error.
 *
 * Counted per task and NOT per watermark: a new turn must not re-arm it, or an
 * active task pays the whole budget again for every turn it lands.
 *
 * Unlike a failed forge write — where the body is cached and the retry is one
 * cheap API call — a synthesis fallback leaves nothing to retry with, so every
 * attempt is a fresh summarizer one-shot (a container and a model call, up to
 * SUMMARIZER_TIMEOUT_MS). Retrying that per task on a 60s cadence forever, for
 * a permanently unavailable summarizer (no credential, no model configured),
 * would cost far more than the staleness it guards against. Three attempts
 * covers the transient cases that motivated holding the watermark at all —
 * a timeout, a rate limit, an overloaded model — and then stops attempting on
 * every pass. It does not stop attempting altogether: a tripped task still
 * probes once every FIDELITY_SYNTHESIS_PROBE_EVERY_PASSES, which is what makes
 * recovery reachable when the failure is global.
 */
const MAX_FIDELITY_SYNTHESIS_ATTEMPTS = 3;

/**
 * How many independent probes must fail before the cause is called this task's
 * own (`PendingFidelity.taskLocalProbes`).
 *
 * A probe is a failure in a pass reached only because synthesis had succeeded
 * somewhere since this task gave up. One of those settles nothing: a rate limit
 * or an overloaded model fails some calls and succeeds others, so one sibling
 * success followed by one failure here is exactly the pattern an intermittent
 * outage produces. Two, each after a FURTHER demonstrated success, is weak
 * evidence made twice — still not proof, which is why the message says
 * "probably" and why the classification expires.
 */
const TASK_LOCAL_PROBES_REQUIRED = 2;

/**
 * Once classified, how many more process-wide successes must be observed before
 * this task probes again (`PendingFidelity.taskLocalRetryAt`).
 *
 * The classification is a likelihood and the cause may be fixed at any time, so
 * it must expire rather than hold for the life of the daemon. Large enough that
 * the cost is negligible next to the constant sibling traffic on an active
 * project — at most one one-shot per this many successes — and small enough
 * that a repaired task catches up the same day.
 *
 * "At most", because FIDELITY_SYNTHESIS_PROBE_EVERY_PASSES can arrive first and
 * spend the attempt instead; see `PendingFidelity.taskLocalRetryAt` for which
 * of the two binds when.
 */
const TASK_LOCAL_RETRY_AFTER_SUCCESSES = 25;

/**
 * How many sweep passes a tripped task is skipped for before it attempts ONE
 * synthesis anyway (`PendingFidelity.trippedPasses`).
 *
 * The success-count re-arm above is free but not sufficient: the failure this
 * breaker exists for is usually global (no credential, no model, a provider
 * outage), and once every task has tripped there is nobody left to move the
 * count. Without this probe the daemon could never notice the summarizer
 * coming back.
 *
 * At the default 60s `[server] sync_interval` this is roughly twenty minutes
 * per tripped task: negligible against the model calls a working project makes
 * anyway, and fast enough that a fixed credential is picked up while the
 * operator is still watching. It is expressed in PASSES rather than minutes
 * because the sweep is what does the attempting — a task is only skipped, and
 * so only owed a probe, on a pass that actually ran.
 */
const FIDELITY_SYNTHESIS_PROBE_EVERY_PASSES = 20;

/**
 * Collapse a forge write warning to the bit that identifies WHICH failure it
 * is, so "the same failure again" can be recognised across ticks.
 *
 * Forge errors carry detail that changes every attempt while the failure does
 * not: the resolved address in `connect ECONNREFUSED 140.82.121.4:443`, a
 * request id in a 5xx body, a timestamp in a rate-limit message. Comparing the
 * whole formatted string made each of those a "new" failure and re-reported it
 * on every pass — the recurring noise the dedup exists to prevent.
 *
 * Volatile tokens are replaced; everything that names the failure is kept.
 * Short numbers survive deliberately, because an HTTP status IS the error
 * class and 404 must not dedup against 502.
 */
function writeFailureSignature(warning: string): string {
  return warning
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<addr>')
    .replace(/\b[0-9a-f]{7,}\b/gi, '<id>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .trim();
}

/**
 * Refresh the PR/MR body's lazy-owned fidelity section when new work has
 * landed since the last pass. Replaces the removed per-turn comment mirroring
 * (`postTurnSummaries`): forge comments are for people, and turn narration was
 * reported as noise — but the PR/MR DESCRIPTION should still reflect what the
 * work has become before anyone opens it.
 *
 * Tracks the last turn seen via driver-managed metadata (the same watermark the
 * removed posting used, so existing stores keep their progress). The watermark
 * advances past every turn — including ask/nudge/review turns, which carry no
 * new work — so they are not re-inspected forever. The body is regenerated
 * only when at least one of the new turns was substantive: an agent work turn
 * or genuine (non-auto) human feedback. Linked tasks are skipped: a linked
 * task never writes another task's PR/MR.
 *
 * The watermark is written AFTER the refresh, and only when the DESCRIPTION
 * actually changed — see the ordering INVARIANT in the loop.
 */
async function refreshFidelityForNewWork(
  storage: Storage,
  driver: RepositoryDriver,
  root: string,
): Promise<{ refreshed: number; errors: string[] }> {
  const result = { refreshed: 0, errors: [] as string[] };
  // Tasks whose refresh failed again on THIS pass, and whose carried state is
  // therefore still wanted. Everything else in `pendingFidelity` is dropped at
  // the end of the pass — see the INVARIANT there.
  const carriedForward = new Set<string>();
  // Whether the usage pause holds the builder role's credential, judged once
  // per pass and only when a regeneration would run (undefined = not asked yet).
  let builderPaused: TaskUsagePause | null | undefined;

  const allTasks = await storage.listTasks();

  for (const task of allTasks) {
    if (!driver.hasRemoteRef(task)) continue;
    // INVARIANT: a linked task never writes another task's PR/MR. Its remote
    // ref points at a PR/MR adopted from someone else (`lazy link`), so a
    // fidelity refresh would rewrite THAT body with this task's own turn
    // history, competing with the PR owner task's refresh of the same
    // section. Same boundary as syncTaskFromRemote (never push or open a PR
    // for a linked task) and exportTasks (never push a linked branch).
    if (isLinkedTask(task)) continue;
    if (task.status !== 'blocked' && task.status !== 'conflict' && task.status !== 'submitted') continue;

    try {
      const session = await storage.getSessionByTaskId(task.id);
      if (!session) continue;

      const turns = await storage.getSessionTurns(session.id);
      if (turns.length === 0) continue;

      // Find all turns not yet reflected in the PR/MR body.
      const lastFidelitySeqNum = driver.getLastFidelityTurnSeq(task);

      const unreflectedTurns = turns.filter(t => t.sequence > lastFidelitySeqNum);
      if (unreflectedTurns.length === 0) continue;

      // Substantive = new work landed (agent work or genuine human feedback).
      // Review / nudge / ask / sync / wrap_up turns (and legacy pre_accept
      // ones) and auto-react echoes have their own paths or are internal
      // noise — never "new work".
      const hasNewWork = unreflectedTurns.some(turn => {
        if (turn.role === 'agent') {
          return (turn.turn_type ?? 'work') === 'work';
        }
        if (turn.role === 'human') {
          if (turn.sequence === 0) return false;
          if (turn.auto_triggered) return false;
          if (turn.actor === 'system' || turn.actor === 'supervisor') return false;
          return (turn.turn_type ?? 'work') === 'work';
        }
        return false;
      });

      const newestSeq = Math.max(...unreflectedTurns.map(t => t.sequence));
      if (newestSeq > lastFidelitySeqNum) {
        // INVARIANT: the body refresh fires only when there are NEW turns, i.e.
        // on actual new work — never on upstream-merge sync (syncTask), which
        // does not consider turns at all. See CLAUDE.md "Upstream merge is
        // sync's job". Non-blocking: regenerateFidelity never throws.
        //
        // Still built PER TASK inside the loop, now for ATTRIBUTION only: every
        // task in the sweep runs on the same builder role target (INVARIANT
        // oneshot-runs-on-builder, src/oneshot/types.ts), but each summary's
        // usage must land on the task it is about, and `taskRef` is what carries
        // that. Hoisting one summarizer out of the loop would bill the whole
        // sweep to whichever task happened to be first.
        //
        // Only regenerate when substantive work actually landed for THIS task —
        // nudges/reviews/asks alone are not "new work".
        if (hasNewWork) {
          // INVARIANT: the watermark advances only once the DESCRIPTION
          // actually changed. regenerateFidelity deliberately never throws, so
          // writing the watermark first left it past turns whose work never
          // reached the PR/MR: a brief forge outage silently froze the
          // description until the next substantive turn happened to arrive.
          // While per-turn comment mirroring existed a cold reader had that as
          // a fallback; with it gone the description is all they see.
          //
          // Branch on `outcome`, never on `warning`: TWO outcomes leave the
          // description untouched and only one of them warns. A synthesis
          // fallback writes nothing at all (it must not downgrade a good
          // description to a commit list) and returns no warning, so a
          // warning-only check would call that success and lose the work from
          // the description exactly as the original ordering did.
          const pending = pendingFidelity.get(task.id);
          // The per-TASK synthesis fields, which survive a watermark change.
          // Carried explicitly rather than by spreading `pending`, so a stale
          // watermark-scoped field cannot ride along by accident.
          const taskScoped = {
            synthesisAttempts: pending?.synthesisAttempts ?? 0,
            synthesisGaveUpAt: pending?.synthesisGaveUpAt,
            taskLocalProbes: pending?.taskLocalProbes,
            taskLocalRetryAt: pending?.taskLocalRetryAt,
          };

          // A cached body is reusable ONLY for the exact watermark it was
          // synthesized for. At any other watermark it describes fewer turns
          // than the store would then record as reflected, so it is not
          // "slightly stale" — writing it loses the newer work for good.
          const carried = pending?.forSeq?.seq === newestSeq ? pending.forSeq : undefined;

          // Tripped while nothing has demonstrated that synthesis works since
          // we gave up — or, once the cause has been classified as probably
          // this task's own, until the capability has demonstrated itself a
          // further TASK_LOCAL_RETRY_AFTER_SUCCESSES times. Both arms watch the
          // same process-wide counter; the classification only raises the bar,
          // it never removes the way back. A cached body is still worth writing
          // (that path needs no summarizer), so only the synthesizing branch is
          // gated.
          const countTripped =
            pending?.synthesisGaveUpAt !== undefined &&
            (pending.taskLocalRetryAt !== undefined
              ? synthesisSuccessCount() < pending.taskLocalRetryAt
              : pending.synthesisGaveUpAt === synthesisSuccessCount());

          // ...unless a probe is due. Neither arm above can re-arm when the
          // summarizer is down for EVERYONE — there is then no sibling left to
          // move the count — so a tripped task attempts one synthesis anyway
          // every FIDELITY_SYNTHESIS_PROBE_EVERY_PASSES passes. This is the
          // only re-arm that needs no signal from outside the task, which is
          // what makes recovery reachable at all; it deliberately applies to
          // the task-local arm too, since that latch watches the same
          // unmovable counter.
          const passesSkipped = (pending?.trippedPasses ?? 0) + 1;
          const probeDue = countTripped && passesSkipped >= FIDELITY_SYNTHESIS_PROBE_EVERY_PASSES;
          const synthesisTripped = countTripped && !probeDue;

          if (synthesisTripped && !carried) {
            // Attempt nothing: with no body to write and synthesis known to be
            // down, every option here costs a one-shot to fail again.
            //
            // The watermark is HELD, which costs nothing (these turns are read
            // from storage every tick regardless) and means no work is lost:
            // whenever synthesis comes back, the next pass refreshes covering
            // everything that landed in the meantime. Holding is only safe
            // because the breaker — not the watermark — is what stops the
            // re-attempts.
            carriedForward.add(task.id);
            // Count the skip, so the probe above comes due. Written through
            // `taskScoped` and with no `forSeq` — a body cached for an older
            // watermark is worthless here, since `carried` is undefined.
            pendingFidelity.set(task.id, { ...taskScoped, trippedPasses: passesSkipped });
            // The give-up was already reported when the breaker tripped, so
            // this is silent by construction; the debug line keeps it
            // traceable.
            logger.debug(
              `Fidelity synthesis given up for task ${displayId(task)}; not attempting ` +
              `(pass ${passesSkipped} of ${FIDELITY_SYNTHESIS_PROBE_EVERY_PASSES} until the next probe).`,
            );
            continue;
          }

          // [usage_pause]: a fresh regeneration runs a model one-shot on the
          // builder role's credential. While that is paused the pass is skipped
          // for this task — the watermark and any carried state are held, so the
          // first pass after the reset refreshes the description covering
          // everything that landed meanwhile. A cached body still gets written:
          // that path spends nothing.
          if (!carried) {
            if (builderPaused === undefined) builderPaused = await daemonBesideLaunchPaused(root).catch((err: unknown) => {
              // A check that cannot run is not evidence of a pause.
              logger.debug(`usage pause: could not judge the description refresh: ${String(err)}`);
              return null;
            });
            if (builderPaused) {
              carriedForward.add(task.id);
              logger.debug(
                `Fidelity refresh for task ${displayId(task)} held by the usage pause: ` +
                  describeUsagePause(builderPaused.verdict),
              );
              continue;
            }
          }

          let outcome: FidelityRemoteOutcome;
          let warning: string | undefined;
          let body: string | undefined;

          if (carried) {
            // Retry the WRITE only. Nothing has landed since the attempt that
            // failed, so re-running the summarizer would spend a model one-shot
            // to re-derive the text we are already holding. This is what keeps
            // a persistently failing forge (deleted PR, revoked token, 403)
            // from costing one one-shot per task per tick indefinitely — the
            // retry is one API call, the same cost class as the PR-state and
            // CI checks this sweep already makes every tick for every task.
            // This is a retry of a write that already warned once; the repeat
            // reporting below decides whether it is worth saying again.
            const write = await writeFidelityBody(task, driver, carried.summary, { logWarning: false });
            outcome = write.outcome;
            warning = write.warning;
            body = carried.summary;
          } else {
            const summarizer = getSummarizer(root, taskRef(task));
            const fidelity = await regenerateFidelity(storage, task, driver, summarizer);
            outcome = fidelity.outcome;
            warning = fidelity.warning;
            body = fidelity.fidelityBody;
          }

          if (outcome === 'write-failed') {
            // Keep the body so the next pass retries the write for free. `body`
            // is always set here: a fresh regeneration that reached the write
            // returns its summary, and the retry path passed one in.
            //
            // Reaching here via a fresh regenerateFidelity means synthesis just
            // SUCCEEDED, so the whole synthesis episode resets — budget,
            // breaker and the task-local verdict. Reaching it via the
            // cached-body retry means no synthesis happened at all, so those
            // carry over untouched.
            const synthesized = !carried;
            // The retry is unbounded, so the REPORT must not be: a write that
            // can never succeed (deleted PR, revoked token) would otherwise
            // raise an error every tick for as long as the task sits in review.
            // Report it once per (task, watermark), and again only when the
            // failure's SIGNATURE changes — a different failure is news, the
            // same one with a fresh IP or request id is not. Repeats stay
            // visible at debug level rather than vanishing.
            const signature = warning === undefined ? undefined : writeFailureSignature(warning);
            pendingFidelity.set(task.id, {
              ...(synthesized ? { synthesisAttempts: 0 } : taskScoped),
              forSeq: body === undefined ? undefined : {
                seq: newestSeq,
                summary: body,
                reportedWriteSignature: signature,
              },
            });
            carriedForward.add(task.id);

            if (warning && signature !== carried?.reportedWriteSignature) {
              result.errors.push(warning);
            } else if (warning) {
              logger.debug(`Fidelity write still failing for task ${displayId(task)}: ${warning}`);
            }
            continue;
          }

          if (outcome === 'synthesis-fallback') {
            // Nothing reached the forge, and any body cached for an EARLIER
            // watermark is now worthless — it covers fewer turns than the
            // watermark it would be written against. Every branch below
            // therefore writes the entry with no `forSeq` at all, dropping it.
            carriedForward.add(task.id);
            const successes = synthesisSuccessCount();

            // A task that HAD given up reaches an attempt in exactly two ways,
            // and only one of them is evidence about the task:
            //
            //  - the process-wide count MOVED since it gave up. The capability
            //    worked somewhere and this task failed anyway: that is ONE
            //    probe pointing at a cause local to this task. One is not
            //    evidence — an intermittent failure (rate limit, timeout,
            //    overloaded model) produces exactly this pattern — so only
            //    once TASK_LOCAL_PROBES_REQUIRED of them have each landed
            //    after a FURTHER demonstrated success is the cause called, and
            //    even then as a likelihood with an expiry, never as a verdict.
            //
            //  - the PERIODIC probe came due (see `trippedPasses`). Nothing
            //    demonstrated anything — the count not moving is precisely why
            //    that probe exists — so a failure here says only that the
            //    summarizer is still down. Counting it as a task-local probe
            //    would let a global outage classify every task in the sweep as
            //    broken in itself and send the operator to read turn records
            //    when their credential is what is wrong.
            //
            // `rearmedBySuccess` is what tells them apart, and it is exact: a
            // moved count is the ONLY thing that makes `countTripped` false,
            // in either of its arms, so an attempt with an unmoved count can
            // only have come from the probe. Do not reduce it back to
            // "had given up" — that is the bug.
            const rearmedBySuccess =
              taskScoped.synthesisGaveUpAt !== undefined && successes !== taskScoped.synthesisGaveUpAt;

            if (taskScoped.synthesisGaveUpAt !== undefined && !rearmedBySuccess) {
              // The periodic probe fired and failed: the summarizer is still
              // down. Nothing has changed except the cost of one one-shot, so
              // re-trip with the same verdict as before, reset the pass count
              // and say nothing — the give-up line already stands, and it
              // already told the operator this is retried.
              pendingFidelity.set(task.id, {
                ...taskScoped,
                synthesisAttempts: taskScoped.synthesisAttempts + 1,
                synthesisGaveUpAt: successes,
                trippedPasses: 0,
              });
              logger.debug(
                `Fidelity synthesis probe failed for task ${displayId(task)}; summarizer still unavailable, ` +
                `probing again in ${FIDELITY_SYNTHESIS_PROBE_EVERY_PASSES} passes.`,
              );
              continue;
            }

            if (rearmedBySuccess) {
              const probes = (taskScoped.taskLocalProbes ?? 0) + 1;
              const classified = probes >= TASK_LOCAL_PROBES_REQUIRED;
              pendingFidelity.set(task.id, {
                synthesisAttempts: taskScoped.synthesisAttempts + 1,
                synthesisGaveUpAt: successes,
                taskLocalProbes: probes,
                taskLocalRetryAt: classified ? successes + TASK_LOCAL_RETRY_AFTER_SUCCESSES : undefined,
                trippedPasses: 0,
              });
              // A second and final line for this task, and only because it says
              // something the first did not: the cause is probably local, so
              // checking the summarizer's credential is probably the wrong
              // place to look. Said once — a later probe that fails again only
              // pushes the retry out, which is not news.
              if (classified && taskScoped.taskLocalRetryAt === undefined) {
                result.errors.push(
                  `PR description for task ${displayId(task)} left stale: fidelity synthesis failed for this ` +
                  `task on ${probes} attempts that each followed a synthesis succeeding elsewhere, so the cause ` +
                  `is PROBABLY specific to this task rather than the summarizer (its turn records, or the size ` +
                  `of its history, are the first things to look at) — though an intermittent failure can look ` +
                  `the same. It is retried automatically after ${TASK_LOCAL_RETRY_AFTER_SUCCESSES} further ` +
                  `successful syntheses elsewhere, or every ${FIDELITY_SYNTHESIS_PROBE_EVERY_PASSES} sync ` +
                  `passes as a probe, and its description is brought up to date when the task is accepted.`,
                );
              } else {
                logger.debug(
                  `Fidelity synthesis failed again for task ${displayId(task)} after a success elsewhere ` +
                  `(probe ${probes}); ${classified ? `retrying after ${TASK_LOCAL_RETRY_AFTER_SUCCESSES} more successes` : 'not yet classified as task-local'}.`,
                );
              }
              continue;
            }

            // Counted PER TASK, not per watermark: an active task landing turns
            // while the summarizer is down would otherwise re-arm the budget on
            // every one of them and never reach the give-up at all.
            const attempts = taskScoped.synthesisAttempts + 1;
            if (attempts < MAX_FIDELITY_SYNTHESIS_ATTEMPTS) {
              pendingFidelity.set(task.id, { synthesisAttempts: attempts });
              result.errors.push(
                `PR description for task ${displayId(task)} not updated: fidelity synthesis unavailable ` +
                `(attempt ${attempts} of ${MAX_FIDELITY_SYNTHESIS_ATTEMPTS}); retrying on the next sync pass.`,
              );
              continue;
            }

            // Budget spent: trip the breaker and say so LOUDLY, once. The
            // watermark is held, so nothing is lost — see the tripped branch
            // above for why that is safe and what re-arms it.
            pendingFidelity.set(task.id, {
              synthesisAttempts: attempts,
              synthesisGaveUpAt: successes,
            });
            result.errors.push(
              `PR description for task ${displayId(task)} left stale: fidelity synthesis unavailable after ` +
              `${MAX_FIDELITY_SYNTHESIS_ATTEMPTS} attempts. Synthesis for this task is retried as soon as one ` +
              `succeeds anywhere, and otherwise probed once every ${FIDELITY_SYNTHESIS_PROBE_EVERY_PASSES} ` +
              `sync passes, after which the description catches up covering everything since — check the ` +
              `summarizer's model and credential.`,
            );
            continue;
          }

          // 'written', or 'not-attempted' — no remote body to write at all,
          // which cannot happen here (the loop already required a remote ref)
          // but must still advance the watermark rather than wedge. Dropping
          // the entry also clears the synthesis budget and the breaker: this
          // task is healthy again.
          pendingFidelity.delete(task.id);
          if (outcome === 'written') result.refreshed++;
        }

        // Advance the watermark past ALL unreflected turns (skipped ones too),
        // so we do not re-inspect them forever. When hasNewWork is false there
        // was nothing to write remotely, so nothing can have failed — that
        // advance is what keeps non-substantive turns off every later tick.
        await storage.updateTaskMetadata(task.id, driver.fidelityTurnSeqKey(), String(newestSeq));
      }
    } catch (err) {
      result.errors.push(`Failed to refresh PR description for task ${displayId(task)}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // INVARIANT: after a pass, the map holds EXACTLY the tasks whose refresh
  // failed during that pass. Anything not re-affirmed above is dropped, so the
  // map cannot grow across passes.
  //
  // It must be keyed on what the sweep re-affirmed, not on what storage holds:
  // `listTasks()` returns every task whatever its status, so a task that was
  // accepted or closed after a failed write is still in that list. Pruning
  // against it would never drop anything except a task physically deleted from
  // storage, and a finished task's whole description body would sit in daemon
  // memory for the life of the process — the growth this is here to prevent.
  //
  // Dropping an entry only ever costs one re-synthesis on a later pass, so
  // erring towards dropping is the safe direction. A task skipped this pass
  // because storage threw loses its cached body for that reason and no other.
  for (const id of pendingFidelity.keys()) {
    if (!carriedForward.has(id)) pendingFidelity.delete(id);
  }

  return result;
}

/**
 * Import direction: fetch comments from remote for all active tasks.
 * Reuses syncTaskFromRemote which handles dedup, storage, and timestamp tracking.
 */
async function fetchRemoteComments(storage: Storage, root: string, driver: RepositoryDriver): Promise<{ synced: number; errors: string[] }> {
  const result = { synced: 0, errors: [] as string[] };

  const allTasks = await storage.listTasks();

  for (const task of allTasks) {
    if (!driver.hasRemoteRef(task)) continue;
    if (task.status !== 'blocked' && task.status !== 'conflict' && task.status !== 'submitted') continue;

    try {
      // Capture comment count before sync to detect new comments
      const commentsBefore = await storage.getTaskComments(task.id);
      const countBefore = commentsBefore.length;

      await syncTaskFromRemote(task, storage, root);

      const commentsAfter = await storage.getTaskComments(task.id);
      const newCount = commentsAfter.length - countBefore;
      if (newCount > 0) {
        result.synced += newCount;

        // Emit comment signals unconditionally — state checks belong in the
        // delivery/consumption phase, not at emission time.
        const newComments = commentsAfter.slice(countBefore);
        for (const comment of newComments) {
          // Don't signal for builder-authored comments (the agent itself)
          if (comment.actor === 'builder') continue;
          emitSignal(task.id, {
            type: 'comment',
            summary: comment.content,
            details: { comment_id: comment.id, actor: comment.actor ?? 'human', source: 'remote' },
          });
        }
        logger.debug(`Sync: emitted ${newCount} comment signal(s) for task ${shortId(task.id)}`);
      }
    } catch (err) {
      result.errors.push(`Failed to fetch comments for task ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return result;
}

/**
 * Core sync logic — single source of truth for all remote sync operations.
 *
 * Runs all sync phases (fetch upstream, detect external changes, fetch comments,
 * export branches, refresh PR descriptions) using the provided storage and root
 * directory. Output is routed through the provided SyncLogger.
 *
 * Does NOT call process.exit or close storage — caller manages lifecycle.
 * Throws if the remote driver has no remote configured (LocalDriver).
 */
export async function runSync(root: string, storage: Storage, log: SyncLogger): Promise<void> {
  const config = await loadConfig(root);
  // Provide storage/root context so hosted-driver CLI calls (incl. commit/PR
  // fidelity body edits) run against the project root.
  const driver = createDriver(config, { storage, lazyRoot: root });

  // Collect unique target branches from active tasks so we can fast-forward them
  const allTasksForBranches = await storage.listTasks();
  const targetBranches = [
    ...new Set(
      allTasksForBranches
        .filter(t => !isTerminalStatus(t.status))
        .map(t => targetBranchOf(t))
        .filter((b): b is string => typeof b === 'string' && b !== 'HEAD')
    ),
  ];

  // Let the driver fetch upstream state (git fetch, ff-merge, etc.)
  // Throws for LocalDriver — caller decides how to handle.
  await driver.fetchRemoteState(root, targetBranches);

  // Linked branch-only tasks: attach a PR/MR that appeared since last pass.
  // PULL only — no webhooks. Uses the adopted git branch, never lazy/<ref>.
  log.phase('Discovering pull requests for linked branches...');
  const discovery = await attachLinkedPullRequests(storage, driver, log);
  if (discovery.attached > 0) {
    log.detail(`  ${discovery.attached} linked branch(es) now have a pull request`);
  } else {
    log.detail('  No new pull requests for linked branches');
  }

  // Detect external changes (merged/closed on remote)
  log.phase('Detecting external changes...');
  const externalResult = await detectExternalChanges(storage, driver, log, root);

  const changes = externalResult.merged + externalResult.closed + externalResult.spurious + externalResult.pipelineFailed;
  if (changes > 0) {
    if (externalResult.merged > 0) {
      log.detail(`  ${externalResult.merged} PR(s) merged externally`);
    }
    if (externalResult.closed > 0) {
      log.detail(`  ${externalResult.closed} PR(s) closed externally`);
    }
    if (externalResult.pipelineFailed > 0) {
      log.detail(`  ${externalResult.pipelineFailed} merging task(s) returned to blocked (pipeline failed)`);
    }
    if (externalResult.spurious > 0) {
      log.detail(`  ${externalResult.spurious} spurious merge(s) ignored`);
    }
  } else {
    log.detail('  No external changes');
  }

  for (const error of externalResult.errors) {
    log.error(`  Error: ${error}`);
  }

  // Import direction: fetch comments from remote
  log.phase('Fetching PR comments...');
  const commentResult = await fetchRemoteComments(storage, root, driver);

  if (commentResult.synced > 0) {
    log.detail(`  ${commentResult.synced} comment(s) fetched`);
  } else {
    log.detail('  No new comments');
  }

  for (const error of commentResult.errors) {
    log.error(`  Error: ${error}`);
  }

  // Import direction: fetch CI failure results from remote
  log.phase('Checking CI status...');
  const ciResult = await fetchCIFailures(storage, driver, log);

  if (ciResult.commented > 0) {
    log.detail(`  ${ciResult.commented} CI failure comment(s) added`);
  } else {
    log.detail('  No new CI failures');
  }

  for (const error of ciResult.errors) {
    log.error(`  Error: ${error}`);
  }

  // Export direction: lazy → remote.
  //
  // This is the daemon's own background tick, not a push the user asked for, so
  // it is one of the automatic pushes `<driver>_auto_push = false` opts out of.
  // Every other sync phase (fetch, comments, CI, PR artifacts) still runs — the
  // setting is about not pushing branches, not about going offline.
  log.phase('Exporting task branches...');
  if (!autoPushEnabled(config)) {
    log.detail(`  Skipped — ${autoPushConfigKey(config)} = false`);
  } else {
    const exportResult = await exportTasks(storage, root, driver, log);

    if (exportResult.pushed > 0) {
      log.detail(`  ${exportResult.pushed} branch(es) pushed`);
    } else {
      log.detail('  Nothing to export');
    }

    for (const error of exportResult.errors) {
      log.error(`  Error: ${error}`);
    }
  }

  // Refresh the PR/MR body's lazy-owned fidelity section when new work has
  // landed. Forge COMMENTS are for people — per-turn narration was removed
  // (reported as noise); only the description reflects new work.
  log.phase('Refreshing PR descriptions...');
  const fidelityResult = await refreshFidelityForNewWork(storage, driver, root);

  if (fidelityResult.refreshed > 0) {
    log.detail(`  ${fidelityResult.refreshed} PR description(s) refreshed`);
  } else {
    log.detail('  No new work to reflect');
  }

  for (const error of fidelityResult.errors) {
    log.error(`  Error: ${error}`);
  }

  log.done(theme.success('\nSync complete.'));
}
