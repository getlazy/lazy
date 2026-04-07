import { requireStorage, displayId, displayIdFor, parseFlags, validateModel, validateCode, MAX_TASK_CODE_LENGTH } from '../helpers';
import { openEditor, removeRecoveryFile, readStdinIfPiped } from '../editor';


import refactorConstraints from '../../prompts/refactor-constraints.md' with { type: 'text' };

const TERMINAL_STATUSES = ['complete', 'abandoned', 'closed'];

export async function commandRefactor(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'goal', takesValue: true },
    { name: 'prompt', takesValue: true },
    { name: 'model', takesValue: true },
    { name: 'code', takesValue: true },
    { name: 'parent', takesValue: true },
  ], 'refactor');

  let goal: string;
  let prompt: string | null = null;
  let model: string | null = null;
  let code: string | undefined;
  let promptRecoveryPath: string | null = null;
  let parentTaskId: string | undefined;

  // Parse --model flag
  const modelValue = parsed.flags.get('model') as string | undefined;
  if (modelValue !== undefined) {
    model = validateModel(modelValue);
  }

  // Parse --code flag
  const codeValue = parsed.flags.get('code') as string | undefined;
  if (codeValue !== undefined) {
    const codeError = validateCode(codeValue);
    if (codeError) {
      console.error(`Invalid code '${codeValue}': ${codeError}`);
      process.exit(1);
    }
    code = codeValue;
  }

  // Flag mode: both goal and optionally prompt provided
  const goalValue = parsed.flags.get('goal') as string | undefined;
  const promptValue = parsed.flags.get('prompt') as string | undefined;
  const parentValue = parsed.flags.get('parent') as string | undefined;

  if (goalValue !== undefined) {
    goal = goalValue;

    if (promptValue !== undefined) {
      prompt = promptValue;
    } else {
      // Try piped stdin as prompt
      const stdinContent = await readStdinIfPiped();
      if (stdinContent !== null) {
        prompt = stdinContent;
      }
    }
  } else {
    // Interactive mode
    if (!process.stdin.isTTY) {
      console.error('Interactive mode requires a TTY. Use --goal and --prompt flags instead.');
      process.exit(1);
    }

    const { promptLine } = await import('../editor');
    const goalInput = await promptLine('Refactoring goal');
    if (!goalInput.trim()) {
      console.error('Goal cannot be empty');
      process.exit(1);
    }
    goal = goalInput;

    // Open editor for prompt
    console.log('\nOpening editor for prompt (close without saving to skip)...');
    const editResult = await openEditor('', `refactor-prompt`);
    if (editResult !== null && editResult.content.trim()) {
      prompt = editResult.content.trim();
      promptRecoveryPath = editResult.recoveryPath;
    } else if (editResult !== null && editResult.recoveryPath) {
      removeRecoveryFile(editResult.recoveryPath);
    }
  }

  // Build the full prompt: user prompt + refactor constraints
  const fullPrompt = prompt
    ? `${prompt}\n\n---\n\n${refactorConstraints}`
    : refactorConstraints;

  const storage = await requireStorage();
  try {
    // Resolve and validate parent if provided
    if (parentValue !== undefined) {
      const { resolveTaskOrExit } = await import('../helpers');
      const parentTask = await resolveTaskOrExit(storage, parentValue);
      if (TERMINAL_STATUSES.includes(parentTask.status)) {
        console.error(`Cannot use task ${displayId(parentTask)} as parent: task is ${parentTask.status}`);
        process.exit(1);
      }
      parentTaskId = parentTask.id;
    }

    const t = await storage.createTask(goal, parentTaskId, undefined, code, 'refactor');
    console.log(`Created task ${displayId(t)}`);
    console.log(`  Goal:   ${t.goal}`);
    console.log(`  Status: ${t.status}`);
    console.log(`  ID:     ${t.id}`);
    console.log(`  Type:   refactor`);
    if (t.code) {
      console.log(`  Code:   ${t.code}`);
    }
    if (t.parent_task_id) {
      console.log(`  Parent: ${await displayIdFor(storage, t.parent_task_id)}`);
    }

    // Add the full prompt (user prompt + constraints)
    const version = await storage.updateTaskPrompt(t.id, fullPrompt);
    if (promptRecoveryPath) removeRecoveryFile(promptRecoveryPath);
    console.log(`  Prompt: v${version.version} (${fullPrompt.length} chars)`);

    // Set model if provided
    if (model) {
      await storage.updateTaskModel(t.id, model);
      console.log(`  Model:  ${model}`);
    }

    console.log(`\nStart working on it with: lazy start ${displayId(t)}`);
  } finally {
    await storage.close();
  }
}

export function refactorUsage(): void {
  console.log(`Usage: lazy refactor [--goal <goal>] [--prompt <text>] [--model <model>] [--code <code>] [--parent <task_id>]

Create a refactoring task. The agent restructures code without changing behavior.
Enforces: no behavior changes, one step per commit, tests pass after each step.

Options:
  --goal <goal>      Refactoring goal (what to refactor and why)
  --prompt <text>    Additional instructions for the refactoring agent
  --model <model>    Set model for this task (raw model ID, e.g. claude-sonnet-4-5-20250929)
  --code <code>      Human-readable code (e.g. "refactor-auth", "refactor-storage")
                     Lowercase alphanumeric + hyphens, 2-${MAX_TASK_CODE_LENGTH} chars
  --parent <task_id> Parent task ID (creates a child task)

Prompt input priority: --prompt flag > piped stdin > $EDITOR (interactive)

Examples:
  lazy refactor --goal "Extract storage interface from FileStorage" --code refactor-storage
  lazy refactor --goal "Reduce cyclomatic complexity in start.ts"
  lazy refactor --goal "Rename TaskStatus to WorkflowStatus" --prompt "Update all references"
  lazy refactor                              # Interactive mode
  echo "Focus on the auth module" | lazy refactor --goal "Split auth into separate modules"`);
}
