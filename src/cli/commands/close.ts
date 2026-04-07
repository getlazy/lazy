import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, displayId, displayIdFor, parseFlags, resolveTaskOrExit, getWorktreePath } from '../helpers';
import { openEditor, removeRecoveryFile, requireTTY, readStdinIfPiped } from '../editor';
import { hasUncommittedChanges } from '../../git/operations';
import { isTerminalStatus } from '../../types';
import { queryCloseTask } from '../../daemon/rpc-fallback';

import { theme } from '../theme';

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
    { name: 'accept-dirty-worktree', takesValue: false },
  ], 'close');

  const taskId = parsed.positional[0];
  if (!taskId) {
    closeUsage();
    process.exit(1);
  }

  const skipEditor = parsed.flags.get('yes') === true;
  const argReason = parsed.flags.get('reason') as string | undefined;
  const acceptDirtyWorktree = parsed.flags.get('accept-dirty-worktree') === true;

  // --- Lightweight pre-flight checks BEFORE collecting reason ---
  // INVARIANT: Pre-flight checks before editor — the user should never type
  // feedback only to have it discarded by a validation failure.
  // The daemon RPC does authoritative validation afterward.
  let goal: string | undefined;
  {
    const root = requireLazyRoot();
    const storage = await requireStorage();
    try {
      const task = await resolveTaskOrExit(storage, taskId);
      goal = task.goal;

      // Terminal status check
      if (isTerminalStatus(task.status)) {
        console.error(`Task ${displayId(task)} is already ${task.status}.`);
        process.exit(1);
      }

      // Pairing check
      if (task.status === 'pairing') {
        console.error(`Task ${displayId(task)} is locked (pairing in progress). End the pairing session first.`);
        process.exit(1);
      }

      // Uncommitted changes check
      const worktreePath = getWorktreePath(root, task);
      if (!acceptDirtyWorktree && existsSync(worktreePath) && await hasUncommittedChanges(worktreePath)) {
        console.error('Error: Task has uncommitted changes!');
        console.error('Commit or stash your changes before closing.');
        console.error('Options:');
        console.error(`  1. Unblock and ask agent to commit: lazy unblock ${displayId(task)} --message "Please commit your changes"`);
        console.error(`  2. Manually commit in shell: lazy shell ${displayId(task)}`);
        console.error(`  3. Accept dirty worktree: lazy close ${displayId(task)} --accept-dirty-worktree`);
        process.exit(1);
      }
    } finally {
      await storage.close();
    }
  }

  // Get reason BEFORE RPC call — collect all interactive input first
  let reason: string;
  let closeRecoveryPath: string | null = null;
  if (argReason !== undefined) {
    reason = argReason;
  } else {
    const stdinContent = await readStdinIfPiped();
    if (stdinContent !== null) {
      reason = stdinContent;
    } else if (skipEditor) {
      console.error('Error: --reason is required when using --yes flag');
      process.exit(1);
    } else {
      try {
        requireTTY('This command requires an interactive terminal. Use --reason to provide a reason non-interactively, or pipe via stdin.');
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }

      const result = await promptForReason(taskId, goal);
      reason = result.reason;
      closeRecoveryPath = result.recoveryPath;
    }
  }

  // --- Delegate to daemon RPC ---
  try {
    const result = await queryCloseTask({
      taskId,
      reason,
      acceptDirtyWorktree,
    });

    // Reason is now durably persisted — clean up recovery file
    if (closeRecoveryPath) removeRecoveryFile(closeRecoveryPath);

    // Print warnings
    for (const w of result.warnings) {
      console.log(w);
    }

    console.log(`\nTask ${theme.taskId(result.displayId)} closed.`);
    console.log(`${theme.label('Reason:')} ${reason}`);
    if (result.branchName) {
      console.log('  Worktree removed.');
      console.log(`  Branch preserved: ${result.branchName}`);
    }
    console.log('  Task history preserved.');
    console.log(`\nTo recover: ${theme.command('lazy reopen ' + result.displayId)}`);

    if (result.parentTaskId) {
      const storage = await requireStorage();
      try {
        console.log(`\nUnblock parent task: ${theme.command('lazy unblock ' + await displayIdFor(storage, result.parentTaskId))}`);
      } finally {
        await storage.close();
      }
    }
  } catch (err) {
    if (closeRecoveryPath) {
      console.error(`Close reason saved to recovery file: ${closeRecoveryPath}`);
    }
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function closeUsage(): void {
  console.log(`Usage: lazy close <task_id> [--reason "reason text"] [--yes] [--accept-dirty-worktree]

Close a task without doing work on it.

Arguments:
  <task_id>    ID of the task to close

Options:
  --reason                Reason for closing the task (required)
                          If not provided, $EDITOR will be opened to enter the reason
  --yes, -y               Skip editor prompt (non-interactive mode)
                          Requires --reason or piped stdin
  --accept-dirty-worktree Allow closing even if worktree has uncommitted changes

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
  - By default, uncommitted changes prevent closing (safety check)
  - Use --accept-dirty-worktree to bypass this check when certain

Examples:
  lazy close abc12345 --reason "Superseded by task def67890" --yes
  lazy close abc1 --yes --reason "No longer needed after refactor"
  lazy close abc1 --reason "No longer needed"  # Interactive (no --yes)
  lazy close abc1 --accept-dirty-worktree --reason "Discard all work" --yes
  lazy close abc1     # Opens editor to enter reason (requires TTY)
  echo "No longer needed" | lazy close abc1 --yes  # Piped stdin as reason`);
}
