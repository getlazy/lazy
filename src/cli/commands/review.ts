/**
 * `lazy review <task_id>` — TUI-based read-only review.
 *
 * Default: full-screen two-panel browser (response, plan, diff, comments, ...).
 *
 * With `-i` (--interactive): hunk-by-hunk review with inline Q&A against the
 * agent's session and per-hunk feedback persisted as comments.
 */

import { requireLazyRoot, requireStorage, shortId, displayId, parseFlags, resolveTaskOrExit, rejectIfPairing } from '../helpers';
import { runReviewTUI } from '../tui';
import { runInteractiveReview } from '../tui/per-hunk-review';

export async function commandReview(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'interactive', aliases: ['i'], takesValue: false },
    { name: 'stub-agent', takesValue: false },
  ], 'review');

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

  const interactive = parsed.flags.get('interactive') === true;
  const stubAgent = parsed.flags.get('stub-agent') === true;

  try {
    const task = await resolveTaskOrExit(storage, taskId);
    const sess = await storage.getSessionByTaskId(task.id);

    rejectIfPairing(root, shortId(task.id), displayId(task));

    if (interactive) {
      if (!sess) {
        console.error(`Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`);
        process.exit(1);
      }
      await runInteractiveReview(storage, task, sess, root, { stubAgent });
      await storage.close();
      return;
    }

    // Default full-screen review — pre-flight: runner availability.
    const { createRunner } = await import('../../runner');
    const runner = await createRunner(root);
    try {
      await runner.checkAvailability();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    await runReviewTUI(storage, task, sess ?? null, root);
    await storage.close();
  } catch (err) {
    try { await storage.close(); } catch { /* ignore */ }
    throw err;
  }
}

export function reviewUsage(): void {
  console.log(`Usage: lazy review <task_id> [-i]

Review a task. Default mode opens a full-screen two-panel browser
of the task's artifacts (response, plan, diff, comments, commits).

Options:
  -i, --interactive   Hunk-by-hunk interactive review:
                        o  mark hunk reviewed, next
                        n  next hunk
                        p  previous hunk
                        s  split this hunk at a context line
                        a  ask the agent a question about this hunk
                            (resumes the agent's session, read-only)
                        f  leave feedback on this hunk (saved as a comment)
                        q  quit (prompts to submit feedback as unblock)

Full-screen mode navigation:
  Tab          Switch between left and right panels
  ↑/↓          Navigate items (left) or scroll (right)
  Enter        Select/expand item
  ←/→          Collapse/expand or switch panels
  t            Toggle task tree (if subtasks exist)
  q / Ctrl+C   Quit

Actions (use CLI after exiting review):
  lazy unblock <task_id>                 Give feedback
  lazy accept <task_id>                  Accept the task
  lazy close <task_id>                   Close the task (no session needed)
  lazy reject <task_id>                  Reject the task (closes PR with reject review)
  lazy sync <task_id>                    Merge upstream changes

Examples:
  lazy review abc123          Full-screen review
  lazy review -i abc123       Hunk-by-hunk interactive review`);
}
