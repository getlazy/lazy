/**
 * Daemon remote sync — periodic synchronization of all tasks with the remote.
 *
 * Runs as part of the daemon's reconcile loop to:
 *   - Fetch upstream state (git fetch, fast-forward target branches)
 *   - Detect externally merged/closed PRs and update task state
 *   - Fetch PR comments from remote
 *   - Fetch CI failure results
 *   - Push unpushed task branches
 *   - Post turn summaries and notes to PRs
 *
 * All remote-specific logic lives behind the RepositoryDriver interface.
 * This module orchestrates the sync flow without knowing whether the
 * remote is GitHub, GitLab, or any other forge.
 */

import { shortId, displayId, getWorktreePath, taskRef } from '../cli/helpers';
import { loadConfig } from '../config/loader';
import { createDriver, type RepositoryDriver } from '../remote';
import { regenerateFidelity } from '../synthesis/fidelity';
import { getSummarizer } from '../synthesis/summarizer';
import type { Summarizer } from '../synthesis/summarizer';
import { syncTaskFromRemote, cleanupWorktreeAndBranch, cleanupTaskContainer } from '../cli/commands/shared';
import { theme } from '../cli/theme';
import { logger } from '../utils/logger';
import { localBranchExists } from '../git/operations';
import { isTerminalStatus } from '../types';
import { targetBranchOf } from '../task-target';
import { removeLock } from '../utils/lock';
import { protocolDir, removeProtocolDir } from '../protocol';
import { getActor } from '../constants';
import { reparentChildren, formatReparentWarning } from '../cli/orphan';
import { emitSignal } from './signals';
import type { Storage } from '../storage';

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

        // Real merge: task has session commits
        if (task.status === 'merging') {
          log.detail(`  Merge completed → task ${theme.taskId(displayId(task))} complete`);
        } else {
          log.detail(`  Remote ref merged externally → task ${theme.taskId(displayId(task))} complete`);
        }
        if (session && !session.ended_at) {
          await storage.endSession(session.id, 'accepted');
        }
        // Transition through merging → complete to satisfy state machine.
        // Most statuses can't transition directly to complete — must go through merging.
        // working/interrupted/pairing also need this path for externally merged MRs
        // (e.g., task was working but crashed when MR was merged on the remote).
        if (task.status !== 'merging' && task.status !== 'complete') {
          await storage.updateTaskStatus(task.id, 'merging', getActor());
        }
        await storage.updateTaskStatus(task.id, 'complete', getActor());

        // Re-parent unfinished children to the grandparent
        const reparented = await reparentChildren(task, storage);
        const reparentMsg = formatReparentWarning(reparented, task);
        if (reparentMsg) {
          log.detail(`  ${reparentMsg} of ${displayId(task)}.`);
        }

        // Clean up worktree, container, and protocol dir for completed merging tasks
        if (root && session) {
          try {
            await cleanupTaskContainer(storage, session, taskRef(task), root);
            const worktreePath = getWorktreePath(root, task);
            await removeLock(worktreePath);
            await cleanupWorktreeAndBranch(worktreePath, session.git_branch, root, storage, task.id, session.agent_session_id);
            removeProtocolDir(protocolDir(task.id));
          } catch (err) {
            logger.debug(`Cleanup after merge completion failed for task ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
          }
        }

        result.merged++;
      } else if (prState === 'CLOSED') {
        if (task.status === 'merging') {
          // Merging task's PR/MR was closed remotely — return to blocked so human can act
          log.detail(`  Remote ref closed while merging → task ${theme.taskId(displayId(task))} blocked`);
          await storage.updateTaskStatus(task.id, 'blocked', getActor());
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
            await storage.updateTaskStatus(task.id, 'blocked', getActor());
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
 * Post all unposted turns (agent summaries AND human review feedback) to remote.
 * Tracks last posted turn via driver-managed metadata.
 *
 * Posts turns in chronological order so the remote comment thread mirrors the
 * conversation. Both agent and human turns are posted — human turns represent
 * review feedback that external reviewers need to see.
 */
async function postTurnSummaries(storage: Storage, driver: RepositoryDriver, summarizer: Summarizer): Promise<{ posted: number; errors: string[] }> {
  const result = { posted: 0, errors: [] as string[] };

  const allTasks = await storage.listTasks();

  for (const task of allTasks) {
    if (!driver.hasRemoteRef(task)) continue;
    if (task.status !== 'blocked' && task.status !== 'conflict' && task.status !== 'submitted') continue;

    try {
      const session = await storage.getSessionByTaskId(task.id);
      if (!session) continue;

      const turns = await storage.getSessionTurns(session.id);
      if (turns.length === 0) continue;

      // Find all unposted turns (both agent and human)
      const lastPostedSeqNum = driver.getLastPostedTurnSeq(task);

      const unpostedTurns = turns.filter(t => t.sequence > lastPostedSeqNum);
      if (unpostedTurns.length === 0) continue;

      // Post turns in chronological order
      let lastSuccessSeq = lastPostedSeqNum;
      for (const turn of unpostedTurns) {
        const taskShortId = shortId(task.id);
        let body: string;

        if (turn.role === 'agent') {
          const turnNumber = Math.floor(turn.sequence / 2) + 1;
          body = formatAgentTurnSummary(turn.content, turnNumber, turn.sequence, taskShortId);
        } else {
          // Human review turn — skip the initial prompt (sequence 0) since
          // it's already in the PR body as the task goal/prompt
          if (turn.sequence === 0) {
            lastSuccessSeq = turn.sequence;
            continue;
          }
          const turnNumber = Math.floor(turn.sequence / 2) + 1;
          body = formatHumanReviewTurn(turn.content, turnNumber, turn.sequence, taskShortId);
        }

        await driver.postTurnSummary(task, body);
        lastSuccessSeq = turn.sequence;
        result.posted++;
      }

      // Mark the last successfully posted turn
      if (lastSuccessSeq > lastPostedSeqNum) {
        await storage.updateTaskMetadata(task.id, driver.postedTurnSeqKey(), String(lastSuccessSeq));

        // New work landed (direct commits/turns pushed) — regenerate the
        // fidelity record so the PR/MR body reflects what the work has become.
        // INVARIANT: this fires only when there are NEW turns to post, i.e. on
        // actual new work — never on upstream-merge sync (syncTask), which does
        // not post turns. See CLAUDE.md "Upstream merge is sync's job".
        // Non-blocking: regenerateFidelity never throws.
        const fidelity = await regenerateFidelity(storage, task, driver, summarizer);
        if (fidelity.warning) result.errors.push(fidelity.warning);
      }
    } catch (err) {
      result.errors.push(`Failed to post summary for task ${displayId(task)}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return result;
}

/**
 * Post unsynced task notes (lazy comments) to the remote.
 * Tracks last posted note timestamp via driver-managed metadata.
 *
 * Only posts notes that were NOT synced from the remote (avoids echoing comments back).
 * Imported notes are identified via driver.isImportedComment().
 */
async function postTaskNotes(storage: Storage, driver: RepositoryDriver): Promise<{ posted: number; errors: string[] }> {
  const result = { posted: 0, errors: [] as string[] };

  const allTasks = await storage.listTasks();

  for (const task of allTasks) {
    if (!driver.hasRemoteRef(task)) continue;
    if (task.status !== 'blocked' && task.status !== 'conflict' && task.status !== 'submitted') continue;

    try {
      const comments = await storage.getTaskComments(task.id);
      if (comments.length === 0) continue;

      // Find unposted comments
      const lastPostedAtStr = driver.getLastPostedNoteAt(task);
      const lastPostedAt = lastPostedAtStr ? Number(lastPostedAtStr) || new Date(lastPostedAtStr).getTime() : undefined;
      const unpostedComments = lastPostedAt !== undefined
        ? comments.filter(n => n.created_at > lastPostedAt)
        : comments;

      if (unpostedComments.length === 0) continue;

      let lastSuccessTimestamp = lastPostedAt ?? 0;
      const taskShortId = shortId(task.id);

      for (const comment of unpostedComments) {
        // Skip comments that were synced FROM the remote (avoid echo).
        // Primary check: structured source field. Fallback: content-based regex
        // for backward compatibility with comments created before the source field existed.
        if (comment.source === 'remote' || driver.isImportedComment(comment.content)) continue;

        const body = formatNoteComment(comment.content, comment.id, taskShortId);
        await driver.postTurnSummary(task, body);
        result.posted++;

        if (comment.created_at > lastSuccessTimestamp) {
          lastSuccessTimestamp = comment.created_at;
        }
      }

      // Update tracking timestamp
      if (lastSuccessTimestamp && lastSuccessTimestamp !== (lastPostedAt ?? 0)) {
        await storage.updateTaskMetadata(task.id, driver.postedNoteAtKey(), new Date(lastSuccessTimestamp).toISOString());
      }
    } catch (err) {
      result.errors.push(`Failed to post comments for task ${displayId(task)}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return result;
}

/**
 * Format an agent turn's response into a concise PR comment summary.
 * Truncates long responses to keep PR comments skimmable for human reviewers.
 * The driver's postTurnSummary prepends the hidden lazy marker for filtering.
 */
export function formatAgentTurnSummary(agentResponse: string, turnNumber: number, sequence: number, taskShortId: string): string {
  const MAX_SUMMARY_LENGTH = 4000;

  let summary = agentResponse;
  if (summary.length > MAX_SUMMARY_LENGTH) {
    summary = summary.substring(0, MAX_SUMMARY_LENGTH) + '\n\n... (truncated)';
  }

  return `### Turn ${turnNumber} — Agent Summary\n\n${summary}\n\n---\n*Posted by [lazy](https://getlazy.dev/) for task \`${taskShortId}\`*`;
}

/**
 * Format a human review turn into a PR comment.
 * Human review feedback is the most important artifact for external reviewers.
 * The driver's postTurnSummary prepends the hidden lazy marker for filtering.
 */
export function formatHumanReviewTurn(feedback: string, turnNumber: number, sequence: number, taskShortId: string): string {
  const MAX_FEEDBACK_LENGTH = 4000;

  let content = feedback;
  if (content.length > MAX_FEEDBACK_LENGTH) {
    content = content.substring(0, MAX_FEEDBACK_LENGTH) + '\n\n... (truncated)';
  }

  return `### Turn ${turnNumber} — Review Feedback\n\n${content}\n\n---\n*Posted by [lazy](https://getlazy.dev/) for task \`${taskShortId}\`*`;
}

/**
 * Format a note/comment into a PR comment.
 * Notes are annotations added via `lazy comment` — context, observations, etc.
 * The driver's postTurnSummary prepends the hidden lazy marker for filtering.
 */
export function formatNoteComment(noteContent: string, noteId: string, taskShortId: string): string {
  const MAX_NOTE_LENGTH = 4000;

  let content = noteContent;
  if (content.length > MAX_NOTE_LENGTH) {
    content = content.substring(0, MAX_NOTE_LENGTH) + '\n\n... (truncated)';
  }

  return `### Note\n\n${content}\n\n---\n*Posted by [lazy](https://getlazy.dev/) for task \`${taskShortId}\`*`;
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
 * export branches, post turns, post notes) using the provided storage and root
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
  const summarizer = getSummarizer(config.models.default);

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

  // Export direction: lazy → remote
  log.phase('Exporting task branches...');
  const exportResult = await exportTasks(storage, root, driver, log);

  if (exportResult.pushed > 0) {
    log.detail(`  ${exportResult.pushed} branch(es) pushed`);
  } else {
    log.detail('  Nothing to export');
  }

  for (const error of exportResult.errors) {
    log.error(`  Error: ${error}`);
  }

  // Post turns to PRs (agent summaries + human review feedback)
  log.phase('Posting task artifacts to PRs...');
  const summaryResult = await postTurnSummaries(storage, driver, summarizer);

  if (summaryResult.posted > 0) {
    log.detail(`  ${summaryResult.posted} turn(s) posted`);
  } else {
    log.detail('  No new turns to post');
  }

  for (const error of summaryResult.errors) {
    log.error(`  Error: ${error}`);
  }

  // Post notes/comments to PRs
  const notesResult = await postTaskNotes(storage, driver);

  if (notesResult.posted > 0) {
    log.detail(`  ${notesResult.posted} note(s) posted`);
  } else {
    log.detail('  No new notes to post');
  }

  for (const error of notesResult.errors) {
    log.error(`  Error: ${error}`);
  }

  log.done(theme.success('\nSync complete.'));
}
