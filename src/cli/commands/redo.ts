import { shortId, displayId, validateCode, MAX_TASK_CODE_LENGTH } from '../../task/identity';
import { parseFlags, validateModel, resolveTaskOrExit, requireStorage } from '../helpers';
import { commandStart } from './start';
import { queryRedoTask } from '../../daemon/rpc-fallback';
import { getActor } from '../../constants';
import type { Storage } from '../../storage/interface';
import { currentPromptOf } from '../../task-prompt';
import { theme } from '../../render/theme';
import { escapeRegex } from '../../utils/regex';

/**
 * Generate a redo code from the old task's code, scanning existing tasks to avoid collisions.
 * Convention: append -redo-1, -redo-2, etc. Truncate base if needed to fit 80-char limit.
 */
export async function generateRedoCode(oldCode: string, storage: Storage): Promise<string> {
  // Check if old code already has a -redo-N suffix
  const redoMatch = oldCode.match(/^(.+)-redo-(\d+)$/);
  let base: string;

  if (redoMatch) {
    base = redoMatch[1];
  } else {
    base = oldCode;
  }

  // Scan existing tasks to find the highest -redo-N suffix for this base
  const allTasks = await storage.listTasks();
  let maxN = 0;

  const redoPattern = new RegExp(`^${escapeRegex(base)}-redo-(\\d+)$`);
  for (const task of allTasks) {
    if (task.code) {
      const match = task.code.match(redoPattern);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > maxN) {
          maxN = n;
        }
      }
    }
  }

  const nextN = maxN + 1;
  const suffix = `-redo-${nextN}`;

  // Truncate base to fit within max code length limit
  const maxBase = MAX_TASK_CODE_LENGTH - suffix.length;
  let finalBase = base;
  if (base.length > maxBase) {
    finalBase = base.substring(0, maxBase);
    // Remove trailing hyphen from truncation
    finalBase = finalBase.replace(/-$/, '');
  }

  const code = finalBase + suffix;
  // Validate the generated code — if it's invalid, skip setting code
  if (validateCode(code) !== null) {
    return '';
  }
  return code;
}

export async function commandRedo(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'prompt', takesValue: true },
    { name: 'model', takesValue: true },
    { name: 'no-start', takesValue: false },
    { name: 'yes', takesValue: false },

  ], 'redo');

  const taskId = parsed.positional[0];
  if (!taskId) {
    redoUsage();
    process.exit(1);
  }

  const promptOverride = parsed.flags.get('prompt') as string | undefined;
  const noStart = parsed.flags.get('no-start') === true;
  const yes = parsed.flags.get('yes') === true;

  let modelOverride: string | undefined;
  const modelValue = parsed.flags.get('model') as string | undefined;
  if (modelValue !== undefined) {
    modelOverride = validateModel(modelValue);
  }

  const storage = await requireStorage();

  let newTaskShortId: string;

  try {
    // Resolve old task
    const oldTask = await resolveTaskOrExit(storage, taskId);

    // Validate: can't redo a task that's already complete (merged)
    if (oldTask.status === 'complete') {
      console.error(`Task ${displayId(oldTask)} is already complete (merged). Nothing to redo.`);
      process.exit(1);
    }

    // Validate: redo closes the old task and reruns it. A task that is already
    // closed has nothing to close, and reopening is the operation the user
    // actually wants. Without this guard redo ran on and failed further down
    // with an unrelated message (e.g. "has no prompt").
    if (oldTask.status === 'abandoned') {
      console.error(`Task ${displayId(oldTask)} is already closed. Nothing to redo.`);
      console.error(`To work on it again: lazy reopen ${displayId(oldTask)}`);
      process.exit(1);
    }

    // The old task's CURRENT prompt, via the one resolver: the daemon seeds
    // the replacement with it plus the previous attempt's context, and a
    // `--prompt` override has to replace only the first part.
    const latestPrompt = currentPromptOf(oldTask) ?? '';

    // The redo itself (create the replacement, close the old task,
    // clean up its container and worktree) is the DAEMON's `redoTask` — the
    // same act the browser's redo button performs — never storage calls from
    // here. In a clone bound to Lazy Teams the member's authorization is then
    // the browser's, and there is no local worktree or container to inspect.
    const redone = await queryRedoTask({
      taskId: oldTask.id,
      reason: 'Started over with lazy redo',
      actor: getActor(),
    });

    // Said only now that the daemon has accepted the redo.
    console.log(`Closing task ${theme.taskId(displayId(oldTask))}... done`);

    // Overrides land on the replacement, which is still in the backlog. The
    // redo has ALREADY happened, so a failed follow-up write must not read as a
    // failed redo: say which override did not land and how to apply it, and
    // do not start the task on the wrong prompt or model.
    const display = redone.displayId;
    const failedOverrides: string[] = [];
    let newTask = await storage.getTask(redone.taskId);
    if (!newTask) throw new Error(`The replacement task ${redone.displayId} was created but cannot be read back.`);
    if (promptOverride) {
      try {
        const seeded = currentPromptOf(newTask) ?? '';
        // The daemon seeded `latestPrompt + context`; keep the context.
        const context = seeded.startsWith(latestPrompt) ? seeded.slice(latestPrompt.length) : '';
        await storage.updateTaskPrompt(newTask.id, promptOverride + context);
      } catch (err) {
        failedOverrides.push(`--prompt did not land (${err instanceof Error ? err.message : String(err)}). Apply it with: lazy edit ${redone.displayId} --prompt "<text>"`);
      }
    }
    if (modelOverride) {
      try {
        await storage.updateTaskModel(newTask.id, modelOverride);
        newTask = (await storage.getTask(redone.taskId)) ?? newTask;
      } catch (err) {
        failedOverrides.push(`--model did not land (${err instanceof Error ? err.message : String(err)}). Apply it with: lazy edit ${redone.displayId} --model ${modelOverride}`);
      }
    }
    if (failedOverrides.length > 0) {
      console.error(`Redid ${displayId(oldTask)} as ${display}, but not every override was applied; ${display} is in the backlog and was not started:`);
      for (const line of failedOverrides) console.error(`  ${line}`);
      process.exitCode = 1;
      return;
    }
    const newModel = newTask.model;
    const imagePinWarning = redone.imagePinWarning;

    newTaskShortId = shortId(newTask.id);

    console.log(`Created task ${theme.taskId(displayId(newTask))} — redo of ${displayId(oldTask)}`);
    console.log(`  ${theme.label('Goal:')} ${newTask.goal}`);
    if (newModel) {
      console.log(`  ${theme.label('Model:')} ${newModel}`);
    }
    if (imagePinWarning) {
      console.log(`  ${theme.warning('Warning:')} ${imagePinWarning}`);
    }

  } finally {
    await storage.close();
  }

  // --- Optionally start new task ---
  if (!noStart) {
    const startArgs = [newTaskShortId, '--yes'];
    if (modelOverride) {
      startArgs.push('--model', modelOverride);
    }
    await commandStart(startArgs);
  } else {
    console.log(`\nTask is in backlog. Start it with: ${theme.command('lazy start ' + newTaskShortId)}`);
  }
}

export function redoUsage(): void {
  console.log(`Usage: lazy redo <task_id> [--prompt <text>] [--model <model>] [--no-start] [--yes]

Close a stale task and restart the same work on a fresh branch.

This is useful when a task's branch has fallen too far behind its parent and
merging would be more expensive than redoing the work from scratch. The old
task's history is preserved (closed, not deleted) and the new task links back
to it.

The replacement keeps the old task's PARENT: redoing a task that sits under a
release hub creates the replacement under that same hub, not on main. Only the
base ref is fresh — the branch is cut from that parent's current HEAD when the
task starts. To move the work elsewhere, use --no-start and re-parent the
replacement (lazy reparent <new_task> --parent main) before starting it.

Arguments:
  <task_id>          ID of the task to redo

Options:
  --prompt <text>    Override the prompt for the new task (default: inherit old prompt)
  --model <model>    Override model for the new task (e.g. opus, sonnet, claude-opus-5-5)
  --no-start         Create the new task but don't start it (backlog)
  --yes              Skip confirmation prompt when starting

What gets carried over:
  - Goal (always)
  - Prompt (latest version, unless --prompt overrides)
  - Model (unless --model overrides)
  - Task code (if set, best-effort)
  - Parent task (the replacement is created under the same parent)
  - Context from previous attempt (agent summary + diff stat)

What starts fresh:
  - Git branch (cut from the parent's current HEAD at start time)
  - Session (new agent session)
  - Turn history (only injected as context, not replayed)
  - Container image (root-resolved; warns if the old task had a per-task pin)

Examples:
  lazy redo abc123                        # Redo task, start immediately
  lazy redo abc123 --no-start             # Redo but keep in backlog
  lazy redo abc123 --prompt "Updated requirements"  # Redo with new prompt
  lazy redo fix-auth --model opus                    # Redo with different model`);
}
