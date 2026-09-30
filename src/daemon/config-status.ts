/**
 * Which lazy.toml the daemon is running on, which of its STARTUP-ONLY settings
 * differ from that file, and `lazy daemon reload`.
 *
 * Nearly everything in lazy.toml is read afresh on every use (`loadConfig` on
 * each turn launch, reconciler tick and request). A handful of settings are
 * not: the daemon reads them once, when it starts, and keeps using that value
 * — a bound socket, a built proxy, an open store, an address baked into every
 * link. Editing lazy.toml changed nothing for those, and nothing said so; the
 * report that prompted this was a dashboard URL still coming from a branch's
 * lazy.toml after the project root had been switched back to main.
 *
 * {@link STARTUP_SETTINGS} is that list, and each entry says how it is applied:
 *
 *   - `reload` — `lazy daemon reload` applies it in place, nothing interrupted
 *     (the dashboard address, the remote-sync period).
 *   - `restart` — only `lazy daemon restart` applies it; reload names it and
 *     changes nothing (anything the daemon has bound, built or opened).
 *
 * The running value of each is what the daemon RECORDED when it started (or
 * last reloaded), never re-derived from the file — comparing the file with
 * itself would report nothing pending, ever.
 *
 * Also here: the daemon's side of the last-known-good config
 * (src/config/last-good.ts) — the loud, once-per-episode system message, and
 * the state `lazy daemon status` and `lazy doctor` report.
 */

import type { ResolvedConfig } from '../config/types';
import { loadConfig, resolveConfigSource, type ConfigSourceRule } from '../config/loader';
import { enableLastKnownGood, lastKnownGoodState, type LastKnownGoodEvent, type LastKnownGoodState } from '../config/last-good';
import { proxyDifferences, proxyFingerprint, runningProxyFingerprint } from './proxy-fingerprint';
import { logger } from '../utils/logger';
import type { Storage } from '../storage/interface';

export type ApplyBy = 'reload' | 'restart';

interface StartupSetting {
  /** The lazy.toml key, as a person would write it. */
  key: string;
  apply: ApplyBy;
  /**
   * Which startup step records the running value: the web server's config
   * (`startup`) or the proxy's own load (`proxy`) — the two are separate reads
   * in src/daemon/server.ts, and each is recorded from the one it really used.
   */
  recordedBy: 'startup' | 'proxy';
  read: (config: ResolvedConfig) => unknown;
}

/**
 * EVERY setting the daemon holds from its start. Adding a startup read to the
 * daemon without adding it here brings back the silence this exists to end.
 */
export const STARTUP_SETTINGS: readonly StartupSetting[] = [
  { key: 'server.dashboard_url', apply: 'reload', recordedBy: 'startup', read: (c) => c.server.dashboard_url },
  { key: 'server.sync_interval', apply: 'reload', recordedBy: 'startup', read: (c) => c.server.sync_interval },
  { key: 'server.port', apply: 'restart', recordedBy: 'startup', read: (c) => c.server.port },
  { key: 'server.bind', apply: 'restart', recordedBy: 'startup', read: (c) => c.server.bind },
  // The runner type also picks which extra interfaces the dashboard and the
  // proxy LISTEN on (the container bridge on Linux). Task launches read it
  // afresh; the listeners do not.
  { key: 'runner.type', apply: 'restart', recordedBy: 'startup', read: (c) => c.runner.type },
  { key: 'storage.backend', apply: 'restart', recordedBy: 'startup', read: (c) => c.storage.backend },
  { key: 'storage.external_path', apply: 'restart', recordedBy: 'startup', read: (c) => c.storage.external_path },
  // Where the proxy's audit log is written; every other use re-reads it.
  { key: 'data.path', apply: 'restart', recordedBy: 'proxy', read: (c) => c.data.path },
  { key: 'proxy.port', apply: 'restart', recordedBy: 'proxy', read: (c) => c.proxy.port },
  { key: 'proxy.bind', apply: 'restart', recordedBy: 'proxy', read: (c) => c.proxy.bind },
  { key: 'proxy.upstream', apply: 'restart', recordedBy: 'proxy', read: (c) => c.proxy.upstream },
  { key: 'proxy.cursor_upstream', apply: 'restart', recordedBy: 'proxy', read: (c) => c.proxy.cursorUpstream },
  { key: 'proxy.fallbacks', apply: 'restart', recordedBy: 'proxy', read: (c) => c.proxy.fallbacks },
  { key: 'proxy.retry_after_threshold', apply: 'restart', recordedBy: 'proxy', read: (c) => c.proxy.retryAfterThreshold },
  { key: 'proxy.upstream_timeout', apply: 'restart', recordedBy: 'proxy', read: (c) => c.proxy.upstreamTimeoutSeconds },
  { key: 'proxy.policy', apply: 'restart', recordedBy: 'proxy', read: (c) => c.proxy.policy },
];

/**
 * The proxy fingerprint's parts that are not a single key above — agent
 * profile routes and the credential map — reported under these names. The
 * fingerprint stays the one authority on them (./proxy-fingerprint.ts).
 */
const FINGERPRINT_ONLY_PARTS = ['agents (proxy routes)', 'proxy credential targets'];

/** Running value per key, as canonical JSON. */
const running = new Map<string, string>();
/** In-place appliers for `reload` settings, registered by the daemon's server. */
const appliers = new Map<string, (config: ResolvedConfig) => void>();

function canonical(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

/** Record the running values a startup step took from `config`. */
export function recordStartupSettings(config: ResolvedConfig, recordedBy: StartupSetting['recordedBy']): void {
  for (const s of STARTUP_SETTINGS) {
    if (s.recordedBy === recordedBy) running.set(s.key, canonical(s.read(config)));
  }
}

/** How the daemon applies a `reload` setting in place. One per key. */
export function registerReloadApplier(key: string, apply: (config: ResolvedConfig) => void): void {
  const setting = STARTUP_SETTINGS.find((s) => s.key === key);
  if (!setting || setting.apply !== 'reload') {
    throw new Error(`registerReloadApplier: ${key} is not a setting \`lazy daemon reload\` applies`);
  }
  appliers.set(key, apply);
}

/** For tests. */
export function resetStartupSettings(): void {
  running.clear();
  appliers.clear();
}

/** One startup-only setting whose running value differs from the file. */
export interface PendingSetting {
  key: string;
  /** What the daemon is running with (a display string). */
  running: string;
  /** What the file in force says. */
  configured: string;
  applyBy: ApplyBy;
}

function display(json: string | undefined): string {
  if (json === undefined) return '(not recorded)';
  // A bare string reads better unquoted; everything else stays JSON.
  try {
    const v = JSON.parse(json);
    if (typeof v === 'string') return v === '' ? '(unset)' : v;
  } catch {
    // Not JSON (a fingerprint part's error text): shown as it is.
  }
  return json;
}

function pendingAgainst(projectRoot: string, config: ResolvedConfig): PendingSetting[] {
  const pending: PendingSetting[] = [];
  for (const s of STARTUP_SETTINGS) {
    const was = running.get(s.key);
    // A setting this process never recorded (a test daemon that built no proxy)
    // has nothing running to differ from.
    if (was === undefined) continue;
    const now = canonical(s.read(config));
    if (now !== was) pending.push({ key: s.key, running: display(was), configured: display(now), applyBy: s.apply });
  }
  const runningProxy = runningProxyFingerprint();
  if (runningProxy) {
    const next = proxyFingerprint(projectRoot, config);
    for (const part of proxyDifferences(runningProxy, next)) {
      if (!FINGERPRINT_ONLY_PARTS.includes(part)) continue;
      pending.push({ key: part, running: '(as started)', configured: '(changed)', applyBy: 'restart' });
    }
  }
  return pending;
}

export interface ConfigStatus {
  /** The file in force (absolute), and the rule that chose it. */
  path: string;
  rule: ConfigSourceRule;
  /** Present while the file does not load and the daemon runs on its last good copy. */
  lastKnownGood: LastKnownGoodState | null;
  /**
   * Present when the file does not load and there is NO good copy in this
   * process to fall back on — which only a daemon started before this existed,
   * or a read racing the very first load, can produce.
   */
  loadError: string | null;
  /** Startup-only settings whose running value differs from the file (the good copy, while it is broken). */
  pending: PendingSetting[];
}

/** The daemon's answer to `lazy daemon status`'s config section. */
export async function configStatus(projectRoot: string): Promise<ConfigStatus> {
  const source = await resolveConfigSource(projectRoot);
  let config: ResolvedConfig | null = null;
  let loadError: string | null = null;
  try {
    // NOT strict: while the file is broken, what differs is measured against
    // the config the daemon is actually using, and this read is also what
    // opens the episode if nothing else has read the file since it broke.
    config = await loadConfig(projectRoot);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }
  return {
    path: source.path,
    rule: source.rule,
    lastKnownGood: lastKnownGoodState(source.path),
    loadError,
    pending: config ? pendingAgainst(projectRoot, config) : [],
  };
}

export type ReloadResult =
  | {
      reloaded: true;
      path: string;
      rule: ConfigSourceRule;
      /** `reload` settings that changed and were applied now. */
      applied: PendingSetting[];
      /** Startup-only settings that differ and still need `lazy daemon restart`. Unchanged. */
      needsRestart: PendingSetting[];
    }
  | {
      reloaded: false;
      path: string;
      rule: ConfigSourceRule;
      /** The loader's parse or validation error. The running config stays. */
      error: string;
    };

/**
 * `lazy daemon reload`: re-read the file in force and apply what can change
 * without a restart. A file that does not load is refused — STRICT, so the
 * last-known-good copy can never be "reloaded" as if it were the file — and
 * nothing changes. Never interrupts a turn: every applier swaps a value the
 * next request reads.
 */
export async function reloadConfig(projectRoot: string): Promise<ReloadResult> {
  const source = await resolveConfigSource(projectRoot);
  let config: ResolvedConfig;
  try {
    config = await loadConfig(projectRoot, { strict: true });
  } catch (err) {
    return { reloaded: false, path: source.path, rule: source.rule, error: err instanceof Error ? err.message : String(err) };
  }
  const pending = pendingAgainst(projectRoot, config);
  const applied: PendingSetting[] = [];
  const needsRestart: PendingSetting[] = [];
  for (const p of pending) {
    const setting = STARTUP_SETTINGS.find((s) => s.key === p.key);
    const apply = setting?.apply === 'reload' ? appliers.get(p.key) : undefined;
    if (!setting || !apply) {
      needsRestart.push(p.applyBy === 'reload' ? { ...p, applyBy: 'restart' } : p);
      continue;
    }
    apply(config);
    running.set(setting.key, canonical(setting.read(config)));
    applied.push(p);
    logger.info(`lazy daemon reload: ${p.key} is now ${p.configured} (was ${p.running})`);
  }
  return { reloaded: true, path: source.path, rule: source.rule, applied, needsRestart };
}

/**
 * Turn on the last-known-good config for this daemon, reporting each episode
 * loudly and once: a warning in the daemon log and a system message naming the
 * file, the error, and that the last good config is in use.
 */
export function enableDaemonLastKnownGood(getStorage: () => Promise<Pick<Storage, 'createSystemMessage'>>): void {
  enableLastKnownGood((event: LastKnownGoodEvent) => {
    if (event.kind === 'recovered') {
      logger.info(`${event.path} loads again — the daemon is back on it.`);
      return;
    }
    const { path, error } = event.state;
    const body = lastKnownGoodMessage(event.state);
    logger.warn(body);
    void getStorage()
      .then((storage) => storage.createSystemMessage({
        source: 'config',
        kind: 'alert',
        title: 'lazy.toml does not load — the daemon is running on its last good config',
        body,
      }))
      .catch((err: unknown) => {
        logger.error(`Could not file a system message that ${path} does not load (${error}): ${err instanceof Error ? err.message : String(err)}`);
      });
  });
}

/** The words every surface uses for an episode. */
export function lastKnownGoodMessage(state: LastKnownGoodState): string {
  return (
    `${state.path} does not load:\n\n${state.error}\n\n` +
    `The daemon keeps running on the last config it loaded from that file (at ${state.goodLoadedAt}), ` +
    'so nothing you changed since then is in effect. Fix the file; the daemon picks it up again on its own ' +
    '(`lazy daemon status` shows when it has). Until then do not run `lazy daemon restart` or `lazy upgrade`: ' +
    'a daemon cannot START on a lazy.toml that does not load, so the project would be left with none.'
  );
}
