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
  agentProfilesFor,
  profileCredentialName,
} from '../config/agent-profiles';

export interface AgentUpstream {
  /** Profile name — what the grant carries. */
  profile: string;
  /** Base URL the proxy forwards this profile's traffic to. */
  upstream: string;
  /** Stored credential whose real secret this upstream gets, or null for none. */
  credential: string | null;
  wire: AgentWire;
}

/** What the proxy needs per profile at request time: where to forward, which wire. */
export interface AgentUpstreamRoute {
  upstream: string;
  wire: AgentWire;
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
    if (!hasOwnUpstream(profile)) continue;
    out.push({
      profile: profile.name,
      upstream: profile.endpoint.replace(/\/$/, ''),
      credential: profileCredentialName(profile),
      wire: profile.wire,
    });
  }
  return out;
}

/** Index profile upstreams for the proxy's per-request lookup. */
export function agentUpstreamMap(config: ResolvedConfig): Record<string, AgentUpstreamRoute> {
  const map: Record<string, AgentUpstreamRoute> = {};
  for (const entry of resolveAgentUpstreams(config)) {
    map[entry.profile] = { upstream: entry.upstream, wire: entry.wire };
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
