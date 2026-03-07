import { requireStorage, shortId, displayId, displayIdFor, parseFlags, validateModel, validateCode, resolveTaskOrExit } from '../helpers';
import { openEditor, promptLine, promptYesNo, removeRecoveryFile, readStdinIfPiped } from '../editor';
import { isTerminalStatus, VALID_TASK_TYPES } from '../../types';
import type { ModelName, Task, TaskType } from '../../types';
import type { Storage } from '../../storage/interface';

/**
 * Check if setting parentId as the parent of taskId would create a cycle.
 * Walks up the ancestry chain from parentId and checks if taskId appears.
 */
async function wouldCreateCycle(storage: Storage, taskId: string, parentId: string): Promise<boolean> {
  let currentId: string | null = parentId;
  while (currentId) {
    if (currentId === taskId) return true;
    const task = await storage.getTask(currentId);
    if (!task) break;
    currentId = task.parent_task_id;
  }
  return false;
}

export async function commandEdit(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'goal', takesValue: true },
    { name: 'prompt', takesValue: true },
    { name: 'model', takesValue: true },
    { name: 'type', takesValue: true },
    { name: 'code', takesValue: true },
    { name: 'parent', takesValue: true },
  ], 'edit');

  const taskId = parsed.positional[0];
  if (!taskId) {
    editUsage();
    process.exit(1);
  }

  const storage = await requireStorage();

  try {
    const t = await resolveTaskOrExit(storage, taskId);

    // Block editing terminal tasks
    if (isTerminalStatus(t.status)) {
      console.error(`Cannot edit task ${displayId(t)}: task is already ${t.status}.`);
      console.error(`Use 'lazy comment ${displayId(t)} --message "..."' to add annotations instead.`);
      process.exit(1);
    }

    // Block editing once an agent has actually worked on the task (has turns).
    // Linked tasks have a session but no turns — those should remain editable.
    const turnCount = await storage.getTurnCountByTaskId(t.id);
    if (turnCount > 0) {
      console.error(`Cannot edit task ${displayId(t)}: task has already been started.`);
      console.error(`Use 'lazy comment ${displayId(t)} --message "..."' to add annotations instead.`);
      process.exit(1);
    }

    const goalValue = parsed.flags.get('goal') as string | undefined;
    const promptValue = parsed.flags.get('prompt') as string | undefined;
    const modelValue = parsed.flags.get('model') as string | undefined;
    const typeValue = parsed.flags.get('type') as string | undefined;
    const codeValue = parsed.flags.get('code') as string | undefined;
    const parentValue = parsed.flags.get('parent') as string | undefined;

    let newGoal: string | null = null;
    let newPrompt: string | null = null;
    let newModel: ModelName | null = null;
    let newType: TaskType | null = null;
    let newCode: string | null | undefined = undefined; // undefined = no change, null = clear, string = new code
    let newParent: string | null | undefined = undefined; // undefined = no change, null = clear, string = new parent ID
    let promptRecoveryPath: string | null = null;

    // Validate model if provided
    if (modelValue !== undefined) {
      newModel = validateModel(modelValue);
    }

    // Validate type if provided
    if (typeValue !== undefined) {
      if (!VALID_TASK_TYPES.includes(typeValue as TaskType)) {
        console.error(`Invalid type '${typeValue}'. Must be one of: ${VALID_TASK_TYPES.join(', ')}`);
        process.exit(1);
      }
      // Warn if trying to change type after prompt was already sent
      if (t.prompt && t.prompt.length > 0) {
        console.warn(`Warning: Changing task type after prompt was set. The agent will receive the prompt crafted for the previous type ('${t.type}').`);
      }
      newType = typeValue as TaskType;
    }

    // Validate code if provided
    if (codeValue !== undefined) {
      if (codeValue === '') {
        newCode = null; // Clear the code
      } else {
        const codeError = validateCode(codeValue);
        if (codeError) {
          console.error(`Invalid code: ${codeError}`);
          process.exit(1);
        }
        newCode = codeValue;
      }
    }

    // Validate parent if provided
    if (parentValue !== undefined) {
      if (parentValue === '') {
        newParent = null; // Clear the parent
      } else {
        const parentTask = await resolveTaskOrExit(storage, parentValue);

        // Cannot set self as parent
        if (parentTask.id === t.id) {
          console.error(`Cannot set task as its own parent`);
          process.exit(1);
        }

        // Parent cannot be in terminal state
        if (isTerminalStatus(parentTask.status)) {
          console.error(`Cannot use task ${displayId(parentTask)} as parent: task is ${parentTask.status}`);
          process.exit(1);
        }

        // Check for circular parent chain
        if (await wouldCreateCycle(storage, t.id, parentTask.id)) {
          console.error(`Cannot set parent: would create a circular parent chain`);
          process.exit(1);
        }

        newParent = parentTask.id;
      }
    }

    // Flag mode
    if (goalValue !== undefined || promptValue !== undefined || newModel !== null || newType !== null || newCode !== undefined || newParent !== undefined) {
      if (goalValue !== undefined) {
        newGoal = goalValue;
      }

      if (promptValue !== undefined) {
        newPrompt = promptValue;
      } else {
        // Try piped stdin as prompt (when other flags are set but --prompt is not)
        const stdinContent = await readStdinIfPiped();
        if (stdinContent !== null) {
          newPrompt = stdinContent;
        }
      }

      // newModel is already set above from validation
    } else {
      // Try piped stdin as prompt when no flags are provided
      const stdinContent = await readStdinIfPiped();
      if (stdinContent !== null) {
        newPrompt = stdinContent;
      } else if (!process.stdin.isTTY) {
        console.error('Interactive mode requires a TTY. Use --goal and --prompt flags instead, or pipe via stdin.');
        process.exit(1);
      } else {
        // Interactive mode
        console.log(`Editing task ${displayId(t)}\n`);
        console.log(`Goal: ${t.goal}`);
        if (t.prompt) {
          const previewLen = Math.min(200, t.prompt.length);
          const preview = t.prompt.substring(0, previewLen).replace(/\n/g, '\\n');
          console.log(`Prompt: ${preview}${t.prompt.length > previewLen ? '...' : ''}`);
        } else {
          console.log(`Prompt: (none)`);
        }
        console.log();

        const goalInput = await promptLine('New goal (press Enter to keep current)', t.goal);
        if (goalInput !== t.goal) {
          newGoal = goalInput;
        }

        const editPrompt = await promptYesNo('Edit prompt in $EDITOR?', false);
        if (editPrompt) {
          const currentPrompt = t.prompt || '';
          const editResult = await openEditor(currentPrompt, `edit-${shortId(t.id)}`);
          if (editResult !== null && editResult.content.trim() !== currentPrompt) {
            newPrompt = editResult.content.trim();
            promptRecoveryPath = editResult.recoveryPath;
          } else if (editResult !== null && editResult.recoveryPath) {
            // No changes — clean up recovery file
            removeRecoveryFile(editResult.recoveryPath);
          }
        }
      }
    }

    // Apply changes
    let updated = false;
    if (newGoal) {
      await storage.updateTaskGoal(t.id, newGoal);
      console.log(`Updated goal: ${newGoal}`);
      updated = true;
    }

    if (newPrompt) {
      const version = await storage.updateTaskPrompt(t.id, newPrompt);
      // Prompt is now durably persisted — clean up recovery file
      if (promptRecoveryPath) removeRecoveryFile(promptRecoveryPath);
      console.log(`Updated prompt to v${version.version} (${newPrompt.length} chars)`);
      updated = true;
    }

    if (newModel) {
      await storage.updateTaskModel(t.id, newModel);
      console.log(`Updated model: ${newModel}`);
      updated = true;
    }

    if (newType) {
      await storage.updateTaskType(t.id, newType);
      console.log(`Updated type: ${newType}`);
      updated = true;
    }

    if (newCode !== undefined) {
      await storage.updateTaskCode(t.id, newCode);
      if (newCode === null) {
        console.log(`Cleared code`);
      } else {
        console.log(`Updated code: ${newCode}`);
      }
      updated = true;
    }

    if (newParent !== undefined) {
      await storage.updateTaskParent(t.id, newParent);
      if (newParent === null) {
        console.log(`Cleared parent`);
      } else {
        console.log(`Updated parent: ${await displayIdFor(storage, newParent)}`);
      }
      updated = true;
    }

    if (!updated) {
      console.log('No changes made');
    }
  } finally {
    await storage.close();
  }
}

export function editUsage(): void {
  console.log(`Usage: lazy edit <task_id> [--goal <goal>] [--prompt <text>] [--model <model>] [--type <type>] [--code <code>] [--parent <task_id>]

Edit a task's goal, prompt, model, type, code, or parent. Interactive if no flags provided.
Editing is not allowed once an agent has worked on the task.
Linked tasks that haven't been agent-started are still editable.
Use 'lazy comment' to add annotations to started tasks.

Arguments:
  <task_id>          ID of the task to edit

Options:
  --goal <goal>      New goal
  --prompt <text>    New prompt
  --model <model>    Change model (apprentice, journeyman, master, sonnet, opus, haiku)
  --type <type>      Change task type (task, fix, spike, refactor, test, audit, migrate, document, tidy, rework, feature, release)
                     Warning: changing type after prompt is set may lead to mismatched expectations
  --code <code>      Set or change the task code (pass "" to clear)
  --parent <task_id> Set or change parent task (pass "" to clear)
                     Parent must exist and not be in a terminal state

Prompt input priority: --prompt flag > piped stdin > $EDITOR (interactive)

Examples:
  lazy edit abc123                           # Interactive mode
  lazy edit abc123 --goal "New goal"
  lazy edit abc123 --prompt "Updated spec"
  lazy edit abc123 --model opus
  lazy edit abc123 --type refactor           # Change to refactor task
  lazy edit abc123 --code fix-auth
  lazy edit abc123 --code ""                 # Clear the code
  lazy edit abc123 --parent def45678         # Set parent task
  lazy edit abc123 --parent ""               # Clear parent (reparent to main)
  echo "New prompt text" | lazy edit abc123  # Piped stdin as prompt`);
}
