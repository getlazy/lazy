import { join } from 'path';
import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, parseFlags, validateModel, validateCode, resolveTaskOrExit, taskRef, getWorktreePath } from '../helpers';
import { getCurrentSha } from '../../git/operations';
import { openEditor, promptLine, promptYesNo, removeRecoveryFile, requireTTY } from '../editor';
import { commandStart } from './start';
import type { ModelName } from '../../types';

import { getDataDir } from '../init';

export async function commandBranch(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'goal', takesValue: true },
    { name: 'prompt', takesValue: true },
    { name: 'model', takesValue: true },
    { name: 'code', takesValue: true },
    { name: 'yes', takesValue: false },
  ], 'branch');

  const parentTaskId = parsed.positional[0];
  if (!parentTaskId) {
    branchUsage();
    process.exit(1);
  }

  const root = requireLazyRoot();
  const storage = await requireStorage();

  let childTaskId: string;
  let childModel: ModelName | null = null;
  let childCode: string | undefined;

  // Validate --code flag
  const codeValue = parsed.flags.get('code') as string | undefined;
  if (codeValue !== undefined) {
    const codeError = validateCode(codeValue);
    if (codeError) {
      console.error(`Invalid code: ${codeError}`);
      process.exit(1);
    }
    childCode = codeValue;
  }

  try {
    // Resolve parent task
    const parentTask = await resolveTaskOrExit(storage, parentTaskId);

    // Get parent's session to find current HEAD
    const parentSession = await storage.getSessionByTaskId(parentTask.id);
    if (!parentSession) {
      console.error(`Parent task ${displayId(parentTask)} has no session. Start it first with: lazy start ${displayId(parentTask)}`);
      process.exit(1);
    }

    // Get parent worktree path and current HEAD
    const parentWorktreePath = getWorktreePath(root, parentTask);
    if (!existsSync(parentWorktreePath)) {
      console.error(`Parent worktree not found at ${parentWorktreePath}`);
      process.exit(1);
    }

    const branchFromSha = getCurrentSha(parentWorktreePath);

    // Parse options
    const goalValue = parsed.flags.get('goal') as string | undefined;
    const promptValue = parsed.flags.get('prompt') as string | undefined;
    const modelValue = parsed.flags.get('model') as string | undefined;

    let childGoal: string;
    let childPrompt: string;
    let branchPromptRecoveryPath: string | null = null;

    // Parse --model flag
    if (modelValue !== undefined) {
      childModel = validateModel(modelValue);
    }

    if (goalValue !== undefined || promptValue !== undefined) {
      // Flag mode
      childGoal = goalValue !== undefined
        ? goalValue
        : `${parentTask.goal} (variant)`;

      childPrompt = promptValue !== undefined
        ? promptValue
        : parentTask.prompt;
    } else {
      // Require TTY for interactive mode
      try {
        requireTTY('This command requires an interactive terminal. Use --goal and --prompt flags to provide input non-interactively.');
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }

      // Interactive mode
      console.log(`Branching from task ${displayId(parentTask)}: ${parentTask.goal}`);
      console.log(`  Branch point: ${branchFromSha.substring(0, 8)}\n`);

      const goalInput = await promptLine('Goal for variant (Enter to use parent goal + "(variant)")');
      childGoal = goalInput.trim() || `${parentTask.goal} (variant)`;

      const editPrompt = await promptYesNo('Edit prompt in $EDITOR?', false);
      if (editPrompt) {
        const editResult = await openEditor(parentTask.prompt, `branch-${shortId(parentTask.id)}`);
        if (editResult !== null && editResult.content.trim()) {
          childPrompt = editResult.content.trim();
          branchPromptRecoveryPath = editResult.recoveryPath;
        } else {
          childPrompt = parentTask.prompt;
          if (editResult !== null && editResult.recoveryPath) {
            removeRecoveryFile(editResult.recoveryPath);
          }
        }
      } else {
        childPrompt = parentTask.prompt;
      }
    }

    // Create child task with parent reference
    const childTask = await storage.createTask(childGoal, parentTask.id, branchFromSha, childCode);

    // Set prompt
    await storage.updateTaskPrompt(childTask.id, childPrompt);
    // Prompt is now durably persisted — clean up recovery file
    if (branchPromptRecoveryPath) removeRecoveryFile(branchPromptRecoveryPath);

    // Set model if provided (otherwise inherits from parent task)
    if (childModel) {
      await storage.updateTaskModel(childTask.id, childModel);
    }

    childTaskId = childTask.id;

    console.log(`\nCreated variant task ${displayId(childTask)}`);
    if (childCode) {
      console.log(`  Code:        ${childCode}`);
    }
    console.log(`  Parent:      ${displayId(parentTask)} - ${parentTask.goal}`);
    console.log(`  Goal:        ${childTask.goal}`);
    console.log(`  Branch from: ${branchFromSha.substring(0, 8)}`);
    if (childModel) {
      console.log(`  Model:       ${childModel}`);
    }

  } finally {
    await storage.close();
  }

  // Now start the task immediately using commandStart
  // (commandStart manages its own storage lifecycle)
  const startArgs = [shortId(childTaskId)];
  if (childModel) {
    startArgs.push('--model', childModel);
  }
  // Pass through --yes flag if provided
  if (parsed.flags.get('yes') === true) {
    startArgs.push('--yes');
  }
  await commandStart(startArgs);
}

export function branchUsage(): void {
  console.log(`Usage: lazy branch <task_id> [--goal <goal>] [--prompt <text>] [--model <model>] [--code <code>] [--yes]

Create a child task branching from a parent task's current state and start it
immediately. The child task will have its git branch starting from the parent's
current HEAD.

Arguments:
  <task_id>          ID of parent task to branch from

Options:
  --goal <goal>      Goal for the variant (default: parent goal + "(variant)")
  --prompt <text>    Prompt for the variant (default: inherit parent's prompt)
  --model <model>    Override model for the variant (sonnet, opus, haiku)
  --code <code>      Set a human-readable code for the variant task
  --yes              Skip confirmation prompt when starting the variant task

Interactive Mode:
  - Without flags, requires an interactive terminal (TTY)
  - Prompts for goal and allows editing prompt in $EDITOR
  - For non-interactive use, provide --goal and/or --prompt flags

Examples:
  lazy branch abc123                                    # Interactive mode (requires TTY)
  lazy branch abc123 --goal "Try Redis instead"        # Custom goal (non-interactive)
  lazy branch abc123 --code try-redis                  # With a code
  lazy branch abc123 --prompt "Use async approach"     # Custom prompt (non-interactive)

After branching:
  lazy accept <child_task_id>   # Merge variant back into parent
  lazy reject <child_task_id>   # Discard variant`);
}
