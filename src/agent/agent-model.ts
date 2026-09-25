/**
 * Launch-time model resolution for a task's agent.
 *
 * This sits above `src/utils/role-target.ts` (which knows only config) because
 * the last step of the decision asks the AGENT what it runs by default — the
 * same shape as `Agent.defaultWatchdogTimeoutMs()`, where Cursor differs from
 * Claude Code because it knows its own quirks.
 */

import type { ResolvedConfig } from '../config/types';
import { resolveRoleTarget } from '../utils/role-target';
import { profileForAgentNameOrNull } from '../config/agent-profiles';
import { getAgent, listAgents } from './registry';

/**
 * The model a task has CHOSEN — an explicit override for this launch, else the
 * persisted `task.model` — to hand `resolveAgentModel` as `overrideModel`,
 * never as a soft `preferredModel`. Shared by the launch
 * (src/daemon/launch-identity.ts) and the task header
 * (src/task/launch-identity-view.ts) so the two can never disagree about which
 * model a turn runs.
 *
 * INVARIANT (turn-model stickiness): the task's persisted model is what its
 * turns run, on every profile. As a soft preference it lost to a profile that
 * pins an `endpoint` (src/utils/role-target.ts): `lazy edit --model` and
 * `lazy unblock --model` were recorded on such a task but not run — the task
 * header showed the profile's model "overriding" the stored one, but nothing
 * refused or asked. A model the pinned server does not serve now fails that turn
 * loudly instead. The profile's model is still the answer for a task that has
 * never had one, and the first launch persists it.
 */
export function taskModelChoice(
  modelOverride: string | null | undefined,
  taskModel: string | null | undefined,
): string | null {
  return modelOverride?.trim() || taskModel?.trim() || null;
}

/**
 * Resolve the concrete model name for a task/agent launch — the single
 * replacement for the `if ollama.enabled force ollama.model` blocks that used to
 * be duplicated across every daemon launch site.
 *
 * Returns the authoritative ollama/proxy model, the caller's preferred anthropic
 * model, the launching agent's own declared default, or `config.models.default`
 * when nothing else is specified. Always non-empty (the model is recorded on the
 * turn/task, so it must be concrete).
 *
 * PRECEDENCE — this is where it is decided, highest first:
 *   1. an explicit `--model` override (`opts.overrideModel`, via resolveRoleTarget)
 *   2. the authoritative model of a local backend ([models.roles.agent] with
 *      backend ollama/proxy) — a pinned local model is never stomped
 *   3. a soft per-task model (`task.model`) on the anthropic backend
 *   4. the selected profile's own `model` ([agents.<name>] model = "…")
 *   5. the agent's own declared default (Agent.defaultModel(); `null` = no opinion)
 *   6. the project-settings overlay (`opts.projectModel`), else `[models] default`
 *
 * (1)–(3) are resolveRoleTarget's job; (4)–(6) are decided here, and only when
 * everything above left the model empty.
 *
 * WHY THE PROFILE'S MODEL OUTRANKS THE AGENT'S DECLARED DEFAULT (4 above 5):
 * `[agents.<name>] model` is the human naming the model for this exact profile,
 * so it is a choice, while `defaultModel()` is the agent class guessing on their
 * behalf. It still yields to a per-task model (3): pinning one task stays a
 * `--model` away, which is the point of having both.
 *
 * WHY THE AGENT'S DECLARED DEFAULT OUTRANKS BOTH GLOBAL DEFAULTS (4 above 5):
 * `[models] default` and the project overlay are ONE model name for the whole
 * project, and in practice an Anthropic one chosen for Claude Code. Handing it
 * to an agent that speaks a different catalog pins every one of that agent's
 * turns to a model nobody picked for it — which is exactly how a fresh Cursor
 * task ended up on Opus and stopped at Cursor's Opus usage cap before it ran a
 * single tool (fix-cursor-model-turn-setting). A per-task model still wins over
 * both, so pinning one task remains a `--model` away.
 */
export function resolveAgentModel(
  config: ResolvedConfig,
  opts?: {
    preferredModel?: string | null;
    overrideModel?: string | null;
    agentId?: string;
    /**
     * The project-settings overlay's default model, when the deployment set
     * one. Replaces `[models] default` as the last resort — it is the same
     * KIND of value (a project-wide default), just from the store rather than
     * the repository, so it belongs at the same rung of the ladder. See
     * resolveProjectModel in src/daemon/project-settings.ts.
     */
    projectModel?: string | null;
  },
): string {
  // `opts.agentId` names a PROFILE. Everything below wants one of the two things
  // behind it: the profile's own `model`, or its HARNESS — which is what the
  // agent registry and the local-backend rule are keyed by. Lenient (see
  // profileForAgentNameOrNull): a task record naming a profile lazy.toml no
  // longer defines must not make a model lookup the thing that fails its launch,
  // for the same reason agentDeclaredModel tolerates an unknown id below.
  const profile = profileForAgentNameOrNull(config, opts?.agentId);
  const harness = profile?.harness ?? opts?.agentId;

  // A task that NAMED a profile is resolved against THAT profile, not against
  // the role's default one — `[models.roles.agent]` is the fallback for a task
  // that named none, which is exactly what `resolveRoleTarget`'s own `profile`
  // parameter documents.
  //
  // Passing only the harness let the role default's model shadow the model of
  // the profile the task actually runs. Latent until a built-in profile carried
  // a model of its own: with the project default agent set to `pi` (whose
  // built-in profile is now a local Ollama with its own model), a task switched
  // to `--agent openai-pi` resolved to the Ollama model and asked OpenAI for
  // it. Caught by test/e2e/pi-agent-binary-seam.test.ts.
  //
  // Only a NAMED agent qualifies: an empty `agentId` resolves to the default
  // profile, and passing that here would bypass `[models.roles.agent]` for
  // every task that never chose an agent — the one case the role default exists
  // to serve.
  const namedProfile = opts?.agentId?.trim() ? profile : null;

  const resolved = resolveRoleTarget('agent', config, {
    preferredModel: opts?.preferredModel,
    overrideModel: opts?.overrideModel,
    harness,
    profile: namedProfile,
  }).model;
  if (resolved) return resolved;

  const profileModel = profile?.model.trim();
  if (profileModel) return profileModel;

  return agentDeclaredModel(harness)
    ?? (opts?.projectModel?.trim() || config.models.default);
}

/**
 * The concrete model a BUILDER-role launch runs — a builder review turn, a
 * machine one-shot, `lazy chat`, a branchless `lazy pair` — none of which has a
 * task model to inherit.
 *
 * The explicit model wins (a human's `--model`), then the role target's model
 * (a profile's own `model`, always concrete on a pinned endpoint), then the
 * harness's declared default, then the project default. Always non-empty:
 * every harness refuses a model-less launch (requireLaunchModel,
 * src/agent/launch-model.ts). These launches used to omit the flag when the
 * builder profile named no model, which on the built-in claude-code profile
 * meant "whatever Claude Code picks" — the silent fallback that refusal ends.
 *
 * `[models] default` is only reached for a harness with no declared default,
 * i.e. claude-code, whose unpinned target speaks to the Anthropic API that
 * default is chosen for.
 */
export function resolveBuilderModel(
  config: ResolvedConfig,
  target: { harness: string; model?: string | null },
  explicitModel?: string | null,
): string {
  return explicitModel?.trim()
    || target.model?.trim()
    || agentDeclaredModel(target.harness)
    || config.models.default;
}

/**
 * The launching agent's own default model, or `null` when it has no opinion.
 *
 * Takes the HARNESS, since `defaultModel()` is a property of the binary and the
 * registry is keyed by it. An unknown harness is also `null`: every entry point
 * validates the profile it was given, and config load validates every profile's
 * harness, so reaching here with a bad one means hand-edited state — and falling
 * through to `config.models.default` is what that state already did before
 * agents could declare a default. Throwing at this depth would turn a stale task
 * record into a failed launch.
 *
 * An agent that returns a blank string DOES throw. That is not a user's stale
 * state but a broken agent implementation: the contract spells "no default"
 * `null`, so a blank is neither answer, and silently reading it as either would
 * hide the bug behind a model nobody chose (CLAUDE.md: no silent fallbacks).
 * Unreachable for the shipped agents — this is the guard rail for the next one.
 */
function agentDeclaredModel(harness: string | undefined): string | null {
  if (!harness || !listAgents().includes(harness)) return null;

  const declared = getAgent(harness).defaultModel();
  if (declared === null) return null;

  const model = declared.trim();
  if (!model) {
    throw new Error(
      `Agent "${harness}" returned a blank default model from defaultModel(). ` +
      `Return null to mean "no default, use the configured model" — a blank ` +
      `string is not a model name.`,
    );
  }
  return model;
}
