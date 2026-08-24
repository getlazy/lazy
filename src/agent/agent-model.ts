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
import { getAgent, listAgents } from './registry';

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
 *   3. a soft per-task model (sticky model / `task.model`) on the anthropic backend
 *   4. the agent's own declared default (Agent.defaultModel(); `null` = no opinion)
 *   5. `[models] default`
 *
 * (1)–(3) are resolveRoleTarget's job; (4) and (5) are decided here, and only
 * when everything above left the model empty. A future per-agent config key
 * slots in between (3) and (4): config should override what the agent class
 * declares about itself, while still yielding to an explicit per-task choice.
 */
export function resolveAgentModel(
  config: ResolvedConfig,
  opts?: { preferredModel?: string | null; overrideModel?: string | null; agentId?: string },
): string {
  const resolved = resolveRoleTarget('agent', config, opts).model;
  if (resolved) return resolved;
  return agentDeclaredModel(opts?.agentId) ?? config.models.default;
}

/**
 * The launching agent's own default model, or `null` when it has no opinion.
 *
 * An unknown agent id is also `null`: every entry point validates the id
 * against `listAgents()`, so reaching here with a bad one means hand-edited
 * state — and falling through to `config.models.default` is what that state
 * already did before agents could declare a default. Throwing at this depth
 * would turn a stale task record into a failed launch.
 *
 * An agent that returns a blank string DOES throw. That is not a user's stale
 * state but a broken agent implementation: the contract spells "no default"
 * `null`, so a blank is neither answer, and silently reading it as either would
 * hide the bug behind a model nobody chose (CLAUDE.md: no silent fallbacks).
 * Unreachable for the shipped agents — this is the guard rail for the next one.
 */
function agentDeclaredModel(agentId: string | undefined): string | null {
  if (!agentId || !listAgents().includes(agentId)) return null;

  const declared = getAgent(agentId).defaultModel();
  if (declared === null) return null;

  const model = declared.trim();
  if (!model) {
    throw new Error(
      `Agent "${agentId}" returned a blank default model from defaultModel(). ` +
      `Return null to mean "no default, use the configured model" — a blank ` +
      `string is not a model name.`,
    );
  }
  return model;
}
