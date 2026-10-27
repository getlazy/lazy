/**
 * Per-PROFILE upstream routing for the proxy.
 *
 * A launch grant carries the name of the agent profile it was minted for
 * (src/proxy/credential-broker.ts), so the proxy can answer "where does THIS
 * caller's traffic go" per task rather than per role. That is the whole point of
 * profiles: `[models.roles.agent]` covers every task in the role at once, so
 * "run pi against a local Ollama" also rerouted every claude-code task.
 *
 * The routing key is evidence, not a claim. The profile name comes off the
 * broker-minted grant the request's placeholder credential resolves to — an
 * agent cannot route itself elsewhere by setting a header, exactly as with the
 * role routing this supersedes.
 *
 * WHAT THIS RETIRES: `routeForGrant`'s `OPENAI_API_KEY` special case, which
 * routed by ENV VAR NAME because that was the only per-caller evidence available
 * before profiles existed. Its zero-config effect is preserved by the built-in
 * `codex` profile, whose default endpoint IS api.openai.com — so codex still
 * reaches OpenAI with no configuration, but now two codex profiles can differ.
 */

import type { ResolvedConfig } from '../config/types';
import {
  type AgentProfile,
  type AgentWire,
  type TierUsageSource,
  agentProfilesFor,
  NO_CREDENTIAL,
  profileCredentialName,
} from '../config/agent-profiles';

export interface AgentUpstream {
  /** Profile name — what the grant carries. */
  profile: string;
  /** Base URL the proxy forwards this profile's traffic to. */
  upstream: string;
  /** Stored credential whose real secret this upstream gets, or null for none. */
  credential: string | null;
  /**
   * True when lazy.toml NAMED `credential` for this endpoint rather than lazy
   * inferring it — the only case in which the proxy will attach a provider's
   * credential to a host that is not that provider's.
   */
  credentialExplicit?: true;
  /** `[endpoints.<name>]` this upstream came from, when it came from one. */
  endpointName?: string;
  wire: AgentWire;
  /**
   * Position in a TIERED profile's chain, absent for an ordinary profile. Every
   * tier is its own upstream → credential entry, so the credential map covers
   * all of them and its origin-collision check sees all of them.
   */
  tier?: number;
}

/** One tier of a tiered profile, as the proxy picks between them per request. */
export interface TierRoute {
  index: number;
  /** `[endpoints.<name>]` the tier runs against. */
  endpoint: string;
  upstream: string;
  model: string;
  usage: TierUsageSource;
  /** Optional early-switch percent; null = used until it refuses (a last windowed tier may leave it to `[usage_pause]`). */
  threshold: number | null;
  /** `[usage_pause]` settings, carried only when `threshold` is left to them. */
  pause?: { threshold_percent: number; credentials: Record<string, number> };
}

/** What the proxy needs per profile at request time: where to forward, which wire. */
export interface AgentUpstreamRoute {
  upstream: string;
  wire: AgentWire;
  /** Set on a TIERED profile: `upstream` is tier 0, and the proxy picks per request. */
  tiers?: TierRoute[];
  /** The configured endpoint's name, when the profile names one — how failures are attributed. */
  endpointName?: string;
}

/** True when this profile needs its own route rather than the primary upstream. */
function hasOwnUpstream(profile: AgentProfile): boolean {
  return profile.endpoint.trim().length > 0;
}

/**
 * The per-profile upstreams this project configures.
 *
 * Only profiles that resolve to a concrete endpoint appear. A profile without
 * one — every built-in but `codex` — rides the proxy's primary upstream and its
 * failover chain, which is what makes a project with no `[agents]` section
 * behave exactly as it did before profiles existed.
 *
 * Endpoints are host-perspective: the daemon makes the upstream call, and
 * `resolveAgentProfiles` normalizes container-perspective spellings once at
 * config load, so nothing downstream re-translates.
 */
export function resolveAgentUpstreams(config: ResolvedConfig): AgentUpstream[] {
  const out: AgentUpstream[] = [];
  for (const profile of agentProfilesFor(config).values()) {
    if (profile.tiers) {
      // One entry PER TIER: each tier's endpoint is a target with its own
      // credential, and the proxy may forward to any of them mid-turn.
      for (const tier of profile.tiers) {
        out.push({
          profile: profile.name,
          upstream: tier.upstream.replace(/\/$/, ''),
          credential: tier.credential === NO_CREDENTIAL ? null : tier.credential,
          ...(tier.credentialExplicit ? { credentialExplicit: true as const } : {}),
          endpointName: tier.endpoint,
          wire: tier.wire,
          tier: tier.index,
        });
      }
      continue;
    }
    if (!hasOwnUpstream(profile)) continue;
    out.push({
      profile: profile.name,
      upstream: profile.endpoint.replace(/\/$/, ''),
      credential: profileCredentialName(profile),
      ...(profile.credentialExplicit ? { credentialExplicit: true as const } : {}),
      ...(profile.endpointName ? { endpointName: profile.endpointName } : {}),
      wire: profile.wire,
    });
  }
  return out;
}

/** Index profile upstreams for the proxy's per-request lookup. */
export function agentUpstreamMap(config: ResolvedConfig): Record<string, AgentUpstreamRoute> {
  const map: Record<string, AgentUpstreamRoute> = {};
  for (const entry of resolveAgentUpstreams(config)) {
    if (entry.tier !== undefined && entry.tier > 0) continue;
    map[entry.profile] = { upstream: entry.upstream, wire: entry.wire, ...(entry.endpointName ? { endpointName: entry.endpointName } : {}) };
  }
  for (const profile of agentProfilesFor(config).values()) {
    if (!profile.tiers || !map[profile.name]) continue;
    map[profile.name]!.tiers = profile.tiers.map((t) => ({
      index: t.index,
      endpoint: t.endpoint,
      upstream: t.upstream.replace(/\/$/, ''),
      model: t.model,
      usage: t.usage,
      threshold: t.threshold,
      ...(t.threshold === null && t.usage !== null
        ? { pause: { threshold_percent: config.usage_pause.threshold_percent, credentials: { ...config.usage_pause.credentials } } }
        : {}),
    }));
  }
  return map;
}

/**
 * The route a VERIFIED caller's traffic takes.
 *
 * A grant minted before profiles existed carries no profile name — the grant
 * registry on disk outlives a daemon restart, so that is a live case rather
 * than a hypothetical one. Such a caller has no profile to route by and keeps
 * going to the primary upstream, the same answer as traffic with no grant at
 * all. Its next launch mints a grant that does carry one.
 */
export function routeForProfile(
  agentUpstreams: Record<string, AgentUpstreamRoute>,
  grant: { profile?: string },
): AgentUpstreamRoute | undefined {
  if (!grant.profile) return undefined;
  return agentUpstreams[grant.profile];
}
