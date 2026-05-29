import { requireStorage, requireLazyRoot, shortId, displayId, displayIdFor, parseFlags, validateModel, validateCode, resolveTaskOrExit, MAX_TASK_CODE_LENGTH } from '../helpers';
import { openEditor, promptLine, removeRecoveryFile, readStdinIfPiped } from '../editor';
import type { TaskType } from '../../types';
import { VALID_TASK_TYPES } from '../../types';
import { listAgents } from '../../agent/registry';
import { loadConfig } from '../../config/loader';
import { VALID_EFFORT_LEVELS, type EffortLevel } from '../../config/types';
import { parentTaskIdOf, branchTarget } from '../../task-target';
import { runGit } from '../../utils/git';

const TERMINAL_STATUSES = ['complete', 'abandoned'];

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
    { name: 'effort', takesValue: true },
  ], 'create');

  let goal: string;
  let prompt: string | null = null;
  let model: string | null = null;
  let taskType: TaskType | null = null;
  let code: string | undefined;
  let promptRecoveryPath: string | null = null;
  let parentTaskId: string | undefined;
  let agentId: string | undefined;
  let effort: EffortLevel | undefined;

  // Parse --effort flag
  const effortValue = parsed.flags.get('effort') as string | undefined;
  if (effortValue !== undefined) {
    if (!VALID_EFFORT_LEVELS.includes(effortValue as EffortLevel)) {
      console.error(`Invalid effort '${effortValue}'. Must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`);
      process.exit(1);
    }
    effort = effortValue as EffortLevel;
  }

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

  // Parse --agent flag (falls back to config's agent.agent_id)
  const agentValue = parsed.flags.get('agent') as string | undefined;
  if (agentValue !== undefined) {
    const validAgents = listAgents();
    if (!validAgents.includes(agentValue)) {
      console.error(`Unknown agent '${agentValue}'. Available agents: ${validAgents.join(', ')}`);
      process.exit(1);
    }
    agentId = agentValue;
  } else {
    // Default to config's agent_id so tasks inherit the project's configured agent
    const config = await loadConfig(process.cwd());
    if (config.agent.agent_id && config.agent.agent_id !== 'claude-code') {
      agentId = config.agent.agent_id;
    }
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
  let explicitBranchTarget: string | undefined;
  try {
    // Resolve --parent: a task code/short-ID, or (fall-through) a raw git branch
    // name. Same precedence as `lazy reparent` — try task first, then branch.
    if (parentValue !== undefined) {
      const resolved = await storage.resolveTask(parentValue);
      if (resolved.task) {
        if (TERMINAL_STATUSES.includes(resolved.task.status)) {
          console.error(`Cannot use task ${displayId(resolved.task)} as parent: task is ${resolved.task.status}`);
          process.exit(1);
        }
        parentTaskId = resolved.task.id;
      } else if (resolved.ambiguousMatches?.length) {
        console.error(`Ambiguous parent '${parentValue}'. Matches: ${resolved.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ')}`);
        process.exit(1);
      } else {
        // Not a task — try as a raw branch name. Verify it resolves locally so
        // we don't store a typo as the integration target.
        const root = requireLazyRoot();
        const verify = await runGit(['rev-parse', '--verify', '--quiet', parentValue], { cwd: root });
        if (verify.exitCode !== 0) {
          console.error(`--parent '${parentValue}' is neither a known task nor a local git branch.`);
          process.exit(1);
        }
        if (parentValue.startsWith('lazy/')) {
          console.error(`--parent must be an integration branch, not a lazy task branch ('${parentValue}').`);
          process.exit(1);
        }
        explicitBranchTarget = parentValue;
      }
    }

    const t = await storage.createTask(goal, parentTaskId, undefined, code, taskType ?? undefined, agentId);

    // Persist the explicit branch target right after creation. The task is
    // now on disk with the empty-sentinel default; we overwrite to the user's
    // explicit choice before any further work.
    if (explicitBranchTarget) {
      await storage.updateTaskTarget(t.id, branchTarget(explicitBranchTarget));
      t.target = branchTarget(explicitBranchTarget);
    }
    console.log(`Created task ${displayId(t)}`);
    console.log(`  Goal:   ${t.goal}`);
    console.log(`  Status: ${t.status}`);
    console.log(`  ID:     ${t.id}`);
    if (t.code) {
      console.log(`  Code:   ${t.code}`);
    }
    const parentId = parentTaskIdOf(t);
    if (parentId) {
      console.log(`  Parent: ${await displayIdFor(storage, parentId)}`);
    } else if (explicitBranchTarget) {
      console.log(`  Target: branch ${explicitBranchTarget}`);
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

    // Set effort if provided (stored as metadata so it persists across resumes)
    if (effort) {
      await storage.updateTaskMetadata(t.id, 'effort', effort);
      console.log(`  Effort: ${effort}`);
    }

    console.log(`\nStart working on it with: lazy start ${displayId(t)}`);
  } finally {
    await storage.close();
  }
}

export function createUsage(): void {
  console.log(`Usage: lazy create [--goal <goal>] [--prompt <text>] [--model <model>] [--type <type>] [--code <code>] [--parent <task_id>] [--agent <agent_id>] [--effort <level>]

Create a new task. Interactive if no flags provided.

Options:
  --goal <goal>      Task goal
  --prompt <text>    Task prompt/specification
  --model <model>    Set model for this task (e.g. opus, sonnet, claude-opus-4-8)
  --type <type>      Set task type (task, fix, spike, refactor, test, audit, migrate, document, tidy, rework, feature, release)
                     Default: task
  --code <code>      Human-readable code (e.g. "fix-models", "add-auth")
                     Lowercase alphanumeric + hyphens, 2-${MAX_TASK_CODE_LENGTH} chars
  --parent <ref>     Parent: a task code/short-ID (creates a child task) or a
                     raw branch name (top-level task targeting that branch).
                     Parent task must not be in a terminal state.
                     Without --parent, the task targets the repo's default
                     integration branch (origin/HEAD → main fallback). The
                     branch the user currently has checked out is NEVER
                     adopted silently — pass it explicitly if you want it.
  --agent <agent_id> Agent to use for this task (default: from lazy.toml or "claude-code")
  --effort <level>   Claude Code reasoning effort for this task (low, medium, high, xhigh, max)
                     Persists across resumes. Default: from lazy.toml [agent].effort (medium)

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
