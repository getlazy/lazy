import { join } from 'path';
import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, parseFlags, resolveTaskOrExit, taskRef, getWorktreePath, getWorktreePathForRef } from '../helpers';
import { createWorktree, createWorktreeFromSha, getCurrentSha } from '../../git/operations';
import { openEditor, removeRecoveryFile, requireTTY, readStdinIfPiped } from '../editor';
import { checkOrphanedChild, retargetOrphanedChild } from '../orphan';

import { getDataDir } from '../init';
import { getActor } from '../../constants';

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

  const argReason = parsed.flags.get('reason') as string | undefined;

  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    // Resolve task
    const task = await resolveTaskOrExit(storage, taskId);

    // Verify task is abandoned, closed, or complete
    if (task.status !== 'abandoned' && task.status !== 'closed' && task.status !== 'complete') {
      console.error(`Task ${displayId(task)} is ${task.status} — only abandoned, closed, or complete tasks can be reopened.`);
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

    // Get session (closed tasks may not have one if they were never started)
    const sess = await storage.getSessionByTaskId(task.id);

    // Check for orphaned child (parent accepted, branch gone) and retarget before recreating worktree
    if (task.parent_task_id) {
      const orphanStatus = await checkOrphanedChild(task, storage, root);
      if (orphanStatus.isOrphaned && orphanStatus.retargetBranch) {
        console.log(`\nParent task was accepted and its branch deleted.`);
        console.log(`This task needs to be retargeted to ${orphanStatus.retargetBranch} before reopening.\n`);

        // Auto-retarget (no prompt needed for reopen - the human already decided to reopen)
        await retargetOrphanedChild(task, storage, orphanStatus.retargetBranch);
        console.log(`Retargeted to ${orphanStatus.retargetBranch}.\n`);

        // Refresh task reference — parent_task_id is now null
        const refreshedTask = await storage.getTask(task.id);
        if (refreshedTask) {
          Object.assign(task, refreshedTask);
        }
      }
    }

    const tRef = taskRef(task);
    const worktreePath = getWorktreePathForRef(root, tRef);

    if (sess) {
      // Determine start SHA: for child tasks, use parent's current HEAD; otherwise use main
      let startSha: string | undefined;
      if (task.parent_task_id) {
        // Child task: must branch from parent's current HEAD
        const parentTask = await storage.getTask(task.parent_task_id);
        if (!parentTask) {
          console.error(`Parent task not found: ${task.parent_task_id}`);
          process.exit(1);
        }

        const parentWorktreePath = getWorktreePath(root, parentTask);
        if (!existsSync(parentWorktreePath)) {
          // Reject instead of silently falling back to main
          console.error(`Cannot reopen child task: parent task has no worktree.`);
          console.error(`Start the parent first with: lazy start ${displayId(parentTask)}`);
          console.error(`Or use 'lazy clone' to recreate under a different parent.`);
          process.exit(1);
        }

        // Parent worktree exists - use its HEAD
        startSha = getCurrentSha(parentWorktreePath);
        // Update branched_from_sha for future reference
        await storage.updateTaskBranchedFromSha(task.id, startSha);
      }

      // Recreate worktree: reuses existing branch if preserved, or creates a fresh
      // branch from parent's HEAD (if child task) or main (otherwise).
      try {
        if (startSha) {
          createWorktreeFromSha(worktreePath, sess.git_branch, startSha, root);
        } else {
          createWorktree(worktreePath, sess.git_branch, root);
        }
      } catch (err) {
        console.error(`Failed to recreate worktree: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }

      // Reset session: clear ended_at, outcome, and claude_session_id
      await storage.resetSession(sess.id);
    }

    // Reset task: status back to blocked (if has session) or backlog (if never started), clear completed_at
    await storage.reopenTask(task.id, getActor());

    // Record reason as a comment if reopening a complete task
    if (reason) {
      await storage.createComment(task.id, `[Reopened] ${reason.trim()}`, getActor());
      // Comment is now durably persisted — clean up recovery file
      if (reopenRecoveryPath) removeRecoveryFile(reopenRecoveryPath);
    }

    // Determine final status based on whether task has a session
    const finalStatus = sess ? 'blocked' : 'backlog';

    console.log(`\nTask ${displayId(task)} reopened.`);
    console.log(`  Goal:   ${task.goal}`);
    if (reason) {
      console.log(`  Reason: ${reason}`);
    }
    if (sess) {
      console.log(`  Branch: ${sess.git_branch}`);
    }
    console.log(`  Status: ${finalStatus}`);
    console.log(`\nContinue with: lazy ${sess ? 'unblock' : 'start'} ${displayId(task)}`);

  } finally {
    await storage.close();
  }
}

export function reopenUsage(): void {
  console.log(`Usage: lazy reopen <task_id> [--reason "reason text"]

Reopen a previously rejected (abandoned), closed, or accepted (complete) task.

Restores the task to 'blocked' status and recreates the worktree.
If the git branch still exists, it is reused; otherwise a fresh
branch is created from main.

Arguments:
  <task_id>    ID of the abandoned, closed, or complete task to reopen

Options:
  --reason     Reason for reopening (required for complete tasks)
               If not provided for complete tasks, $EDITOR will be opened

Reason input priority: --reason flag > piped stdin > $EDITOR (interactive)

Interactive Mode:
  - For complete tasks without --reason, requires an interactive terminal (TTY)
  - Opens $EDITOR to enter the reopening reason
  - For non-interactive use, provide --reason or pipe via stdin

Notes:
  - Only works on tasks with 'abandoned', 'closed', or 'complete' status
  - For complete tasks, a reason is required and recorded as a comment
  - Resets the session so the task can receive new feedback
  - For complete tasks, clears the old Claude session ID to start fresh
  - After reopening, use 'lazy unblock' to continue (or 'lazy start' for never-started tasks)

Examples:
  lazy reopen abc12345
  lazy reopen def4 --reason "Erroneous acceptance by reconciler bug"
  echo "Need to fix a bug" | lazy reopen abc1`);
}
