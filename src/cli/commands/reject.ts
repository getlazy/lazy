import { join } from 'path';
import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, displayIdFor, parseFlags, resolveTaskOrExit, rejectIfPairing, taskRef, getWorktreePath } from '../helpers';
import { hasUncommittedChanges } from '../../git/operations';
import { removeLock } from '../../utils/lock';
import { cleanupWorktree, cleanupTaskContainer } from './shared';
import { protocolDir, removeProtocolDir } from '../../protocol';
import { promptYesNo, openEditor, removeRecoveryFile, requireTTY, readStdinIfPiped } from '../editor';
import { loadConfig } from '../../config/loader';
import { createDriver } from '../../remote';
import { logger } from '../../utils/logger';

import { getDataDir } from '../init';
import { theme } from '../theme';
import { getActor } from '../../constants';

export async function commandReject(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'yes', aliases: ['y'], takesValue: false },
    { name: 'reason', takesValue: true },
  ], 'reject');

  const taskId = parsed.positional[0];
  if (!taskId) {
    rejectUsage();
    process.exit(1);
  }

  const skipConfirmation = parsed.flags.get('yes') === true;
  const reasonFromFlag = parsed.flags.get('reason') as string | undefined;

  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    // Resolve task
    const task = await resolveTaskOrExit(storage, taskId);

    // Get worktree path
    const worktreePath = getWorktreePath(root, task);

    // CRITICAL: Check for uncommitted changes in worktree FIRST
    // This is the hardest gate — losing uncommitted work is the worst outcome.
    // Must happen before ANY destructive or remote operations.
    if (existsSync(worktreePath) && hasUncommittedChanges(worktreePath)) {
      console.error('Error: Task has uncommitted changes!');
      console.error('Commit or stash your changes before rejecting.');
      console.error('Options:');
      console.error(`  1. Unblock and ask agent to commit: lazy unblock ${displayId(task)} --message "Please commit your changes"`);
      console.error(`  2. Manually commit in shell: lazy shell ${displayId(task)}`);
      process.exit(1);
    }

    // Get session
    const sess = await storage.getSessionByTaskId(task.id);
    if (!sess) {
      console.error(`Task ${displayId(task)} has no session.`);
      process.exit(1);
    }

    if (sess.outcome === 'rejected') {
      console.log(`Task ${displayId(task)} was already rejected.`);
      return;
    }
    if (sess.ended_at) {
      console.error(`Session already ended (${sess.outcome ?? 'ended'}).`);
      process.exit(1);
    }

    // Refuse if task is in pairing state — task is locked
    if (task.status === 'pairing') {
      console.error(`Task ${displayId(task)} is locked (pairing in progress). End the pairing session first.`);
      process.exit(1);
    }

    // Check for pairing lock — refuse if someone is pairing on this task
    rejectIfPairing(root, shortId(task.id), displayId(task));

    // Get rejection reason from --reason or $EDITOR
    let reason: string;
    let reasonRecoveryPath: string | null = null;
    if (reasonFromFlag !== undefined) {
      reason = reasonFromFlag;
    } else {
      // Try piped stdin before falling back to $EDITOR
      const stdinContent = await readStdinIfPiped();
      if (stdinContent !== null) {
        reason = stdinContent;
      } else {
        // Rejection reason is required — open editor if TTY, error otherwise
        if (!process.stdin.isTTY) {
          console.error('Rejection reason is required. Use --reason to provide one or pipe via stdin.');
          process.exit(1);
        }
        console.log('Opening editor for rejection reason...');
        const editResult = await openEditor('', `reject-${shortId(task.id)}`);
        if (editResult === null) {
          console.log('Editor cancelled.');
          return;
        }
        const { content: edited, recoveryPath } = editResult;
        if (!edited.trim()) {
          if (recoveryPath) removeRecoveryFile(recoveryPath);
          console.log('Empty rejection reason. Cancelled.');
          return;
        }
        reason = edited.trim();
        reasonRecoveryPath = recoveryPath;
      }
    }

    if (!reason.trim()) {
      if (reasonRecoveryPath) removeRecoveryFile(reasonRecoveryPath);
      console.error('Empty rejection reason.');
      process.exit(1);
    }

    // Confirmation prompt
    if (!skipConfirmation) {
      // Require TTY for confirmation prompt
      try {
        requireTTY('This command requires an interactive terminal for confirmation. Use --yes to skip confirmation.');
      } catch (err) {
        if (reasonRecoveryPath) removeRecoveryFile(reasonRecoveryPath);
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }

      const confirmed = await promptYesNo(`Are you sure you want to reject task ${displayId(task)}?`);
      if (!confirmed) {
        if (reasonRecoveryPath) removeRecoveryFile(reasonRecoveryPath);
        console.log('Cancelled.');
        return;
      }
    }

    // End session with rejected outcome
    await storage.endSession(sess.id, 'rejected');

    // Stop and remove the task's Docker container
    await cleanupTaskContainer(storage, sess, taskRef(task), root);

    // Mark task as abandoned
    await storage.updateTaskStatus(task.id, 'abandoned', getActor());

    // Store rejection reason as a comment (with prefix for easy identification)
    await storage.createComment(task.id, `[Rejected] ${reason.trim()}`, getActor());
    // Comment is now durably persisted — clean up recovery file
    if (reasonRecoveryPath) removeRecoveryFile(reasonRecoveryPath);

    // Post reject review to PR (if remote driver) and close PR
    try {
      const config = loadConfig(root);
      const driver = createDriver(config);
      // Post the reject reason as a PR review BEFORE closing the PR
      const reviewWarning = await driver.postRejectReview(task, reason.trim());
      if (reviewWarning) {
        console.error(`Warning: ${reviewWarning}`);
      }
      await driver.cleanup(sess.git_branch);
    } catch (err) {
      logger.debug(`Remote cleanup failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }

    // Remove lock before cleaning up worktree
    removeLock(worktreePath);

    // Remove worktree but preserve branch for potential recovery
    cleanupWorktree(worktreePath, root);

    // Clean up protocol directory
    removeProtocolDir(protocolDir(task.id));

    console.log(`\nTask ${theme.taskId(displayId(task))} rejected.`);
    console.log(`  Branch preserved: ${sess.git_branch}`);
    console.log('  Worktree removed.');
    console.log('  Task history preserved.');
    console.log(`\nTo recover: ${theme.command('lazy reopen ' + displayId(task))}`);


    if (task.parent_task_id) {
      console.log(`\nUnblock parent task: ${theme.command('lazy unblock ' + await displayIdFor(storage, task.parent_task_id))}`);
    }

  } finally {
    await storage.close();
  }
}

export function rejectUsage(): void {
  console.log(`Usage: lazy reject <task_id> [--reason "..."] [--yes]

Reject a task's work and discard the changes.

Arguments:
  <task_id>    ID of the task to reject

Options:
  --reason "..."   Provide rejection reason inline instead of opening editor
  --yes, -y        Skip confirmation prompt

Reason input priority: --reason flag > piped stdin > $EDITOR (interactive)

Interactive Mode:
  - Without --reason, requires an interactive terminal (TTY) for editor
  - Without --yes, requires TTY for confirmation prompt
  - For fully non-interactive use, provide both --reason (or pipe stdin) and --yes

Notes:
  - Rejection reason is REQUIRED and stored as a note on the task
  - Removes the worktree but preserves the git branch
  - Task history (turns, commits) is preserved
  - Task is marked as 'abandoned'
  - Use 'lazy reopen <task_id>' to restore the task later
  - If this is a child task, you can unblock the parent

Examples:
  lazy reject abc12345 --reason "Incorrect approach, needs redesign" --yes
  lazy reject def4 --yes --reason "Superseded by task xyz"
  lazy reject abc1 --reason "Bad approach"    # Will prompt for confirmation (requires TTY)
  echo "Bad approach" | lazy reject abc1 --yes  # Piped stdin as reason`);
}
