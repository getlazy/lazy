import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, displayIdFor, parseFlags, resolveTaskOrExit, rejectIfPairing, getWorktreePath } from '../helpers';
import { openEditor, removeRecoveryFile, requireTTY, readStdinIfPiped } from '../editor';
import { hasUncommittedChanges } from '../../git/operations';
import { isTerminalStatus } from '../../types';
import { queryAbandonTask } from '../../daemon/rpc-fallback';

import { theme } from '../theme';

async function promptForReason(taskShortId: string, goal?: string): Promise<{ reason: string; recoveryPath: string | null }> {
  const headerLines = [
    `# Task: ${taskShortId}`,
    ...(goal ? [`# Goal: ${goal}`] : []),
    '#',
    '# Enter the reason for abandoning this task',
    '# Lines starting with # will be ignored',
    '',
  ];
  const template = headerLines.join('\n') + '\n';

  const editResult = await openEditor(template, `abandon-${taskShortId}`);
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

export async function commandAbandon(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'yes', aliases: ['y'], takesValue: false },
    { name: 'reason', takesValue: true },
    { name: 'accept-dirty-worktree', takesValue: false },
  ], 'abandon');

  const taskId = parsed.positional[0];
  if (!taskId) {
    abandonUsage();
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

      // Pairing lock check (for tasks with sessions)
      const sess = await storage.getSessionByTaskId(task.id);
      if (sess) {
        rejectIfPairing(root, shortId(task.id), displayId(task));
      }

      // Uncommitted changes check
      const worktreePath = getWorktreePath(root, task);
      if (!acceptDirtyWorktree && existsSync(worktreePath) && await hasUncommittedChanges(worktreePath)) {
        console.error('Error: Task has uncommitted changes!');
        console.error('Commit or stash your changes before abandoning.');
        console.error('Options:');
        console.error(`  1. Unblock and ask agent to commit: lazy unblock ${displayId(task)} --message "Please commit your changes"`);
        console.error(`  2. Manually commit in shell: lazy shell ${displayId(task)}`);
        console.error(`  3. Accept dirty worktree: lazy abandon ${displayId(task)} --accept-dirty-worktree`);
        process.exit(1);
      }
    } finally {
      await storage.close();
    }
  }

  // Get reason BEFORE RPC call — collect all interactive input first
  let reason: string;
  let recoveryPath: string | null = null;
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
      recoveryPath = result.recoveryPath;
    }
  }

  // --- Delegate to daemon RPC ---
  try {
    const result = await queryAbandonTask({
      taskId,
      reason,
      acceptDirtyWorktree,
    });

    // Reason is now durably persisted — clean up recovery file
    if (recoveryPath) removeRecoveryFile(recoveryPath);

    // Print warnings
    for (const w of result.warnings) {
      console.log(w);
    }

    console.log(`\nTask ${theme.taskId(result.displayId)} abandoned.`);
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
    if (recoveryPath) {
      console.error(`Abandon reason saved to recovery file: ${recoveryPath}`);
    }
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function abandonUsage(): void {
  console.log(`Usage: lazy abandon <task_id> [--reason "reason text"] [--yes] [--accept-dirty-worktree]

Abandon a task — discard its work and mark it as abandoned.

Arguments:
  <task_id>    ID of the task to abandon

Options:
  --reason                Reason for abandoning the task (required)
                          If not provided, $EDITOR will be opened to enter the reason
  --yes, -y               Skip editor prompt (non-interactive mode)
                          Requires --reason or piped stdin
  --accept-dirty-worktree Allow abandoning even if worktree has uncommitted changes

Reason input priority: --reason flag > piped stdin > $EDITOR (interactive)

Interactive Mode:
  - Without --reason, requires an interactive terminal (TTY)
  - Opens $EDITOR to enter the abandon reason
  - For fully non-interactive use, provide --reason (or pipe stdin) and --yes

Notes:
  - Can be used on working, blocked, interrupted, or backlog tasks
  - Task is marked as 'abandoned' with the provided reason
  - If a session exists, the worktree is removed but the branch is preserved
  - If a session exists with work, the session is ended with 'rejected' outcome
  - Task history is preserved
  - Use 'lazy reopen <task_id>' to restore the task later
  - Use this when a task is superseded, no longer relevant, or decided against
  - By default, uncommitted changes prevent abandoning (safety check)
  - Use --accept-dirty-worktree to bypass this check when certain

Examples:
  lazy abandon abc12345 --reason "Superseded by task def67890" --yes
  lazy abandon abc1 --yes --reason "No longer needed after refactor"
  lazy abandon abc1 --reason "No longer needed"  # Interactive (no --yes)
  lazy abandon abc1 --accept-dirty-worktree --reason "Discard all work" --yes
  lazy abandon abc1     # Opens editor to enter reason (requires TTY)
  echo "No longer needed" | lazy abandon abc1 --yes  # Piped stdin as reason`);
}
