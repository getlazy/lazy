/**
 * `lazy sync <task>` — merge upstream into a task's worktree.
 *
 * This is a thin CLI command that dispatches to the daemon via RPC.
 * Global remote sync (detect external changes, fetch comments, export
 * branches, refresh PR descriptions) lives in src/daemon/remote-sync.ts and
 * runs automatically in the daemon's reconcile loop.
 */

import { theme } from '../../render/theme';
import { usagePauseOverrideEligibility } from '../human-terminal';

export async function commandSync(args: string[]): Promise<void> {
  const firstArg = args[0];
  if (!firstArg || firstArg.startsWith('-')) {
    console.error('Global sync is now handled automatically by the daemon.');
    console.error('Use: lazy sync <task_id>  — to merge upstream into a specific task');
    console.error('Run: lazy daemon start    — to enable automatic remote sync');
    process.exit(1);
  }

  await commandSyncTask(args);
}

/**
 * `lazy sync <task>` — task-level upstream merge as a standalone operation.
 *
 * Merges the parent/upstream branch into the task's worktree without
 * running an agent work phase. This is the foundation for decoupling
 * sync from unblock.
 */
export async function commandSyncTask(args: string[]): Promise<void> {
  const taskId = args[0];
  if (!taskId) {
    console.error('Usage: lazy sync <task_id>');
    process.exit(1);
  }

  const { querySyncTask } = await import('../../daemon/rpc-fallback');
  const { createPhaseDisplay } = await import('../phase-display');

  // A sync fetches, and may build a container image before the supervisor can
  // start — minutes in which the command otherwise says nothing at all.
  const display = createPhaseDisplay();
  try {
    const result = await querySyncTask({ taskId, ...(await usagePauseOverrideEligibility()), }, display);
    display.close();

    // Display warnings
    for (const warning of result.warnings) {
      console.error(theme.warning(`Warning: ${warning}`));
    }

    // Display result
    switch (result.status) {
      case 'up_to_date':
        console.log(theme.success(`${result.displayId}: Already up to date.`));
        break;
      case 'sync_launched':
        console.log(theme.success(`${result.displayId}: ${result.message}`));
        break;
      case 'pending_sync':
        console.error(theme.warning(`${result.displayId}: ${result.message}`));
        process.exit(1);
        break;
      default:
        // `merged` / `conflict` are the self-sync route (an agent syncing its own
        // running task), which the CLI cannot reach — printing the daemon's own
        // message is still better than saying nothing if it ever does.
        console.log(`${result.displayId}: ${result.message}`);
        break;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    // Idempotent — the success path closes it before printing the result so the
    // checklist never interleaves with the summary.
    display.close();
  }
}

export function syncUsage(): void {
  console.log(`Usage: lazy sync <task_id>

Reconcile a task's worktree, by task ID, with everything it is behind — in two
steps, each narrated as it happens.

  1. The task's own branch on origin — if a colleague has pushed commits to
     origin/<task-branch>, they are merged into the worktree first. Skipped
     with a one-line reason when the remote driver is "local", when lazy is
     offline, or when the branch is not on origin yet.
  2. The parent/upstream branch — fetched and merged, as before.

  - Conflicts in either step are resolved by the task's own agent
  - Neither step ever touches or pushes the parent branch
  - If the upstream fetch fails, marks the task for retry (pending_sync)
  - Task must be blocked/conflict/submitted/interrupted (not working)
  - A submitted task stays submitted: the merge changes nothing about its
    open PR, so syncing it does not take it out of the review queue

Global remote sync (detecting external changes, fetching comments, pushing
branches, posting turns) is now handled automatically by the daemon. Start
the daemon with: lazy daemon start

Requirements:
  - Task must have a session and worktree
  - A remote driver must be configured for upstream fetch

Examples:
  lazy sync abc12345   # Merge upstream into task abc12345`);
}
