/**
 * `lazy sync <task>` — merge upstream into a task's worktree.
 *
 * This is a thin CLI command that dispatches to the daemon via RPC.
 * Global remote sync (detect external changes, fetch comments, export
 * branches, post turns/notes) lives in src/daemon/remote-sync.ts and
 * runs automatically in the daemon's reconcile loop.
 */

import { theme } from '../theme';

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
/**
 * Compute a deterministic signature from a set of CI failures.
 * Used to deduplicate CI failure comments — same signature means same failures.
 */
export function ciFailureSignature(failed: Array<{ name: string; url?: string }>): string {
  return failed
    .map(f => f.url ? `${f.name}|${f.url}` : f.name)
    .sort()
    .join('\n');
}

export async function commandSyncTask(args: string[]): Promise<void> {
  const taskId = args[0];
  if (!taskId) {
    console.error('Usage: lazy sync <task_id>');
    process.exit(1);
  }

  const { querySyncTask } = await import('../../daemon/rpc-fallback');

  try {
    const result = await querySyncTask({ taskId });

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
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export function syncUsage(): void {
  console.log(`Usage: lazy sync <task_id>

Merge upstream changes into a task's worktree by task ID.

  - Fetches the parent/upstream branch
  - If upstream has changes, launches a sync-only merge (no agent work)
  - If fetch fails, marks the task for retry (pending_sync)
  - Task must be blocked/conflict/interrupted (not working)

Global remote sync (detecting external changes, fetching comments, pushing
branches, posting turns) is now handled automatically by the daemon. Start
the daemon with: lazy daemon start

Requirements:
  - Task must have a session and worktree
  - A remote driver must be configured for upstream fetch

Examples:
  lazy sync abc12345   # Merge upstream into task abc12345`);
}
