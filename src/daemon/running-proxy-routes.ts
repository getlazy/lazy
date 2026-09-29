/**
 * Where the RUNNING proxy forwards each agent profile's traffic.
 *
 * The proxy's per-profile routes are built once, at daemon start, from the
 * config of that moment (src/daemon/server.ts). A saved config change re-routes
 * nothing until the daemon restarts — so "where will a request on this profile
 * actually go?" is answered from what the proxy was built with, never from a
 * fresh read of the config. A member's credential is checked against THIS
 * (./member-credentials.ts): checking the saved config instead would let a
 * credential consented for the new endpoint be sent to the old one in the
 * window between a save and the restart.
 *
 * A leaf module on purpose: the credential rules import it, and the proxy's
 * own modules import the credential rules.
 */

import type { ResolvedConfig } from '../config/types';
import { agentUpstreamMap, type AgentUpstreamRoute } from '../proxy/agent-upstreams';

const running = new Map<string, Record<string, AgentUpstreamRoute>>();

/** Called when the proxy is built from `config` for this project. */
export function recordRunningProxyRoutes(projectRoot: string, config: ResolvedConfig): void {
  running.set(projectRoot, agentUpstreamMap(config));
}

/**
 * The origin the proxy forwards `profile` to, or '' for the proxy's primary
 * upstream (a profile with no route of its own).
 *
 * With no proxy built in this process for the project (a test, a CLI), the
 * config stands in for it — `config` is what the proxy WOULD be built from.
 */
export function forwardingOriginFor(projectRoot: string, profile: string, config: ResolvedConfig): string {
  const routes = running.get(projectRoot) ?? agentUpstreamMap(config);
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

/** For tests. */
export function resetRunningProxyRoutes(): void {
  running.clear();
}
