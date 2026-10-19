/**
 * Which tier a TIERED builder is answering on, and when it last switched.
 *
 * A task's tier switches land in its journal (./tier-switch-record.ts). A
 * builder has no task, so its switches — reported by the proxy with the
 * launch grant's label and no task id — are kept here, in memory: bounded,
 * per daemon process, and lost on a restart, after which the next switch
 * records again. Nothing is billed or decided from it; it exists so the
 * builder's surfaces (the dashboard's Builders pages, `lazy builder`, the
 * builder's own `lazy_status`) can say when a long conversation fell to a
 * weaker model — the silent quality drop a tiered builder otherwise risks.
 *
 * "Answering now" is computed with the proxy's own rule (`tierInUseNow`), so
 * it is what the next request would get, not a guess from the last switch.
 */

import type { ResolvedConfig } from '../config/types';
import { profileForAgentNameOrNull } from '../config/agent-profiles';
import type { TierSwitchEvent } from '../proxy/tier-select';
import { tierInUseNow } from './usage-pause';
import { teamModeEnabled } from './user-credentials';
import { getTaskSessionBinding } from './session-credentials';
import { memberProfileCredentialProblem } from './member-credentials';
import type { Storage } from '../storage/interface';
import type { ActorIdentity } from './actor-tokens';
import { RpcError } from './rpc-error';

/** Most switches kept. */
export const BUILDER_TIER_HISTORY_MAX = 20;

const history: TierSwitchEvent[] = [];

/** Record one switch the proxy reported for a launch with no task. */
export function recordBuilderTierSwitch(event: TierSwitchEvent): void {
  if (event.taskId) return;
  history.push(event);
  while (history.length > BUILDER_TIER_HISTORY_MAX) history.shift();
}

/** Test seam. */
export function resetBuilderTierHistory(): void {
  history.length = 0;
}

export interface BuilderTierView {
  profile: string;
  tiered: boolean;
  /** Every tier, in order (empty when not tiered). */
  tiers: Array<{ index: number; endpoint: string; model: string }>;
  /** The tier the next builder request is served by, by the proxy's rule; null when unknown. */
  /** Why this member cannot launch the builder; then `now` is null. */
  refused?: string;
  now: { index: number; endpoint: string; model: string; allFull: boolean; reason: string } | null;
  /** Switches since this daemon started, newest first, for this profile. */
  switches: Array<{
    label: string | null;
    from: TierSwitchEvent['from'];
    to: TierSwitchEvent['to'];
    reason: string;
    at: string;
  }>;
}

export async function builderTierView(
  projectRoot: string,
  config: ResolvedConfig,
  caller: { label?: string | null; member?: string | null; bindingKey?: string | null } = {},
): Promise<BuilderTierView> {
  const name = config.models.roles.builder.profile;
  const profile = profileForAgentNameOrNull(config, name);
  if (!profile?.tiers) return { profile: name, tiered: false, tiers: [], now: null, switches: [] };
  const tiers = profile.tiers.map((t) => ({ index: t.index, endpoint: t.endpoint, model: t.model }));
  const perMember = await teamModeEnabled(projectRoot);
  let principal = caller.member ?? null;
  const bindingKey = caller.bindingKey ?? (caller.label?.startsWith('builder-') ? caller.label.slice('builder-'.length) : null);
  if (perMember && bindingKey) {
    const binding = await getTaskSessionBinding(projectRoot, bindingKey);
    if (binding?.revokedAt === null) principal = binding.ownerUserId;
  }
  if (perMember) {
    const refused = principal
      ? await memberProfileCredentialProblem(projectRoot, principal, profile, config)
      : 'The builder’s member credential binding is unavailable; start or resume that builder to read its tier.';
    if (refused) return { profile: name, tiered: true, tiers, refused, now: null, switches: [] };
  }
  const inUse = await tierInUseNow(projectRoot, config, name, Date.now(), principal);
  return {
    profile: name,
    tiered: true,
    tiers,
    now: inUse
      ? { index: inUse.tier.index, endpoint: inUse.tier.endpoint, model: inUse.tier.model, allFull: inUse.allFull, reason: inUse.reason }
      : null,
    switches: history
      .filter((e) => e.profile === name && (!perMember || (bindingKey && e.bindingKey === bindingKey) || (caller.label && e.label === caller.label)))
      .slice()
      .reverse()
      .map((e) => ({ label: e.label ?? null, from: e.from, to: e.to, reason: e.reason, at: new Date(e.ts).toISOString() })),
  };
}

/** Resolve a human/control view through the existing builder-session read scope. */
export async function builderTierViewForCaller(
  projectRoot: string,
  config: ResolvedConfig,
  storage: Storage,
  caller: ActorIdentity,
  builderSessionId?: string,
): Promise<BuilderTierView> {
  if (!builderSessionId) return builderTierView(projectRoot, config, { member: caller.kind === 'user' ? caller.email : null });
  const { scopeBuilderSessionStorageRead } = await import('./builder-sessions');
  const scoped = await scopeBuilderSessionStorageRead(projectRoot, 'getBuilderSession', { id: builderSessionId }, caller);
  const session = scoped === undefined ? await storage.getBuilderSession(builderSessionId) : scoped;
  if (!session || Array.isArray(session) || session.projectRoot !== projectRoot) throw new RpcError(404, `Builder session not found: ${builderSessionId}`);
  return builderTierView(projectRoot, config, { member: session.memberEmail, bindingKey: session.builderId, label: `builder-${session.builderId}` });
}

/** One plain-language line for a terminal or a status field. */
export function builderTierLine(view: BuilderTierView): string | null {
  if (!view.tiered) return null;
  if (view.refused) return view.refused;
  const top = view.tiers[0];
  if (!view.now) return `Builder runs on tiered profile "${view.profile}"; the tier in use cannot be read right now.`;
  if (view.now.allFull) {
    return `Builder profile "${view.profile}": every tier is full, so requests are refused until a usage window resets.`;
  }
  const on = `tier ${view.now.index + 1} of ${view.tiers.length} — ${view.now.endpoint}, model ${view.now.model}`;
  const last = view.switches[0];
  const since = last ? ` (switched ${last.at})` : '';
  const weaker = view.now.index > 0 && top ? ` — below tier 1 (${top.model})` : '';
  return `Builder profile "${view.profile}" is answering on ${on}${weaker}${since}.`;
}
