/**
 * What the running proxy was BUILT from.
 *
 * The daemon constructs its proxy once, at startup (src/daemon/server.ts), from
 * the config of that moment: its own tunables. Agent profile routes and
 * credential targets are read on every proxy request. Other settings are
 * re-read on use. So "does this config change need a restart?" is exactly "does the
 * new config's proxy fingerprint differ from the one the running proxy was
 * built from" — compared against what is RUNNING, not against the previous
 * file, so a restart that was owed and never happened is still owed on the
 * next save.
 */

import type { ResolvedConfig } from '../config/types';

/** One named part of the fingerprint → its canonical JSON. */
export type ProxyFingerprint = Record<string, string>;

export function proxyFingerprint(projectRoot: string, config: ResolvedConfig): ProxyFingerprint {
  return {
    'proxy.retry_after_threshold': JSON.stringify(config.proxy.retryAfterThreshold),
    'proxy.tier_retry_interval': JSON.stringify(config.proxy.tierRetryIntervalSeconds),
    'proxy.upstream_timeout': JSON.stringify(config.proxy.upstreamTimeoutSeconds),
    'proxy.audit_retention_days': JSON.stringify(config.proxy.auditRetentionDays),
    'proxy.audit_retention_mib': JSON.stringify(config.proxy.auditRetentionMib),
    'proxy.policy.deny_path_globs': JSON.stringify(config.proxy.policy.denyPathGlobs),
  };
}

let running: ProxyFingerprint | null = null;

/** Called once the proxy has been constructed from `config`. */
export function recordRunningProxy(projectRoot: string, config: ResolvedConfig): void {
  running = proxyFingerprint(projectRoot, config);
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
