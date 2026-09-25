import { join } from 'path';
import { requireActorIdentity } from '../identity-preflight';
import { parseFlags, requireLazyRoot } from '../helpers';
import { querySubmitTask, querySubmitTaskPreflight } from '../../daemon/rpc-fallback';
import { isOfflineMode } from '../../utils/offline';
import { loadConfig } from '../../config/loader';
import { isTTY, promptLine, promptYesNo } from '../editor';
import {
  submitPlainConfirmText,
  submitStrongConfirmText,
  submitConfirmMatches,
} from '../../submit-confirmation';
import { theme } from '../../render/theme';

export async function commandSubmit(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'yes', aliases: ['y'], takesValue: false },
  ], 'submit');

  const taskId = parsed.positional[0];
  if (!taskId) {
    submitUsage();
    process.exit(1);
  }

  // Before the submit confirmation is typed: the daemon refuses a write it cannot
  // attribute, and a refusal must never cost the human what they wrote.
  await requireActorIdentity();

  const yes = parsed.flags.get('yes') === true;

  // Early offline check — submit requires remote operations (PR creation),
  // so fail fast before attempting the daemon RPC call.
  const root = requireLazyRoot();
  const config = await loadConfig(root);
  if (await isOfflineMode(join(root, '.lazy'), config.remote.offline)) {
    console.error('Error: Cannot submit while in offline mode. Run `lazy system online` to restore remote operations, then retry.');
    process.exit(1);
  }

  try {
    // Preflight before any prompt: a refusal must not ask the human to type
    // a branch name and then throw it away.
    const preflight = await querySubmitTaskPreflight({ taskId });
    if (!preflight.canSubmit) {
      console.error(`Error: ${preflight.refusal ?? 'Submit is not available.'}`);
      process.exit(1);
    }

    if (!yes) {
      if (!isTTY()) {
        console.error('Error: Submit requires confirmation. Re-run with --yes to skip the prompt.');
        process.exit(1);
      }
      if (preflight.confirmationTier === 'plain') {
        const ok = await promptYesNo(submitPlainConfirmText(preflight), false);
        if (!ok) {
          console.error('Aborted.');
          process.exit(1);
        }
      } else if (preflight.confirmationTier === 'strong') {
        console.log(submitStrongConfirmText(preflight));
        const typed = await promptLine('Type the target branch or task code');
        if (!submitConfirmMatches(typed, preflight, preflight.taskCode)) {
          console.error('Error: Confirmation did not match. Aborted.');
          process.exit(1);
        }
      }
    }

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
  console.log(`Usage: lazy submit <task_id> [options]

Submit a task for review by creating or updating a pull request.

Arguments:
  <task_id>    ID of the task to submit

Options:
  -y, --yes    Skip the confirmation prompt

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
  - A subtask integrates into its parent task's branch, and lazy never opens
    a PR for it on its own. Submitting one explicitly opens the PR against
    the parent's branch, which must already be on the remote (submit never
    pushes it). Accept still merges locally, then closes the PR
  - An open PR you opened by hand for the task's branch is adopted rather
    than duplicated, as long as it targets the task's target branch
  - Until submit, the branch is pushed by daemon auto-push and CI runs,
    but there is no PR and no review comments. With
    [remote] <driver>_auto_push = false there is no automatic push either,
    and submit is the first thing to publish the branch
  - Use 'lazy accept <task_id>' to merge after review
  - Use 'lazy unblock <task_id>' to send feedback and return to working
  - Protected targets get a yes/no prompt (default No). Unprotected or
    unknown targets require typing the target branch or the task code.
  - --yes skips the prompt; MCP has no equivalent (confirmation_code instead)

Examples:
  lazy submit abc12345          # Submit task for review
  lazy submit fix-auth --yes    # Submit by task code, skip confirmation`);
}
