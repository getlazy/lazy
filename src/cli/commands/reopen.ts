import { join } from 'path';
import { requireActorIdentity } from '../identity-preflight';
import { shortId, displayId, taskRef, getWorktreePathForRef } from '../../task/identity';
import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, parseFlags, resolveTaskOrExit } from '../helpers';
import { recoverMissingWorktree, copyUntrackedFilesIntoWorktree } from '../../git/operations';

import { openEditor, removeRecoveryFile, requireTTY, readStdinIfPiped } from '../editor';
import { checkOrphanedChild, retargetOrphanedChild } from '../../task/orphan';
import { loadConfig } from '../../config/loader';

import { getDataDir } from '../../project-paths';
import { getActor } from '../../constants';
import { parentTaskIdOf } from '../../task-target';
import { queryReopenTask } from '../../daemon/rpc-fallback';

async function promptForReason(taskShortId: string, goal?: string): Promise<{ reason: string; recoveryPath: string | null }> {
  const headerLines = [
    `# Task: ${taskShortId}`,
    ...(goal ? [`# Goal: ${goal}`] : []),
    '#',
    '# Enter the reason for reopening this accepted task',
    '# Lines starting with # will be ignored',
    '',
  ];
  const template = headerLines.join('\n') + '\n';

  const editResult = await openEditor(template, `reopen-${taskShortId}`);
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

export async function commandReopen(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'reason', takesValue: true },
  ], 'reopen');

  const taskId = parsed.positional[0];
  if (!taskId) {
    reopenUsage();
    process.exit(1);
  }

  // Before the reopen reason is typed: the daemon refuses a write it cannot
  // attribute, and a refusal must never cost the human what they wrote.
  await requireActorIdentity();

  const argReason = parsed.flags.get('reason') as string | undefined;

  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    // Resolve task
    const task = await resolveTaskOrExit(storage, taskId);

    // Verify task is abandoned or complete
    if (task.status !== 'abandoned' && task.status !== 'complete') {
      console.error(`Task ${displayId(task)} is ${task.status} — only abandoned or complete tasks can be reopened.`);
      process.exit(1);
    }

    // Get or prompt for reason if task is complete (accepted)
    let reason: string | null = null;
    let reopenRecoveryPath: string | null = null;
    if (task.status === 'complete') {
      if (argReason !== undefined) {
        reason = argReason;
      } else {
        // Try piped stdin before falling back to $EDITOR
        const stdinContent = await readStdinIfPiped();
        if (stdinContent !== null) {
          reason = stdinContent;
        } else {
          // Require TTY before opening editor
          try {
            requireTTY('This command requires an interactive terminal. Use --reason to provide a reason non-interactively, or pipe via stdin.');
          } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
          }
          // Pre-flight before the editor (never lose feedback): a reopen that
          // cannot find the task's work refuses NOW, before anything is typed.
          try {
            await queryReopenTask({ taskId: task.id, actor: getActor(), checkOnly: true });
          } catch (err) {
            console.error(`Error: ${err instanceof Error ? err.message : err}`);
            process.exit(1);
          }
          const result = await promptForReason(displayId(task), task.goal);
          reason = result.reason;
          reopenRecoveryPath = result.recoveryPath;
        }
      }

      if (!reason.trim()) {
        if (reopenRecoveryPath) removeRecoveryFile(reopenRecoveryPath);
        console.error('Error: reason is required for reopening accepted tasks');
        process.exit(1);
      }
    }

    // Get session (abandoned tasks may not have one if they were never started)
    const sess = await storage.getSessionByTaskId(task.id);

    const tRef = taskRef(task);
    const worktreePath = getWorktreePathForRef(root, tRef);

    // The one reopen implementation (src/daemon/task-lifecycle.ts), shared with
    // lazy_reopen and the web task page: restore the task branch at its last
    // head (or refuse, changing nothing) → reason comment → reopen to
    // blocked-or-backlog → session reset. Only attaching the worktree below is
    // CLI-side; the other callers defer it to the next start/unblock.
    let result;
    try {
      result = await queryReopenTask({
        taskId: task.id,
        reason: reason ?? undefined,
        actor: getActor(),
      });
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      if (reopenRecoveryPath) console.error(`Your reason was kept in ${reopenRecoveryPath}`);
      process.exit(1);
    }
    // Reason (if any) is now durably persisted as a comment — clean up recovery file
    if (reopenRecoveryPath) removeRecoveryFile(reopenRecoveryPath);

    if (result.restore) console.log(result.restore.message);

    // An orphaned child (parent accepted, its branch gone) is retargeted —
    // after the reopen succeeded, so a refused reopen changes nothing.
    if (parentTaskIdOf(task)) {
      const orphanStatus = await checkOrphanedChild(task, storage, root);
      if (orphanStatus.isOrphaned && orphanStatus.retargetBranch) {
        await retargetOrphanedChild(task, storage, orphanStatus.retargetBranch);
        console.log(`Parent task was accepted and its branch deleted — retargeted to ${orphanStatus.retargetBranch}.`);
      }
    }

    // Attach the worktree to the restored branch — never `-b`, which would cut
    // a fresh, empty branch.
    if (sess && !existsSync(worktreePath)) {
      try {
        const recovery = await recoverMissingWorktree(worktreePath, sess.git_branch, root);
        if (!recovery.recovered) throw new Error(`branch ${sess.git_branch} is missing`);
        const config = await loadConfig(root);
        await copyUntrackedFilesIntoWorktree(root, worktreePath, config.worktree.include);
      } catch (err) {
        console.error(`Warning: could not recreate the worktree now (${err instanceof Error ? err.message : err}); 'lazy unblock' will recreate it from ${sess.git_branch}.`);
      }
    }

    const finalStatus = result.newStatus;

    console.log(`\nTask ${displayId(task)} reopened.`);
    console.log(`  Goal:   ${task.goal}`);
    if (reason) {
      console.log(`  Reason: ${reason}`);
    }
    if (sess) {
      console.log(`  Branch: ${sess.git_branch}`);
    }
    console.log(`  Status: ${finalStatus}`);
    if (result.restore?.syncHint) console.log(`\n${result.restore.syncHint}`);
    console.log(`\nContinue with: lazy ${sess ? 'unblock' : 'start'} ${displayId(task)}`);

  } finally {
    await storage.close();
  }
}

export function reopenUsage(): void {
  console.log(`Usage: lazy reopen <task_id> [--reason "reason text"]

Reopen a previously abandoned or accepted (complete) task.

Restores the task to 'blocked' status and brings back its branch at the
task's last head: the local branch if it still exists, otherwise the
task's branch on the remote (unless lazy recorded newer work the remote
never received, which is restored instead), otherwise the last commit lazy
recorded for it. If none can be found, reopen refuses and changes nothing — reopen
never starts a task empty (use 'lazy clone' or 'lazy redo' for that).
If the parent moved meanwhile, run 'lazy sync' afterwards.

Arguments:
  <task_id>    ID of the abandoned or complete task to reopen

Options:
  --reason     Reason for reopening (required for complete tasks)
               If not provided for complete tasks, $EDITOR will be opened

Reason input priority: --reason flag > piped stdin > $EDITOR (interactive)

Interactive Mode:
  - For complete tasks without --reason, requires an interactive terminal (TTY)
  - Opens $EDITOR to enter the reopening reason
  - For non-interactive use, provide --reason or pipe via stdin

Notes:
  - Only works on tasks with 'abandoned' or 'complete' status
  - For complete tasks, a reason is required and recorded as a comment
  - Resets the session so the task can receive new feedback
  - For complete tasks, clears the old agent session ID to start fresh
  - After reopening, use 'lazy unblock' to continue (or 'lazy start' for never-started tasks)

Examples:
  lazy reopen abc12345
  lazy reopen def4 --reason "Erroneous acceptance by reconciler bug"
  echo "Need to fix a bug" | lazy reopen abc1`);
}
