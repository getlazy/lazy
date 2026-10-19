/**
 * Where the RUNNING proxy forwards each agent profile's traffic.
 *
 * The proxy resolves its per-profile routes from the effective config on
 * every request. Credential consent checks use the effective config too.
 *
 * A leaf module on purpose: the credential rules import it, and the proxy's
 * own modules import the credential rules.
 */

import type { ResolvedConfig } from '../config/types';
import { agentUpstreamMap } from '../proxy/agent-upstreams';

/**
 * The origin the proxy forwards `profile` to, or '' for the proxy's primary
 * upstream (a profile with no route of its own).
 *
 * Reads the effective config, the same source used by the proxy on each request.
 */
export function forwardingOriginFor(projectRoot: string, profile: string, config: ResolvedConfig): string {
  const routes = agentUpstreamMap(config);
  const upstream = routes[profile]?.upstream;
  return upstream ? originOf(upstream) : '';
}

/** `https://host:port` for a URL; the input itself when it does not parse. */
export function originOf(endpoint: string): string {
  if (!endpoint.trim()) return '';
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint.trim();
  }
}
