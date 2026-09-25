import { requireStorage, requireLazyRoot, parseFlags, validateModel, validateAgentProfileOrExit, resolveTaskOrExit } from '../helpers';
import { requireActorIdentity } from '../identity-preflight';
import {
  describeReviewOverrides,
  hasReviewOverrides,
  reviewOverrideMetadata,
} from '../../review/mode';
import { parseReviewFlags, REVIEW_FLAGS } from '../review-flags';
import { pinChosenEffort } from '../../daemon/effort';
import { shortId, displayId, displayIdFor, validateCode } from '../../task/identity';
import { openEditor, promptLine, promptYesNo, removeRecoveryFile, readStdinIfPiped } from '../editor';
import { isTerminalStatus, VALID_TASK_TYPES, invalidTaskTypeMessage } from '../../types';
import type { Task, TaskType } from '../../types';
import type { Storage } from '../../storage/interface';
import { parentTaskIdOf, taskTarget, branchTarget } from '../../task-target';
import { resolveRunnerType, RUNNER_ALIAS_HINT, VALID_EFFORT_LEVELS } from '../../config/types';
import { hostRunnerRemovedMessage, isRemovedHostRunnerInput } from '../../runner/host-runner-gate';
import type { EffortLevel } from '../../config/types';
import { loadConfig } from '../../config/loader';
import { resolveProjectModel } from '../../daemon/project-settings';
import { switchTaskAgent, formatAgentSwitchAnnouncement } from '../../daemon/agent-switch';
import { maybeOfferWorktreeImageForTask } from '../../docker/worktree-image';

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
    currentId = parentTaskIdOf(task);
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
    { name: 'runner', takesValue: true },
    { name: 'effort', takesValue: true },
    { name: 'agent', takesValue: true },
    ...REVIEW_FLAGS,
  ], 'edit');

  const taskId = parsed.positional[0];
  if (!taskId) {
    editUsage();
    process.exit(1);
  }

  // Before the new goal or prompt is typed: the daemon refuses a write it cannot
  // attribute, and a refusal must never cost the human what they wrote.
  await requireActorIdentity();

  const storage = await requireStorage();

  try {
    const t = await resolveTaskOrExit(storage, taskId);

    // Block editing terminal tasks
    if (isTerminalStatus(t.status)) {
      console.error(`Cannot edit task ${displayId(t)}: task is already ${t.status}.`);
      console.error(`Use 'lazy comment ${displayId(t)} --message "..."' to add annotations instead.`);
      process.exit(1);
    }

    const runnerValue = parsed.flags.get('runner') as string | undefined;
    const agentValue = parsed.flags.get('agent') as string | undefined;
    const goalValue = parsed.flags.get('goal') as string | undefined;
    const promptValue = parsed.flags.get('prompt') as string | undefined;
    const modelValue = parsed.flags.get('model') as string | undefined;
    const typeValue = parsed.flags.get('type') as string | undefined;
    const codeValue = parsed.flags.get('code') as string | undefined;
    const parentValue = parsed.flags.get('parent') as string | undefined;
    const effortValue = parsed.flags.get('effort') as string | undefined;
    const reviewFlags = parseReviewFlags(parsed.flags);
    if ('error' in reviewFlags) {
      console.error(reviewFlags.error);
      process.exit(1);
    }
    const reviewOverrides = reviewFlags.overrides;

    // Block editing once an agent has actually worked on the task (has turns).
    // Linked tasks have a session but no turns — those should remain editable.
    // Exception: model, effort, runner and agent are safe mid-flight (they do
    // not restate the work), so they are the supported way to durably retarget
    // a started task. Auto-resume/auto-deliver relaunch from the task's stored
    // values, so a stale value there is what caused a real crash-loop incident.
    //
    // This gate runs BEFORE any storage write below, so a rejected command
    // applies nothing — a combined edit must not leave the agent or runner
    // changed while the goal edit that accompanied it was refused.
    const turnCount = await storage.getTurnCountByTaskId(t.id);
    const isMidFlightSafeEdit = (modelValue !== undefined || effortValue !== undefined
        || runnerValue !== undefined || agentValue !== undefined
        || hasReviewOverrides(reviewOverrides))
      && goalValue === undefined && promptValue === undefined
      && typeValue === undefined && codeValue === undefined && parentValue === undefined;
    if (turnCount > 0 && !isMidFlightSafeEdit) {
      console.error(`Cannot edit task ${displayId(t)}: task has already been started; only --model and --effort can be changed.`);
      console.error(`(--runner and --agent are changeable on a started task too, but only on their own — not combined with a goal/prompt/type/code/parent edit.)`);
      console.error(`Use 'lazy comment ${displayId(t)} --message "..."' to add annotations instead.`);
      process.exit(1);
    }

    // --- Review mode: changeable at ANY time, even after work begins ---
    // It decides what happens at this task's NEXT final, so switching a task
    // that is grinding through separate-reviewer rounds onto low-high (or off)
    // is the escape hatch from exactly the situation this whole feature exists
    // for. Takes effect on the next turn, like --runner.
    let reviewHandled = false;
    if (hasReviewOverrides(reviewOverrides)) {
      // Only what was SUPPLIED is written: a task edited with --review-gate
      // keeps inheriting its mode, rather than having one flag silently pin
      // all three against a project default that may still change.
      for (const [key, value] of Object.entries(reviewOverrideMetadata(reviewOverrides))) {
        await storage.updateTaskMetadata(t.id, key, value);
      }
      console.log(`Updated review settings: ${describeReviewOverrides(reviewOverrides)} (takes effect next turn)`);
      reviewHandled = true;
    }

    // --- Runner override: changeable at ANY time, even after work begins ---
    // It takes effect on the next turn (see Task.runner_type). Accepts "" to
    // clear (inherit the global [runner] type).
    let runnerHandled = false;
    if (runnerValue !== undefined) {
      if (runnerValue === '') {
        await storage.updateTaskRunnerType(t.id, null);
        console.log(`Cleared runner override (inherits global [runner] type)`);
      } else {
        if (isRemovedHostRunnerInput(runnerValue)) {
          console.error(hostRunnerRemovedMessage('per-task --runner'));
          process.exit(1);
        }
        const resolved = resolveRunnerType(runnerValue);
        if (!resolved) {
          console.error(`Invalid runner '${runnerValue}'. Must be one of: ${RUNNER_ALIAS_HINT}`);
          process.exit(1);
        }
        await storage.updateTaskRunnerType(t.id, resolved);
        console.log(`Updated runner: ${resolved} (takes effect next turn)`);
      }
      runnerHandled = true;
    }

    // --- Agent override: changeable after work begins, but not mid-turn ---
    // Switching agents mid-task retargets the next turn (Claude Code <-> Cursor).
    // The session's agent_session_id is cleared because an agent session is not
    // portable across agents; the task's turn history survives in lazy's store.
    // Model and effort are re-resolved for the new agent unless this same write
    // also supplies --model / --effort (chosen for THIS agent) — see
    // switchTaskAgent. Same-agent --agent is a no-op on identity fields.
    let agentHandled = false;
    // When the switch consumed --model/--effort, skip the later same-agent
    // update paths so we do not write twice or fight the re-resolve.
    let modelHandledByAgentSwitch = false;
    let effortHandledByAgentSwitch = false;
    if (agentValue !== undefined) {
      await validateAgentProfileOrExit(process.cwd(), agentValue);

      // Validate co-supplied effort before any write — same set as start/unblock.
      if (effortValue !== undefined && !VALID_EFFORT_LEVELS.includes(effortValue as EffortLevel)) {
        console.error(`Invalid effort '${effortValue}'. Must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`);
        process.exit(1);
      }
      const coModel = modelValue !== undefined ? validateModel(modelValue) : undefined;

      if (agentValue !== t.agent_id) {
        const root = requireLazyRoot();
        const config = await loadConfig(root);
        const projectSettings = await storage.getProjectSettings();
        try {
          const switchResult = await switchTaskAgent({
            storage,
            task: t,
            newAgentId: agentValue,
            config,
            projectModel: resolveProjectModel(projectSettings, config),
            modelOverride: coModel,
            effortOverride: effortValue as EffortLevel | undefined,
          });
          for (const line of formatAgentSwitchAnnouncement(switchResult)) {
            console.log(line);
          }
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
        if (coModel !== undefined) modelHandledByAgentSwitch = true;
        if (effortValue !== undefined) effortHandledByAgentSwitch = true;
      } else {
        console.log(`Agent already set to ${agentValue} (no change)`);
      }
      agentHandled = true;
    }

    // If --runner and/or --agent were the only flags, we're done — don't fall
    // through to interactive mode. Co-supplied --model/--effort on an agent
    // switch were already applied above.
    const otherEditFlags = ['goal', 'prompt', 'model', 'type', 'code', 'parent', 'effort'].some(f => {
      if (f === 'model' && modelHandledByAgentSwitch) return false;
      if (f === 'effort' && effortHandledByAgentSwitch) return false;
      return parsed.flags.get(f) !== undefined;
    });
    if ((runnerHandled || agentHandled || reviewHandled) && !otherEditFlags) {
      return;
    }

    let newGoal: string | null = null;
    let newPrompt: string | null = null;
    let newModel: string | null = null;
    let newType: TaskType | null = null;
    let newCode: string | null | undefined = undefined; // undefined = no change, null = clear, string = new code
    let newParent: string | null | undefined = undefined; // undefined = no change, null = clear, string = new parent ID
    let newEffort: EffortLevel | null = null;
    let promptRecoveryPath: string | null = null;

    // Validate model if provided (and not already applied by an agent switch)
    if (modelValue !== undefined && !modelHandledByAgentSwitch) {
      newModel = validateModel(modelValue);
    }

    // Validate effort if provided — same value set and same message shape as
    // `lazy start --effort`, so the two surfaces never disagree about what is legal.
    if (effortValue !== undefined && !effortHandledByAgentSwitch) {
      if (!VALID_EFFORT_LEVELS.includes(effortValue as EffortLevel)) {
        console.error(`Invalid effort '${effortValue}'. Must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`);
        process.exit(1);
      }
      newEffort = effortValue as EffortLevel;
    }

    // Validate type if provided
    if (typeValue !== undefined) {
      if (!VALID_TASK_TYPES.includes(typeValue as TaskType)) {
        console.error(invalidTaskTypeMessage(typeValue));
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
    if (goalValue !== undefined || promptValue !== undefined || newModel !== null || newType !== null || newCode !== undefined || newParent !== undefined || newEffort !== null) {
      if (goalValue !== undefined) {
        newGoal = goalValue;
      }

      if (promptValue !== undefined) {
        newPrompt = promptValue;
      } else if (turnCount === 0) {
        // Try piped stdin as prompt (when other flags are set but --prompt is not).
        // Skipped on started tasks — only the model may change there, and piped
        // stdin must not become a prompt edit that bypasses the guard above.
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

    if (newEffort) {
      // Effort lives in task metadata — the same slot resolveAndPersistEffort
      // writes on every launch, so this is a durable per-turn override.
      await pinChosenEffort(storage, t.id, newEffort);
      console.log(`Updated effort: ${newEffort} (takes effect next turn)`);
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
      // Clearing the parent makes the task top-level, integrating into main
      // (per --parent "" docs); setting one stacks it on that task.
      await storage.updateTaskTarget(t.id, newParent === null ? branchTarget('main') : taskTarget(newParent));
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

    // CLI TTY only: offer to pin this cwd's worktree Dockerfile after edits.
    // Runs even when "No changes made" so a human can still opt into an image
    // pin from edit without changing other fields.
    await maybeOfferWorktreeImageForTask(requireLazyRoot(), storage, t.id);
  } finally {
    await storage.close();
  }
}

export function editUsage(): void {
  console.log(`Usage: lazy edit <task_id> [--goal <goal>] [--prompt <text>] [--model <model>] [--type <type>] [--code <code>] [--parent <task_id>] [--runner <docker|container|podman>] [--effort <level>] [--agent <profile>] [--review <mode>] [--review-gate <g>] [--review-auto-fix <on|off>]

Edit a task's goal, prompt, model, type, code, parent, runner, effort, agent, or review mode. Interactive if no flags provided.
Once an agent has worked on the task, only --model, --effort, --runner, --agent and the
--review* flags can still be changed; goal/prompt/type/code/parent edits are rejected. The --runner, --agent and
--review overrides take effect on the next turn.
Linked tasks that haven't been agent-started are still fully editable.
Use 'lazy comment' to add annotations to started tasks.

Arguments:
  <task_id>          ID of the task to edit

Options:
  --goal <goal>      New goal
  --prompt <text>    New prompt
  --model <model>    Change model (e.g. opus, sonnet, claude-opus-5)
  --type <type>      Change task type (task, fix, spike, refactor, test, audit, migrate, document, tidy, rework, feature, release)
                     Warning: changing type after prompt is set may lead to mismatched expectations
  --code <code>      Set or change the task code (pass "" to clear)
  --parent <task_id> Set or change parent task (pass "" to clear)
                     Parent must exist and not be in a terminal state
  --runner <type>    Set the runner for this task: docker, container, or
                     podman (pass "" to clear and inherit the global [runner]
                     type). Allowed any time; takes effect next turn.
  --effort <level>   Change Claude Code reasoning effort for the next turn:
                     low, medium, high, xhigh, max. Allowed any time; takes
                     effect next turn. Respected in low-high review mode — the
                     draft runs at it rather than at [review] draft_effort.
  --review <mode>    Change how this task gets reviewed at its next final:
                     low-high (the writer self-reviews in its own session),
                     separate (a reviewer runs afterwards and gates accept), or
                     off. Allowed any time; takes effect next turn — which is
                     how you pull a task out of a reviewer cycle that is costing
                     more than it is finding.
  --review-gate <g>  Change when a recorded review holds the merge: auto (the
                     mode decides), always, or never. Allowed any time.
  --review-auto-fix <on|off>
                     Change whether a 'separate' review that found something
                     starts a fix turn by itself. Allowed any time.
                     Each of the three is independent: setting one leaves the
                     others inherited from the parent task, or the project.
  --agent <profile>  Switch to a different agent profile — an [agents.<name>] block in
                     lazy.toml; harness names (claude-code, codex, cursor, pi) are the
                     built-in profiles.
                     Refused while the task is working (a turn is in flight);
                     wait for it to block or run lazy stop first. Otherwise
                     allowed any time; takes effect next turn. When switching
                     agents mid-task, the session is reset (cannot resume across
                     agents), and model/effort are re-resolved for the new agent
                     unless you also pass --model / --effort on the same command.
                     The task's conversation history is preserved and accessible
                     via lazy tools.

Prompt input priority: --prompt flag > piped stdin > $EDITOR (interactive)

Examples:
  lazy edit abc123                           # Interactive mode
  lazy edit abc123 --goal "New goal"
  lazy edit abc123 --prompt "Updated spec"
  lazy edit abc123 --model opus
  lazy edit abc123 --effort medium           # Dial the next turn down from max
  lazy edit abc123 --type refactor           # Change to refactor task
  lazy edit abc123 --code fix-auth
  lazy edit abc123 --code ""                 # Clear the code
  lazy edit abc123 --parent def45678         # Set parent task
  lazy edit abc123 --parent ""               # Clear parent (reparent to main)
  lazy edit abc123 --agent cursor            # Switch to Cursor agent
  echo "New prompt text" | lazy edit abc123  # Piped stdin as prompt`);
}
