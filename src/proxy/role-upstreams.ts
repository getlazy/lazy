/**
 * Per-ROLE upstream routing for the proxy.
 *
 * THE BYPASS THIS CLOSES: a role's `endpoint` used to be an address the launched
 * agent dialed itself — `ollama` roles went straight to the local model, and any
 * role with an explicit `endpoint` connected there directly. Both were real
 * traffic outside lazy's audit and policy plane, and a porous audit plane is not
 * an audit plane. The key survives with its meaning INVERTED: an `endpoint` is
 * now the upstream lazy's proxy forwards that role's traffic to. Every launch
 * dials the proxy; the proxy decides where it goes.
 *
 * The routing key is the caller's GRANT role, not a header: the JIT credential
 * exchange already authenticates the placeholder a request presents and knows
 * which role it was minted for (src/proxy/credential-broker.ts). That is
 * evidence, so an agent cannot route itself somewhere else by setting a header.
 * Traffic with no grant — a host `claude` login session sharing the proxy — has
 * no role to route by and keeps going to the primary upstream, as before.
 */

import type { ResolvedConfig, RoleName, RoleTarget } from '../config/types';

/** Which real credential a role's upstream should be given, if any. */
export type RoleUpstreamCredential = 'anthropic' | 'none';

export interface RoleUpstream {
  role: RoleName;
  /** Anthropic-native base URL the proxy forwards this role's traffic to. */
  upstream: string;
  credential: RoleUpstreamCredential;
}

/**
 * Which credential a role's own upstream gets.
 *
 * `ollama` — a local model server that ignores auth. Sending the user's real
 * Anthropic token to it would leak the secret to a process that never needed it,
 * so: none. (Hosted Ollama will need one; that is a mapping change here, which
 * is precisely why this is data rather than a backend check in the hot path —
 * see src/proxy/target-credentials.ts.)
 *
 * `proxy` — an Anthropic-native endpoint the user pinned deliberately, which is
 * what used to receive the real credential when the agent dialed it directly.
 * Preserving that keeps this task a routing change and not a silent auth change.
 */
function credentialFor(backend: RoleTarget['backend']): RoleUpstreamCredential {
  return backend === 'ollama' ? 'none' : 'anthropic';
}

/**
 * The per-role upstreams this project configures, if any.
 *
 * Only roles that name their OWN endpoint appear. A role without one (every
 * `anthropic` role, and a `backend = "proxy"` role that left `endpoint` unset —
 * the recommended spelling) rides the proxy's primary upstream and its failover
 * chain, exactly as before.
 *
 * Endpoints are host-perspective: the daemon makes the upstream call, and the
 * config loader normalizes container-perspective spellings once at load
 * (`resolveRole` in src/config/loader.ts), so nothing downstream re-translates.
 */
export function resolveRoleUpstreams(config: ResolvedConfig): RoleUpstream[] {
  const out: RoleUpstream[] = [];
  for (const role of ['builder', 'agent'] as const) {
    const target = config.models.roles[role];
    if (!target.endpoint) continue;
    out.push({
      role,
      upstream: target.endpoint.replace(/\/$/, ''),
      credential: credentialFor(target.backend),
    });
  }
  return out;
}

/** Index role upstreams for the proxy's per-request lookup. */
export function roleUpstreamMap(config: ResolvedConfig): Partial<Record<RoleName, string>> {
  const map: Partial<Record<RoleName, string>> = {};
  for (const entry of resolveRoleUpstreams(config)) map[entry.role] = entry.upstream;
  return map;
}
