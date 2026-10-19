/**
 * The model rule for a TIERED agent profile.
 *
 * A task's persisted model is what its turns run on every ordinary profile
 * (the turn-model stickiness invariant in ./agent-model.ts). A tiered profile is
 * the carve-out: its model is chosen PER REQUEST by the proxy from the tier that
 * serves it (src/proxy/tier-select.ts), so a model pinned on the task would
 * either be ignored or — worse — be sent to every tier, including endpoints that
 * do not serve it. For a task on a tiered profile `task.model` is therefore
 * never read and never written (a switch onto one clears it), and asking for a
 * model is refused with the way to pin one tier instead.
 */

import type { ResolvedConfig } from '../config/types';
import { profileForAgentNameOrNull } from '../config/agent-profiles';

/** The refusal for a `--model` on a task whose profile is tiered. */
export function tieredModelRefusal(profileName: string, tierProfiles: string): string {
  return (
    `Agent profile "${profileName}" is tiered: lazy picks the model from the tier serving each request, ` +
    `so a task on it cannot pin one with --model. To run one model, put the task on a profile with a ` +
    `single endpoint instead (${tierProfiles}).`
  );
}

/** Throw when `model` is being pinned on a task whose profile `agentId` is tiered. */
export function assertNoModelOnTiered(config: ResolvedConfig, agentId: string | null | undefined, model: string | null | undefined): void {
  if (!model?.trim()) return;
  const profile = profileForAgentNameOrNull(config, agentId);
  if (!profile?.tiers) return;
  throw new Error(tieredModelRefusal(
    profile.name,
    `e.g. a profile with named_endpoint = "${profile.tiers[0]!.endpoint}" and model = "${profile.tiers[0]!.model}"`,
  ));
}

/** True when `agentId` names a tiered profile. */
export function isTieredAgent(config: ResolvedConfig, agentId: string | null | undefined): boolean {
  return !!profileForAgentNameOrNull(config, agentId)?.tiers;
}
