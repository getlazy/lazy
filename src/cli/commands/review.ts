/**
 * `lazy review <task_id>` — TUI-based read-only review of a blocked task.
 *
 * Opens a full-screen two-panel interface showing all task artifacts:
 * response, plan, diff (per-file), comments, proposals, and commits.
 *
 * The human can navigate artifacts and quit. Actions (accept, reject, feedback)
 * should be performed via the CLI after exiting the review TUI.
 */

import { requireLazyRoot, requireStorage, shortId, displayId, parseFlags, resolveTaskOrExit, rejectIfPairing } from '../helpers';
import { runReviewTUI } from '../tui';

export async function commandReview(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'review');

  const taskId = parsed.positional[0];
  if (!taskId) {
    reviewUsage();
    process.exit(1);
  }

  if (!process.stdin.isTTY) {
    console.error('lazy review requires an interactive terminal.');
    process.exit(1);
  }

  const root = requireLazyRoot();

  // Pre-flight checks before entering the TUI
  const { createRunner } = await import('../../runner');
  const runner = createRunner(root);
  try {
    runner.checkAvailability();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const storage = await requireStorage();

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

Read-only TUI review of a task. Opens a full-screen interface showing
all task artifacts in a two-panel layout.

Left panel: navigation tree of artifacts
  - Response (agent's summary/questions)
  - Plan (if agent produced one)
  - Diff (per-file with syntax coloring)
  - Comments (with unseen highlighted)
  - Proposals (pending follow-up suggestions)
  - Commits (with individual diffs)

Right panel: content of the selected artifact

Navigation:
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
  lazy unblock <task_id> --sync-with-upstream  Merge upstream changes

Examples:
  lazy review abc123`);
}
