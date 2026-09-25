/**
 * What a task RUNS ON, rendered for a human — agent profile, model, effort.
 *
 * A display-only sibling of `resolveTurnLaunchIdentity` (src/daemon/launch-
 * identity.ts): the same ladder, the same helpers, but it writes nothing and it
 * carries the PROVENANCE of each value, to the limited extent the task record
 * knows it. A surface showing only the winning value cannot be honest about a
 * task that has never recorded one — the effective effort of an unstarted task
 * is `[agent] effort` from lazy.toml, and printing it bare hides that entirely.
 *
 * The distinction it CAN draw is "recorded on the task" vs "resolved from
 * config", and that is all any caller may claim from it — see
 * {@link LaunchIdentitySource}.
 *
 * Never used to decide a launch. The launch resolver persists; this one is a
 * read, so the two must not be confused: if this file ever needs a write, the
 * caller is asking the wrong function.
 */

import type { Task } from '../types';
import type { ResolvedConfig } from '../config/types';
import { resolveAgentModel, taskModelChoice } from '../agent/agent-model';
import { agentProfilesFor, profileNameForAgent } from '../config/agent-profiles';

/**
 * Where a displayed value came from — as far as the task record can say.
 *
 * DELIBERATELY NOT "chosen vs defaulted", because the record cannot answer
 * that: the first launch PERSISTS whatever it resolved (resolveTurnLaunchIdentity,
 * resolveAndPersistEffort), and `agent_id` is written at create time from the
 * project default, so a value nobody picked is stored exactly like one a human
 * pinned with `--model`. A surface reading `task` as intent would assert a
 * choice on essentially every started task. Say "recorded", never "set".
 *
 * Recording the real provenance means a new field written on the launch path —
 * a change to the task record, not to a header. It is proposed separately.
 */
export type LaunchIdentitySource =
  /** Present on the task record — pinned by a human OR filled in by a launch. */
  | 'task'
  /** Nothing recorded; this is what lazy.toml (or a built-in default) resolves to. */
  | 'default';

export interface LaunchIdentityItem {
  /** The value actually in force. Never empty. */
  value: string;
  source: LaunchIdentitySource;
  /** Extra provenance worth a tooltip, when the plain source does not say it all. */
  note?: string;
}

export interface TaskLaunchIdentityView {
  /** The `[agents.<name>]` profile the task's turns run on. */
  agent: LaunchIdentityItem;
  model: LaunchIdentityItem;
  effort: LaunchIdentityItem;
}

export interface TaskLaunchIdentityViewOptions {
  task: Task;
  config: ResolvedConfig;
  /**
   * The project-settings overlay's default model, when the deployment set one —
   * `resolveProjectModel(settings, config)`. Same rung as `[models] default`.
   */
  projectModel?: string | null;
}

/**
 * Resolve the agent / model / effort a task's next turn would run on, with the
 * provenance of each. Pure: reads the task record and config, writes nothing.
 */
export function taskLaunchIdentityView(
  opts: TaskLaunchIdentityViewOptions,
): TaskLaunchIdentityView {
  const { task, config, projectModel } = opts;

  return {
    agent: agentItem(task, config),
    model: modelItem(task, config, projectModel),
    effort: effortItem(task, config),
  };
}

/**
 * The model an interactive pair/chat session on this task pins.
 *
 * INVARIANT (turn-model stickiness): a pair session runs exactly what the
 * task's next turn would — the persisted model, else (a task that has never run
 * a turn) its profile's default — resolved on the host by the same rule the
 * launch uses. `lazy pair` used to pin the BUILDER role's model and the web
 * shell passed raw `task.model` (null on a fresh task, which a pi session then
 * refused), so a session could run a model the task's turns never would.
 */
export function pairSessionModel(opts: TaskLaunchIdentityViewOptions): string {
  return modelItem(opts.task, opts.config, opts.projectModel).value;
}

function agentItem(task: Task, config: ResolvedConfig): LaunchIdentityItem {
  const stored = task.agent_id?.trim() ?? '';
  const name = profileNameForAgent(stored);
  // A task record may name a profile lazy.toml no longer defines (renamed or
  // deleted block). Launches are deliberately lenient about that, so say it
  // rather than silently showing a name nothing backs.
  const known = agentProfilesFor(config).has(name);
  const note = known ? undefined : 'no [agents] profile of this name is defined in lazy.toml';
  if (!stored) {
    return { value: name, source: 'default', note };
  }
  return { value: name, source: 'task', note };
}

function modelItem(
  task: Task,
  config: ResolvedConfig,
  projectModel: string | null | undefined,
): LaunchIdentityItem {
  const stored = task.model?.trim() ?? '';
  const resolved = resolveAgentModel(config, {
    overrideModel: taskModelChoice(null, task.model),
    projectModel,
    agentId: task.agent_id,
  });
  if (!stored) return { value: resolved, source: 'default' };
  if (resolved !== stored) {
    // Unreachable through the launch rule (taskModelChoice makes a stored
    // model win everywhere), kept so a future rung that outranks the task is
    // shown honestly rather than hidden. The header shows what would run.
    return {
      value: resolved,
      source: 'default',
      note: `overrides this task's stored model "${stored}"`,
    };
  }
  return { value: resolved, source: 'task' };
}

function effortItem(task: Task, config: ResolvedConfig): LaunchIdentityItem {
  const stored = task.metadata?.effort?.trim() ?? '';
  if (stored) return { value: stored, source: 'task' };
  return { value: config.agent.effort, source: 'default' };
}
