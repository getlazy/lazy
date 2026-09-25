/**
 * `lazy review <task_id>` — run an agent review of the task's work.
 *
 * Thin CLI over the daemon's `reviewTask` RPC (`launchReviewTask`): a
 * read-only turn in a NEW agent session (never `--resume` the implementer)
 * that reports structured findings. The task's prior status is restored
 * when the turn completes.
 *
 * The former TUI browser lives at `lazy browse`.
 */

import { requireStorage, parseFlags, resolveTaskOrExit } from '../helpers';
import { displayId } from '../../task/identity';
import { promptYesNo, isTTY } from '../editor';
import { theme, dim } from '../../render/theme';
import { writeStdoutLine } from '../../utils/stdio';
import { VALID_EFFORT_LEVELS, type EffortLevel } from '../../config/types';
import { formatReviewReport } from '../../review/parse-report';
import { usagePauseOverrideEligibility } from '../human-terminal';

function unwrapRpcMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = raw.match(/^RPC \w+ failed: \d{3}\s+([\s\S]+)$/);
  return match ? match[1].trim() : raw;
}

export async function commandReview(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'yes', takesValue: false },
    { name: 'post', takesValue: false },
    { name: 'no-wait', takesValue: false },
    { name: 'model', takesValue: true },
    { name: 'effort', takesValue: true },
  ], 'review');

  const yes = parsed.flags.get('yes') === true;
  const noWait = parsed.flags.get('no-wait') === true;
  const modelOverride = parsed.flags.get('model') as string | undefined;
  const effortValue = parsed.flags.get('effort') as string | undefined;
  let effortOverride: EffortLevel | undefined;
  if (effortValue !== undefined) {
    if (!VALID_EFFORT_LEVELS.includes(effortValue as EffortLevel)) {
      console.error(`Invalid effort '${effortValue}'. Must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`);
      process.exit(1);
    }
    effortOverride = effortValue as EffortLevel;
  }

  const taskId = parsed.positional[0];
  if (!taskId) {
    reviewUsage();
    process.exit(1);
  }

  if (parsed.flags.get('post') === true) {
    // Kept registered so existing scripts do not die on an unknown flag. Lazy
    // no longer writes reviews to a forge at all (engineer decision,
    // 2026-09-21), so there is nothing for it to turn on.
    // stderr, like every other advisory here: the flag exists only so old
    // scripts keep working, and its notice must not land in piped output.
    console.error(
      `Note: ${theme.command('--post')} no longer does anything — lazy does not post reviews ` +
      `to pull or merge requests. The report lands on the task; read it with ` +
      `${theme.command('lazy show <task>')}.\n`,
    );
  }

  const storage = await requireStorage();
  try {
    const task = await resolveTaskOrExit(storage, taskId);

    if (!yes && isTTY()) {
      console.log(`Task: ${displayId(task)}`);
      console.log(`Goal: ${task.goal}`);
      console.log('');
      const confirmed = await promptYesNo('Run an agent review of this task?', false);
      if (!confirmed) {
        console.log('Review cancelled.');
        process.exit(0);
      }
    }

    console.error(dim(
      noWait
        ? `Starting a review of ${displayId(task)} (read-only, new session)…`
        : `Reviewing ${displayId(task)} (read-only, new session) — this may take a few minutes…`,
    ));

    const { queryReviewTask, queryReviewTaskAwaited } = await import('../../daemon/rpc-fallback');
    const { createPhaseDisplay } = await import('../phase-display');
    const display = createPhaseDisplay({ stream: 'stderr' });

    // --no-wait exposes what the daemon does anyway: start the reviewer and
    // return. The report still lands as a review turn on the task, so this is
    // "do not sit here", not "do not review".
    if (noWait) {
      try {
        const started = await queryReviewTask({
          taskId: task.id, modelOverride, effortOverride,
          ...(await usagePauseOverrideEligibility()),
        }, display);
        display.close();
        await writeStdoutLine(
          `Review started for ${started.displayId}. It has no time limit.\n` +
          `  Wait for it:  lazy wait ${started.displayId}\n` +
          `  Read it:      lazy show ${started.displayId}\n` +
          `  End it:       lazy stop ${started.displayId} --reason "..."`,
        );
      } catch (err) {
        display.close();
        console.error(unwrapRpcMessage(err));
        process.exit(1);
      }
      return;
    }
    let result;
    try {
      result = await queryReviewTaskAwaited({
        taskId: task.id,
        modelOverride,
        effortOverride,
        ...(await usagePauseOverrideEligibility()),
      }, display);
      display.close();
    } catch (err) {
      display.close();
      console.error(unwrapRpcMessage(err));
      process.exit(1);
    }

    for (const warning of result.warnings ?? []) {
      console.error(theme.warning(`Warning: ${warning}`));
    }
    await writeStdoutLine(formatReviewReport(result.report));
  } finally {
    await storage.close();
  }
}

export function reviewUsage(): void {
  console.log(`Usage: lazy review <task_id> [--yes] [--no-wait] [--model <model>] [--effort <level>]

Run an agent review of a task's work. The reviewer starts a new session
in the task's container (it does not resume the implementer's conversation),
sweeps the branch for security and data-integrity issues first, then
correctness / tests / incomplete work / style, and prints a structured
report. The task's status is restored afterwards (submitted stays submitted).
Finished tasks (complete / abandoned) are refused.

A review has no time limit. This command waits for it and prints the report;
interrupting the command leaves the review running and its report still lands
as a review turn on the task. Use --no-wait to start one without waiting, and
\`lazy stop <task>\` to end one you no longer want.

The report lands on the task and nowhere else: lazy does not post reviews
to a pull or merge request. Read it with \`lazy show <task>\`, on the web
review page, or here when this command waits for it.

The former TUI artifact browser is now \`lazy browse\`.

Options:
  --yes              Skip the "run a review?" confirmation
  --post             Deprecated no-op — lazy does not post reviews to a PR/MR
  --no-wait          Start the review and return; read the report later with lazy show
  --model <model>    Model for this review only (not written back to the task)
  --effort <level>   Reasoning effort for this review only (low, medium, high, xhigh, max)

Examples:
  lazy review abc123
  lazy review abc123 --yes --effort max`);
}
