/**
 * What the running proxy was BUILT from.
 *
 * The daemon constructs its proxy once, at startup (src/daemon/server.ts), from
 * the config of that moment: its own tunables, the per-agent-profile routes and
 * the upstream → credential map. Everything else in lazy.toml is re-read on
 * each use. So "does this config change need a restart?" is exactly "does the
 * new config's proxy fingerprint differ from the one the running proxy was
 * built from" — compared against what is RUNNING, not against the previous
 * file, so a restart that was owed and never happened is still owed on the
 * next save.
 */

import type { ResolvedConfig } from '../config/types';
import { agentUpstreamMap } from '../proxy/agent-upstreams';
import { buildTargetCredentials } from '../proxy/credential-deps';
import { recordRunningProxyRoutes } from './running-proxy-routes';

/** One named part of the fingerprint → its canonical JSON. */
export type ProxyFingerprint = Record<string, string>;

export function proxyFingerprint(projectRoot: string, config: ResolvedConfig): ProxyFingerprint {
  let credentialTargets: string;
  try {
    credentialTargets = JSON.stringify(buildTargetCredentials(projectRoot, config).lines);
  } catch (err) {
    // The proxy refuses to start on the same error, so a config carrying it
    // differs from any running proxy by definition.
    credentialTargets = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  return {
    'proxy.retry_after_threshold': JSON.stringify(config.proxy.retryAfterThreshold),
    'proxy.upstream_timeout': JSON.stringify(config.proxy.upstreamTimeoutSeconds),
    'proxy.policy.deny_path_globs': JSON.stringify(config.proxy.policy.denyPathGlobs),
    'agents (proxy routes)': JSON.stringify(agentUpstreamMap(config)),
    'proxy credential targets': credentialTargets,
  };
}

let running: ProxyFingerprint | null = null;

/** Called once the proxy has been constructed from `config`. */
export function recordRunningProxy(projectRoot: string, config: ResolvedConfig): void {
  running = proxyFingerprint(projectRoot, config);
  // Where each profile's traffic now goes — what a member's credential is
  // checked against (./running-proxy-routes.ts).
  recordRunningProxyRoutes(projectRoot, config);
}

/** The running proxy's fingerprint, or null when no proxy was built in this process. */
export function runningProxyFingerprint(): ProxyFingerprint | null {
  return running;
}

/** For tests. */
export function resetRunningProxy(): void {
  running = null;
}

/** The parts of `next` that differ from `base`. */
export function proxyDifferences(base: ProxyFingerprint, next: ProxyFingerprint): string[] {
  return Object.keys(next).filter((k) => base[k] !== next[k]);
}
