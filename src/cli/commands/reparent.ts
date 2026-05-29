/**
 * `lazy reparent <task> --parent <new-parent>` — repoint a task to a new
 * parent and merge that parent into the task's branch.
 *
 * Reparent does NOT create a new task or discard history. It keeps the task —
 * same session, same turns, same commits, same branch — and only changes its
 * parent pointer (and therefore its sync/accept/diff base). It then reuses the
 * existing `lazy sync` machinery so the task's own agent merges the new parent
 * into its branch and resolves any conflicts in place.
 */

import { parseFlags } from '../helpers';
import { isTTY, promptYesNo } from '../editor';
import { theme } from '../theme';

export async function commandReparent(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'parent', takesValue: true },
    { name: 'yes', takesValue: false },
  ], 'reparent');

  const taskId = parsed.positional[0];
  if (!taskId) {
    reparentUsage();
    process.exit(1);
  }

  const parent = parsed.flags.get('parent') as string | undefined;
  if (!parent) {
    console.error('Error: --parent <new-parent> is required.');
    reparentUsage();
    process.exit(1);
  }

  const yes = parsed.flags.get('yes') === true;

  // Confirmation (skipped with --yes for non-interactive/MCP/scripted use).
  if (!yes) {
    if (!isTTY()) {
      console.error('Reparent requires confirmation. Re-run with --yes for non-interactive use.');
      process.exit(1);
    }
    const ok = await promptYesNo(
      `Reparent ${taskId} onto ${parent}? This repoints the task and merges ${parent} into its branch.`,
      false,
    );
    if (!ok) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  const { queryReparentTask } = await import('../../daemon/rpc-fallback');

  try {
    const result = await queryReparentTask({ taskId, parent });

    for (const warning of result.warnings) {
      console.error(theme.warning(`Warning: ${warning}`));
    }

    switch (result.status) {
      case 'noop':
        console.log(theme.success(`${result.displayId}: ${result.message}`));
        break;
      case 'reparented_no_sync':
        console.log(theme.success(`${result.displayId}: ${result.message}`));
        break;
      case 'reparented':
        if (result.syncStatus === 'pending_sync') {
          console.error(theme.warning(`${result.displayId}: ${result.message}`));
          process.exit(1);
        }
        console.log(theme.success(`${result.displayId}: ${result.message}`));
        break;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export function reparentUsage(): void {
  console.log(`Usage: lazy reparent <task_id> --parent <new-parent> [--yes]

Repoint a task to a new parent and merge that parent into the task's branch.

Use this when a task was created on the wrong parent (e.g. branched from main
when it should have been on a release branch). Reparent keeps the task — same
session, same turns, same commits, same branch — and only changes its parent.
It then runs a sync so the task's own agent merges the new parent in, resolving
any conflicts in place.

Arguments:
  <task_id>          Task code or short ID of the task to reparent

Options:
  --parent <target>  New parent: a task code, short ID, or a raw branch
                     name (e.g. main). Required.
  --yes              Skip the confirmation prompt (for non-interactive use)

Notes:
  - The task must not be currently 'working' (wait or interrupt the agent first)
  - Terminal tasks (complete/abandoned) must be reopened first
  - Child tasks are unaffected — they stay based on this task's branch and pick
    up the new parent's changes the next time they sync
  - If the task is already on the requested parent, this is a no-op

Examples:
  lazy reparent fix-auth --parent release-v016
  lazy reparent abc12345 --parent main --yes`);
}
