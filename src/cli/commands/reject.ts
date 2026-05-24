import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, displayIdFor, parseFlags, resolveTaskOrExit, rejectIfPairing, getWorktreePath } from '../helpers';
import { promptYesNo, openEditor, removeRecoveryFile, requireTTY, readStdinIfPiped } from '../editor';
import { hasUncommittedChanges } from '../../git/operations';
import { queryRejectTask } from '../../daemon/rpc-fallback';

import { theme } from '../theme';

export async function commandReject(args: string[]): Promise<void> {
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

  // INVARIANT: Pre-flight checks before editor — the user should never type
  // feedback only to have it discarded by a validation failure.
  let taskDisplayId = taskId;
  {
    const root = requireLazyRoot();
    const storage = await requireStorage();
    try {
      const task = await resolveTaskOrExit(storage, taskId);
      taskDisplayId = displayId(task);

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

      // Reject requires an active session — it ends the session and posts PR review.
      // For closing a task with no session, use `lazy close`.
      const sess = await storage.getSessionByTaskId(task.id);
      if (!sess) {
        console.error(`Task ${taskDisplayId} has no session. Use 'lazy close' for tasks that haven't been worked on.`);
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

      if (task.status === 'pairing') {
        console.error(`Task ${taskDisplayId} is locked (pairing in progress). End the pairing session first.`);
        process.exit(1);
      }

      rejectIfPairing(root, shortId(task.id), taskDisplayId);
    } finally {
      await storage.close();
    }
  }

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

  try {
    const result = await queryRejectTask({
      taskId,
      reason: reason.trim(),
      acceptDirtyWorktree,
    });

    if (reasonRecoveryPath) removeRecoveryFile(reasonRecoveryPath);

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
      const storage = await requireStorage();
      try {
        console.log(`\nUnblock parent task: ${theme.command('lazy unblock ' + await displayIdFor(storage, result.parentTaskId))}`);
      } finally {
        await storage.close();
      }
    }
  } catch (err) {
    if (reasonRecoveryPath) {
      console.error(`Rejection reason saved to recovery file: ${reasonRecoveryPath}`);
    }
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function rejectUsage(): void {
  console.log(`Usage: lazy reject <task_id> [--reason "..."] [--yes] [--accept-dirty-worktree]

Reject a task's work and close its PR with a reject review.

Arguments:
  <task_id>    ID of the task to reject

Options:
  --reason "..."          Provide rejection reason inline instead of opening editor
  --yes, -y               Skip confirmation prompt
  --accept-dirty-worktree Allow rejecting even if worktree has uncommitted changes

Reason input priority: --reason flag > piped stdin > $EDITOR (interactive)

Notes:
  - Requires an active session. For tasks that haven't been worked on, use 'lazy close'.
  - The task's session ends with outcome 'rejected'
  - The PR is closed with a reject review
  - Worktree is removed; branch and task history are preserved
  - Task is marked as 'abandoned'
  - Use 'lazy reopen <task_id>' to restore the task later
  - By default, uncommitted changes prevent rejection (safety check)
  - Use --accept-dirty-worktree to bypass this check when certain

Examples:
  lazy reject abc12345 --reason "Incorrect approach, needs redesign" --yes
  lazy reject abc1 --reason "Bad approach"
  echo "Bad approach" | lazy reject abc1 --yes`);
}
