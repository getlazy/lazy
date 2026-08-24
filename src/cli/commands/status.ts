import { join } from 'path';
import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, displayIdFor, parseFlags, resolveTaskOrExit, formatDate, taskRef, getWorktreePath } from '../helpers';
import { getCurrentSha, hasUncommittedChanges, readWorktreeMergeState, isMidMerge, describeMergeState } from '../../git/operations';
import { checkOrphanedChild } from '../orphan';
import { isTerminalStatus } from '../../types';
import type { Storage } from '../../storage';
import type { Task } from '../../types';

import { getDataDir } from '../init';
import { theme } from '../theme';
import { loadConfig } from '../../config/loader';
import { parentTaskIdOf } from '../../task-target';
import { checkLock } from '../../utils/lock';
import { createRunner } from '../../runner';
import { protocolDir as getProtocolDir } from '../../protocol';
import { computeWorkingSubstate, renderWorkingStatus } from '../../utils/working-substate';
import { loadTaskProtectionStatus, protectionSummary, protectionAdvice } from '../../protection/status';
import { logger } from '../../utils/logger';
import {
  isAutoReactPaused,
  getAutoReactPausedReason,
  getAutoReactCount,
  readDailyBudget,
  effectiveDailyLimit,
  checkBackoff,
  type AutoReactTrigger,
} from '../../daemon/auto-react-budget';
import { runGit } from '../../utils/git';
import { agentDisplayName } from '../../agent/registry';

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

    // Derive the working substate (agent / harness:<phase> / not-alive) so the
    // status word distinguishes busy post-turn work from a hung or dead supervisor.
    let statusText: string = task.status;
    if (task.status === 'working' && sess) {
      try {
        const runner = await createRunner(root);
        const cn = sess.container_name ?? runner.runNameForTask(taskRef(task));
        const info = await runner.getRunInfo(cn);
        const substate = await computeWorkingSubstate(getProtocolDir(task.id), info?.running === true);
        statusText = renderWorkingStatus(substate);
      } catch (err) {
        logger.debug(`Task ${shortId(task.id)}: could not derive working substate: ${err instanceof Error ? err.message : err}`);
      }
    }

    console.log(`Task ${theme.taskId(displayId(task))} Status`);
    console.log(`  ${theme.label('Goal:')}   ${task.goal}`);
    console.log(`  ${theme.label('Status:')} ${theme.status(statusText)}`);

    const parentId = parentTaskIdOf(task);
    if (parentId) {
      console.log(`  ${theme.label('Parent:')} ${theme.taskId(await displayIdFor(storage, parentId))}`);

      // Check if this is an orphaned child (parent accepted, branch gone)
      const orphanStatus = await checkOrphanedChild(task, storage, root);
      if (orphanStatus.isOrphaned && orphanStatus.retargetBranch) {
        console.log(theme.warning(`\n  Warning: Parent task was accepted and its branch deleted.`));
        console.log(theme.warning(`  This task needs rebasing onto ${orphanStatus.retargetBranch} before it can continue.`));
        console.log(`  Run: ${theme.command('lazy unblock ' + displayId(task))} or ${theme.command('lazy start ' + displayId(task))} to retarget automatically.`);
      }
    }

    // Protection, if any. Same wording as `lazy show` — the point of the shared
    // vocabulary is that a gate reads identically wherever you meet it.
    try {
      const config = await loadConfig(root);
      const protection = await loadTaskProtectionStatus(storage, config, root, task, {
        hasBranch: Boolean(sess?.git_branch),
      });
      const summary = protectionSummary(protection);
      if (summary) {
        const paint = protection.gated ? theme.warning : (s: string) => s;
        console.log(`  ${theme.label('Protected:')} ${paint(summary)}`);
        for (const line of protectionAdvice(protection, displayId(task))) {
          console.log(`             ${line}`);
        }
      }
    } catch (err) {
      logger.debug(`Task ${shortId(task.id)}: could not resolve protection status: ${err instanceof Error ? err.message : err}`);
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
        // For active/blocked tasks, missing worktree is notable but not fatal
        console.error('\n  ' + theme.error('WARNING:') + ' Worktree directory does not exist!');
        console.error('  The session cannot be resumed without the worktree.');
      }
    }

    // Get current HEAD (only if worktree exists)
    if (worktreeExists) {
      try {
        const currentSha = await getCurrentSha(worktreePath);
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
      // An unresolved merge is reported BEFORE the uncommitted-changes line: the
      // conflict markers would otherwise show up as ordinary modified files with
      // nothing saying the tree is mid-merge (fix-sync-silent-conflict).
      const mergeState = await readWorktreeMergeState(worktreePath);
      if (isMidMerge(mergeState)) {
        console.log(`\n  ${theme.warning(`Unresolved merge: ${describeMergeState(mergeState)}`)}`);
        console.log(`  A sync did not finish. Resolve the conflicts and commit the merge, or run \`git merge --abort\`.`);
      }

      const hasUncommitted = await hasUncommittedChanges(worktreePath);
      console.log(`\n  Uncommitted changes: ${hasUncommitted ? 'YES' : 'NO'}`);

      if (hasUncommitted) {
        const gitStatus = (await runGit(['status', '--porcelain', '--', ':!.lazy-task-sandbox'], { cwd: worktreePath })).stdout;
        const files = gitStatus.trim().split('\n').filter((l: string) => l.trim());
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

    // Agent session info — labelled with the TASK's agent, not "Claude"
    const agentLabel = task.agent_id ? agentDisplayName(task.agent_id) : 'Agent';
    if (sess.agent_session_id) {
      console.log(`\n  ${agentLabel} session: ${sess.agent_session_id}`);
      console.log(`  Can resume: ${sess.ended_at ? 'NO (session ended)' : 'YES'}`);
    } else {
      console.log(`\n  ${agentLabel} session: (none)`);
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
    const status = sess.outcome ?? (sess.ended_at ? 'ended' : statusText);
    console.log(`\n  ${theme.label('Session status:')} ${theme.status(status)}`);

    // Auto-react diagnostics (only for blocked tasks)
    if (task.status === 'blocked') {
      await printAutoReactDiagnostics(storage, task, root, worktreePath, worktreeExists);
    }

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

async function printAutoReactDiagnostics(
  storage: Storage,
  task: Task,
  lazyRoot: string,
  worktreePath: string,
  worktreeExists: boolean,
): Promise<void> {
  const config = await loadConfig(lazyRoot);
  const dataDir = join(lazyRoot, getDataDir(lazyRoot));
  const { auto_react_max_retries, auto_react_backoff, auto_react_daily_budget } = config.daemon;

  const triggers: AutoReactTrigger[] = ['ci_failure', 'upstream_sync', 'comment', 'child_completed', 'crash'];
  const blockReasons: string[] = [];

  console.log(`\n${theme.label('Auto-react:')}`);

  // 1. Paused status
  const paused = await isAutoReactPaused(storage, task.id);
  if (paused) {
    const reason = await getAutoReactPausedReason(storage, task.id);
    console.log(`  ${theme.label('Paused:')}  ${theme.warning('yes')} — ${reason ?? 'unknown reason'}`);
    blockReasons.push(reason ?? 'paused');
  } else {
    console.log(`  ${theme.label('Paused:')}  no`);
  }

  // 2. Per-trigger retry counts
  const countsWithActivity: { trigger: AutoReactTrigger; count: number }[] = [];
  for (const trigger of triggers) {
    const count = await getAutoReactCount(storage, task.id, trigger);
    if (count > 0) {
      countsWithActivity.push({ trigger, count });
    }
  }

  if (countsWithActivity.length > 0) {
    console.log(`  ${theme.label('Retries:')}`);
    for (const { trigger, count } of countsWithActivity) {
      const exhausted = count >= auto_react_max_retries;
      const label = trigger.replace(/_/g, ' ');
      const countStr = `${count}/${auto_react_max_retries}`;
      console.log(`    ${label}: ${exhausted ? theme.warning(countStr + ' (exhausted)') : countStr}`);
      if (exhausted) {
        blockReasons.push(`${label} retry limit reached`);
      }
    }
  } else {
    console.log(`  ${theme.label('Retries:')} none used (max ${auto_react_max_retries} per trigger)`);
  }

  // 3. Daily budget (reflects any today-only cap override)
  const budget = await readDailyBudget(dataDir);
  const effectiveLimit = effectiveDailyLimit(budget, auto_react_daily_budget);
  const budgetExhausted = budget.used >= effectiveLimit;
  const budgetStr = `${budget.used}/${effectiveLimit}`;
  if (budgetExhausted) {
    console.log(`  ${theme.label('Daily budget:')} ${theme.warning(budgetStr + ' (exhausted)')}`);
    blockReasons.push('daily budget exhausted');
  } else {
    console.log(`  ${theme.label('Daily budget:')} ${budgetStr}`);
  }

  // 4. Backoff (only show if any trigger has non-zero count)
  if (auto_react_backoff !== 'none' && countsWithActivity.length > 0) {
    const backoffParts: string[] = [];
    for (const { trigger } of countsWithActivity) {
      const backoff = await checkBackoff(storage, task.id, trigger, auto_react_backoff);
      if (!backoff.allowed) {
        const secs = Math.ceil(backoff.remainingMs / 1000);
        const label = trigger.replace(/_/g, ' ');
        backoffParts.push(`${label}: ${secs}s remaining`);
        blockReasons.push(`backoff: ${label} (${secs}s)`);
      }
    }
    if (backoffParts.length > 0) {
      console.log(`  ${theme.label('Backoff:')}  ${theme.warning(backoffParts.join(', '))}`);
    } else {
      console.log(`  ${theme.label('Backoff:')}  clear`);
    }
  }

  // 5. Worktree status
  if (!worktreeExists) {
    console.log(`  ${theme.label('Worktree:')} ${theme.warning('missing')}`);
    blockReasons.push('worktree missing');
  } else {
    const lock = await checkLock(worktreePath);
    if (lock) {
      console.log(`  ${theme.label('Worktree:')} locked (${lock.command})`);
      blockReasons.push('worktree locked');
    } else {
      console.log(`  ${theme.label('Worktree:')} ready`);
    }
  }

  // 6. Overall verdict
  if (blockReasons.length === 0) {
    console.log(`  ${theme.label('Verdict:')}  ${theme.success('ready')}`);
  } else {
    console.log(`  ${theme.label('Verdict:')}  ${theme.warning('blocked')} (${blockReasons[0]})`);
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
