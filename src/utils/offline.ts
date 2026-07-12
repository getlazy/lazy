/**
 * Offline mode state management.
 *
 * Offline mode is a per-project runtime toggle stored as
 * `${projectRoot}/.lazy/offline.json`. When enabled, all remote operations
 * (push, fetch, sync, PR creation) are skipped and the system operates in
 * local-only mode.
 *
 * Per-project because different projects may use different services: one
 * talks to GitLab (offline when on a plane), another uses Ollama locally
 * (always works). Each daemon reads its own project's offline state.
 *
 * Two ways to be offline, with deliberately different lifetimes:
 *
 *   1. Temporary (the `lazy system offline` command). Writes offline.json with
 *      an `expires_at` set to the next local midnight. Once that instant
 *      passes, `isOfflineMode()` reports ONLINE again and the daemon resumes
 *      remote ops with no manual `lazy system online`. This is the fix for the
 *      #1 pain — forgetting to go back online and silently staying stranded.
 *
 *   2. Permanent (the `[remote] offline = true` config flag). For users who
 *      genuinely want to stay offline indefinitely. Permanent offline is NOT
 *      subject to the midnight auto-expiry — it is honored for as long as the
 *      config flag is set. The flag value is supplied by callers via the
 *      `permanentOffline` argument (read from `config.remote.offline`) so this
 *      module never has to load config on the hot reconcile path.
 *
 * `lazy system online` clears the temporary offline file early. It does NOT
 * touch lazy.toml — to leave permanent offline, the user removes the config
 * flag (principle of least surprise: a command named "online" must not silently
 * rewrite the user's config).
 */

import { join } from 'path';
import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { nextLocalMidnight, describeExpiry } from './local-day';

const OFFLINE_FILENAME = 'offline.json';

export interface OfflineState {
  enabled: boolean;
  enabled_at?: string;
  /**
   * ISO timestamp at which a temporary offline auto-recovers (next local
   * midnight at the time `lazy system offline` ran). Absent only on legacy
   * files written before auto-expiry existed — those are treated as
   * non-expiring temporary offline for backward compatibility.
   */
  expires_at?: string;
  configured_driver?: string;
}

/**
 * The resolved, display-ready offline picture combining the on-disk temporary
 * state with the permanent config flag.
 */
export interface ResolvedOfflineStatus {
  /** Effective offline right now (permanent OR an unexpired temporary file). */
  offline: boolean;
  /** Offline because `[remote] offline = true` in lazy.toml. Never auto-expires. */
  permanent: boolean;
  /** A temporary offline file is present and not yet expired. */
  temporary: boolean;
  /** When the temporary offline auto-recovers (next local midnight). */
  expiresAt?: Date;
  /** When offline was enabled (from the temporary file). */
  enabledAt?: string;
  /** The remote driver suspended while offline (from the temporary file). */
  configuredDriver?: string;
}

/**
 * Get the path to the offline state file for a project.
 */
function getOfflineFilePath(dataDir: string): string {
  return join(dataDir, OFFLINE_FILENAME);
}

/**
 * Whether a temporary offline state has passed its auto-recovery instant.
 * A missing `expires_at` (legacy file) never expires. A malformed timestamp is
 * treated as non-expiring rather than guessing.
 */
function isExpired(state: OfflineState, now: Date = new Date()): boolean {
  if (!state.expires_at) return false;
  const t = Date.parse(state.expires_at);
  if (Number.isNaN(t)) return false;
  return now.getTime() >= t;
}

/**
 * Best-effort removal of an expired offline file so a stale state doesn't
 * linger on disk. Failures are non-fatal: the expiry is computed from the
 * timestamp on every read, so reporting ONLINE does not depend on the file
 * actually being gone. ENOENT (already removed, e.g. by a concurrent tick) is
 * the expected race and is ignored.
 */
async function cleanupExpired(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Non-fatal: the timestamp comparison already decided we're online. Leave
      // the stale file; the next write or `lazy system online` will clear it.
    }
  }
}

/**
 * Read and parse the raw offline state file. Returns `{ enabled: false }` when
 * no file exists. Throws on a file that exists but cannot be parsed (a broken
 * file is a bug to surface, not silently treat as online).
 */
async function readOfflineFile(filePath: string): Promise<OfflineState> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as OfflineState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: false };
    throw new Error(`Failed to parse ${filePath}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Check if offline mode is currently in effect for this project.
 *
 * Called on every daemon reconcile/sync tick, so it stays cheap: at most the
 * single offline.json read plus a timestamp comparison. The permanent config
 * flag is passed in (not read here) to avoid a per-tick config load.
 *
 * @param dataDir - The .lazy data directory (e.g., `${projectRoot}/.lazy`)
 * @param permanentOffline - The `[remote] offline` config flag. When true,
 *   offline is in effect regardless of the temporary file or its expiry.
 */
export async function isOfflineMode(dataDir: string, permanentOffline = false): Promise<boolean> {
  if (permanentOffline) return true;

  const filePath = getOfflineFilePath(dataDir);
  const state = await readOfflineFile(filePath);
  if (state.enabled !== true) return false;

  if (isExpired(state)) {
    // Auto-recover: the temporary offline has reached local midnight. Treat as
    // online and clean up the stale file so we stop re-reading it.
    await cleanupExpired(filePath);
    return false;
  }

  return true;
}

/**
 * Enable or disable temporary offline mode for a project.
 *
 * Enabling records `expires_at = next local midnight` so the state
 * auto-recovers — there is no indefinite temporary offline. Disabling removes
 * the file entirely (immediate manual restore). Permanent offline lives in
 * lazy.toml and is unaffected by this function.
 *
 * @param dataDir - The .lazy data directory
 * @param enabled - Whether to enable offline mode
 * @param configuredDriver - The currently configured remote driver (for display when going online)
 */
export async function setOfflineMode(
  dataDir: string,
  enabled: boolean,
  configuredDriver?: string,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const filePath = getOfflineFilePath(dataDir);

  if (enabled) {
    const state: OfflineState = {
      enabled: true,
      enabled_at: new Date().toISOString(),
      expires_at: nextLocalMidnight().toISOString(),
      ...(configuredDriver ? { configured_driver: configuredDriver } : {}),
    };
    await writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } else {
    // Remove the file entirely when going online
    try {
      await unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Failed to remove ${filePath}: ${err instanceof Error ? err.message : err}`);
      }
      // File doesn't exist — already online, nothing to do
    }
  }
}

/**
 * Get the raw temporary offline state file contents for a project.
 * Returns `{ enabled: false }` when no file exists. Does NOT apply expiry or
 * the permanent config flag — use `resolveOfflineStatus` for display.
 *
 * @param dataDir - The .lazy data directory
 */
export async function getOfflineStatus(dataDir: string): Promise<OfflineState> {
  return readOfflineFile(getOfflineFilePath(dataDir));
}

/**
 * Resolve the full, display-ready offline status by combining the on-disk
 * temporary state (with expiry applied) and the permanent config flag.
 *
 * An expired temporary file reports as not-offline and is cleaned up, matching
 * `isOfflineMode` so status output never disagrees with the daemon's behavior.
 *
 * @param dataDir - The .lazy data directory
 * @param permanentOffline - The `[remote] offline` config flag.
 */
export async function resolveOfflineStatus(
  dataDir: string,
  permanentOffline = false,
): Promise<ResolvedOfflineStatus> {
  const filePath = getOfflineFilePath(dataDir);
  const state = await readOfflineFile(filePath);

  let temporary = state.enabled === true;
  if (temporary && isExpired(state)) {
    // Match isOfflineMode: expired temporary offline is effectively online.
    await cleanupExpired(filePath);
    temporary = false;
  }

  return {
    offline: permanentOffline || temporary,
    permanent: permanentOffline,
    temporary,
    expiresAt: temporary && state.expires_at ? new Date(state.expires_at) : undefined,
    enabledAt: temporary ? state.enabled_at : undefined,
    configuredDriver: temporary ? state.configured_driver : undefined,
  };
}

/**
 * One-line, human description of when offline ends — reused everywhere offline
 * is displayed (`lazy system offline`, `lazy system status`, `lazy doctor`,
 * `lazy config get offline`) so the wording stays consistent. Examples:
 *   "auto-resumes in 6h (00:00 local)"  (temporary)
 *   "permanent (set in lazy.toml) — does not auto-resume"  (config flag)
 * Returns an empty string when not offline (or a legacy file with no expiry).
 */
export function formatOfflineExpiry(status: ResolvedOfflineStatus, now: Date = new Date()): string {
  if (status.permanent) return 'permanent (set in lazy.toml) — does not auto-resume';
  if (status.temporary && status.expiresAt) return `auto-resumes ${describeExpiry(status.expiresAt, now)}`;
  return '';
}
