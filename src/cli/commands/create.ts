import { requireActorIdentity } from '../identity-preflight';
import { requireStorage, requireLazyRoot, parseFlags, validateModel, validateAgentProfileOrExit, resolveTaskOrExit } from '../helpers';
import {
  describeReviewOverrides,
  hasReviewOverrides,
  reviewOverrideMetadata,
  type ReviewSettingsOverrides,
} from '../../review/mode';
import { parseReviewFlags, REVIEW_FLAGS, REVIEW_FLAGS_USAGE } from '../review-flags';
import { pinChosenEffort } from '../../daemon/effort';
import { shortId, displayId, displayIdFor, validateCode, MAX_TASK_CODE_LENGTH } from '../../task/identity';
import { looksLikeTaskBranch } from '../../git/branch-prefix';
import { openEditor, promptLine, removeRecoveryFile, readStdinIfPiped } from '../editor';
import type { Task, TaskType } from '../../types';
import { VALID_TASK_TYPES, invalidTaskTypeMessage } from '../../types';
import { resolveAgentForNewTaskFromConfig, formatAgentResolutionLine } from '../../agent/task-agent';
import { loadConfig } from '../../config/loader';
import { VALID_EFFORT_LEVELS, type EffortLevel, type RunnerType, resolveRunnerType, RUNNER_ALIAS_HINT } from '../../config/types';
import { hostRunnerRemovedMessage, isRemovedHostRunnerInput } from '../../runner/host-runner-gate';
import { parentTaskIdOf, branchTarget } from '../../task-target';
import { sanitizeUserText } from '../../utils/sanitize-text';
import { runGit } from '../../utils/git';
import { normalizeTag } from '../../utils/tags';
import { getActor } from '../../constants';
import {
  inheritCustomImageMetadata,
  maybeOfferWorktreeImageForTask,
  pinnedCustomImage,
} from '../../docker/worktree-image';

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
    { name: 'runner', takesValue: true },
    ...REVIEW_FLAGS,
    { name: 'tag', takesValue: true, accumulate: true },
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
  let runnerType: RunnerType | undefined;
  let reviewOverrides: ReviewSettingsOverrides = {};

  // Parse --runner flag (per-task runner override stored on the task)
  const runnerValue = parsed.flags.get('runner') as string | undefined;
  if (runnerValue !== undefined) {
    if (isRemovedHostRunnerInput(runnerValue)) {
      console.error(hostRunnerRemovedMessage('per-task --runner'));
      process.exit(1);
    }
    const resolved = resolveRunnerType(runnerValue);
    if (!resolved) {
      console.error(`Invalid runner '${runnerValue}'. Must be one of: ${RUNNER_ALIAS_HINT}`);
      process.exit(1);
    }
    runnerType = resolved;
  }

  // The three --review* flags, each independent and each pinned on the task.
  const reviewFlags = parseReviewFlags(parsed.flags);
  if ('error' in reviewFlags) {
    console.error(reviewFlags.error);
    process.exit(1);
  }
  reviewOverrides = reviewFlags.overrides;

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

  // Parse --tag flags (repeatable). Normalize + de-dupe up front so invalid
  // input fails fast, before the task is created.
  const rawTags = (parsed.flags.get('tag') as string[] | undefined) ?? [];
  const tags: string[] = [];
  for (const raw of rawTags) {
    const normalized = normalizeTag(raw);
    if (!normalized) {
      console.error(`Invalid tag '${raw}': a tag must contain at least one letter or digit.`);
      process.exit(1);
    }
    if (!tags.includes(normalized)) tags.push(normalized);
  }

  // Parse --type flag
  const typeValue = parsed.flags.get('type') as string | undefined;
  if (typeValue !== undefined) {
    if (!VALID_TASK_TYPES.includes(typeValue as TaskType)) {
      console.error(invalidTaskTypeMessage(typeValue));
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

  // Parse --agent flag. Resolution (explicit > parent > project default) is
  // finished below, once we know whether this is a subtask — a subtask must
  // inherit its parent's agent rather than the project default.
  const agentValue = parsed.flags.get('agent') as string | undefined;
  if (agentValue !== undefined) {
    await validateAgentProfileOrExit(process.cwd(), agentValue);
  }
  const configAgentId = (await loadConfig(process.cwd())).agent;

  // Before the goal prompt and the prompt editor: a task the daemon cannot
  // attribute is refused at creation, and finding that out after the human has
  // written a prompt would throw the prompt away.
  await requireActorIdentity();

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

  // INTAKE BOUNDARY: the goal and prompt are both rendered into the start
  // prompt, which becomes argv[2] of `claude -p`. Escape non-printable control
  // characters before persisting. The goal is a one-liner, so it is escaped
  // without the explanatory note; the prompt gets the note so the substitution
  // is visible to both the human and the agent.
  goal = sanitizeUserText(goal, { annotate: false });
  if (prompt) prompt = sanitizeUserText(prompt);

  const storage = await requireStorage();
  let explicitBranchTarget: string | undefined;
  try {
    // Resolve --parent: a task code/short-ID, or (fall-through) a raw git branch
    // name. Same precedence as `lazy reparent` — try task first, then branch.
    let parentTask: Task | null = null;
    if (parentValue !== undefined) {
      const resolved = await storage.resolveTask(parentValue);
      if (resolved.task) {
        if (TERMINAL_STATUSES.includes(resolved.task.status)) {
          console.error(`Cannot use task ${displayId(resolved.task)} as parent: task is ${resolved.task.status}`);
          process.exit(1);
        }
        parentTaskId = resolved.task.id;
        parentTask = resolved.task;
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
        if (looksLikeTaskBranch(parentValue)) {
          console.error(`--parent must be an integration branch, not a lazy task branch ('${parentValue}').`);
          process.exit(1);
        }
        explicitBranchTarget = parentValue;
      }
    }

    // A subtask inherits its parent's agent — the project default must not
    // quietly retarget a child of a task that is deliberately on another agent.
    const projectSettings = await storage.getProjectSettings();
    const agentResolution = resolveAgentForNewTaskFromConfig(
      {
        explicit: agentValue,
        inheritFrom: parentTask,
        taskType: taskType ?? 'task',
      },
      configAgentId,
      projectSettings,
    );
    agentId = agentResolution.agentId;

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
    const agentLine = formatAgentResolutionLine(agentResolution);
    if (agentLine) {
      console.log(agentLine);
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
      await pinChosenEffort(storage, t.id, effort);
      console.log(`  Effort: ${effort}`);
    }

    // Pin whatever review settings were given. Written here rather than at
    // start so a task created --review separate is in that arm from its first
    // turn, with no second flag to remember on the command that launches it.
    // Only what was SUPPLIED is written: the rest stays inherited, so a later
    // change to the parent or the project still reaches this task.
    for (const [key, value] of Object.entries(reviewOverrideMetadata(reviewOverrides))) {
      await storage.updateTaskMetadata(t.id, key, value);
    }
    if (hasReviewOverrides(reviewOverrides)) {
      console.log(`  Review: ${describeReviewOverrides(reviewOverrides)}`);
    }

    // Set per-task runner override if provided
    if (runnerType) {
      await storage.updateTaskRunnerType(t.id, runnerType);
      console.log(`  Runner: ${runnerType}`);
    }

    // Apply tags (already normalized + de-duped above). Attributed to the human
    // actor since this is the CLI channel.
    if (tags.length > 0) {
      let applied: string[] = [];
      for (const tag of tags) {
        const updated = await storage.addTaskTag(t.id, tag, getActor());
        applied = updated.tags;
      }
      console.log(`  Tags:   ${applied.map(tg => '#' + tg).join(' ')}`);
    }

    // Subtasks inherit the parent's pinned worktree image (if any) before the
    // TTY offer — so a child of a pinned parent stays on that image without a
    // second prompt, and MCP create gets the same inheritance without ever
    // prompting.
    if (parentTask) {
      const inherited = await inheritCustomImageMetadata(storage, t.id, parentTask);
      if (inherited) {
        console.log(`  Image:  ${pinnedCustomImage(parentTask)} (inherited from parent)`);
      }
    }

    // CLI TTY only: offer to build+pin this cwd's worktree Dockerfile when it
    // differs from the reference. Never runs under --yes (create has none) or
    // non-TTY; MCP never calls this helper.
    const root = requireLazyRoot();
    await maybeOfferWorktreeImageForTask(root, storage, t.id);

    console.log(`\nStart working on it with: lazy start ${displayId(t)}`);
  } finally {
    await storage.close();
  }
}

export function createUsage(): void {
  console.log(`Usage: lazy create [--goal <goal>] [--prompt <text>] [--model <model>] [--type <type>] [--code <code>] [--parent <task_id>] [--agent <profile>] [--effort <level>] [--runner <docker|container|podman>] [--tag <tag>]

Create a new task. Interactive if no flags provided.

Options:
  --goal <goal>      Task goal
  --prompt <text>    Task prompt/specification
  --model <model>    Set model for this task (e.g. opus, sonnet, claude-opus-5)
  --type <type>      Set task type (task, fix, spike, refactor, test, audit, migrate, document, tidy, rework, feature, release, cluster)
                     Default: task
                     cluster: the task's own agent drives its subtasks instead of
                     doing the work — it decides how many run at once, reviews
                     each one and accepts it into the cluster's branch.
  --code <code>      Human-readable code (e.g. "fix-models", "add-auth")
                     Lowercase alphanumeric + hyphens, 2-${MAX_TASK_CODE_LENGTH} chars
  --parent <ref>     Parent: a task code/short-ID (creates a child task) or a
                     raw branch name (top-level task targeting that branch).
                     Parent task must not be in a terminal state.
                     Without --parent, the task targets the repo's default
                     integration branch (origin/HEAD → main fallback). The
                     branch the user currently has checked out is NEVER
                     adopted silently — pass it explicitly if you want it.
  --agent <profile>  Agent profile to run this task with — an [agents.<name>] block in
                     lazy.toml (harness + model + endpoint + credential). The harness
                     names (claude-code, codex, cursor, pi) are the built-in profiles.
                     See them with lazy system agent. Default: from lazy.toml.
  --effort <level>   Claude Code reasoning effort for this task (low, medium, high, xhigh, max)
                     Persists across resumes. Default: from lazy.toml [agent].effort (medium)
                     An effort you set here is respected in low-high review
                     mode: the draft runs at it, not at [review] draft_effort.
                     A project-wide [agent] effort does not do that — only a
                     choice about this task.
  --runner <type>    Run this task on a specific runner regardless of the global
                     [runner] type: docker, container, or podman.
                     Default: inherit lazy.toml [runner] type.
${REVIEW_FLAGS_USAGE}
  --tag <tag>        Add a tag for grouping (repeatable). Normalized to lowercase
                     alphanumerics + hyphens. E.g. --tag onboarding --tag launch

Prompt input priority: --prompt flag > piped stdin > $EDITOR (interactive)

Examples:
  lazy create                              # Interactive mode
  lazy create --goal "Add auth"            # Create with goal only
  lazy create --goal "Add auth" --code add-auth
  lazy create --goal "Add auth" --tag onboarding --tag launch
  lazy create --goal "Add auth" --prompt "Implement OAuth2 login"
  lazy create --goal "Refactor" --model opus --type refactor
  lazy create --goal "Sub-task" --parent abc12345
  lazy create --goal "Fix bug" --agent claude-code
  echo "Detailed prompt" | lazy create --goal "Add auth"  # Piped stdin as prompt`);
}
