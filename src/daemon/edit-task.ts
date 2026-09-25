/**
 * Task edit business logic — ONE implementation behind `lazy edit`, MCP
 * `lazy_edit`, and the `editTask` RPC.
 *
 * The rules here mirror `src/cli/commands/edit.ts`: goal/prompt/type/code/parent
 * are locked once a task has turns; model/effort/agent (and runner) may change
 * on a started task but not combined with a locked-field edit in one write.
 */

import { pinChosenEffort } from './effort';
import type { ActorInput, Task, TaskType } from '../types';
import { isTerminalStatus, VALID_TASK_TYPES, invalidTaskTypeMessage } from '../types';
import type { Storage } from '../storage/interface';
import type { EffortLevel } from '../config/types';
import { parentTaskIdOf, taskTarget, branchTarget } from '../task-target';
import { taskEditability } from '../task-edit-rules';
import { resolveRunnerType, RUNNER_ALIAS_HINT, VALID_EFFORT_LEVELS } from '../config/types';
import { hostRunnerRemovedMessage, isRemovedHostRunnerInput } from '../runner/host-runner-gate';
import { assertKnownAgentProfile } from './agent-profile-check';
import { loadConfig } from '../config/loader';
import { resolveProjectModel } from './project-settings';
import { switchTaskAgent, formatAgentSwitchAnnouncement } from './agent-switch';
// validateModel() is deliberately NOT imported here — see the validation block
// below: it exits the process on an empty value, which in the daemon would exit
// the daemon.
import { validateCode, displayId } from '../task/identity';
import { logger } from '../utils/logger';
import { RpcError } from './rpc-error';

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

  const hasLockedFieldEdit =
    input.goal !== undefined ||
    input.prompt !== undefined ||
    input.type !== undefined ||
    input.code !== undefined ||
    input.parent !== undefined;

  const hasMidFlightEdit =
    input.model !== undefined ||
    input.effort !== undefined ||
    input.runner !== undefined ||
    input.agent !== undefined;

  const isMidFlightSafeEdit = hasMidFlightEdit && !hasLockedFieldEdit;

  if (!editability.canEditLockedFields && !isMidFlightSafeEdit && (hasLockedFieldEdit || hasMidFlightEdit)) {
    throw new RpcError(
      400,
      `Cannot edit task ${displayId(task)}: task has already been started; only model, effort, runner and agent can be changed (not combined with goal/prompt/type/code/parent).`,
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
  // daemon (CLAUDE.md, "process.exit() belongs to CLI commands"). Every
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
  }
  await assertKnownAgentProfile(projectRoot, input.agent);
  if (input.runner !== undefined && input.runner !== null && input.runner !== '') {
    if (isRemovedHostRunnerInput(input.runner)) {
      throw new RpcError(400, hostRunnerRemovedMessage('per-task runner'));
    }
    if (!resolveRunnerType(input.runner)) {
      throw new RpcError(400, `Invalid runner '${input.runner}'. Must be one of: ${RUNNER_ALIAS_HINT}`);
    }
  }
  if (input.model !== undefined && !input.model.trim()) {
    throw new RpcError(400, 'Model name cannot be empty');
  }

  const changes: string[] = [];
  const announcements: string[] = [];

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

  return {
    taskId: task.id,
    displayId: displayId(task),
    changes,
    ...(announcements.length > 0 ? { announcements } : {}),
  };
}
