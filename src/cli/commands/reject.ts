import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, displayIdFor, parseFlags, resolveTaskOrExit, rejectIfPairing, getWorktreePath } from '../helpers';
import { promptYesNo, openEditor, removeRecoveryFile, requireTTY, readStdinIfPiped } from '../editor';
import { hasUncommittedChanges } from '../../git/operations';
import { queryRejectTask } from '../../daemon/rpc-fallback';

import { theme } from '../theme';

export async function commandReject(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'yes', aliases: ['y'], takesValue: false },
    { name: 'reason', takesValue: true },
    { name: 'accept-dirty-worktree', takesValue: false },
  ], 'reject');

  const taskId = parsed.positional[0];
  if (!taskId) {
    rejectUsage();
    process.exit(1);
  }

  const skipConfirmation = parsed.flags.get('yes') === true;
  const reasonFromFlag = parsed.flags.get('reason') as string | undefined;
  const acceptDirtyWorktree = parsed.flags.get('accept-dirty-worktree') === true;

  // --- Lightweight pre-flight checks BEFORE editor ---
  // INVARIANT: Pre-flight checks before editor — the user should never type
  // feedback only to have it discarded by a validation failure.
  // The daemon RPC does authoritative validation afterward.
  let taskDisplayId = taskId;
  {
    const root = requireLazyRoot();
    const storage = await requireStorage();
    try {
      const task = await resolveTaskOrExit(storage, taskId);
      taskDisplayId = displayId(task);

      // Uncommitted changes check
      const worktreePath = getWorktreePath(root, task);
      if (!acceptDirtyWorktree && existsSync(worktreePath) && await hasUncommittedChanges(worktreePath)) {
        console.error('Error: Task has uncommitted changes!');
        console.error('Commit or stash your changes before rejecting.');
        console.error('Options:');
        console.error(`  1. Unblock and ask agent to commit: lazy unblock ${taskDisplayId} --message "Please commit your changes"`);
        console.error(`  2. Manually commit in shell: lazy shell ${taskDisplayId}`);
        console.error(`  3. Accept dirty worktree: lazy reject ${taskDisplayId} --accept-dirty-worktree`);
        process.exit(1);
      }

      // Session check
      const sess = await storage.getSessionByTaskId(task.id);
      if (!sess) {
        console.error(`Task ${taskDisplayId} has no session.`);
        process.exit(1);
      }
      if (sess.outcome === 'rejected') {
        console.log(`Task ${taskDisplayId} was already rejected.`);
        return;
      }
      if (sess.ended_at) {
        console.error(`Session already ended (${sess.outcome ?? 'ended'}).`);
        process.exit(1);
      }

      // Status checks
      if (task.status === 'pairing') {
        console.error(`Task ${taskDisplayId} is locked (pairing in progress). End the pairing session first.`);
        process.exit(1);
      }

      // Pairing lock check
      rejectIfPairing(root, shortId(task.id), taskDisplayId);
    } finally {
      await storage.close();
    }
  }

  // Get rejection reason from --reason, piped stdin, or $EDITOR
  // CRITICAL: Collect reason BEFORE the RPC call so feedback is never lost
  let reason: string;
  let reasonRecoveryPath: string | null = null;
  if (reasonFromFlag !== undefined) {
    reason = reasonFromFlag;
  } else {
    const stdinContent = await readStdinIfPiped();
    if (stdinContent !== null) {
      reason = stdinContent;
    } else {
      if (!process.stdin.isTTY) {
        console.error('Rejection reason is required. Use --reason to provide one or pipe via stdin.');
        process.exit(1);
      }
      console.log('Opening editor for rejection reason...');
      const editResult = await openEditor('', `reject-${taskId}`);
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

  // Confirmation prompt (CLI-only interaction)
  if (!skipConfirmation) {
    try {
      requireTTY('This command requires an interactive terminal for confirmation. Use --yes to skip confirmation.');
    } catch (err) {
      if (reasonRecoveryPath) removeRecoveryFile(reasonRecoveryPath);
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }

    const confirmed = await promptYesNo(`Are you sure you want to reject task ${taskDisplayId}?`);
    if (!confirmed) {
      if (reasonRecoveryPath) removeRecoveryFile(reasonRecoveryPath);
      console.log('Cancelled.');
      return;
    }
  }

  // --- Delegate to daemon RPC ---
  try {
    const result = await queryRejectTask({
      taskId,
      reason: reason.trim(),
      acceptDirtyWorktree,
    });

    // Reason is now durably persisted — clean up recovery file
    if (reasonRecoveryPath) removeRecoveryFile(reasonRecoveryPath);

    // Print warnings
    for (const w of result.warnings) {
      console.log(w);
    }

    console.log(`\nTask ${theme.taskId(result.displayId)} rejected.`);
    if (result.branchName) {
      console.log(`  Branch preserved: ${result.branchName}`);
    }
    console.log('  Worktree removed.');
    console.log('  Task history preserved.');
    console.log(`\nTo recover: ${theme.command('lazy reopen ' + result.displayId)}`);

    if (result.parentTaskId) {
      // Need storage for displayIdFor — open briefly
      const storage = await requireStorage();
      try {
        console.log(`\nUnblock parent task: ${theme.command('lazy unblock ' + await displayIdFor(storage, result.parentTaskId))}`);
      } finally {
        await storage.close();
      }
    }
  } catch (err) {
    // Preserve recovery file on failure
    if (reasonRecoveryPath) {
      console.error(`Rejection reason saved to recovery file: ${reasonRecoveryPath}`);
    }
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function rejectUsage(): void {
  console.log(`Usage: lazy reject <task_id> [--reason "..."] [--yes] [--accept-dirty-worktree]

Reject a task's work and discard the changes.

Arguments:
  <task_id>    ID of the task to reject

Options:
  --reason "..."          Provide rejection reason inline instead of opening editor
  --yes, -y               Skip confirmation prompt
  --accept-dirty-worktree Allow rejecting even if worktree has uncommitted changes

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
  - By default, uncommitted changes prevent rejection (safety check)
  - Use --accept-dirty-worktree to bypass this check when certain

Examples:
  lazy reject abc12345 --reason "Incorrect approach, needs redesign" --yes
  lazy reject def4 --yes --reason "Superseded by task xyz"
  lazy reject abc1 --reason "Bad approach"    # Will prompt for confirmation (requires TTY)
  lazy reject abc1 --accept-dirty-worktree --reason "Discard all work" --yes
  echo "Bad approach" | lazy reject abc1 --yes  # Piped stdin as reason`);
}
