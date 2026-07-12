import { join } from 'path';
import { parseFlags, requireLazyRoot } from '../helpers';
import { querySubmitTask } from '../../daemon/rpc-fallback';
import { isOfflineMode } from '../../utils/offline';
import { loadConfig } from '../../config/loader';
import { theme } from '../theme';

export async function commandSubmit(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'yes', aliases: ['y'], takesValue: false },
  ], 'submit');

  const taskId = parsed.positional[0];
  if (!taskId) {
    submitUsage();
    process.exit(1);
  }

  // Early offline check — submit requires remote operations (PR creation),
  // so fail fast before attempting the daemon RPC call.
  const root = requireLazyRoot();
  const config = await loadConfig(root);
  if (await isOfflineMode(join(root, '.lazy'), config.remote.offline)) {
    console.error('Error: Cannot submit while in offline mode. Run `lazy system online` to restore remote operations, then retry.');
    process.exit(1);
  }

  try {
    const result = await querySubmitTask({ taskId });

    // Print warnings
    for (const w of result.warnings) {
      console.log(w);
    }

    if (result.prUrl) {
      console.log(theme.success(`\nTask ${theme.taskId(result.displayId)} submitted for review.`));
      console.log(`  ${theme.label('PR:')} ${result.prUrl}`);
    } else {
      console.log(theme.success(`\nTask ${theme.taskId(result.displayId)} submitted for review.`));
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function submitUsage(): void {
  console.log(`Usage: lazy submit <task_id>

Submit a task for review by creating or updating a pull request.

Arguments:
  <task_id>    ID of the task to submit

Behavior:
  - Pushes the task branch to the remote
  - Creates a PR (or updates an existing one) and marks it ready for review
  - Transitions the task from blocked/conflict to submitted
  - Only submitted tasks receive PR comment auto-react (review feedback)

Pre-conditions:
  - Task must be in blocked or conflict status
  - Task must have at least one commit (non-empty diff)
  - A remote driver must be configured (e.g., [remote] driver = "github" in lazy.toml)

Notes:
  - Until submit, the branch is pushed by daemon auto-push and CI runs,
    but there is no PR and no review comments
  - Use 'lazy accept <task_id>' to merge after review
  - Use 'lazy unblock <task_id>' to send feedback and return to working

Examples:
  lazy submit abc12345          # Submit task for review
  lazy submit fix-auth          # Submit by task code`);
}
