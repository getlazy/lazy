import { join } from 'path';
import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, displayIdFor, parseFlags, resolveTaskOrExit, taskRef, getWorktreePath } from '../helpers';
import { hasUncommittedChanges } from '../../git/operations';
import { openEditor, removeRecoveryFile, requireTTY, readStdinIfPiped } from '../editor';
import { cleanupWorktree, cleanupTaskContainer } from './shared';
import { protocolDir, removeProtocolDir } from '../../protocol';
import { removeLock } from '../../utils/lock';
import { loadConfig } from '../../config/loader';
import { createDriver } from '../../remote';
import { logger } from '../../utils/logger';
import { isTerminalStatus } from '../../types';

import { getDataDir } from '../init';
import { theme } from '../theme';
import { getActor } from '../../constants';

async function promptForReason(taskShortId: string, goal?: string): Promise<{ reason: string; recoveryPath: string | null }> {
  const headerLines = [
    `# Task: ${taskShortId}`,
    ...(goal ? [`# Goal: ${goal}`] : []),
    '#',
    '# Enter the reason for closing this task',
    '# Lines starting with # will be ignored',
    '',
  ];
  const template = headerLines.join('\n') + '\n';

  const editResult = await openEditor(template, `close-${taskShortId}`);
  if (editResult === null) {
    console.error('Error: editor exited with non-zero status');
    process.exit(1);
  }

  const { content, recoveryPath } = editResult;
  const lines = content
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .map(line => line.trim())
    .filter(line => line.length > 0);

  const reason = lines.join('\n').trim();

  if (!reason) {
    // No reason provided — clean up recovery file (nothing to preserve)
    if (recoveryPath) removeRecoveryFile(recoveryPath);
    console.error('Error: no reason provided');
    process.exit(1);
  }

  return { reason, recoveryPath };
}

export async function commandClose(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'yes', aliases: ['y'], takesValue: false },
    { name: 'reason', takesValue: true },
  ], 'close');

  const taskId = parsed.positional[0];
  if (!taskId) {
    closeUsage();
    process.exit(1);
  }

  const skipEditor = parsed.flags.get('yes') === true;
  const argReason = parsed.flags.get('reason') as string | undefined;

  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    // Resolve task
    const task = await resolveTaskOrExit(storage, taskId);

    // Check if task is already ended
    if (isTerminalStatus(task.status)) {
      console.error(`Task ${displayId(task)} is already ${task.status}.`);
      process.exit(1);
    }

    // Refuse if task is in pairing state — task is locked
    if (task.status === 'pairing') {
      console.error(`Task ${displayId(task)} is locked (pairing in progress). End the pairing session first.`);
      process.exit(1);
    }

    // Get worktree path
    const worktreePath = getWorktreePath(root, task);

    // CRITICAL: Check for uncommitted changes in worktree FIRST
    // This is the hardest gate — losing uncommitted work is the worst outcome.
    // Must happen before ANY destructive or remote operations.
    if (existsSync(worktreePath) && hasUncommittedChanges(worktreePath)) {
      console.error('Error: Task has uncommitted changes!');
      console.error('Commit or stash your changes before closing.');
      console.error('Options:');
      console.error(`  1. Unblock and ask agent to commit: lazy unblock ${displayId(task)} --message "Please commit your changes"`);
      console.error(`  2. Manually commit in shell: lazy shell ${displayId(task)}`);
      process.exit(1);
    }

    // Get or prompt for reason
    let reason: string;
    let closeRecoveryPath: string | null = null;
    if (argReason !== undefined) {
      reason = argReason;
    } else {
      // Try piped stdin before falling back to $EDITOR
      const stdinContent = await readStdinIfPiped();
      if (stdinContent !== null) {
        reason = stdinContent;
      } else if (skipEditor) {
        // Non-interactive mode: reason is required
        console.error('Error: --reason is required when using --yes flag');
        process.exit(1);
      } else {
        // Require TTY before opening editor
        try {
          requireTTY('This command requires an interactive terminal. Use --reason to provide a reason non-interactively, or pipe via stdin.');
        } catch (err) {
          console.error(err instanceof Error ? err.message : err);
          process.exit(1);
        }
        const result = await promptForReason(displayId(task), task.goal);
        reason = result.reason;
        closeRecoveryPath = result.recoveryPath;
      }
    }

    // Get session if it exists
    const sess = await storage.getSessionByTaskId(task.id);

    // Close the task (persists reason to DB)
    await storage.closeTask(task.id, reason, getActor());

    // Reason is now durably persisted — clean up recovery file
    if (closeRecoveryPath) removeRecoveryFile(closeRecoveryPath);

    // Clean up container, remote resources, and worktree if session exists
    if (sess) {
      await cleanupTaskContainer(storage, sess, taskRef(task), root);

      // Clean up remote resources (e.g., close PR on GitHub)
      try {
        const config = loadConfig(root);
        const driver = createDriver(config);
        await driver.cleanup(sess.git_branch);
      } catch (err) {
        logger.debug(`Remote cleanup failed (non-fatal): ${err instanceof Error ? err.message : err}`);
      }

      // Remove lock before cleaning up worktree
      removeLock(worktreePath);

      // Remove worktree but preserve branch for potential reopen
      cleanupWorktree(worktreePath, root);
    }

    // Clean up protocol directory (outside the if block since protocol dir exists regardless of session)
    removeProtocolDir(protocolDir(task.id));

    console.log(`\nTask ${theme.taskId(displayId(task))} closed.`);
    console.log(`${theme.label('Reason:')} ${reason}`);
    if (sess) {
      console.log('  Worktree removed.');
      console.log(`  Branch preserved: ${sess.git_branch}`);
    }
    console.log('  Task history preserved.');
    console.log(`\nTo recover: ${theme.command('lazy reopen ' + displayId(task))}`);

    if (task.parent_task_id) {
      console.log(`\nUnblock parent task: ${theme.command('lazy unblock ' + await displayIdFor(storage, task.parent_task_id))}`);
    }

  } finally {
    await storage.close();
  }
}

export function closeUsage(): void {
  console.log(`Usage: lazy close <task_id> [--reason "reason text"] [--yes]

Close a task without doing work on it.

Arguments:
  <task_id>    ID of the task to close

Options:
  --reason     Reason for closing the task (required)
               If not provided, $EDITOR will be opened to enter the reason
  --yes, -y    Skip editor prompt (non-interactive mode)
               Requires --reason or piped stdin

Reason input priority: --reason flag > piped stdin > $EDITOR (interactive)

Interactive Mode:
  - Without --reason, requires an interactive terminal (TTY)
  - Opens $EDITOR to enter the close reason
  - For fully non-interactive use, provide --reason (or pipe stdin) and --yes

Notes:
  - Can be used on working, blocked, or interrupted tasks
  - Task is marked as 'closed' with the provided reason
  - If a session exists, the worktree is removed but the branch is preserved
  - Task history is preserved
  - Use 'lazy reopen <task_id>' to restore the task later
  - Use this when a task is superseded, no longer relevant, or decided against

Examples:
  lazy close abc12345 --reason "Superseded by task def67890" --yes
  lazy close abc1 --yes --reason "No longer needed after refactor"
  lazy close abc1 --reason "No longer needed"  # Interactive (no --yes)
  lazy close abc1     # Opens editor to enter reason (requires TTY)
  echo "No longer needed" | lazy close abc1 --yes  # Piped stdin as reason`);
}
