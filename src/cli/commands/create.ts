import { requireStorage, shortId, displayId, displayIdFor, parseFlags, validateModel, validateCode, resolveTaskOrExit, MAX_TASK_CODE_LENGTH } from '../helpers';
import { openEditor, promptLine, removeRecoveryFile, readStdinIfPiped } from '../editor';
import type { ModelName, TaskType } from '../../types';
import { VALID_TASK_TYPES } from '../../types';
import { listAgents } from '../../agent/registry';

const TERMINAL_STATUSES = ['complete', 'abandoned', 'closed'];

export async function commandCreate(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'goal', takesValue: true },
    { name: 'prompt', takesValue: true },
    { name: 'model', takesValue: true },
    { name: 'type', takesValue: true },
    { name: 'code', takesValue: true },
    { name: 'parent', takesValue: true },
    { name: 'agent', takesValue: true },
  ], 'create');

  let goal: string;
  let prompt: string | null = null;
  let model: ModelName | null = null;
  let taskType: TaskType | null = null;
  let code: string | undefined;
  let promptRecoveryPath: string | null = null;
  let parentTaskId: string | undefined;
  let agentId: string | undefined;

  // Parse --model flag
  const modelValue = parsed.flags.get('model') as string | undefined;
  if (modelValue !== undefined) {
    model = validateModel(modelValue);
  }

  // Parse --type flag
  const typeValue = parsed.flags.get('type') as string | undefined;
  if (typeValue !== undefined) {
    if (!VALID_TASK_TYPES.includes(typeValue as TaskType)) {
      console.error(`Invalid type '${typeValue}'. Must be one of: ${VALID_TASK_TYPES.join(', ')}`);
      process.exit(1);
    }
    taskType = typeValue as TaskType;
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

  // Parse --agent flag
  const agentValue = parsed.flags.get('agent') as string | undefined;
  if (agentValue !== undefined) {
    const validAgents = listAgents();
    if (!validAgents.includes(agentValue)) {
      console.error(`Unknown agent '${agentValue}'. Available agents: ${validAgents.join(', ')}`);
      process.exit(1);
    }
    agentId = agentValue;
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

    const goalInput = await promptLine('Task goal');
    if (!goalInput.trim()) {
      console.error('Goal cannot be empty');
      process.exit(1);
    }
    goal = goalInput;

    // Open editor for prompt
    console.log('\nOpening editor for prompt (close without saving to skip)...');
    const editResult = await openEditor('', `create-prompt`);
    if (editResult !== null && editResult.content.trim()) {
      prompt = editResult.content.trim();
      promptRecoveryPath = editResult.recoveryPath;
    } else if (editResult !== null && editResult.recoveryPath) {
      // Empty prompt — clean up recovery file
      removeRecoveryFile(editResult.recoveryPath);
    }
  }

  const storage = await requireStorage();
  try {
    // Resolve and validate parent if provided
    if (parentValue !== undefined) {
      const parentTask = await resolveTaskOrExit(storage, parentValue);
      if (TERMINAL_STATUSES.includes(parentTask.status)) {
        console.error(`Cannot use task ${displayId(parentTask)} as parent: task is ${parentTask.status}`);
        process.exit(1);
      }
      parentTaskId = parentTask.id;
    }

    const t = await storage.createTask(goal, parentTaskId, undefined, code, taskType ?? undefined, agentId);
    console.log(`Created task ${displayId(t)}`);
    console.log(`  Goal:   ${t.goal}`);
    console.log(`  Status: ${t.status}`);
    console.log(`  ID:     ${t.id}`);
    if (t.code) {
      console.log(`  Code:   ${t.code}`);
    }
    if (t.parent_task_id) {
      console.log(`  Parent: ${await displayIdFor(storage, t.parent_task_id)}`);
    }
    if (t.type !== 'task') {
      console.log(`  Type:   ${t.type}`);
    }
    if (t.agent_id !== 'claude-code') {
      console.log(`  Agent:  ${t.agent_id}`);
    }

    // Add prompt if provided
    if (prompt) {
      const version = await storage.updateTaskPrompt(t.id, prompt);
      // Prompt is now durably persisted — clean up recovery file
      if (promptRecoveryPath) removeRecoveryFile(promptRecoveryPath);
      console.log(`  Prompt: v${version.version} (${prompt.length} chars)`);
    }

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

export function createUsage(): void {
  console.log(`Usage: lazy create [--goal <goal>] [--prompt <text>] [--model <model>] [--type <type>] [--code <code>] [--parent <task_id>] [--agent <agent_id>]

Create a new task. Interactive if no flags provided.

Options:
  --goal <goal>      Task goal
  --prompt <text>    Task prompt/specification
  --model <model>    Set model for this task (apprentice, journeyman, master, sonnet, opus, haiku)
  --type <type>      Set task type (task, fix, spike, refactor, test, audit, migrate, document, tidy, rework, feature, release)
                     Default: task
  --code <code>      Human-readable code (e.g. "fix-models", "add-auth")
                     Lowercase alphanumeric + hyphens, 2-${MAX_TASK_CODE_LENGTH} chars
  --parent <task_id> Parent task ID (creates a child task)
                     Parent must exist and not be in a terminal state
  --agent <agent_id> Agent to use for this task (default: from lazy.toml or "claude-code")

Prompt input priority: --prompt flag > piped stdin > $EDITOR (interactive)

Examples:
  lazy create                              # Interactive mode
  lazy create --goal "Add auth"            # Create with goal only
  lazy create --goal "Add auth" --code add-auth
  lazy create --goal "Add auth" --prompt "Implement OAuth2 login"
  lazy create --goal "Refactor" --model opus --type refactor
  lazy create --goal "Sub-task" --parent abc12345
  lazy create --goal "Fix bug" --agent claude-code
  echo "Detailed prompt" | lazy create --goal "Add auth"  # Piped stdin as prompt`);
}
