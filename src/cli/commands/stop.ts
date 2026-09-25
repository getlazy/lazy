import { requireStorage, parseFlags, resolveTaskOrExit } from '../helpers';
import { requireActorIdentity } from '../identity-preflight';
import { displayId } from '../../task/identity';
import { promptLine, isTTY, readStdinIfPiped } from '../editor';
import { queryStopTask } from '../../daemon/rpc-fallback';
import { stoppableClaimOf } from '../../daemon/in-flight-turn';
import { createPhaseDisplay } from '../phase-display';
import { theme } from '../../render/theme';

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

  // Before the stop reason is typed: the daemon refuses a write it cannot
  // attribute, and a refusal must never cost the human what they wrote.
  await requireActorIdentity();

  const skipPrompt = parsed.flags.get('yes') === true;
  const reasonFromFlag = parsed.flags.get('reason') as string | undefined;

  // Pre-flight: verify the task exists and is running BEFORE asking for a reason.
  // Per CLAUDE.md "Save first, act second" — we should never ask the user to
  // type feedback only to throw it away because the task wasn't stoppable.
  let taskDisplayId = taskId;
  let claimOwner: 'ask' | 'review' | null = null;
  {
    const storage = await requireStorage();
    try {
      const task = await resolveTaskOrExit(storage, taskId);
      taskDisplayId = displayId(task);
      claimOwner = stoppableClaimOf(task)?.owner as 'ask' | 'review' | undefined ?? null;

      // THE CLAIM OUTRANKS THE STATUS — the same rule the daemon routes on, read
      // from its own module rather than restated here. A live ask/review claim
      // on a task whose status says `blocked` means a turn is running, or died
      // and left its record behind, and opening that disagreement is exactly
      // what an operator needs this verb for. While this pre-flight kept its own
      // `status !== 'working'` copy, the daemon's claim route was unreachable
      // from the CLI and the wedge still answered "blocked, not working".
      if (task.status !== 'working' && !claimOwner) {
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
    const display = createPhaseDisplay();
    let result;
    try {
      result = await queryStopTask({ taskId, reason }, display);
    } finally {
      display.close();
    }
    // WHICH ENDING RAN IS THE DAEMON'S ANSWER, not ours to re-derive: the
    // pre-flight snapshot above was taken before the reason prompt, which a
    // person can sit on for minutes, so a claim that settled in that window
    // would have had us announcing "the task itself was not stopped" about a
    // task just stopped with auto-resume disabled. The snapshot is the fallback
    // only for a daemon too old to send the field.
    const endedClaim = result.ended ? result.ended === 'claim' : claimOwner !== null;
    if (endedClaim) {
      // A stopped ask/review is a VISITOR being shown out: the status it found
      // is restored, the user-stopped gate is never set, and the task needs no
      // unblock to be usable. Saying "blocked (will not auto-resume)" here — the
      // work-turn ending — would describe a task lazy did not leave behind.
      console.log(`\n${claimOwner === 'ask' ? 'Ask' : 'Review'} on ${theme.taskId(result.displayId)} stopped.`);
      console.log(`  Reason: ${result.reason}`);
      console.log(`  Status: restored to what the ${claimOwner ?? 'review'} found (the task itself was not stopped)`);
    } else {
      console.log(`\nTask ${theme.taskId(result.displayId)} stopped.`);
      console.log(`  Reason: ${result.reason}`);
      console.log(`  Status: blocked (will not auto-resume)`);
      console.log(`\nTo continue: ${theme.command('lazy unblock ' + result.displayId)}`);
    }
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
  <task_id>    ID or code of the task to stop (running, or carrying a
               review/ask that is still running on it)

Options:
  --reason "..."  Reason for stopping (default: "${DEFAULT_STOP_REASON}")
  --yes, -y       Skip the interactive reason prompt and use the default

Reason input priority: --reason flag > piped stdin > interactive prompt > default.

Notes:
  - Running ('working') tasks can be stopped. So can a task carrying a
    \`lazy review\` or \`lazy ask\` that is still running on it, whatever its
    status reads — that ends the review or ask only, and restores the status it
    found. For anything else, use \`lazy close\` or \`lazy unblock\`.
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
