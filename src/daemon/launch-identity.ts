/**
 * The agent / model / effort a turn launches on — resolved in ONE place, for
 * every turn type.
 *
 * INVARIANT (turn-launch-continuity): a turn runs on the task's CURRENT agent,
 * model and effort — `task.agent_id`, `task.model`, `task.metadata.effort` —
 * unless this launch was handed an explicit override. Every turn type resolves
 * them here: work turns (start, unblock, resume, auto-resume, auto-deliver),
 * asks, sync/merge turns and wrap-up turns. Two reasons, both concrete:
 *
 *   - QUOTA. Model pools are not interchangeable and the scarce one must never
 *     be picked up implicitly. A turn that silently falls back to
 *     `[models] default` spends from a pool nobody chose for this task.
 *   - PROMPT CACHE. Switching model between consecutive turns of one session
 *     throws the cache away, so an unasked-for switch costs real tokens on the
 *     turn after it as well.
 *
 * The behavioural effect is that a turn follows the one before it, but the
 * MECHANISM is the task record and only the task record — never a scan of turn
 * history. Every path that takes an explicit override persists it to the task
 * in the same operation, so the record already IS the running answer, and it is
 * also the thing `lazy edit --model/--effort/--agent` writes between turns.
 * Turn labels stay labels: see the removal note on `findStickyModel` in
 * src/utils/turns.ts for what a launch that reads them back instead does to an
 * edit on a started task.
 *
 * ACTIONS PERSIST; ONE-OFFS DO NOT. An override handed to a work-turn launch
 * (`lazy unblock --model`, `lazy start --effort`, `lazy edit --agent`) is the
 * human choosing what this task runs on from now on, so it is written to the
 * record and the next turn inherits it. A ONE-OFF — an ask, a chat — is not a
 * choice about the task: it reads the record, may use its own effort for that
 * single invocation, and writes nothing back.
 * {@link resolveTurnLaunchIdentity} is the persisting form;
 * {@link resolveOneOffTurnIdentity} is the read-only one.
 *
 * NOTHING HERE DECIDES A MACHINE ONE-SHOT. An ask and a chat RESUME the task's
 * agent session, which is why they read the record — the cache they land on is
 * the one the work turn just filled. A machine one-shot (the accept-time
 * fidelity summary, `lazy report`, memory compaction, a conversation ask) does
 * not: it strips `--resume`/`--continue`, so there is no session and no cache to
 * inherit, and it runs on the BUILDER role target end to end. See
 * src/oneshot/types.ts and docs/oneshot-execution.md.
 *
 * The one deliberate exception is `switchTaskAgent` (src/daemon/agent-switch.ts),
 * which DISCARDS the stored model and effort when the human switches agents
 * without naming new ones — model ids are not portable across agents. It
 * persists the re-resolved pair before any turn launches, so by the time this
 * helper runs the task record is again the running answer.
 */

import type { Task } from '../types';
import type { Storage } from '../storage';
import type { EffortLevel, ResolvedConfig } from '../config/types';
import { resolveAgentModel, taskModelChoice } from '../agent/agent-model';
import { resolveProjectModel } from './project-settings';
import { resolveAndPersistEffort, resolveEffort } from './effort';

/** What a turn launches on, once every rung of the ladder has been consulted. */
export interface TurnLaunchIdentity {
  /**
   * The agent PROFILE the turn runs on (`[agents.<name>]`), i.e. `task.agent_id`.
   * Changing it is `lazy edit --agent` / `lazy unblock --agent`, which persist
   * through switchTaskAgent — never something a launch decides for itself.
   */
  agentId: string;
  /** Concrete model name for the launch. Always non-empty. */
  model: string;
  /** Reasoning effort for the launch. */
  effort: EffortLevel;
}

export interface ResolveTurnLaunchIdentityOptions {
  storage: Storage;
  task: Task;
  config: ResolvedConfig;
  /** An explicit `--model` for THIS launch. A durable choice: it is persisted. */
  modelOverride?: string | null;
  /** An explicit `--effort` for THIS launch. Also durable, also persisted. */
  effortOverride?: string;
}

export interface ResolveOneOffTurnIdentityOptions {
  storage: Storage;
  task: Task;
  config: ResolvedConfig;
  /** A `--model` for THIS invocation only. Read, never written back. */
  modelOverride?: string | null;
  /** An `--effort` for THIS invocation only. Read, never written back. */
  effortOverride?: string;
}

/**
 * Resolve the agent, model and effort for a ONE-OFF turn — an ask, a chat —
 * without writing anything to the task.
 *
 * Same ladder as {@link resolveTurnLaunchIdentity}; the only difference is that
 * nothing here is an ACTION. A reviewer asking a question at `--effort max` is
 * not deciding what the task's next work turn runs on, so the override applies
 * to this invocation and stops there. The agent and model still come from the
 * record, which is what keeps the question on the prompt cache the work turn
 * just filled — and keeps a scarce model pool from being spent by a question.
 */
export async function resolveOneOffTurnIdentity(
  opts: ResolveOneOffTurnIdentityOptions,
): Promise<TurnLaunchIdentity> {
  const { storage, task, config, modelOverride, effortOverride } = opts;

  const projectSettings = await storage.getProjectSettings();
  const model = resolveAgentModel(config, {
    overrideModel: taskModelChoice(modelOverride, task.model),
    projectModel: resolveProjectModel(projectSettings, config),
    agentId: task.agent_id,
  });

  return {
    agentId: task.agent_id,
    model,
    effort: resolveEffort(task, effortOverride, config.agent.effort),
  };
}

/**
 * Resolve (and persist) the agent, model and effort for one turn launch.
 *
 * PRECEDENCE, highest first:
 *   1. an explicit override passed to this launch (`--model` / `--effort`)
 *   2. the task's stored `model` / `metadata.effort`
 *   3. the profile's own default, the agent's declared default, the project
 *      overlay, then `[models] default` / `[agent] effort`
 *
 * Rung 2 is what makes a turn follow the one before it: rung 1 is always
 * written back, so by the next launch the choice is simply part of the task.
 *
 * A profile that pins an endpoint does NOT override rungs 1–2: its model is
 * rung 3, the default for a task that has never had one (see taskModelChoice).
 *
 * PERSISTENCE. An override is written to the task so the NEXT turn inherits it
 * without anyone restating it. With no override, the
 * resolved values are written only when the task has none yet — whichever turn
 * type runs first for a task pins them, and no later turn re-reads a config
 * default that may have changed mid-task. A plain turn never clobbers a stored
 * choice.
 *
 * NOT resolved here: the experimental low-high loop, which substitutes a DRAFT
 * effort for the work turn it runs on while leaving the task's own effort
 * untouched (src/daemon/effort.ts). Work-turn callers layer that on top of the
 * `effort` returned here; every other turn type launches on it directly.
 */
export async function resolveTurnLaunchIdentity(
  opts: ResolveTurnLaunchIdentityOptions,
): Promise<TurnLaunchIdentity> {
  const { storage, task, config, modelOverride, effortOverride } = opts;

  const projectSettings = await storage.getProjectSettings();
  const model = resolveAgentModel(config, {
    overrideModel: taskModelChoice(modelOverride, task.model),
    projectModel: resolveProjectModel(projectSettings, config),
    agentId: task.agent_id,
  });

  // An explicit override is durable — persist it even over an existing
  // task.model, so every later turn (including the auto-resume and
  // auto-deliver paths, which have no override of their own) inherits it.
  // Without one, fill only an empty slot.
  if (modelOverride || !task.model) {
    await storage.updateTaskModel(task.id, model);
    task.model = model;
  }

  const effort = await resolveAndPersistEffort(task, effortOverride, config.agent.effort, storage);

  return { agentId: task.agent_id, model, effort };
}
