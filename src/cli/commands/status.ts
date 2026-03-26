import { join } from 'path';
import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, displayIdFor, parseFlags, resolveTaskOrExit, formatDate, taskRef, getWorktreePath } from '../helpers';
import { getCurrentSha, hasUncommittedChanges } from '../../git/operations';
import { checkOrphanedChild } from '../orphan';
import { isTerminalStatus } from '../../types';

import { getDataDir } from '../init';
import { theme } from '../theme';
import { runGit } from '../../utils/git';

export async function commandStatus(args: string[]): Promise<void> {
  // Parse and validate flags (no flags supported, but validate against unknown flags)
  const parsed = parseFlags(args, [], 'status');

  const taskId = parsed.positional[0];
  if (!taskId) {
    statusUsage();
    process.exit(1);
  }

  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    // Resolve task
    const task = await resolveTaskOrExit(storage, taskId);

    // Get session
    const sess = await storage.getSessionByTaskId(task.id);

    console.log(`Task ${theme.taskId(displayId(task))} Status`);
    console.log(`  ${theme.label('Goal:')}   ${task.goal}`);
    console.log(`  ${theme.label('Status:')} ${theme.status(task.status)}`);

    if (task.parent_task_id) {
      console.log(`  ${theme.label('Parent:')} ${theme.taskId(await displayIdFor(storage, task.parent_task_id))}`);

      // Check if this is an orphaned child (parent accepted, branch gone)
      const orphanStatus = await checkOrphanedChild(task, storage, root);
      if (orphanStatus.isOrphaned && orphanStatus.retargetBranch) {
        console.log(theme.warning(`\n  Warning: Parent task was accepted and its branch deleted.`));
        console.log(theme.warning(`  This task needs rebasing onto ${orphanStatus.retargetBranch} before it can continue.`));
        console.log(`  Run: ${theme.command('lazy unblock ' + displayId(task))} or ${theme.command('lazy start ' + displayId(task))} to retarget automatically.`);
      }
    }

    if (!sess) {
      console.log(`\n${theme.label('Session:')} not started`);
      console.log(`  Start with: ${theme.command('lazy start ' + displayId(task))}`);
      return;
    }

    const worktreePath = getWorktreePath(root, task);

    console.log(`\n${theme.label('Session:')}`);
    console.log(`  ${theme.label('Branch:')}   ${sess.git_branch}`);
    console.log(`  ${theme.label('Worktree:')} ${worktreePath}`);
    console.log(`  ${theme.label('Baseline:')} ${theme.commitSha(sess.git_start_sha.substring(0, 8))}`);

    // Check worktree existence
    const worktreeExists = existsSync(worktreePath);
    if (!worktreeExists) {
      // For terminal tasks (complete, abandoned, closed), missing worktree is expected
      if (isTerminalStatus(task.status)) {
        console.log(`\n  ${theme.label('Note:')} Worktree directory has been cleaned up (task is ${task.status})`);
      } else {
        // For active/blocked tasks, missing worktree is an error
        console.error('\n  ERROR: Worktree directory does not exist!');
        console.error('  The session cannot be resumed without the worktree.');
        return;
      }
    }

    // Get current HEAD (only if worktree exists)
    if (worktreeExists) {
      try {
        const currentSha = getCurrentSha(worktreePath);
        console.log(`  ${theme.label('HEAD:')}     ${theme.commitSha(currentSha.substring(0, 8))}`);
      } catch {
        console.error('\n  ERROR: Failed to read HEAD from worktree!');
      }
    }

    // Check for commits
    const commits = await storage.getSessionCommits(sess.id);
    console.log(`\n  ${theme.label('Commits:')} ${theme.count(String(commits.length))}`);
    if (commits.length > 0) {
      for (const c of commits) {
        console.log(`    ${theme.commitSha(c.sha.substring(0, 8))} ${c.message}`);
      }
    }

    // Check for uncommitted changes (only if worktree exists)
    if (worktreeExists) {
      const hasUncommitted = hasUncommittedChanges(worktreePath);
      console.log(`\n  Uncommitted changes: ${hasUncommitted ? 'YES' : 'NO'}`);

      if (hasUncommitted) {
        const gitStatus = runGit(['status', '--porcelain', '--', ':!.lazy-task-sandbox'], { cwd: worktreePath }).stdout;
        const files = gitStatus.trim().split('\n').filter(l => l.trim());
        console.log(`  Modified files: ${files.length}`);
        for (const line of files.slice(0, 10)) {
          console.log(`    ${line}`);
        }
        if (files.length > 10) {
          console.log(`    ... and ${files.length - 10} more`);
        }

        // Check for saved snapshot
        const snapshot = await storage.getLatestWorktreeSnapshot(sess.id);
        if (snapshot) {
          console.log(`\n  Latest backup snapshot:`);
          console.log(`    Turn: ${snapshot.turn_sequence}`);
          console.log(`    Time: ${formatDate(snapshot.timestamp)}`);
          console.log(`    (Uncommitted changes have been backed up)`);
        }
      }
    }

    // Claude session info
    if (sess.agent_session_id) {
      console.log(`\n  Claude session: ${sess.agent_session_id}`);
      console.log(`  Can resume: ${sess.ended_at ? 'NO (session ended)' : 'YES'}`);
    } else {
      console.log(`\n  Claude session: (none)`);
      console.log(`  Can resume: NO`);
    }

    // Interrupt history
    if (sess.interrupt_at) {
      console.log(`\n  ${theme.label('Last Interrupt:')}`);
      console.log(`    Reason:      ${sess.interrupt_reason ?? 'unknown'}`);
      if (sess.interrupt_exit_code !== null) {
        console.log(`    Exit code:   ${sess.interrupt_exit_code}`);
      }
      console.log(`    Time:        ${formatDate(sess.interrupt_at)}`);
      console.log(`    Consecutive: ${sess.consecutive_interruptions}`);
      if (sess.auto_resumed) {
        console.log(`    Auto-resumed: yes`);
      }
    }

    // Session status
    const status = sess.outcome ?? (sess.ended_at ? 'ended' : task.status);
    console.log(`\n  ${theme.label('Session status:')} ${theme.status(status)}`);

    // Suggestions
    if (!sess.ended_at) {
      const di = displayId(task);
      console.log(`\n${theme.label('Actions:')}`);
      console.log(`  ${theme.command('lazy unblock ' + di)}    # Unblock with feedback`);
      console.log(`  ${theme.command('lazy diff ' + di)}       # See changes`);
      console.log(`  ${theme.command('lazy shell ' + di)}      # Open shell in worktree`);
      console.log(`  ${theme.command('lazy accept ' + di)}     # Accept and merge`);
      console.log(`  ${theme.command('lazy reject ' + di)}     # Reject and discard`);
    }

  } finally {
    await storage.close();
  }
}

export function statusUsage(): void {
  console.log(`Usage: lazy status <task_id>

Show the current status of a task including worktree state, commits,
and uncommitted changes.

Arguments:
  <task_id>    ID of the task

Examples:
  lazy status abc123
  lazy status abc1        # Prefix matching works`);
}
