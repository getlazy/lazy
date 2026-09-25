/**
 * Daemon auto-react — detect actionable external signals and auto-unblock tasks.
 *
 * Runs as part of the daemon reconcile loop. For each submitted task with a
 * remote reference, checks for new PR comments from humans and auto-unblocks.
 *
 * CI failure handling has been moved to the signal system (remote-sync emits
 * ci_result signals → auto-deliver delivers them). This module only handles
 * PR comment auto-react, which requires direct driver interaction for comment
 * fetching and dedup that doesn't fit the signal model.
 *
 * Uses the budget system (auto-react-budget.ts) for rate limiting. Auto-react
 * results are observable via task state and signal delivery.
 *
 * Auto-react NEVER auto-accepts. It only auto-unblocks, giving the agent
 * another turn to address the signal.
 */

import { join } from 'path';
import type { Storage } from '../storage/interface';
import type { Task } from '../types';
import type { ResolvedConfig } from '../config/types';
import type { RepositoryDriver, RemoteComment } from '../remote/driver';
import { createDriver } from '../remote';
import { planForgeImport, applyForgeImport, seenPredicate } from '../remote/imported-comments';
import {
  shouldAutoReact,
  recordAutoReact,
  type AutoReactTrigger,
} from './auto-react-budget';
import { autoUnblockTask } from './auto-deliver';
import { usagePauseHold } from './usage-pause';
import { logger } from '../utils/logger';
// --- Metadata keys for tracking auto-react state ---

/** Metadata key for the last comment ID auto-reacted to. */
const AUTO_REACT_LAST_COMMENT_KEY = 'auto_react_last_comment_id';

// --- Auto-react result ---

export interface AutoReactResult {
  /** Tasks auto-unblocked due to PR comments. */
  commentUnblocked: string[];
  /** Tasks skipped due to budget exhaustion. */
  budgetSkipped: string[];
  /** Errors encountered during auto-react. */
  errors: string[];
}

/**
 * Run auto-react checks for submitted tasks with remote refs in a project.
 *
 * Called from the daemon reconcile loop after reconcileTasks() completes.
 * CI failure handling is done by the signal system (remote-sync → signals → auto-deliver).
 * This function only handles PR comment auto-react for submitted tasks.
 */
export async function runAutoReact(
  storage: Storage,
  projectRoot: string,
  config: ResolvedConfig,
): Promise<AutoReactResult> {
  const result: AutoReactResult = {
    commentUnblocked: [],
    budgetSkipped: [],
    errors: [],
  };

  if (!config.daemon.auto_react_comments) {
    return result;
  }

  let driver: RepositoryDriver;
  try {
    driver = createDriver(config, { storage, lazyRoot: projectRoot });
  } catch {
    // No remote configured — nothing to auto-react to
    return result;
  }

  // Only submitted tasks get PR comment auto-react — submit is the explicit
  // "ready for review" step. CI is handled by the signal system now.
  const allTasks = await storage.listTasks();
  const submittedTasks = allTasks.filter(t => t.status === 'submitted');

  if (submittedTasks.length === 0) {
    return result;
  }

  const dataDir = join(projectRoot, '.lazy');

  // Process tasks concurrently with a sliding window of up to 5.
  // Each task is independent — one failure must not affect others.
  const MAX_CONCURRENCY = 5;

  async function processTask(task: Task): Promise<void> {
    const taskShortId = task.id.substring(0, 8);

    try {
      // Check PR comments — only for submitted tasks with remote refs.
      // INVARIANT: Comment auto-react is gated on submitted status so that
      // pre-submit PR comments (e.g., from CI-only PRs) don't trigger agent work.
      if (driver.hasRemoteRef(task)) {
        const commentResult = await checkPRComments(
          storage, driver, task, config, dataDir, projectRoot,
        );
        if (commentResult === 'unblocked') {
          result.commentUnblocked.push(taskShortId);
        } else if (commentResult === 'budget_exhausted') {
          result.budgetSkipped.push(taskShortId);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Task ${taskShortId}: ${msg}`);
      logger.error(`Auto-react error for task ${taskShortId}: ${msg}`);
    }
  }

  // Sliding window: keep up to MAX_CONCURRENCY promises in flight at once.
  // Each promise removes itself from the set when it settles, so the set
  // always reflects truly in-flight work.
  const inflight = new Set<Promise<void>>();
  for (const task of submittedTasks) {
    const p = processTask(task);
    inflight.add(p);
    p.finally(() => inflight.delete(p));

    if (inflight.size >= MAX_CONCURRENCY) {
      await Promise.race(inflight);
    }
  }

  // Wait for remaining in-flight tasks to complete
  await Promise.allSettled([...inflight]);

  return result;
}

type CheckResult = 'unblocked' | 'budget_exhausted' | 'no_action';

// --- PR comment detection ---

/**
 * Check for new PR comments on a task and auto-unblock if found.
 *
 * Only reacts to comments from humans (not the lazy bot). Tracks the
 * last comment ID that was auto-reacted to for dedup.
 */
async function checkPRComments(
  storage: Storage,
  driver: RepositoryDriver,
  task: Task,
  config: ResolvedConfig,
  dataDir: string,
  projectRoot: string,
): Promise<CheckResult> {
  const taskShortId = task.id.substring(0, 8);

  // Every visible comment, deduped by id below — no timestamp window, for the
  // same reason as syncTaskFromRemote: created_at is when a comment was
  // written, not when it became visible.
  logger.info(`Fetching PR comments for task ${taskShortId}`);
  let comments: RemoteComment[];
  try {
    comments = await driver.syncComments(task);
  } catch (err) {
    logger.error(`Failed to fetch PR comments for task ${taskShortId}: ${err instanceof Error ? err.message : err}`);
    return 'no_action';
  }

  if (comments.length === 0) {
    return 'no_action';
  }

  // Filter out lazy bot comments (imported from lazy)
  const humanComments = comments.filter(c => !driver.isImportedComment(c.body));

  if (humanComments.length === 0) {
    return 'no_action';
  }

  // Newest by created_at, recorded for diagnostics only. It is NOT a "seen
  // everything" shortcut: a late-visible comment sorts before it.
  const latestCommentId = humanComments[humanComments.length - 1].id;

  // Dedup and edit detection by structured identity (src/remote/imported-comments.ts).
  const plan = planForgeImport(
    await storage.getTaskComments(task.id),
    humanComments,
    await seenPredicate(storage, task.id),
  );
  const format = (c: RemoteComment) => driver.formatImportedComment(c, task);

  // What warrants a turn: comments never imported, and edits to comments the
  // agent already saw (they arrive as new revisions). Claims of legacy records
  // and in-place edits of still-queued comments change nothing the agent has
  // yet to receive in a new turn, so they are applied without one.
  const newComments = [...plan.create, ...plan.revise.map(e => e.remote)];

  if (newComments.length === 0) {
    await applyForgeImport(storage, task.id, plan, format, 'system');
    await storage.updateTaskMetadata(task.id, AUTO_REACT_LAST_COMMENT_KEY, latestCommentId);
    return 'no_action';
  }

  logger.info(`${newComments.length} new PR comment(s) for task ${taskShortId}`);

  // [usage_pause]: held BEFORE anything is consumed. Importing the comments or
  // recording the attempt here would make the next tick see nothing new, and
  // the reaction would be lost instead of delayed. Held, the comments stay
  // un-imported on the forge and this path finds them again after the reset.
  const usageHold = await usagePauseHold(projectRoot, storage, task, 'auto-react (PR comment)');
  if (usageHold) {
    logger.info(`Auto-react: PR comment for task ${taskShortId} held by usage pause — ${usageHold}`);
    return 'no_action';
  }

  // Check budget
  const decision = await shouldAutoReact(storage, task.id, 'comment', config, dataDir);
  if (!decision.allowed) {
    logger.info(`Auto-react: PR comment for task ${taskShortId} blocked by budget: ${decision.reason}`);
    return 'budget_exhausted';
  }

  // Store the new comments in storage first (so the agent can see them)
  const outcome = await applyForgeImport(storage, task.id, plan, format, 'system');
  logger.info(`Imported ${outcome.created.length + outcome.revised.length} remote comment(s) for task ${taskShortId}`);

  // Build feedback message from new comments
  const feedback = formatCommentFeedback(newComments);

  // Always record the attempt (budget accounting) — prevents spin loops.
  await recordAutoReact(storage, task.id, 'comment', dataDir);

  // Auto-unblock the task
  const success = await triggerAutoUnblock(storage, task, feedback, 'comment', projectRoot);

  if (success) {
    // Store the latest comment ID so we don't re-trigger
    await storage.updateTaskMetadata(task.id, AUTO_REACT_LAST_COMMENT_KEY, latestCommentId);

    logger.info(`Auto-react: auto-unblocked task ${taskShortId} for ${newComments.length} new PR comment(s)`);

    return 'unblocked';
  }

  return 'no_action';
}

// --- Auto-unblock trigger ---

/**
 * Trigger an auto-unblock by calling autoUnblockTask directly (in-process).
 *
 * Previous implementation spawned `lazy unblock` as a subprocess with
 * LAZY_IS_DAEMON=1, which prevented the subprocess from accessing storage
 * via RPC or direct init — causing "Daemon storage not initialized" errors
 * and a spin loop (failures didn't count toward the budget).
 *
 * Now uses the in-process autoUnblockTask from auto-deliver.ts, which
 * shares the daemon's storage instance and avoids the subprocess issues.
 *
 * Returns true if the unblock was successfully initiated.
 */
async function triggerAutoUnblock(
  storage: Storage,
  task: Task,
  feedback: string,
  trigger: AutoReactTrigger,
  projectRoot: string,
): Promise<boolean> {
  const taskShortId = task.id.substring(0, 8);

  const session = await storage.getSessionByTaskId(task.id);
  if (!session) {
    return false;
  }

  logger.info(`Auto-react: triggering unblock for task ${taskShortId} (trigger: ${trigger})`);

  // Prefix the feedback with an auto-react marker so the agent and
  // human reviewers can distinguish auto-triggered from human feedback.
  const markedFeedback = `[AUTO-REACT: ${trigger.replace('_', ' ')}]\n\n${feedback}`;

  return autoUnblockTask(storage, task, session, projectRoot, markedFeedback, trigger);
}

// --- Feedback formatting ---

/**
 * Format PR comments into feedback for the agent.
 */
function formatCommentFeedback(comments: RemoteComment[]): string {
  const parts: string[] = [
    `New review comment${comments.length === 1 ? '' : 's'} on the PR. Address the feedback:`,
    '',
  ];

  for (const comment of comments) {
    parts.push(`**${comment.author}** commented:`);
    if (comment.path) {
      parts.push(`File: \`${comment.path}\`${comment.line ? ` (line ${comment.line})` : ''}`);
    }
    parts.push('');
    parts.push(comment.body);
    parts.push('');
    parts.push('---');
    parts.push('');
  }

  return parts.join('\n');
}
