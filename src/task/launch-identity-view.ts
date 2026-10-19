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
import {
  agentProfilesFor,
  NO_CREDENTIAL,
  profileCredentialName,
  profileNameForAgent,
  type AgentProfile,
} from '../config/agent-profiles';

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

/** One tier of a tiered profile, as the header shows it. */
export interface LaunchIdentityTier {
  endpoint: string;
  model: string;
  /** Upstream URL of this tier. */
  url: string;
  /** Credential NAME this tier spends; null when it spends none. */
  credential: string | null;
  /** Usage percent at which the tier counts as full; null when unconditional. */
  threshold: number | null;
}

/**
 * The rung a model or effort came from. Finer than {@link LaunchIdentitySource}
 * (which stays two-valued for the existing items): `profile` is the profile's
 * own `model`, `project` is the harness default / `[models] default` / the
 * project-settings overlay.
 */
export type LaunchIdentityOrigin = 'task' | 'profile' | 'project';

/**
 * The resolved profile behind `agent`: what the launch reads from lazy.toml at
 * each turn. The ANSWER, so no client resolves a profile itself. Never carries a
 * secret — only the credential's NAME.
 */
export interface LaunchIdentityProfile {
  name: string;
  /** False when the task names a profile lazy.toml no longer defines. */
  found: boolean;
  /** True for a built-in, false for an `[agents.<name>]` block; null when not found. */
  builtin: boolean | null;
  harness: string | null;
  /** Named `[endpoints.<name>]` the profile runs against, when it names one. */
  endpoint_name: string | null;
  /** Upstream URL, or null for "the harness default". */
  endpoint_url: string | null;
  /** Credential NAME the profile spends; null when it spends none or is missing. */
  credential: string | null;
  /** Ordered tiers of a tiered profile, else null. The shown model is then never sent. */
  tiers: LaunchIdentityTier[] | null;
  model_origin: LaunchIdentityOrigin;
  /** Effort is never a profile key, so this is `task` or `project`. */
  effort_origin: LaunchIdentityOrigin;
}

export interface TaskLaunchIdentityView {
  /** The `[agents.<name>]` profile the task's turns run on. */
  agent: LaunchIdentityItem;
  model: LaunchIdentityItem;
  effort: LaunchIdentityItem;
  /** Absent only on a view built without profile detail; renderers fall back to `agent`. */
  profile?: LaunchIdentityProfile;
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

  const model = modelItem(task, config, projectModel);
  const effort = effortItem(task, config);
  return {
    agent: agentItem(task, config),
    model,
    effort,
    profile: profileDetail(task, config, model, effort),
  };
}

function profileDetail(
  task: Task,
  config: ResolvedConfig,
  model: LaunchIdentityItem,
  effort: LaunchIdentityItem,
): LaunchIdentityProfile {
  const name = profileNameForAgent(task.agent_id);
  const profile: AgentProfile | undefined = agentProfilesFor(config).get(name);
  const effortOrigin: LaunchIdentityOrigin = effort.source === 'task' ? 'task' : 'project';
  if (!profile) {
    return {
      name, found: false, builtin: null, harness: null, endpoint_name: null,
      endpoint_url: null, credential: null, tiers: null,
      model_origin: model.source === 'task' ? 'task' : 'project',
      effort_origin: effortOrigin,
    };
  }
  const modelOrigin: LaunchIdentityOrigin = model.source === 'task'
    ? 'task'
    : profile.model.trim() && profile.model.trim() === model.value ? 'profile' : 'project';
  // A tiered profile's endpoint and credential differ per tier (the profile's own
  // fields only mirror tier 0), so they ride on the tiers and not on the profile.
  const tiered = !!profile.tiers && profile.tiers.length > 0;
  return {
    name,
    found: true,
    builtin: profile.builtin,
    harness: profile.harness,
    endpoint_name: tiered ? null : profile.endpointName ?? null,
    endpoint_url: tiered || !profile.endpoint ? null : sanitizeDisplayUrl(profile.endpoint),
    credential: tiered ? null : profileCredentialName(profile),
    tiers: tiered
      ? profile.tiers!.map((t) => ({
          endpoint: t.endpoint,
          url: sanitizeDisplayUrl(t.upstream),
          credential: t.credential === NO_CREDENTIAL ? null : t.credential,
          model: t.model,
          threshold: t.threshold,
        }))
      : null,
    model_origin: modelOrigin,
    effort_origin: effortOrigin,
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
  const resolved = resolveViewModel(config, task.agent_id, task.model, projectModel);
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

/**
 * The model a task on agent profile `agentId` would run when nothing is
 * recorded on the task — the same `modelItem` ladder with an empty task
 * record. A display read for pickers (the Teams New Task form's per-profile
 * default); like the rest of this file it writes nothing and decides no turn.
 * Throws whatever the launch resolution throws for a broken profile.
 */
export function profileDefaultModel(opts: {
  agentId: string;
  config: ResolvedConfig;
  projectModel?: string | null;
}): string {
  return resolveViewModel(opts.config, opts.agentId, null, opts.projectModel);
}

/** The one resolution every read in this file shares, so no two can drift. */
function resolveViewModel(
  config: ResolvedConfig,
  agentId: string | undefined,
  taskModel: string | null | undefined,
  projectModel: string | null | undefined,
): string {
  return resolveAgentModel(config, {
    overrideModel: taskModelChoice(null, taskModel),
    projectModel,
    agentId,
  });
}

/**
 * A URL safe to put on a page: userinfo (`user:pass@`), query and fragment
 * removed. lazy.toml URLs are written by the operator and may embed a secret;
 * `launchIdentity` leaves the daemon on `show` and into every header tooltip.
 * Config load guarantees an absolute http(s) URL, so a value that does not
 * parse is not shown rather than echoed raw.
 */
export function sanitizeDisplayUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, url.endsWith('/') ? '/' : '');
  } catch {
    // Unparseable: never echo the raw text, which may carry a secret.
    return '<invalid url>';
  }
}
