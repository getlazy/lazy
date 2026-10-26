/**
 * Task edit business logic — ONE implementation behind `lazy edit`, MCP
 * `lazy_edit`, and the `editTask` RPC.
 *
 * The rules here mirror `src/cli/commands/edit.ts`: goal/prompt/type/code/parent
 * are locked once a task has turns; model/effort/agent (and runner) may change
 * on a started task but not combined with a locked-field edit in one write.
 */

import { pinChosenEffort } from './effort';
import { assertCodeIsNotARunSlug } from './create-task';
import type { ActorInput, Task, TaskType } from '../types';
import { isTerminalStatus, VALID_TASK_TYPES, invalidTaskTypeMessage } from '../types';
import type { Storage } from '../storage/interface';
import type { EffortLevel } from '../config/types';
import { parentTaskIdOf, taskTarget, branchTarget } from '../task-target';
import { taskEditability } from '../task-edit-rules';
import { resolveRunnerType, RUNNER_ALIAS_HINT, VALID_EFFORT_LEVELS } from '../config/types';
import { hostRunnerRemovedMessage, isRemovedHostRunnerInput, smolvmRefusedInManagedMode } from '../runner/host-runner-gate';
import { assertKnownAgentProfile } from './agent-profile-check';
import { assertNoModelOnTiered } from '../agent/tiered-model';
import { loadConfig } from '../config/loader';
import { resolveProjectModel } from './project-settings';
import { switchTaskAgent, formatAgentSwitchAnnouncement } from './agent-switch';
// validateModel() is deliberately NOT imported here — see the validation block
// below: it exits the process on an empty value, which in the daemon would exit
// the daemon.
import { validateCode, displayId, taskRef } from '../task/identity';
import { taskBranchFor } from '../git/branch-prefix';
import { logger } from '../utils/logger';
import { RpcError } from './rpc-error';
import {
  parseReviewMode, parseReviewGate, parseReviewToggle, reviewOverrideMetadata, reviewOverridesApplied,
  REVIEW_MODE_INPUTS, REVIEW_GATE_INPUTS, REVIEW_TOGGLE_INPUTS,
  type ReviewSettingsOverrides,
} from '../review/mode';

export interface EditTaskInput {
  taskId: string;
  goal?: string;
  prompt?: string;
  model?: string;
  type?: string;
  /** Omit = no change; null or '' = clear */
  code?: string | null;
  /** Omit = no change; null or '' = clear parent (integrate into main) */
  parent?: string | null;
  effort?: string;
  agent?: string;
  review?: string;
  reviewGate?: string;
  reviewAutoFix?: string;
  /** Omit = no change; null or '' = clear runner override */
  runner?: string | null;
  /**
   * WHO is making this edit. Recorded as a journal entry on the task (see
   * {@link recordEditInJournal}) — the Task record itself carries no actor, so
   * without this an edit is the one act on a task nobody can be traced to.
   */
  actor?: ActorInput;
}

export interface EditTaskResult {
  taskId: string;
  displayId: string;
  changes: string[];
  announcements?: string[];
  reviewSettingsApplied?: boolean;
}

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

/**
 * One changed field, as a person reads it: `model → opus`.
 *
 * Values are included where the field HAS a short one, because "model" alone
 * answers a different question than "model → opus" — a reader asking who put
 * this task on the expensive model needs the value. `goal`, `prompt` and
 * `parent` are named without theirs: a prompt is paragraphs (and already
 * versioned, so the text is recoverable), and a goal can be a sentence.
 */
function describeEdit(input: EditTaskInput, field: string): string {
  const cleared = (value: string | null | undefined) => value === null || value === '';
  switch (field) {
    case 'model': return `model → ${input.model}`;
    case 'effort': return `effort → ${input.effort}`;
    case 'type': return `type → ${input.type}`;
    case 'agent': return `agent → ${input.agent}`;
    case 'review': return `review mode → ${input.review}`;
    case 'reviewGate': return `review gate → ${input.reviewGate}`;
    case 'reviewAutoFix': return `review auto-fix → ${input.reviewAutoFix}`;
    case 'runner': return cleared(input.runner) ? 'runner override cleared' : `runner → ${input.runner}`;
    case 'code': return cleared(input.code) ? 'code cleared' : `code → ${input.code}`;
    case 'parent': return cleared(input.parent) ? 'parent cleared (integrates into main)' : `parent → ${input.parent}`;
    default: return field;
  }
}

/**
 * Record an edit as an attributed JOURNAL entry.
 *
 * WHY THE JOURNAL. A task's own record carries no actor, so before this the
 * edit was the one act on a task with nobody behind it — "who put this task on
 * the expensive model?" was unanswerable on a shared project
 * (docs/design/actor-identity-and-remote-clients.md §7.4). The journal is the
 * right home for it rather than a comment: a comment is DELIVERED into the
 * agent's next prompt as guidance, and a model change is not guidance. A
 * journal entry informs whoever looks, and never steers a turn.
 *
 * Best-effort on purpose. The edits are already saved and the caller has
 * already been told which fields changed; failing here would report a refusal
 * for an edit that in fact applied, which is worse than an edit whose
 * attribution is missing from the journal (the failure is logged).
 */
async function recordEditInJournal(
  storage: Storage,
  taskId: string,
  input: EditTaskInput,
  changes: string[],
): Promise<void> {
  const summary = `Task edited: ${changes.map(field => describeEdit(input, field)).join(', ')}`;
  try {
    await storage.appendJournalEntry(taskId, summary, input.actor ?? 'human');
  } catch (err) {
    logger.warn(
      `Task ${taskId.substring(0, 8)} was edited (${changes.join(', ')}) but the journal entry recording it ` +
      `could not be written: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Apply edits to one task. Throws {@link RpcError} for client mistakes and
 * ordinary `Error` for resolution failures the RPC layer maps to 400/404.
 */
export async function editTask(
  storage: Storage,
  projectRoot: string,
  input: EditTaskInput,
): Promise<EditTaskResult> {
  const resolved = await storage.resolveTask(input.taskId);
  if (!resolved.task) {
    if (resolved.ambiguousMatches?.length) {
      throw new RpcError(400, `Ambiguous task id '${input.taskId}' — be more specific`);
    }
    throw new RpcError(404, `Task not found: ${input.taskId}`);
  }
  const task = resolved.task;

  // The predicate is shared with the web UI (src/task-edit-rules.ts) so the
  // form offers exactly what this function will accept; the wording below stays
  // CLI-shaped and is this layer's own.
  const turnCount = await storage.getTurnCountByTaskId(task.id);
  const editability = taskEditability(task.status, turnCount);

  if (editability.terminal) {
    throw new RpcError(
      400,
      `Cannot edit task ${displayId(task)}: task is already ${task.status}.`,
    );
  }

  // A code edit on a STARTED task is a cosmetic rename: `task.code` changes and
  // nothing else. Every name a launch derived — branch, worktree, container and
  // run names, the agent's session store — comes from the pinned
  // `metadata.task_ref` (taskRef in src/task/identity.ts), and a child finds its
  // parent's branch the same way, so none of them move and none break. What is
  // keyed on the CURRENT code by design (`lazy show <code>`, dashboard URLs,
  // `[serve]` hostnames) follows the new code. On its own only, and never a
  // clear: a code is how a person addresses the task.
  const isCosmeticRename = input.code !== undefined && !editability.canEditLockedFields;
  if (isCosmeticRename) {
    const others = Object.entries(input).filter(
      ([k, v]) => v !== undefined && k !== 'code' && k !== 'taskId' && k !== 'actor',
    );
    if (others.length > 0) {
      throw new RpcError(400, `Cannot combine a code change on started task ${displayId(task)} with other edits (${others.map(([k]) => k).join(', ')}) — change the code on its own.`);
    }
    if (input.code === null || input.code === '') {
      throw new RpcError(400, `Cannot clear the code of started task ${displayId(task)} — give it a new code instead.`);
    }
    // [protection].protected_tasks names tasks by code and resolves them at
    // accept time, so renaming a listed task would silently disarm its gate
    // (and hand it to whichever task takes the old code next). A short-id
    // entry survives a rename, so only a code entry refuses.
    if (task.code && input.code !== task.code) {
      const listed = (await loadConfig(projectRoot)).protection.protected_tasks;
      if (listed.includes(task.code)) {
        throw new RpcError(
          409,
          `Cannot rename ${task.code}: it is listed by code in [protection].protected_tasks, and renaming it would leave that entry protecting nothing. ` +
          `Run \`lazy protect ${task.code} off\`, rename, then \`lazy protect ${input.code} on\`.`,
        );
      }
    }
  }

  const hasLockedFieldEdit =
    input.goal !== undefined ||
    input.prompt !== undefined ||
    input.type !== undefined ||
    (input.code !== undefined && !isCosmeticRename) ||
    input.parent !== undefined;

  const hasMidFlightEdit =
    input.model !== undefined ||
    input.effort !== undefined ||
    input.runner !== undefined ||
    input.agent !== undefined ||
    input.review !== undefined || input.reviewGate !== undefined || input.reviewAutoFix !== undefined;

  const isMidFlightSafeEdit = (hasMidFlightEdit || isCosmeticRename) && !hasLockedFieldEdit;

  if (!editability.canEditLockedFields && !isMidFlightSafeEdit && (hasLockedFieldEdit || hasMidFlightEdit)) {
    throw new RpcError(
      400,
      `Cannot edit task ${displayId(task)}: task has already been started; only model, effort, runner, agent and review settings can be changed (not combined with goal/prompt/type/parent), and the code can be changed on its own.`,
    );
  }

  // VALIDATE EVERYTHING BEFORE WRITING ANYTHING.
  //
  // The writes below happen one field at a time, so a validation that lives
  // next to its own write leaves the earlier fields already saved when a later
  // one is rejected. That was visible the moment a surface could submit several
  // fields at once: a web form carrying a rewritten prompt and a bad effort
  // value stored the prompt (as a new version) and then answered "that edit
  // could not be saved" — a refusal that had in fact half-applied.
  //
  // This block is the ONLY place these fields are validated — the checks that
  // used to sit next to each write are gone, so there is one obvious thing to
  // read and nothing to keep in sync. Do not re-add a per-field check next to
  // its write: that is the arrangement that produced the half-apply above.
  //
  // Parent is the one field still validated at its write: its checks are
  // storage lookups (resolve, terminal, cycle), and it is the last write
  // anyway. That leaves a residual — a prompt edit combined with an invalid
  // parent still half-applies. Recorded as a follow-up rather than fixed here,
  // because closing it properly means the writes become one atomic storage
  // operation, which is a different change.
  //
  // The empty-model check is what lets the writes below use input.model
  // directly instead of validateModel(): that is a CLI helper which prints and
  // calls process.exit(1) on an empty value, and in the daemon that exits the
  // daemon (AGENTS.md, "process.exit() belongs to CLI commands"). Every
  // non-CLI surface — RPC, MCP, the web edit form — funnels through here.
  if (input.goal !== undefined && !input.goal.trim()) {
    throw new RpcError(400, 'goal cannot be empty');
  }
  if (input.effort !== undefined && !VALID_EFFORT_LEVELS.includes(input.effort as EffortLevel)) {
    throw new RpcError(400, `Invalid effort '${input.effort}'. Must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`);
  }
  if (input.type !== undefined && !VALID_TASK_TYPES.includes(input.type as TaskType)) {
    throw new RpcError(400, invalidTaskTypeMessage(String(input.type)));
  }
  if (input.code !== undefined && input.code !== null && input.code !== '') {
    const codeError = validateCode(input.code);
    if (codeError) {
      throw new RpcError(400, `Invalid code: ${codeError}`);
    }
    await assertCodeFree(storage, task, input.code);
    // Nor a code that is a running commit's address (src/daemon/commit-run.ts):
    // checked here, before any write, so a refused rename edits nothing. The
    // store refuses it again inside its lock.
    if (input.code !== task.code) await assertCodeIsNotARunSlug(storage, input.code);
  }
  await assertKnownAgentProfile(projectRoot, input.agent);
  if (input.model !== undefined && input.model !== null && input.model !== '') {
    // Before any write: a model on a task whose (new) profile is tiered is
    // refused (src/agent/tiered-model.ts).
    try {
      assertNoModelOnTiered(await loadConfig(projectRoot), input.agent ?? task.agent_id, input.model);
    } catch (err) {
      throw new RpcError(400, err instanceof Error ? err.message : String(err));
    }
  }
  if (input.runner !== undefined && input.runner !== null && input.runner !== '') {
    if (isRemovedHostRunnerInput(input.runner)) {
      throw new RpcError(400, hostRunnerRemovedMessage('per-task runner'));
    }
    const resolvedRunner = resolveRunnerType(input.runner);
    if (!resolvedRunner) {
      throw new RpcError(400, `Invalid runner '${input.runner}'. Must be one of: ${RUNNER_ALIAS_HINT}`);
    }
    const managedRefusal = smolvmRefusedInManagedMode(resolvedRunner);
    if (managedRefusal) throw new RpcError(400, managedRefusal);
  }
  if (input.model !== undefined && !input.model.trim()) {
    throw new RpcError(400, 'Model name cannot be empty');
  }

  const reviewOverrides: ReviewSettingsOverrides = {};
  if (input.review !== undefined) {
    const mode = parseReviewMode(input.review);
    if (!mode) throw new RpcError(400, `Invalid review mode '${input.review}'. Must be one of: ${REVIEW_MODE_INPUTS.join(', ')}`);
    reviewOverrides.mode = mode;
  }
  if (input.reviewGate !== undefined) {
    const gate = parseReviewGate(input.reviewGate);
    if (!gate) throw new RpcError(400, `Invalid review gate '${input.reviewGate}'. Must be one of: ${REVIEW_GATE_INPUTS.join(', ')}`);
    reviewOverrides.gate = gate;
  }
  if (input.reviewAutoFix !== undefined) {
    const autoFix = parseReviewToggle(input.reviewAutoFix);
    if (autoFix === null) throw new RpcError(400, `Invalid review auto-fix '${input.reviewAutoFix}'. Must be one of: ${REVIEW_TOGGLE_INPUTS.join(', ')}`);
    reviewOverrides.auto_fix = autoFix;
  }

  const changes: string[] = [];
  const announcements: string[] = [];
  for (const [key, value] of Object.entries(reviewOverrideMetadata(reviewOverrides))) {
    await storage.updateTaskMetadata(task.id, key, value);
  }
  if (input.review !== undefined) changes.push('review');
  if (input.reviewGate !== undefined) changes.push('reviewGate');
  if (input.reviewAutoFix !== undefined) changes.push('reviewAutoFix');

  // Runner — changeable any time; takes effect next turn.
  if (input.runner !== undefined) {
    if (input.runner === null || input.runner === '') {
      await storage.updateTaskRunnerType(task.id, null);
      changes.push('runner');
    } else {
      // Validated above; resolveRunnerType is called here for the canonical
      // value it returns, not as a check.
      await storage.updateTaskRunnerType(task.id, resolveRunnerType(input.runner)!);
      changes.push('runner');
    }
  }

  // Agent switch — may consume co-supplied model/effort.
  let modelHandledByAgentSwitch = false;
  let effortHandledByAgentSwitch = false;

  if (input.agent !== undefined) {
    const coModel = input.model;

    if (input.agent !== task.agent_id) {
      const config = await loadConfig(projectRoot);
      const projectSettings = await storage.getProjectSettings();
      const switchResult = await switchTaskAgent({
        storage,
        task,
        newAgentId: input.agent,
        config,
        projectModel: resolveProjectModel(projectSettings, config),
        modelOverride: coModel,
        effortOverride: input.effort as EffortLevel | undefined,
      });
      announcements.push(...formatAgentSwitchAnnouncement(switchResult));
      if (coModel !== undefined) modelHandledByAgentSwitch = true;
      if (input.effort !== undefined) effortHandledByAgentSwitch = true;
    }
    changes.push('agent');
  }

  if (input.goal !== undefined) {
    await storage.updateTaskGoal(task.id, input.goal.trim());
    changes.push('goal');
  }

  if (input.prompt !== undefined) {
    await storage.updateTaskPrompt(task.id, input.prompt);
    changes.push('prompt');
  }

  if (input.model !== undefined && !modelHandledByAgentSwitch) {
    await storage.updateTaskModel(task.id, input.model);
    changes.push('model');
  }

  if (input.effort !== undefined && !effortHandledByAgentSwitch) {
    await pinChosenEffort(storage, task.id, input.effort);
    changes.push('effort');
  }

  if (input.type !== undefined) {
    await storage.updateTaskType(task.id, input.type as TaskType);
    changes.push('type');
  }

  if (input.code !== undefined) {
    await storage.updateTaskCode(task.id, input.code === '' ? null : input.code);
    changes.push('code');
    if (isCosmeticRename && input.code !== task.code) {
      const branch = (await storage.getSessionByTaskId(task.id))?.git_branch || taskBranchFor(taskRef(task));
      announcements.push(
        `Renamed ${displayId(task)} → ${input.code}. Its branch (${branch}), worktree, container and any PR/MR keep their old names; ` +
        'links, service hostnames and lookups now use the new code.',
      );
    }
  }

  if (input.parent !== undefined) {
    if (input.parent === null || input.parent === '') {
      await storage.updateTaskTarget(task.id, branchTarget('main'));
    } else {
      const parentResolved = await storage.resolveTask(input.parent);
      if (!parentResolved.task) {
        throw new RpcError(404, `Parent task not found: ${input.parent}`);
      }
      const parentTask = parentResolved.task;

      if (parentTask.id === task.id) {
        throw new RpcError(400, 'Cannot set task as its own parent');
      }
      if (isTerminalStatus(parentTask.status)) {
        throw new RpcError(
          400,
          `Cannot use task ${displayId(parentTask)} as parent: task is ${parentTask.status}`,
        );
      }
      if (await wouldCreateCycle(storage, task.id, parentTask.id)) {
        throw new RpcError(400, 'Cannot set parent: would create a circular parent chain');
      }
      await storage.updateTaskTarget(task.id, taskTarget(parentTask.id));
    }
    changes.push('parent');
  }

  if (changes.length === 0) {
    return {
      taskId: task.id,
      displayId: displayId(task),
      changes: [],
    };
  }

  await recordEditInJournal(storage, task.id, input, changes);

  let reviewSettingsApplied = true;
  if (Object.keys(reviewOverrides).length > 0) {
    try {
      const saved = await storage.getTask(task.id);
      reviewSettingsApplied = reviewOverridesApplied(reviewOverrides, saved?.metadata);
    } catch (err) {
      logger.warn(`Could not confirm review settings on ${displayId(task)} after edit: ${err instanceof Error ? err.message : String(err)}`);
      reviewSettingsApplied = false;
    }
  }

  return {
    taskId: task.id,
    displayId: displayId(task),
    changes,
    reviewSettingsApplied,
    ...(announcements.length > 0 ? { announcements } : {}),
  };
}

/**
 * The collision rule shared with create: no two live tasks share a code. Every
 * surface that sets a code (daemon edit, `lazy edit`, `lazy_edit`) calls this,
 * so the rule lives once.
 */
export async function assertCodeFree(storage: Storage, task: Task, code: string): Promise<void> {
  const clash = code === task.code
    ? undefined
    : (await storage.listTasks()).find(t => t.id !== task.id && t.code === code && !isTerminalStatus(t.status));
  if (clash) {
    throw new RpcError(
      409,
      `A task with code '${code}' already exists (${clash.id.slice(0, 8)}, status: ${clash.status}). ` +
      'Choose a different code or close/reject the existing task first.',
    );
  }
}
