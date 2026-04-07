/**
 * `lazy review <task_id>` — TUI-based read-only review.
 *
 * Opens a full-screen two-panel interface showing all task artifacts
 * (response, plan, diff, comments, proposals, commits).
 *
 * Actions (accept, reject, feedback) should be performed via the CLI
 * after exiting the review TUI.
 */

import { requireLazyRoot, requireStorage, shortId, displayId, parseFlags, resolveTaskOrExit, rejectIfPairing } from '../helpers';
import { runReviewTUI } from '../tui';

export async function commandReview(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'review');

  if (!process.stdin.isTTY) {
    console.error('lazy review requires an interactive terminal.');
    process.exit(1);
  }

  const root = requireLazyRoot();
  const storage = await requireStorage();

  const taskId = parsed.positional[0];

  if (!taskId) {
    reviewUsage();
    process.exit(1);
  }

  // Single-task review mode
  // Pre-flight checks before entering the TUI
  const { createRunner } = await import('../../runner');
  const runner = await createRunner(root);
  try {
    runner.checkAvailability();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  try {
    const task = await resolveTaskOrExit(storage, taskId);

    // Review is read-only — allow reviewing any task regardless of status
    const sess = await storage.getSessionByTaskId(task.id);

    rejectIfPairing(root, shortId(task.id), displayId(task));

    // Run the TUI (session may be null for tasks that haven't started)
    await runReviewTUI(storage, task, sess ?? null, root);

    // Close storage
    await storage.close();
  } catch (err) {
    // Make sure we clean up the terminal even on error
    try { await storage.close(); } catch { /* ignore */ }
    throw err;
  }
}

export function reviewUsage(): void {
  console.log(`Usage: lazy review <task_id>

Opens a full-screen two-panel review of the specified task.

Left panel: navigation tree of artifacts
  - Response (agent's summary/questions)
  - Plan (if agent produced one)
  - Diff (per-file with syntax coloring)
  - Comments (with unseen highlighted)
  - Proposals (pending follow-up suggestions)
  - Commits (with individual diffs)

Right panel: content of the selected artifact

Review navigation:
  Tab          Switch between left and right panels
  ↑/↓          Navigate items (left) or scroll (right)
  Enter        Select/expand item
  ←/→          Collapse/expand or switch panels
  t            Toggle task tree (if subtasks exist)
  q / Ctrl+C   Quit

Actions (use CLI after exiting review):
  lazy unblock <task_id>                 Give feedback
  lazy accept <task_id>                  Accept the task
  lazy reject <task_id>                  Reject the task
  lazy sync <task_id>                    Merge upstream changes

Example:
  lazy review abc123       Review specific task`);
}
