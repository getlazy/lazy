/**
 * `lazy sync` — sync lazy tasks with your remote repository.
 *
 * All remote-specific logic lives behind the RepositoryDriver interface.
 * This module orchestrates the sync flow without knowing whether the
 * remote is GitHub, GitLab, or any other forge.
 *
 * Import direction (remote → lazy):
 *   - Fetches comments for all active tasks with remote refs
 *   - Detects externally merged/closed refs and updates task state
 *
 * Export direction (lazy → remote):
 *   - Pushes unpushed task branches
 *   - Creates remote refs for branches with commits
 *   - Posts all task artifacts: agent turns, human review turns, and notes
 */

import { requireLazyRoot, requireStorage, shortId, displayId, getWorktreePath, taskRef } from '../helpers';
import { loadConfig } from '../../config/loader';
import { createDriver, type RepositoryDriver } from '../../remote';
import { syncTaskFromRemote, cleanupWorktreeAndBranch, cleanupTaskContainer } from './shared';
import { theme } from '../theme';
import { logger } from '../../utils/logger';
import { branchExists } from '../../git/operations';
import { isTerminalStatus } from '../../types';
import { removeLock } from '../../utils/lock';
import { protocolDir, removeProtocolDir } from '../../protocol';
import { getActor } from '../../constants';
import { reparentChildren } from '../orphan';

/**
 * SyncLogger abstracts how sync progress is reported.
 *
 * The CLI uses a console-based implementation with per-phase headers and
 * themed output. The background server sync uses a debug-level implementation
 * that writes to the internal logger without cluttering stdout.
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

/** Console-based logger for interactive `lazy sync` CLI command. */
class ConsoleSyncLogger implements SyncLogger {
  phase(message: string): void {
    console.log(message);
  }
  detail(message: string): void {
    console.log(message);
  }
  error(message: string): void {
    console.error(message);
  }
  done(message: string): void {
    console.log(message);
  }
}

/** Debug-level logger for background sync (e.g., in lazy server). */
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

/** The debug-level SyncLogger instance for background use. */
export const debugSyncLogger = new DebugSyncLogger();

/**
 * Detect externally merged or closed PRs/MRs and update task state.
 * Only checks tasks that have a remote reference (PR, MR, etc.).
 * Uses the driver's getPRState() to check remote state without
 * knowing the specifics of the remote system.
 */
async function detectExternalChanges(storage: ReturnType<typeof requireStorage> extends Promise<infer T> ? T : never, driver: RepositoryDriver, log: SyncLogger, root?: string): Promise<{ merged: number; closed: number; spurious: number; pipelineFailed: number; errors: string[] }> {
  const result = { merged: 0, closed: 0, spurious: 0, pipelineFailed: 0, errors: [] as string[] };

  const allTasks = await storage.listTasks();

  for (const task of allTasks) {
    if (!driver.hasRemoteRef(task)) continue;
    // Check blocked, conflict, and merging tasks for external state changes
    if (task.status !== 'blocked' && task.status !== 'conflict' && task.status !== 'merging') continue;

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
        await storage.updateTaskStatus(task.id, 'complete', getActor());

        // Re-parent unfinished children to the grandparent
        const reparented = await reparentChildren(task, storage);
        if (reparented.length > 0) {
          const newParentDesc = task.parent_task_id
            ? task.parent_task_id.substring(0, 8)
            : 'top-level';
          const plural = reparented.length === 1 ? 'child' : 'children';
          log.detail(`  Re-parented ${reparented.length} unfinished ${plural} of ${displayId(task)} to ${newParentDesc}`);
        }

        // Clean up worktree, container, and protocol dir for completed merging tasks
        if (root && session) {
          try {
            await cleanupTaskContainer(storage, session, taskRef(task), root);
            const worktreePath = getWorktreePath(root, task);
            removeLock(worktreePath);
            cleanupWorktreeAndBranch(worktreePath, session.git_branch, root);
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
          await storage.closeTask(task.id, 'Closed externally via remote', getActor());
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
 * Export direction: push unpushed branches, create remote refs for branches with commits.
 */
async function exportTasks(storage: ReturnType<typeof requireStorage> extends Promise<infer T> ? T : never, root: string, driver: RepositoryDriver, log: SyncLogger): Promise<{ pushed: number; prsCreated: number; errors: string[] }> {
  const result = { pushed: 0, prsCreated: 0, errors: [] as string[] };

  const allTasks = await storage.listTasks();

  for (const task of allTasks) {
    // Only export tasks that have sessions (i.e., work has been done)
    if (task.status !== 'blocked' && task.status !== 'conflict') continue;

    const session = await storage.getSessionByTaskId(task.id);
    if (!session?.git_branch) continue;

    try {
      // Check if branch exists locally
      if (!branchExists(session.git_branch, root)) continue;

      // Push branch
      try {
        await driver.pushBranch(session.git_branch);
        result.pushed++;
      } catch (err) {
        result.errors.push(`Failed to push ${session.git_branch}: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      // Create remote ref if branch has commits and no ref exists yet
      if (!driver.hasRemoteRef(task)) {
        const commits = await storage.getSessionCommits(session.id);
        if (commits.length > 0) {
          try {
            const prResult = await driver.markReadyForReview(task);
            if (prResult.metadata) {
              for (const [key, value] of Object.entries(prResult.metadata)) {
                await storage.updateTaskMetadata(task.id, key, value);
              }
              // Update in-memory metadata
              if (!task.metadata) task.metadata = {};
              Object.assign(task.metadata, prResult.metadata);
              const url = await driver.getTaskUrl(task);
              log.detail(`  Created remote ref for task ${theme.taskId(displayId(task))}${url ? ': ' + url : ''}`);

              result.prsCreated++;
            }
          } catch (err) {
            result.errors.push(`Failed to create remote ref for task ${displayId(task)}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
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
async function postTurnSummaries(storage: ReturnType<typeof requireStorage> extends Promise<infer T> ? T : never, driver: RepositoryDriver): Promise<{ posted: number; errors: string[] }> {
  const result = { posted: 0, errors: [] as string[] };

  const allTasks = await storage.listTasks();

  for (const task of allTasks) {
    if (!driver.hasRemoteRef(task)) continue;
    if (task.status !== 'blocked' && task.status !== 'conflict') continue;

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
async function postTaskNotes(storage: ReturnType<typeof requireStorage> extends Promise<infer T> ? T : never, driver: RepositoryDriver): Promise<{ posted: number; errors: string[] }> {
  const result = { posted: 0, errors: [] as string[] };

  const allTasks = await storage.listTasks();

  for (const task of allTasks) {
    if (!driver.hasRemoteRef(task)) continue;
    if (task.status !== 'blocked' && task.status !== 'conflict') continue;

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
        // Skip comments that were synced FROM the remote (avoid echo)
        if (driver.isImportedComment(comment.content)) continue;

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
 * Import direction: fetch comments from remote for all active tasks.
 * Reuses syncTaskFromRemote which handles dedup, storage, and timestamp tracking.
 */
async function fetchRemoteComments(storage: ReturnType<typeof requireStorage> extends Promise<infer T> ? T : never, root: string, driver: RepositoryDriver): Promise<{ synced: number; errors: string[] }> {
  const result = { synced: 0, errors: [] as string[] };

  const allTasks = await storage.listTasks();

  for (const task of allTasks) {
    if (!driver.hasRemoteRef(task)) continue;
    if (task.status !== 'blocked' && task.status !== 'conflict') continue;

    try {
      // Capture comment count before sync to detect new comments
      const commentsBefore = await storage.getTaskComments(task.id);
      const countBefore = commentsBefore.length;

      await syncTaskFromRemote(task, storage, root);

      const commentsAfter = await storage.getTaskComments(task.id);
      const newComments = commentsAfter.length - countBefore;
      if (newComments > 0) {
        result.synced += newComments;
      }
    } catch (err) {
      result.errors.push(`Failed to fetch comments for task ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return result;
}

/**
 * Core sync logic — single source of truth for all sync operations.
 *
 * Runs all sync phases (detect external changes, fetch comments, export branches,
 * post turns, post notes) using the provided storage and root directory.
 * Output is routed through the provided SyncLogger, allowing callers to control
 * how progress is reported (console for CLI, debug logger for background server sync).
 *
 * Does NOT call process.exit or close storage — caller manages lifecycle.
 * Throws if the remote driver has no remote configured (LocalDriver).
 */
export async function runSync(root: string, storage: Awaited<ReturnType<typeof requireStorage>>, log: SyncLogger): Promise<void> {
  const config = loadConfig(root);
  const driver = createDriver(config);

  // Collect unique target branches from active tasks so we can fast-forward them
  const allTasksForBranches = await storage.listTasks();
  const targetBranches = [
    ...new Set(
      allTasksForBranches
        .filter(t => !isTerminalStatus(t.status))
        .map(t => t.metadata?.remote_target_branch ?? t.metadata?.github_pr_target_branch)
        .filter((b): b is string => typeof b === 'string')
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
  log.phase('\nFetching PR comments...');
  const commentResult = await fetchRemoteComments(storage, root, driver);

  if (commentResult.synced > 0) {
    log.detail(`  ${commentResult.synced} comment(s) fetched`);
  } else {
    log.detail('  No new comments');
  }

  for (const error of commentResult.errors) {
    log.error(`  Error: ${error}`);
  }

  // Export direction: lazy → remote
  log.phase('\nExporting task branches...');
  const exportResult = await exportTasks(storage, root, driver, log);

  if (exportResult.pushed > 0 || exportResult.prsCreated > 0) {
    log.detail(`  ${exportResult.pushed} branch(es) pushed, ${exportResult.prsCreated} PR(s) created`);
  } else {
    log.detail('  Nothing to export');
  }

  for (const error of exportResult.errors) {
    log.error(`  Error: ${error}`);
  }

  // Post turns to PRs (agent summaries + human review feedback)
  log.phase('\nPosting task artifacts to PRs...');
  const summaryResult = await postTurnSummaries(storage, driver);

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

export async function commandSync(_args: string[]): Promise<void> {
  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    console.log('Syncing with remote...\n');
    const log = new ConsoleSyncLogger();

    try {
      await runSync(root, storage, log);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      console.error('Or set [remote] driver in lazy.toml');
      process.exit(1);
    }
  } finally {
    await storage.close();
  }
}

export function syncUsage(): void {
  console.log(`Usage: lazy sync

Sync lazy tasks with your remote repository.

What sync does:
  - Fetches PR comments from remote for all active tasks
  - Pushes unpushed task branches to origin
  - Creates PRs for branches with commits (skips zero-commit branches)
  - Posts all task artifacts as PR comments:
    - Agent turn summaries
    - Human review feedback
    - Notes added via lazy comment
  - Detects externally merged PRs → marks tasks complete
  - Detects externally closed PRs → marks tasks closed
  - Distinguishes real merges from spurious ones (zero-commit branches)

Requirements:
  - A remote driver must be configured (e.g., [remote] driver = "github" in lazy.toml)
  - For GitHub: gh CLI must be installed and authenticated

Examples:
  lazy sync    # Sync task state with remote`);
}
