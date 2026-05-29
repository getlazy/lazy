import { requireStorage, displayId, displayIdFor, parseFlags, validateModel, validateCode, MAX_TASK_CODE_LENGTH } from '../helpers';
import { openEditor, removeRecoveryFile, readStdinIfPiped } from '../editor';


import fixConstraints from '../../prompts/fix-constraints.md' with { type: 'text' };
import { parentTaskIdOf } from '../../task-target';

const TERMINAL_STATUSES = ['complete', 'abandoned'];

export async function commandFix(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'goal', takesValue: true },
    { name: 'prompt', takesValue: true },
    { name: 'model', takesValue: true },
    { name: 'code', takesValue: true },
    { name: 'parent', takesValue: true },
  ], 'fix');

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
    const goalInput = await promptLine('Bug/issue to fix');
    if (!goalInput.trim()) {
      console.error('Goal cannot be empty');
      process.exit(1);
    }
    goal = goalInput;

    // Open editor for prompt
    console.log('\nOpening editor for prompt (close without saving to skip)...');
    const editResult = await openEditor('', `fix-prompt`);
    if (editResult !== null && editResult.content.trim()) {
      prompt = editResult.content.trim();
      promptRecoveryPath = editResult.recoveryPath;
    } else if (editResult !== null && editResult.recoveryPath) {
      removeRecoveryFile(editResult.recoveryPath);
    }
  }

  // Build the full prompt: user prompt + fix constraints
  const fullPrompt = prompt
    ? `${prompt}\n\n---\n\n${fixConstraints}`
    : fixConstraints;

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

    const t = await storage.createTask(goal, parentTaskId, undefined, code, 'fix');
    console.log(`Created task ${displayId(t)}`);
    console.log(`  Goal:   ${t.goal}`);
    console.log(`  Status: ${t.status}`);
    console.log(`  ID:     ${t.id}`);
    console.log(`  Type:   fix`);
    if (t.code) {
      console.log(`  Code:   ${t.code}`);
    }
    const parentId = parentTaskIdOf(t);
    if (parentId) {
      console.log(`  Parent: ${await displayIdFor(storage, parentId)}`);
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

export function fixUsage(): void {
  console.log(`Usage: lazy fix [--goal <goal>] [--prompt <text>] [--model <model>] [--code <code>] [--parent <task_id>]

Create a debugging/fix task with experimental debugging methodology.
Enforces: reproduce first, instrument to prove hypotheses, verify fix with tests.

The agent is constrained to prove everything through execution rather than
assuming behavior by reading code. This methodology is designed for fixing
subtle bugs that resist traditional debugging approaches.

Options:
  --goal <goal>      Bug or issue to fix (what's broken and symptoms)
  --prompt <text>    Additional context (reproduction steps, error messages, etc.)
  --model <model>    Set model for this task (e.g. opus, sonnet, claude-opus-4-8)
  --code <code>      Human-readable code (e.g. "fix-token-hang", "fix-null-deref")
                     Lowercase alphanumeric + hyphens, 2-${MAX_TASK_CODE_LENGTH} chars
  --parent <task_id> Parent task ID (creates a child task)

Prompt input priority: --prompt flag > piped stdin > $EDITOR (interactive)

The debugging methodology:
  1. Reproduce the bug first (test, script, or manual steps)
  2. Instrument code with assertions/logs to prove hypotheses
  3. Run and observe actual behavior (don't assume from reading)
  4. Fix with evidence, not theory
  5. Verify fix passes reproduction and full test suite
  6. Leave regression test to prevent reintroduction

Examples:
  lazy fix --goal "Token refresh hangs on expired tokens" --code fix-token-hang
  lazy fix --goal "Null pointer in session cleanup" --prompt "Crashes on logout"
  lazy fix --goal "Race condition in worker pool"
  lazy fix                                    # Interactive mode
  echo "Error: ENOENT when path has spaces" | lazy fix --goal "Path handling bug"`);
}
