import { readFile } from 'fs/promises';
import { appliedRecordPath, sha256Text } from '../config/config-provenance';
import type { ResolvedConfig } from '../config/types';
import { loadConfig, resolveConfigPath } from '../config/loader';
import { lastKnownGoodState } from '../config/last-good';
import { agentProfilesFor } from '../config/agent-profiles';
import { agentUpstreamMap } from '../proxy/agent-upstreams';
import { buildTargetCredentials } from '../proxy/credential-deps';
import type { TargetCredentials } from '../proxy/target-credentials';
import type { ProxyAgentRouting } from '../proxy/server';
import { logger } from '../utils/logger';
import { teamModeEnabled } from './user-credentials';

interface ContentVersion {
  /** Hash of everything routes are built from: the file's bytes and its applied record's bytes. */
  version: string;
  /** False when the record names a config hash that is not the file's: the pair may be half-written. */
  consistent: boolean;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function contentVersion(path: string): Promise<ContentVersion | 'missing'> {
  const text = await readOrNull(path);
  if (text === null) return 'missing';
  const record = await readOrNull(appliedRecordPath(path));
  let consistent = true;
  if (record !== null) {
    try {
      const named = (JSON.parse(record) as { sha256?: unknown }).sha256;
      consistent = typeof named !== 'string' || named === sha256Text(text);
    } catch {
      // A torn record is unreadable as one; treat it as disagreeing so the next tick re-reads it.
      consistent = false;
    }
  }
  return { version: sha256Text(`${sha256Text(text)}\n${record === null ? 'no-record' : sha256Text(record)}`), consistent };
}

/** How long a lazy.toml whose applied record names different bytes is held before it applies as it stands. */
const MISMATCH_GRACE_MS = 3000;

/** Only config-derived routing is held here; every target resolver reads its secret live. */
export async function createLiveProxyRouting(
  projectRoot: string,
  initialConfig: ResolvedConfig,
  initialTargets: TargetCredentials,
  options: { mismatchGraceMs?: number } = {},
): Promise<() => Promise<ProxyAgentRouting>> {
  let appliedPath = await resolveConfigPath(projectRoot);
  // The file can change after startup loaded initialConfig; verify it on the first request.
  let appliedVersion: string | null = null;
  let routing: ProxyAgentRouting = {
    routes: agentUpstreamMap(initialConfig),
    targets: initialTargets,
    profiles: new Set(agentProfilesFor(initialConfig).keys()),
    config: initialConfig,
  };
  let refreshing: Promise<void> | null = null;
  let warnedVersion: string | null = null;
  let rejectedVersion: string | null = null;
  let rejectedPath: string | null = null;
  // A record naming different bytes than the file means the pair is probably mid-write. Applying it would load the
  // file under the stricter repository rules and drop profiles into removedProfiles for good, so keep serving the
  // last routes for a grace PERIOD (not a request count), then apply as it stands: a file written another way leaves
  // a record that is stale forever, which must not strand routing.
  const graceMs = options.mismatchGraceMs ?? MISMATCH_GRACE_MS;
  let deferredVersion: string | null = null;
  let deferredSince = 0;
  const removedProfiles = new Set<string>();

  return async () => {
    for (;;) {
      let path: string;
      let version: string;
      try {
        path = await resolveConfigPath(projectRoot);
        const read = await contentVersion(path);
        version = read === 'missing' ? 'missing' : read.version;
        if (read !== 'missing' && !read.consistent && version !== appliedVersion && version !== rejectedVersion) {
          if (deferredVersion !== version) {
            deferredVersion = version;
            deferredSince = Date.now();
          }
          if (Date.now() - deferredSince < graceMs) return routing;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (warnedVersion !== message) {
          logger.warn(`[proxy] cannot check lazy.toml for changed routes: ${message}; keeping the last applied routes. Run lazy doctor.`);
          warnedVersion = message;
        }
        return routing;
      }
      if (refreshing) {
        await refreshing;
        continue;
      }
      if ((path === appliedPath && version === appliedVersion) ||
          (path === rejectedPath && version === rejectedVersion)) return routing;
      if (version === 'missing') {
        if ((appliedVersion !== null || path !== appliedPath) && warnedVersion !== `missing:${path}`) {
          logger.warn(`[proxy] lazy.toml at ${path} is missing; keeping the last applied routes. Run lazy doctor.`);
          warnedVersion = `missing:${path}`;
        }
        return routing;
      }
      const work = async () => {
        try {
          const current = await loadConfig(projectRoot);
          if (lastKnownGoodState(path)) {
            rejectedVersion = version;
            rejectedPath = path;
            return;
          }
          const targets = buildTargetCredentials(projectRoot, current, await teamModeEnabled(projectRoot)).targets;
          const nextProfiles = new Set(agentProfilesFor(current).keys());
          const nextRoutes = agentUpstreamMap(current);
          if (await resolveConfigPath(projectRoot) !== path) return;
          for (const profile of routing.profiles) {
            if (!nextProfiles.has(profile)) removedProfiles.add(profile);
          }
          for (const profile of removedProfiles) {
            nextProfiles.delete(profile);
            delete nextRoutes[profile];
          }
          const next: ProxyAgentRouting = { routes: nextRoutes, targets, profiles: nextProfiles, config: current };
          const previousVersion = appliedVersion;
          routing = next;
          appliedPath = path;
          appliedVersion = version;
          deferredVersion = null;
          rejectedVersion = null;
          rejectedPath = null;
          warnedVersion = null;
          if (previousVersion !== null) logger.info('[proxy] applied updated agent routes and credential targets');
        } catch (error) {
          rejectedVersion = version;
          rejectedPath = path;
          const message = error instanceof Error ? error.message : String(error);
          if (warnedVersion !== version) {
            logger.warn(`[proxy] cannot apply changed agent routes: ${message}; keeping the last applied routes. Run lazy doctor.`);
            warnedVersion = version;
          }
        }
      };
      const pending = work();
      refreshing = pending;
      try {
        await pending;
      } finally {
        if (refreshing === pending) refreshing = null;
      }
      return routing;
    }
  };
}
