import { requireLazyRoot, requireStorage, shortId, displayId, parseFlags, validateModel, validateCode, resolveTaskOrExit, displayIdFor, MAX_TASK_CODE_LENGTH } from '../helpers';
import { logger } from '../../utils/logger';
import type { ModelName } from '../../types';
import { theme } from '../theme';

const TERMINAL_STATUSES = ['complete', 'abandoned', 'closed'];

/**
 * Generate a clone code from the old task's code.
 * Convention: append -clone-1, -clone-2, etc. Truncate base if needed to fit max code length limit.
 */
function generateCloneCode(oldCode: string): string {
  // Check if old code already has a -clone-N suffix
  const cloneMatch = oldCode.match(/^(.+)-clone-(\d+)$/);
  let base: string;
  let n: number;
  if (cloneMatch) {
    base = cloneMatch[1];
    n = parseInt(cloneMatch[2], 10) + 1;
  } else {
    base = oldCode;
    n = 1;
  }

  const suffix = `-clone-${n}`;
  // Truncate base to fit within max code length limit
  const maxBase = MAX_TASK_CODE_LENGTH - suffix.length;
  if (base.length > maxBase) {
    base = base.substring(0, maxBase);
    // Remove trailing hyphen from truncation
    base = base.replace(/-$/, '');
  }

  const code = base + suffix;
  // Validate the generated code — if it's invalid, skip setting code
  if (validateCode(code) !== null) {
    return '';
  }
  return code;
}

export async function commandClone(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'parent', takesValue: true },
    { name: 'default-parent', takesValue: false },
    { name: 'code', takesValue: true },
    { name: 'model', takesValue: true },
  ], 'clone');

  const taskId = parsed.positional[0];
  if (!taskId) {
    cloneUsage();
    process.exit(1);
  }

  const parentValue = parsed.flags.get('parent') as string | undefined;
  const defaultParent = parsed.flags.get('default-parent') as boolean;
  const codeValue = parsed.flags.get('code') as string | undefined;
  const modelValue = parsed.flags.get('model') as string | undefined;

  // Check for conflicting flags
  if (parentValue !== undefined && defaultParent) {
    console.error('Error: Cannot use both --parent and --default-parent flags');
    process.exit(1);
  }

  // Validate --code flag if provided
  if (codeValue !== undefined) {
    const codeError = validateCode(codeValue);
    if (codeError) {
      console.error(`Invalid code '${codeValue}': ${codeError}`);
      process.exit(1);
    }
  }

  // Validate --model flag if provided
  let modelOverride: ModelName | undefined;
  if (modelValue !== undefined) {
    modelOverride = validateModel(modelValue);
  }

  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    // Resolve source task
    const sourceTask = await resolveTaskOrExit(storage, taskId);

    // Get the latest prompt version
    const promptHistory = await storage.getPromptHistory(sourceTask.id);
    const latestPrompt = promptHistory.length > 0
      ? promptHistory[promptHistory.length - 1].content
      : sourceTask.prompt;

    // Resolve and validate parent
    let newParentTaskId: string | undefined;
    if (parentValue !== undefined) {
      // Explicit --parent flag: use the specified parent
      const parentTask = await resolveTaskOrExit(storage, parentValue);
      if (TERMINAL_STATUSES.includes(parentTask.status)) {
        console.error(`Cannot use task ${displayId(parentTask)} as parent: task is ${parentTask.status}`);
        process.exit(1);
      }
      newParentTaskId = parentTask.id;
    } else if (defaultParent) {
      // --default-parent flag: use default parent (null, root task)
      newParentTaskId = undefined;
    } else {
      // No flags: inherit parent from source task (default behavior)
      newParentTaskId = sourceTask.parent_task_id ?? undefined;
    }

    // Determine code: explicit > auto-generated > none
    let cloneCode: string | undefined = codeValue;
    if (!cloneCode && sourceTask.code) {
      cloneCode = generateCloneCode(sourceTask.code);
    }

    // Create cloned task
    const clonedTask = await storage.createTask(
      sourceTask.goal,
      newParentTaskId,
      undefined,
      cloneCode,
      sourceTask.type
    );

    // Set prompt
    await storage.updateTaskPrompt(clonedTask.id, latestPrompt);

    // Set model: CLI override > source task model
    const finalModel = modelOverride ?? sourceTask.model;
    if (finalModel) {
      await storage.updateTaskModel(clonedTask.id, finalModel);
    }

    // Set cloned_from metadata to link back to source task
    await storage.updateTaskMetadata(clonedTask.id, 'cloned_from', sourceTask.id);

    console.log(`Created task ${theme.taskId(displayId(clonedTask))} — clone of ${displayId(sourceTask)}`);
    console.log(`  ${theme.label('Goal:')} ${clonedTask.goal}`);
    if (clonedTask.code) {
      console.log(`  ${theme.label('Code:')} ${clonedTask.code}`);
    }
    if (newParentTaskId) {
      console.log(`  ${theme.label('Parent:')} ${await displayIdFor(storage, newParentTaskId)}`);
    }
    if (finalModel) {
      console.log(`  ${theme.label('Model:')} ${finalModel}`);
    }
    if (clonedTask.type !== 'task') {
      console.log(`  ${theme.label('Type:')} ${clonedTask.type}`);
    }

    console.log(`\nTask is in backlog. Start it with: ${theme.command('lazy start ' + shortId(clonedTask.id))}`);

  } finally {
    await storage.close();
  }
}

export function cloneUsage(): void {
  console.log(`Usage: lazy clone <task_id> [--parent <task_id> | --default-parent] [--code <code>] [--model <model>]

Duplicate a task with the same goal, prompt, model, and type. Creates a fresh task
in the backlog with no session history. By default, inherits the source task's parent.

Arguments:
  <task_id>          ID of the task to clone

Options:
  --parent <task_id> Set a new parent for the cloned task
  --default-parent   Use default parent (null, root task) instead of inheriting from source
                     (conflicts with --parent)
  --code <code>      Set a custom code for the cloned task (default: auto-generated)
  --model <model>    Override model for the cloned task (apprentice, journeyman, master, sonnet, opus, haiku)
                     Default: inherit from source task

What gets carried over:
  - Goal (always)
  - Prompt (latest version)
  - Model (unless --model overrides)
  - Task type (task, fix, spike, etc.)
  - Code (auto-suffixed with -clone-N, or explicit via --code)

What starts fresh:
  - No session, no turns, no commits
  - New git branch from parent's HEAD (or main if no parent)
  - Status: backlog
  - Metadata: cloned_from=<source_task_id> recorded

What does NOT carry over:
  - Session history, turns, comments
  - Container state

Examples:
  lazy clone abc123                           # Clone, inheriting source task's parent
  lazy clone abc123 --default-parent          # Clone as root task (no parent)
  lazy clone abc123 --parent def456           # Clone under a specific parent
  lazy clone abc123 --code my-new-code        # Clone with explicit code
  lazy clone abc123 --model opus              # Clone with different model
  lazy clone fix-auth --parent main-task      # Reparent a task

After cloning:
  lazy start <cloned_task_id>                 # Start working on the clone`);
}
