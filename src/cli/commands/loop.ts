import { requireLazyRoot, requireStorage, shortId, displayId, validateModel, parseFlags, formatDate, taskRef, getWorktreePath, getBranchNameFromId } from '../helpers';
import { promptChoice } from '../editor';
import { commandAccept } from './accept';
import { commandReject } from './reject';
import { commandUnblock } from './unblock';
import { showTaskContext, runFeedbackFlow, syncTaskFromRemote } from './shared';
import { commandSyncTask } from './sync';
import { buildTaskTree, printTaskTree } from './list';

import { isTerminalStatus } from '../../types';
import { theme, dim } from '../theme';

import { ActivityMonitor } from '../activity-monitor';


import { cleanupWorktreeAndBranch, cleanupTaskContainer } from './shared';
import { getActor } from '../../constants';

/** Maximum number of recent activity lines to display in the polling view. */
const MAX_ACTIVITY_LINES = 10;

/**
 * Rolling buffer of recent activity lines for display during polling.
 * Each entry includes a timestamp, task ID, and activity description.
 */
interface RecentActivityLine {
  timestamp: string;
  taskId: string;
  activity: string;
}

const recentActivity: RecentActivityLine[] = [];

/** Active activity monitors keyed by task short ID. */
const activeMonitors = new Map<string, ActivityMonitor>();

/**
 * Ensure activity monitors are running for all working tasks.
 * Stops monitors for tasks that are no longer working.
 */
function syncActivityMonitors(
  workingTaskIds: Map<string, { worktreePath: string; turnStartedAt?: string }>,
): void {
  // Start monitors for new working tasks
  for (const [taskShortId, info] of workingTaskIds) {
    if (!activeMonitors.has(taskShortId)) {
      const monitor = new ActivityMonitor(info.worktreePath, taskShortId, info.turnStartedAt);
      monitor.start();
      activeMonitors.set(taskShortId, monitor);
    }
  }

  // Stop monitors for tasks that are no longer working
  for (const [taskShortId, monitor] of activeMonitors) {
    if (!workingTaskIds.has(taskShortId)) {
      monitor.stop();
      activeMonitors.delete(taskShortId);
    }
  }
}

/**
 * Drain activity from all monitors into the recent activity buffer.
 */
function drainActivityMonitors(): void {
  for (const [taskShortId, monitor] of activeMonitors) {
    const lines = monitor.drain();
    for (const line of lines) {
      recentActivity.push({
        timestamp: line.timestamp,
        taskId: taskShortId,
        activity: line.activity,
      });
    }
  }

  // Trim to max size
  while (recentActivity.length > MAX_ACTIVITY_LINES) {
    recentActivity.shift();
  }
}

/**
 * Stop all running activity monitors. Call when exiting the polling loop.
 */
function stopAllMonitors(): void {
  for (const [, monitor] of activeMonitors) {
    monitor.stop();
  }
  activeMonitors.clear();
}

/**
 * Handle interrupted tasks: prompt user to resume, close, or skip each one.
 * Interrupted tasks are those whose agent crashed or container died unexpectedly.
 */
async function handleInterruptedTasks(
  storage: Awaited<ReturnType<typeof requireStorage>>,
  root: string,
  skippedIds: Set<string>,
  modelOverride: any,
  follow: boolean,
): Promise<void> {
  const interruptedTasks = await storage.listTasksWithOptions({ interruptedOnly: true, withSessionsOnly: true });

  // Filter to tasks not already skipped this session, with active sessions
  const reviewable: typeof interruptedTasks = [];
  for (const task of interruptedTasks) {
    if (skippedIds.has(task.id)) continue;
    const sess = await storage.getSessionByTaskId(task.id);
    if (sess && !sess.ended_at) {
      reviewable.push(task);
    }
  }

  if (reviewable.length === 0) return;

  // Sort by last_interaction_at ASC (oldest-waiting first)
  const tasksWithSessions = await Promise.all(
    reviewable.map(async (task) => ({
      task,
      session: (await storage.getSessionByTaskId(task.id))!,
    }))
  );
  tasksWithSessions.sort((a, b) => {
    const aTime = a.session.last_interaction_at ?? null;
    const bTime = b.session.last_interaction_at ?? null;
    if (aTime === null && bTime === null) return a.task.created_at - b.task.created_at;
    if (aTime === null) return -1;
    if (bTime === null) return 1;
    return (aTime - bTime) || (a.task.created_at - b.task.created_at);
  });

  // Process each interrupted task
  for (let i = 0; i < tasksWithSessions.length; i++) {
    const { task, session: sess } = tasksWithSessions[i];
    const taskShortId = shortId(task.id);
    const taskDisplayId = displayId(task);
    const worktreePath = getWorktreePath(root, task);

    console.log(`\n--- Interrupted Task ${i + 1} of ${tasksWithSessions.length}: ${taskDisplayId} ---`);

    // Show basic context
    console.log(`\nTask: ${taskDisplayId}`);
    console.log(`Goal: ${task.goal}`);
    console.log(`Status: interrupted  |  Last active: ${sess.last_interaction_at ? formatDate(sess.last_interaction_at) : 'unknown'}`);

    // Show recent commits if available
    let targetBranch: string;
    if (task.parent_task_id) {
      targetBranch = await getBranchNameFromId(task.parent_task_id, storage);
    } else {
      targetBranch = 'main';
    }

    try {
      const { getBranchCommitMessages } = await import('../../git/operations');
      const commits = await getBranchCommitMessages(sess.git_branch, targetBranch, root);
      if (commits.length > 0) {
        const recent = commits.slice(0, 3);
        console.log(`\nRecent commits (${commits.length} total):`);
        for (const msg of recent) {
          console.log(`  ${msg}`);
        }
        if (commits.length > 3) {
          console.log(`  ... and ${commits.length - 3} more`);
        }
      }
    } catch {
      // Branch may not exist
    }

    console.log('');
    const menuOptions = [
      'Resume (restart agent)',
      'Reject task',
      'Skip (decide later)',
    ];

    const choice = await promptChoice('What would you like to do?', menuOptions);

    if (choice === 2) {
      // Skip
      skippedIds.add(task.id);
      continue;
    }

    if (choice === 0) {
      // Resume — restart the supervisor container and launch the agent
      // Pass --message to force imperative mode (launches agent immediately)
      // This is like unblock with a minimal feedback message.
      // After the agent finishes, the task will transition from working → blocked,
      // and the loop will pick it up again for review.
      await storage.close();
      const taskShortId = shortId(task.id);
      await commandUnblock([taskShortId, '--message', 'Resuming from interruption']);
      // Break out of interrupted tasks loop and let the main loop refresh storage
      // The task will be blocked and ready for review (or completed if agent finished)
      return;
    }

    if (choice === 1) {
      // Abandon — mark as abandoned and clean up
      console.log('Abandoning task...');
      try {
        // Mark as abandoned with reason
        await storage.abandonTask(task.id, 'Abandoned due to interruption', getActor());

        // Clean up worktree and branch
        try {
          await cleanupWorktreeAndBranch(worktreePath, sess.git_branch, root);
        } catch (err) {
          // Log but don't fail — partial cleanup is acceptable
          console.error(`Warning: could not fully clean up worktree: ${err instanceof Error ? err.message : err}`);
        }

        // Clean up container
        try {
          await cleanupTaskContainer(storage, sess, taskRef(task), root);
        } catch (err) {
          console.error(`Warning: could not clean up container: ${err instanceof Error ? err.message : err}`);
        }

        console.log(`Task ${taskDisplayId} abandoned.`);
      } catch (err) {
        console.error(`Error abandoning task: ${err instanceof Error ? err.message : err}`);
      }

      skippedIds.add(task.id);
      continue;
    }
  }
}

/**
 * Sequential review loop: iterate through all blocked tasks with sessions.
 * Shows each task, offers feedback/accept/reject/skip, then moves to the next.
 */
export async function commandLoop(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'model', takesValue: true },
    { name: 'follow', takesValue: false },
  ], 'loop');

  if (!process.stdin.isTTY) {
    console.error('lazy loop requires an interactive terminal.');
    process.exit(1);
  }

  // Parse --model flag
  const modelValue = parsed.flags.get('model') as string | undefined;
  let modelOverride: string | undefined;
  if (modelValue !== undefined) {
    modelOverride = validateModel(modelValue);
  }

  const follow = parsed.flags.get('follow') === true;
  const root = requireLazyRoot();

  // Pre-flight checks before entering the review loop
  const { createRunner } = await import('../../runner');
  const runner = await createRunner(root);
  try {
    runner.checkAvailability();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Track skipped tasks so we don't re-show them
  const skippedBlockedIds = new Set<string>();
  const skippedInterruptedIds = new Set<string>();

  // Main review loop
  while (true) {
    const storage = await requireStorage();
    try {
      // First, check for interrupted tasks and offer to resume them
      await handleInterruptedTasks(storage, root, skippedInterruptedIds, modelOverride, follow);

      // Query blocked tasks with sessions (started tasks waiting for review)
      const allBlocked = await storage.listTasksWithOptions({ blockedOnly: true, withSessionsOnly: true });

      // Filter to only tasks with active (non-ended) sessions, excluding skipped
      const reviewable: typeof allBlocked = [];
      for (const task of allBlocked) {
        if (skippedBlockedIds.has(task.id)) continue;
        const sess = await storage.getSessionByTaskId(task.id);
        if (sess && !sess.ended_at) {
          reviewable.push(task);
        }
      }

      if (reviewable.length === 0) {
        // No blocked tasks — wait for new ones, showing active tasks like `active --follow`
        const pollIntervalMs = 3000;
        let foundBlocked = false;

        while (!foundBlocked) {
          // Clear screen for clean display
          process.stdout.write('\x1B[2J\x1B[H');

          // Check for newly blocked tasks that weren't already skipped
          const newBlocked = await storage.listTasksWithOptions({ blockedOnly: true, withSessionsOnly: true });
          const newReviewable: typeof newBlocked = [];
          for (const t of newBlocked) {
            if (skippedBlockedIds.has(t.id)) continue;
            const s = await storage.getSessionByTaskId(t.id);
            if (s && !s.ended_at) newReviewable.push(t);
          }

          if (newReviewable.length > 0) {
            // Genuinely new blocked tasks found — reset skips and resume review loop
            skippedBlockedIds.clear();
            foundBlocked = true;
            break;
          }

          // Show active tasks (non-terminal with sessions) while waiting
          const activeTasks = await storage.listTasksWithOptions({ withSessionsOnly: true, nonTerminalOnly: true });

          if (activeTasks.length === 0) {
            stopAllMonitors();
            console.log('No active tasks. Waiting for tasks to become blocked...');
          } else {
            // Start/sync activity monitors for working tasks
            const workingTasks = new Map<string, { worktreePath: string; turnStartedAt?: string }>();
            for (const t of activeTasks) {
              if (t.status === 'working') {
                const tRef = taskRef(t);
                const tWorktree = getWorktreePath(root, t);
                const tSess = await storage.getSessionByTaskId(t.id);
                workingTasks.set(tRef, {
                  worktreePath: tWorktree,
                  turnStartedAt: tSess?.last_interaction_at ? new Date(tSess.last_interaction_at).toISOString() : undefined,
                });
              }
            }
            syncActivityMonitors(workingTasks);
            drainActivityMonitors();

            const tree = await buildTaskTree(storage, activeTasks, root);
            console.log(`${theme.header('CODE'.padEnd(20))} ${theme.header('STATUS'.padEnd(12))} ${theme.header('MODEL'.padEnd(8))} ${theme.header('TURNS'.padEnd(8))} ${theme.header('LAST ACTIVE'.padEnd(18))} ${theme.header('DURATION'.padEnd(10))} ${theme.header('TOKENS IN/OUT'.padEnd(14))} ${theme.header('GOAL')}`);
            console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(18)} ${'─'.repeat(10)} ${'─'.repeat(14)} ${'─'.repeat(30)}`));
            for (const rootNode of tree) {
              printTaskTree(rootNode);
            }

            // Show recent activity feed below the task table
            if (recentActivity.length > 0) {
              console.log(`\n${theme.header('Recent Activity')}`);
              console.log(theme.separator('─'.repeat(70)));
              for (const line of recentActivity) {
                console.log(`${dim(line.timestamp)} [${theme.taskId(line.taskId)}] ${line.activity}`);
              }
            }
          }

          console.log(`\n(waiting for tasks — press Ctrl+C to stop, polling every ${pollIntervalMs / 1000}s)`);
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        // Stop activity monitors when leaving the polling loop
        stopAllMonitors();

        // Close storage and re-enter the main loop to pick up the blocked task
        await storage.close();
        continue;
      }

      // Sort by last_interaction_at ASC (oldest-waiting first)
      const tasksWithSessions = await Promise.all(
        reviewable.map(async (task) => ({
          task,
          session: (await storage.getSessionByTaskId(task.id))!,
        }))
      );
      tasksWithSessions.sort((a, b) => {
        const aTime = a.session.last_interaction_at ?? null;
        const bTime = b.session.last_interaction_at ?? null;
        if (aTime === null && bTime === null) return a.task.created_at - b.task.created_at;
        if (aTime === null) return -1;
        if (bTime === null) return 1;
        return (aTime - bTime) || (a.task.created_at - b.task.created_at);
      });

      // Pick the first task
      const { task, session: sess } = tasksWithSessions[0];
      const taskShortId = shortId(task.id);
      const worktreePath = getWorktreePath(root, task);

      // Sync PR comments and state from GitHub before showing context
      await syncTaskFromRemote(task, storage, root);

      // Re-read task in case sync updated its status (e.g., PR merged/closed externally)
      const freshTask = await storage.getTask(task.id);
      if (freshTask && isTerminalStatus(freshTask.status)) {
        const taskLabel = displayId(task);
        console.log(`\nTask ${taskLabel} is now ${freshTask.status}. Skipping.`);
        await storage.close();
        continue;
      }

      // Show position in queue
      const taskLabel = displayId(task);
      console.log(`\n--- Task 1 of ${tasksWithSessions.length}: ${taskLabel} ---`);

      const turnCount = await storage.getTurnCountByTaskId(task.id);
      const unseenCount = await showTaskContext(
        taskShortId,
        task.goal,
        task.status,
        turnCount,
        sess.git_branch,
        worktreePath,
        root,
        task.parent_task_id,
        storage,
        task.id,
        sess.id,
        taskLabel,
      );

      const menuOptions = unseenCount > 0
        ? [
            'Give feedback - includes unseen comments (recommended)',
            `Accept anyway (agent hasn't seen ${unseenCount} comment${unseenCount === 1 ? '' : 's'})`,
            'Reject (discard work)',
            'Sync upstream (lazy sync)',
            'Skip (move to next task)',
          ]
        : [
            'Give feedback (open editor)',
            'Accept (merge work)',
            'Reject (discard work)',
            'Sync upstream (lazy sync)',
            'Skip (move to next task)',
          ];

      const choice = await promptChoice('What would you like to do?', menuOptions);

      if (choice === 4) {
        // Skip — track and move to next task
        skippedBlockedIds.add(task.id);
        await storage.close();
        continue;
      }

      // Close storage before delegating to accept/abandon (they open their own)
      await storage.close();

      switch (choice) {
        case 1:
          // Accept
          await commandAccept([taskShortId]);
          break;
        case 2:
          // Reject
          await commandReject([taskShortId]);
          break;
        case 3:
          // Merge upstream via lazy sync
          await commandSyncTask([taskShortId]);
          break;
        default: {
          // Give feedback (choice 0)
          const storage2 = await requireStorage();
          try {
            const task2 = await storage2.getTask(task.id);
            if (!task2) { console.error(`Task not found: ${taskShortId}`); process.exit(1); }
            const sess2 = await storage2.getSessionByTaskId(task2.id);
            if (!sess2) { console.error(`Task ${taskShortId} has no session.`); process.exit(1); }

            await runFeedbackFlow(task2, sess2, root, storage2, worktreePath, taskShortId, follow, modelOverride);
          } finally {
            await storage2.close();
          }
          break;
        }
      }

      // Continue to next task (list will be refreshed on next iteration)
    } finally {
      // Storage may already be closed by delegates, safe to call multiple times
      try { await storage.close(); } catch { /* ignore */ }
    }
  }
}

export function loopUsage(): void {
  console.log(`Usage: lazy loop [--model <model>] [--follow]

Sequentially review all blocked tasks. For each task, shows context (goal, diff,
comments) and offers: give feedback, accept, reject, merge upstream, or skip.

After acting on a task, automatically moves to the next. When no blocked tasks
remain, enters a follow mode that shows active tasks and polls for new blocked
tasks every 3 seconds. Ctrl+C exits at any time.

Options:
  --model <model>   Override model for feedback turns (e.g. opus, sonnet, claude-sonnet-4-5-20250929)
  --follow          Wait for agent after giving feedback

Examples:
  lazy loop                          # Review all blocked tasks
  lazy loop --model opus                        # Use opus for feedback turns
  lazy loop --follow                 # Wait for agent after giving feedback`);
}
