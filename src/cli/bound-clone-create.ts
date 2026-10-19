/**
 * Creating a task from a clone bound to Lazy Teams: ONE daemon `createTask`
 * call, so the task lands whole or not at all.
 *
 * In a bound clone `Storage` is `RemoteStorage`, and Lazy Teams authorizes each
 * storage write on its own. `lazy create` used to create the row and then set
 * the branch target, prompt and settings as separate writes; when Teams refused
 * one (a branch parent), the task was left in the backlog with no prompt.
 * `lazy create`, `--type cluster` and the `lazy fix` / `document` / `refactor`
 * shortcuts all come through here instead. (`lazy raised promote` already is
 * one daemon call.)
 */

import type { Storage } from '../storage/interface';
import type { Task } from '../types';
import { isTerminalStatus } from '../types';
import { queryCreateTask } from '../daemon/rpc-fallback';
import { RpcApplicationError } from '../daemon/client';
import { displayId, displayIdFor, shortId } from '../task/identity';
import { parentTaskIdOf, targetBranchOf } from '../task-target';
import { getActor } from '../constants';
import { removeRecoveryFile } from './editor';

export interface BoundCloneCreateInput {
  goal: string;
  prompt?: string;
  /** The editor's recovery file, removed only once the create landed. */
  promptRecoveryPath?: string | null;
  code?: string;
  type?: string;
  /** Resolved tasks travel as their full id; anything else as a branch name. */
  parentTask?: Task | null;
  parentBranch?: string;
  agent?: string;
  model?: string;
  effort?: string;
  review?: string;
  reviewGate?: string;
  reviewAutoFix?: string;
  tags?: string[];
}

/**
 * Resolve `--parent` for a bound clone. A task is sent as its full id; any
 * other value is sent as a branch name for the daemon to resolve — the branch
 * lives in the team's repository, which this clone need not have fetched.
 * Exits on a finished or ambiguous task, like the local path.
 */
export async function resolveBoundCloneParent(
  storage: Storage,
  parentValue: string,
): Promise<{ parentTask: Task | null; parentBranch?: string }> {
  const resolved = await storage.resolveTask(parentValue);
  if (resolved.task) {
    if (isTerminalStatus(resolved.task.status)) {
      console.error(`Cannot use task ${displayId(resolved.task)} as parent: task is ${resolved.task.status}`);
      process.exit(1);
    }
    return { parentTask: resolved.task };
  }
  if (resolved.ambiguousMatches?.length) {
    console.error(`Ambiguous parent '${parentValue}'. Matches: ${resolved.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ')}`);
    process.exit(1);
  }
  return { parentTask: null, parentBranch: parentValue };
}

/** Create through the daemon and print the created task. Exits 1 on refusal. */
export async function createTaskFromBoundClone(storage: Storage, input: BoundCloneCreateInput): Promise<Task> {
  let taskId: string;
  try {
    const result = await queryCreateTask({
      goal: input.goal,
      prompt: input.prompt || undefined,
      code: input.code,
      parent: input.parentTask?.id ?? input.parentBranch,
      type: input.type,
      model: input.model,
      effort: input.effort,
      agent: input.agent,
      review: input.review,
      reviewGate: input.reviewGate,
      reviewAutoFix: input.reviewAutoFix,
      tags: input.tags && input.tags.length > 0 ? input.tags : undefined,
      // `lazy create` never invents a code; only the web form promises one.
      deriveCode: false,
      actor: getActor(),
    });
    taskId = result.taskId;
  } catch (err) {
    const message = err instanceof RpcApplicationError || err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    console.error('No task was created.');
    if (input.promptRecoveryPath) {
      console.error(`Your prompt is saved in ${input.promptRecoveryPath}`);
    }
    process.exit(1);
  }
  if (input.promptRecoveryPath) removeRecoveryFile(input.promptRecoveryPath);

  const t = await storage.getTask(taskId);
  if (!t) throw new Error(`task ${taskId} was created but could not be read back`);
  console.log(`Created task ${displayId(t)}`);
  console.log(`  Goal:   ${t.goal}`);
  console.log(`  Status: ${t.status}`);
  console.log(`  ID:     ${t.id}`);
  if (t.code) console.log(`  Code:   ${t.code}`);
  const parentId = parentTaskIdOf(t);
  if (parentId) {
    console.log(`  Parent: ${await displayIdFor(storage, parentId)}`);
  } else if (input.parentBranch) {
    console.log(`  Target: branch ${targetBranchOf(t) ?? input.parentBranch}`);
  }
  if (t.type !== 'task') console.log(`  Type:   ${t.type}`);
  if (t.agent_id) console.log(`  Agent:  ${t.agent_id}`);
  if (t.prompt) console.log(`  Prompt: v1 (${t.prompt.length} chars)`);
  if (input.model) console.log(`  Model:  ${t.model ?? input.model}`);
  if (input.effort) console.log(`  Effort: ${input.effort}`);
  if (t.tags.length > 0) console.log(`  Tags:   ${t.tags.map(tg => '#' + tg).join(' ')}`);
  return t;
}

/**
 * `lazy fix` / `document` / `refactor` in a bound clone: the shortcut's
 * prompt (the person's words plus its constraints) and type, created in one
 * daemon call. Their `--parent` names a task only, as on the local path.
 */
export async function createShortcutTaskFromBoundClone(storage: Storage, input: {
  type: 'fix' | 'document' | 'refactor';
  goal: string;
  fullPrompt: string;
  promptRecoveryPath: string | null;
  code?: string;
  parentValue?: string;
  model: string | null;
}): Promise<void> {
  let parent: Task | null = null;
  if (input.parentValue !== undefined) {
    const { resolveTaskOrExit } = await import('./helpers');
    parent = await resolveTaskOrExit(storage, input.parentValue);
    if (isTerminalStatus(parent.status)) {
      console.error(`Cannot use task ${displayId(parent)} as parent: task is ${parent.status}`);
      process.exit(1);
    }
  }
  const { loadConfig } = await import('../config/loader');
  const { resolveAgentForNewTaskFromConfig } = await import('../agent/task-agent');
  const { agentToSend, requireLazyRoot } = await import('./helpers');
  const agentResolution = resolveAgentForNewTaskFromConfig(
    { inheritFrom: parent, taskType: input.type },
    (await loadConfig(requireLazyRoot())).agent,
    await storage.getProjectSettings(),
  );
  const t = await createTaskFromBoundClone(storage, {
    goal: input.goal,
    prompt: input.fullPrompt,
    promptRecoveryPath: input.promptRecoveryPath,
    code: input.code,
    type: input.type,
    parentTask: parent,
    agent: await agentToSend(agentResolution),
    model: input.model ?? undefined,
  });
  console.log(`\nStart working on it with: lazy start ${displayId(t)}`);
}

/**
 * Refuse, before anything is written, a create a bound clone cannot finish:
 * `lazy rework` / `lazy revert` record provenance keys (`rework_of`,
 * `reverts_task_id`) Lazy Teams does not let a member set — the browser has
 * neither act — so going ahead would leave a half-made task behind.
 */
export async function refuseCreateInBoundClone(command: string): Promise<void> {
  const { isBoundClone } = await import('./helpers');
  if (!(await isBoundClone())) return;
  console.error(`\`lazy ${command}\` cannot run from a clone logged in to Lazy Teams: the install does not offer it, and it would leave a half-made task.`);
  console.error('No task was created. Run `lazy logout` to work locally, or create the task with `lazy create`.');
  process.exit(1);
}
