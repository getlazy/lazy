/**
 * Create a task — ONE implementation behind the web New-task form.
 *
 * The web calls this through TaskActions, and so does Lazy Teams' New-task
 * form. A clone bound to Teams calls it for `lazy create` and the `lazy fix` /
 * `document` / `refactor` shortcuts (`src/cli/bound-clone-create.ts`), and a
 * bound clone's MCP `lazy_create` does too. A local CLI and local MCP
 * `lazy_create` still open storage themselves.
 *
 * ONE storage write creates the task with everything it starts with (see
 * `NewTaskInitialState`): it lands whole or leaves nothing behind.
 * Validation, parent resolution, agent resolution and code derivation all
 * live here so the form cannot grow a second copy.
 *
 * A blank code is not "no code": the form promises a suggestion from the
 * goal, so this applies {@link deriveCode} when the caller omitted one. The
 * CLI sends `deriveCode: false` — it only has a code when `--code` was passed.
 */

import { chosenEffortMetadata } from './effort';
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
import { resolveBranchParent } from '../task/branch-parent';
import { normalizeTag } from '../utils/tags';
import { loadConfig } from '../config/loader';
import { resolveAgentForNewTaskFromConfig } from '../agent/task-agent';
import { assertAgentProfileRunnable, assertKnownAgentProfile } from './agent-profile-check';
import { assertNoModelOnTiered } from '../agent/tiered-model';
import { inheritedCustomImageMetadata } from '../docker/worktree-image';
import { deriveCode, displayId, shortId, validateCode } from '../task/identity';
import { sanitizeUserText } from '../utils/sanitize-text';
import { RpcError } from './rpc-error';

/** A full task id, any case — the shape Lazy Teams reads as a task parent. */
const TASK_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  /** Tags for the new task, written with it (normalized here). */
  tags?: string[];
  /**
   * Fill a blank code in from the goal (the web form's promise). `false` keeps
   * a blank code blank — what `lazy create` without `--code` has always done.
   */
  deriveCode?: boolean;
  actor?: ActorInput;
}

export interface CreateTaskResult {
  taskId: string;
  displayId: string;
  /** True when a code was filled in from the goal rather than typed. */
  derivedCode: boolean;
  /**
   * Always empty now: every field is written with the row, so a create lands
   * whole or not at all. Kept on the wire because clients read it.
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
  } else if (input.deriveCode !== false) {
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
    // resolveTask (a code/id never starts with `-`) and before any git call;
    // `resolveBranchParent` also checks the name with `check-ref-format`.
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
    } else if (TASK_ID_SHAPE.test(parentValue)) {
      // A full task id that names no task is a missing task, never a branch.
      // Lazy Teams picks the bar a create must pass from this same shape
      // (`CliRpcCommand.branch_parent?`): an id-shaped parent gets the New-task
      // form's, a branch parent "Move under another task"'s as well. Falling
      // through to the branch lookup here would let a branch pushed under an
      // id-shaped name be targeted past the bar Teams meant for it.
      throw new RpcError(404, `Parent task not found: ${parentValue}`);
    } else {
      // Same fall-through as `lazy create --parent` / `lazy reparent`: not a
      // task, so it must be an integration branch — resolved below, once every
      // other field has been checked, because in managed mode resolving it may
      // fetch it from origin.
      explicitBranchTarget = parentValue;
    }
  }

  const tags: string[] = [];
  for (const raw of input.tags ?? []) {
    const normalized = normalizeTag(raw);
    if (!normalized) {
      throw new RpcError(400, `Invalid tag '${raw}': a tag must contain at least one letter or digit.`);
    }
    if (!tags.includes(normalized)) tags.push(normalized);
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
  if (modelValue) {
    // Before the row exists: a tiered profile picks the model per request.
    try {
      assertNoModelOnTiered(config, agentResolution.agentId, modelValue);
    } catch (err) {
      throw new RpcError(400, err instanceof Error ? err.message : String(err));
    }
  }

  if (explicitBranchTarget) {
    const branch = await resolveBranchParent(projectRoot, explicitBranchTarget);
    if (!branch.ok) {
      throw new RpcError(400, branch.reason === 'task-branch'
        ? `Parent must be an integration branch, not a lazy task branch ('${explicitBranchTarget}').`
        : branch.reason === 'case-collision'
          ? `Parent '${explicitBranchTarget}' differs only in letter case from an existing branch; name that branch exactly.`
          : `Parent '${explicitBranchTarget}' is neither a known task nor a git branch of this project.`);
    }
  }

  // Everything the task starts with is written WITH its row: a create either
  // lands whole or leaves nothing behind. It used to be a row followed by
  // separate writes, and when one of those failed (or, from a clone bound to
  // Lazy Teams, was refused) the task was left in the backlog with no prompt.
  const metadata: Record<string, string> = {
    ...(parentTask ? inheritedCustomImageMetadata(parentTask) : {}),
    ...(effortValue ? chosenEffortMetadata(effortValue) : {}),
    ...reviewOverrideMetadata(reviewOverrides),
  };

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
      {
        targetBranch: explicitBranchTarget,
        prompt: prompt.trim() ? prompt : undefined,
        model: modelValue || undefined,
        metadata,
        tags,
      },
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

  return {
    taskId: created.id,
    displayId: displayId(created),
    derivedCode,
    warnings: [],
  };
}

/** FileStorage's exact refusal when a non-terminal task already holds this code. */
export function isDuplicateCodeError(message: string): boolean {
  return /^A task with code '.+' already exists\b/.test(message);
}
