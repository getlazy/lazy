import { requireStorage, displayId, parseFlags, resolveTaskOrExit } from '../helpers';
import { promptLine, isTTY, readStdinIfPiped } from '../editor';
import { queryStopTask } from '../../daemon/rpc-fallback';
import { theme } from '../theme';

const DEFAULT_STOP_REASON = 'Stopping to change direction';

export async function commandStop(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'yes', aliases: ['y'], takesValue: false },
    { name: 'reason', takesValue: true },
  ], 'stop');

  const taskId = parsed.positional[0];
  if (!taskId) {
    stopUsage();
    process.exit(1);
  }

  const skipPrompt = parsed.flags.get('yes') === true;
  const reasonFromFlag = parsed.flags.get('reason') as string | undefined;

  // Pre-flight: verify the task exists and is running BEFORE asking for a reason.
  // Per CLAUDE.md "Save first, act second" — we should never ask the user to
  // type feedback only to throw it away because the task wasn't stoppable.
  let taskDisplayId = taskId;
  {
    const storage = await requireStorage();
    try {
      const task = await resolveTaskOrExit(storage, taskId);
      taskDisplayId = displayId(task);

      if (task.status !== 'working') {
        console.error(
          `Task ${taskDisplayId} is ${task.status}, not working. ` +
          `Only running tasks can be stopped.`,
        );
        if (task.status === 'interrupted' || task.status === 'blocked' || task.status === 'conflict' || task.status === 'submitted') {
          console.error(`  To give feedback: lazy unblock ${taskDisplayId}`);
          console.error(`  To close:         lazy close ${taskDisplayId} --reason "..."`);
        } else {
          console.error(`  To close: lazy close ${taskDisplayId} --reason "..."`);
        }
        process.exit(1);
      }
    } finally {
      await storage.close();
    }
  }

  // Resolve the reason. Priority: --reason flag > piped stdin > interactive prompt > default.
  let reason: string;
  if (reasonFromFlag !== undefined) {
    reason = reasonFromFlag.trim();
    if (!reason) {
      console.error('Empty --reason. Provide a non-empty reason or omit the flag to use the default.');
      process.exit(1);
    }
  } else {
    const piped = await readStdinIfPiped();
    if (piped !== null && piped.trim()) {
      reason = piped.trim();
    } else if (skipPrompt || !isTTY()) {
      // --yes or non-interactive: use the default silently.
      reason = DEFAULT_STOP_REASON;
    } else {
      const answer = await promptLine(`Reason for stopping ${taskDisplayId}`, DEFAULT_STOP_REASON);
      reason = (answer || DEFAULT_STOP_REASON).trim();
      if (!reason) reason = DEFAULT_STOP_REASON;
    }
  }

  try {
    const result = await queryStopTask({ taskId, reason });
    console.log(`\nTask ${theme.taskId(result.displayId)} stopped.`);
    console.log(`  Reason: ${result.reason}`);
    console.log(`  Status: blocked (will not auto-resume)`);
    console.log(`\nTo continue: ${theme.command('lazy unblock ' + result.displayId)}`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function stopUsage(): void {
  console.log(`Usage: lazy stop <task_id> [--reason "..."] [--yes]

Halt a running task without auto-resume. Records a human turn note and sets
the user-stopped flag so the reconciler will NOT auto-resume the task.

Arguments:
  <task_id>    ID or code of the task to stop (must be in 'working' status)

Options:
  --reason "..."  Reason for stopping (default: "${DEFAULT_STOP_REASON}")
  --yes, -y       Skip the interactive reason prompt and use the default

Reason input priority: --reason flag > piped stdin > interactive prompt > default.

Notes:
  - Only running ('working') tasks can be stopped. For other statuses, use
    \`lazy close\` or \`lazy unblock\` as appropriate.
  - The task transitions to 'blocked' (with a user-stopped gate). Unlike a
    crash, the reconciler will NOT auto-resume — a manual \`lazy unblock\` is
    required to continue.
  - \`lazy unblock\` (with or without --message) re-arms auto-resume.

Examples:
  lazy stop abc12345
  lazy stop abc12345 --reason "Wrong approach, will redirect"
  lazy stop abc12345 --yes
  echo "Need to redirect" | lazy stop abc12345`);
}
