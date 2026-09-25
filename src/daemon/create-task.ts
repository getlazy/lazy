/**
 * Create a task — ONE implementation behind the web New-task form.
 *
 * CLI `lazy create` and MCP `lazy_create` still open storage themselves this
 * slice (same posture as clone-redo). The web never does: it calls this
 * through TaskActions. Validation, parent resolution, agent resolution and
 * code derivation all live here so the form cannot grow a second copy.
 *
 * A blank code is not "no code": the form promises a suggestion from the
 * goal, so this applies {@link deriveCode} when the caller omitted one.
 * CLI create is unchanged — it only sends a code when `--code` was passed.
 */

import { pinChosenEffort } from './effort';
import {
  REVIEW_GATE_INPUTS,
  REVIEW_MODE_INPUTS,
  REVIEW_TOGGLE_INPUTS,
  parseReviewGate,
  parseReviewMode,
  parseReviewToggle,
  reviewOverrideMetadata,
  type ReviewSettingsOverrides,
} from '../review/mode';
import type { Task, TaskType } from '../types';
import { isTerminalStatus, VALID_TASK_TYPES, invalidTaskTypeMessage } from '../types';
import type { Storage } from '../storage/interface';
import type { ActorInput } from '../types';
import type { EffortLevel } from '../config/types';
import { VALID_EFFORT_LEVELS } from '../config/types';
import { branchTarget } from '../task-target';
import { looksLikeTaskBranch } from '../git/branch-prefix';
import { loadConfig } from '../config/loader';
import { resolveAgentForNewTaskFromConfig } from '../agent/task-agent';
import { assertAgentProfileRunnable, assertKnownAgentProfile } from './agent-profile-check';
import { inheritCustomImageMetadata } from '../docker/worktree-image';
import { deriveCode, displayId, shortId, validateCode } from '../task/identity';
import { sanitizeUserText } from '../utils/sanitize-text';
import { runGit } from '../utils/git';
import { RpcError } from './rpc-error';

export interface CreateTaskInput {
  goal: string;
  prompt?: string;
  code?: string;
  parent?: string;
  type?: string;
  model?: string;
  effort?: string;
  /** Review mode for the new task (off | low-high | separate). Pinned on the task. */
  review?: string;
  /** When a recorded review gates (auto | always | never). Pinned on the task. */
  reviewGate?: string;
  /** Whether a separate review auto-fixes (on | off). Pinned on the task. */
  reviewAutoFix?: string;
  agent?: string;
  actor?: ActorInput;
}

export interface CreateTaskResult {
  taskId: string;
  displayId: string;
  /** True when a code was filled in from the goal rather than typed. */
  derivedCode: boolean;
  /**
   * Follow-up writes (prompt, model, effort, branch target, image pin)
   * that failed after the task row existed. The task is real; these are
   * what did not stick. Empty when every write landed.
   */
  warnings: string[];
}

/**
 * Persist a new backlog task. Throws {@link RpcError} for caller mistakes.
 *
 * Every field is validated before any write, so a bad effort cannot leave a
 * half-created task the way a per-field write-then-check would.
 */
export async function createTask(
  storage: Storage,
  projectRoot: string,
  input: CreateTaskInput,
): Promise<CreateTaskResult> {
  // Intake: strip the argv-fatal control characters the start prompt would
  // otherwise carry. Goal is a one-liner (no annotation); the prompt keeps
  // the substitution note so the agent can see what changed.
  const goal = sanitizeUserText(input.goal, { annotate: false }).trim();
  if (!goal) {
    throw new RpcError(400, 'The goal cannot be empty.');
  }
  const prompt = input.prompt !== undefined
    ? sanitizeUserText(input.prompt)
    : '';

  const typeValue = input.type?.trim();
  let taskType: TaskType | undefined;
  if (typeValue) {
    if (!VALID_TASK_TYPES.includes(typeValue as TaskType)) {
      throw new RpcError(400, invalidTaskTypeMessage(typeValue));
    }
    taskType = typeValue as TaskType;
  }

  const effortValue = input.effort?.trim();
  if (effortValue && !VALID_EFFORT_LEVELS.includes(effortValue as EffortLevel)) {
    throw new RpcError(400, `Invalid effort '${effortValue}'. Must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`);
  }

  // Validated before any write, like effort above: a bad value must not leave a
  // task row behind carrying a setting nobody chose. Only what was SUPPLIED is
  // recorded; the rest stays inherited (task > parent task > project).
  const reviewOverrides: ReviewSettingsOverrides = {};
  const reviewInput = input.review?.trim();
  if (reviewInput) {
    const mode = parseReviewMode(reviewInput);
    if (!mode) {
      throw new RpcError(400, `Invalid review mode '${reviewInput}'. Must be one of: ${REVIEW_MODE_INPUTS.join(', ')}`);
    }
    reviewOverrides.mode = mode;
  }
  const gateInput = input.reviewGate?.trim();
  if (gateInput) {
    const gate = parseReviewGate(gateInput);
    if (!gate) {
      throw new RpcError(400, `Invalid review gate '${gateInput}'. Must be one of: ${REVIEW_GATE_INPUTS.join(', ')}`);
    }
    reviewOverrides.gate = gate;
  }
  const autoFixInput = input.reviewAutoFix?.trim();
  if (autoFixInput) {
    const autoFix = parseReviewToggle(autoFixInput);
    if (autoFix === null) {
      throw new RpcError(400, `Invalid review auto-fix '${autoFixInput}'. Must be one of: ${REVIEW_TOGGLE_INPUTS.join(', ')}`);
    }
    reviewOverrides.auto_fix = autoFix;
  }

  const modelValue = input.model?.trim();
  if (input.model !== undefined && input.model !== '' && !modelValue) {
    throw new RpcError(400, 'Model name cannot be empty.');
  }

  const agentValue = input.agent?.trim() || undefined;
  await assertKnownAgentProfile(projectRoot, agentValue);

  const typedCode = input.code?.trim() || '';
  let code: string | undefined;
  let derivedCode = false;
  if (typedCode) {
    const codeError = validateCode(typedCode);
    if (codeError) {
      throw new RpcError(400, `Invalid code '${typedCode}': ${codeError}`);
    }
    code = typedCode;
  } else {
    // Suggestion the form advertised: a kebab-case slug from the goal, when
    // the goal itself is a valid code. Too-short or reserved goals stay
    // uncoded (the short id is the address) rather than inventing padding.
    const suggested = deriveCode(goal);
    if (suggested) {
      code = suggested;
      derivedCode = true;
    }
  }

  const parentValue = input.parent?.trim() || '';
  let parentTaskId: string | undefined;
  let parentTask: Task | null = null;
  let explicitBranchTarget: string | undefined;
  if (parentValue) {
    // A value beginning with `-` is a git option, not a ref. Reject before
    // resolveTask (a code/id never starts with `-`) and before rev-parse,
    // and pass `--` anyway so a later edit cannot reintroduce the hole.
    if (parentValue.startsWith('-')) {
      throw new RpcError(
        400,
        `Parent '${parentValue}' is not a task or branch name — names cannot start with '-'.`,
      );
    }
    const resolved = await storage.resolveTask(parentValue);
    if (resolved.task) {
      if (isTerminalStatus(resolved.task.status)) {
        throw new RpcError(
          400,
          `Cannot use task ${displayId(resolved.task)} as parent: task is ${resolved.task.status}`,
        );
      }
      parentTaskId = resolved.task.id;
      parentTask = resolved.task;
    } else if (resolved.ambiguousMatches?.length) {
      throw new RpcError(
        400,
        `Ambiguous parent '${parentValue}'. Matches: ${resolved.ambiguousMatches.map((t) => `${shortId(t.id)} (${t.goal})`).join(', ')}`,
      );
    } else {
      // Same fall-through as `lazy create --parent` / `lazy reparent`: not a
      // task, so it must be a local integration branch, not a typo and not a
      // lazy/ task branch.
      const verify = await runGit(
        ['rev-parse', '--verify', '--quiet', '--', parentValue],
        { cwd: projectRoot },
      );
      if (verify.exitCode !== 0) {
        throw new RpcError(400, `Parent '${parentValue}' is neither a known task nor a local git branch.`);
      }
      if (looksLikeTaskBranch(parentValue)) {
        throw new RpcError(400, `Parent must be an integration branch, not a lazy task branch ('${parentValue}').`);
      }
      explicitBranchTarget = parentValue;
    }
  }

  const [config, projectSettings] = await Promise.all([
    loadConfig(projectRoot),
    storage.getProjectSettings(),
  ]);
  const agentResolution = resolveAgentForNewTaskFromConfig(
    {
      explicit: agentValue,
      inheritFrom: parentTask,
      taskType: taskType ?? 'task',
    },
    config.agent,
    projectSettings,
  );
  // The agent this task would actually RUN on — after inheritance and
  // `[agent.by_type]`, not the one that was typed — because a task inheriting
  // an unrunnable agent from its parent is just as dead as one that named it.
  await assertAgentProfileRunnable(projectRoot, agentResolution.agentId);

  let created: Task;
  try {
    created = await storage.createTask(
      goal,
      parentTaskId,
      undefined,
      code,
      taskType,
      agentResolution.agentId,
      input.actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Duplicate-code is a caller mistake (they typed a taken slug). Anything
    // else is a write failure — do not dress it up as a 400.
    if (isDuplicateCodeError(message)) {
      throw new RpcError(400, message);
    }
    throw new Error(`failed to create task: ${message}`, { cause: err instanceof Error ? err : undefined });
  }

  // The row exists. Prompt / model / effort / branch target / image pin are
  // separate writes; a failure here must not look like "create never happened"
  // (a form re-display would duplicate the row on retry). Collect and return.
  const warnings: string[] = [];
  const followUp = async (label: string, work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`${label}: ${message}`);
    }
  };
  if (explicitBranchTarget) {
    await followUp('Could not set the branch parent', () =>
      storage.updateTaskTarget(created.id, branchTarget(explicitBranchTarget)));
  }
  if (prompt.trim()) {
    await followUp('Could not save the prompt', () =>
      storage.updateTaskPrompt(created.id, prompt));
  }
  if (modelValue) {
    await followUp('Could not save the model', () =>
      storage.updateTaskModel(created.id, modelValue));
  }
  if (effortValue) {
    await followUp('Could not save the effort', () =>
      pinChosenEffort(storage, created.id, effortValue));
  }
  for (const [key, value] of Object.entries(reviewOverrideMetadata(reviewOverrides))) {
    await followUp('Could not save the review settings', () =>
      storage.updateTaskMetadata(created.id, key, value));
  }
  // Subtasks inherit a parent's consented image pin. The web never offers
  // the TTY pin prompt — that stays CLI-only.
  if (parentTask) {
    await followUp('Could not inherit the parent image pin', () =>
      inheritCustomImageMetadata(storage, created.id, parentTask));
  }

  // Re-read so displayId sees a code we derived and any target write.
  const fresh = await storage.getTask(created.id);
  const task = fresh ?? created;
  return {
    taskId: task.id,
    displayId: displayId(task),
    derivedCode,
    warnings,
  };
}

/** FileStorage's exact refusal when a non-terminal task already holds this code. */
export function isDuplicateCodeError(message: string): boolean {
  return /^A task with code '.+' already exists\b/.test(message);
}
