/**
 * The one rule every harness's argv builder applies to its model: a launch
 * names one, or it does not happen.
 *
 * INVARIANT (turn-model stickiness): no harness launches an agent without an
 * explicit model. A turn runs the task's persisted model (resolved on the host,
 * src/daemon/launch-identity.ts), and a launch that is not a task turn — a
 * builder review turn, a machine one-shot, a chat — resolves one too
 * (resolveBuilderModel, src/agent/agent-model.ts). Omitting the flag hands the
 * choice to whatever the harness reads by default — a persisted selection in
 * its own config (cursor-agent's cli-config.json), the human's settings file,
 * or a compiled-in default that changes between versions — and nothing
 * reports that it did. That silent fallback is what this refusal exists to end.
 *
 * Stickiness is a property of lazy, not of a harness, so the refusal is one
 * function shared by all of them rather than a per-harness habit.
 */
import type { AgentFailure, AgentFailureInput } from './failure-taxonomy';
import { failureHaystack } from './failure-taxonomy';

/**
 * Lowercase marker in every refusal's message — what the classifier keys on
 * (failureHaystack lowercases). Each message reads "<harness> launch names no
 * model: …", e.g. "pi launch names no model".
 */
export const NO_MODEL_MARKER = 'launch names no model';

/** The model a `harness` launch runs, or a loud refusal. */
export function requireLaunchModel(harness: string, modelId: string | null | undefined): string {
  const model = modelId?.trim();
  if (model) return model;
  throw new Error(
    `${harness} ${NO_MODEL_MARKER}: refusing to start ${harness} without a model, which would ` +
    `run whatever ${harness} picks by default instead of the task's model. Every turn carries ` +
    'the task\'s persisted model (or its profile\'s default, resolved on the host), so this is a ' +
    'launch-path bug — report it; `lazy edit <task> --model <name>` pins a model explicitly in ' +
    'the meantime.',
  );
}

/**
 * `fatal_config` for a failure caused by {@link requireLaunchModel}, else null.
 * Every launch fails identically until the launch path or config changes, so
 * retrying is pointless. Each harness's classifyFailure asks this FIRST, before
 * its own dialect: the refusal's text mentions "model", which some harness
 * patterns would otherwise claim under a less precise reason.
 */
export function classifyNoModelRefusal(input: AgentFailureInput): AgentFailure | null {
  if (!failureHaystack(input).includes(NO_MODEL_MARKER)) return null;
  return { class: 'fatal_config', reason: 'launch named no model' };
}
