/**
 * The control plane's copy of a managed project's lazy.toml.
 *
 * Lazy Teams imports a project's lazy.toml ONCE, keeps it in its own database,
 * lets the project owner edit it, and hands the effective text to the daemon.
 * The daemon keeps it in the file named by `LAZY_MANAGED_CONFIG_PATH` — outside
 * the clone, so a save never dirties the git tree — and from the moment that
 * file exists the repository's lazy.toml is never read again (the loader's
 * `resolveConfigPath`). Nothing is ever synced back the other way.
 *
 * Three operations, all behind control-plane RPCs:
 *
 *   - READ: which file is in force, its text, the repository's own lazy.toml
 *     (what an import copies), and the editable key set.
 *   - VALIDATE: the daemon's own verdict on candidate text, per key.
 *   - APPLY: validate, then write atomically. An invalid candidate is never
 *     written, so the file in force is always one the daemon has already
 *     accepted — a bad save cannot take a running daemon down.
 *
 * WHEN A CHANGE TAKES EFFECT. The daemon does not cache its config: every
 * turn launch, reconciler tick and request calls `loadConfig`, which reads the
 * file afresh. So an applied change is live for the next turn and the next
 * tick with no restart — except what the proxy is built from at startup
 * (./proxy-fingerprint); APPLY names what differs from the RUNNING proxy so the
 * control plane can restart the daemon for the user.
 */

import { lstat, mkdir, readFile, rename, writeFile, rm } from 'fs/promises';
import { readConnections, type ConnectionsRead } from '../config/connection-consent';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { loadConfig, resolveConfigSource, resolveConfigText } from '../config/loader';
import { describeConfigFile, sha256Text, writeAppliedRecord, type ConfigInForce } from '../config/config-provenance';
import { managedConfigPath, isManagedMode } from '../config/managed';
import {
  editableConfigKeys,
  validateProjectConfigText,
  profileSupport,
  type ProfileSupport,
  RESTART_REQUIRED_SUMMARY,
  type ProjectConfigVerdict,
} from '../config/project-config';
import {
  describeConfigChange,
  editConfigText,
  settingValues,
  settingsCatalog,
  SettingEditError,
  type SettingChange,
  type SettingsCatalogRead,
} from '../config/settings-catalog';
import { RpcError } from './rpc-error';
import { proxyDifferences, proxyFingerprint, runningProxyFingerprint } from './proxy-fingerprint';

/** Larger than any real lazy.toml by two orders of magnitude; a bound, not a budget. */
export const PROJECT_CONFIG_MAX_BYTES = 256 * 1024;

export interface ProjectConfigRead {
  managed: boolean;
  /** The control plane's file, or null when this daemon has none configured. */
  managedPath: string | null;
  /** True once the control plane's file exists — the repository is no longer read. */
  imported: boolean;
  /** Which file the daemon's config comes from right now. */
  source: 'control-plane' | 'repository';
  /** The text in force, or null when there is no file at all (lazy's defaults). */
  toml: string | null;
  /** The repository's own lazy.toml at the project root — what an import copies. */
  repositoryToml: string | null;
  editableKeys: string[];
  restartRequiredKeys: readonly string[];
  /** Every editable key grouped, explained, and with when a change takes effect. */
  settings: SettingsCatalogRead;
  /**
   * What differs between the config in force and what the running proxy was
   * built from — a restart still owed. Empty when nothing is owed, or when
   * this process built no proxy to compare against.
   */
  restartPending: string[];
  /**
   * The file in force as it is on disk: path, the rule that chose it, a hash
   * of its bytes and the control-plane version those bytes were applied from
   * (null when none is recorded for them). Reported so a control plane shows
   * what the daemon is ACTUALLY on, never infers it from its own bookkeeping.
   */
  inForce: ConfigInForce;
}

/** What the config in force needs a restart for, compared with the running proxy. */
async function pendingRestart(projectRoot: string): Promise<string[]> {
  const running = runningProxyFingerprint();
  if (!running) return [];
  try {
    return proxyDifferences(running, proxyFingerprint(projectRoot, await loadConfig(projectRoot)));
  } catch {
    // A config in force that no longer loads is reported by every other read;
    // it says nothing about a restart.
    return [];
  }
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function readProjectConfig(projectRoot: string): Promise<ProjectConfigRead> {
  const managedPath = managedConfigPath(projectRoot);
  const source = await resolveConfigSource(projectRoot);
  const inForce = source.path;
  const imported = managedPath !== null && inForce === managedPath;
  return {
    managed: isManagedMode(),
    managedPath,
    imported,
    source: imported ? 'control-plane' : 'repository',
    toml: await readIfPresent(inForce),
    repositoryToml: await readIfPresent(join(projectRoot, 'lazy.toml')),
    editableKeys: editableConfigKeys(),
    restartRequiredKeys: RESTART_REQUIRED_SUMMARY,
    settings: settingsCatalog(),
    restartPending: await pendingRestart(projectRoot),
    inForce: await describeConfigFile(source.path, source.rule),
  };
}

function requireToml(toml: unknown): string {
  if (typeof toml !== 'string') throw new RpcError(400, 'toml must be a string');
  if (Buffer.byteLength(toml, 'utf-8') > PROJECT_CONFIG_MAX_BYTES) {
    throw new RpcError(400, `toml is larger than ${PROJECT_CONFIG_MAX_BYTES} bytes`);
  }
  return toml;
}

export interface ProjectConfigCheck extends ProjectConfigVerdict {
  /** What the candidate sets, per key, as display text. */
  values: Record<string, string>;
  /** Every profile the text defines, and whether this installation can use it. */
  profiles: ProfileSupport[];
  /** Per-key changes from `before`, with when each takes effect — only when `before` was sent. */
  changes?: SettingChange[];
}

/**
 * The daemon's verdict on candidate text, plus what it sets and — given the
 * version it would replace — what changes and when each change is picked up.
 */
export function validateProjectConfig(toml: unknown, before?: unknown, rawOrigin?: unknown, rawBeforeOrigin?: unknown): ProjectConfigCheck {
  const text = requireToml(toml);
  const origin = rawOrigin === 'repository' ? 'repository' as const : 'control-plane' as const;
  const keptOrigin = rawBeforeOrigin === 'repository' ? 'repository' as const : 'control-plane' as const;
  // What the saved version already carries is kept, not refused again: an
  // imported file is stored verbatim and its withheld settings are reported, not
  // a reason to refuse an unrelated edit.
  const kept = typeof before === 'string' ? before : null;
  const check: ProjectConfigCheck = { ...validateProjectConfigText(text, { kept, origin, keptOrigin }), values: settingValues(text), profiles: profileSupport(text, origin) };
  if (before !== undefined && before !== null) {
    // Omitted when either text does not parse: nothing can be said about what it sets.
    const changes = describeConfigChange(requireToml(before), text);
    if (changes) check.changes = changes;
  }
  return check;
}

/**
 * Candidate text with the settings form's edits applied, comments intact.
 * Writes nothing: the control plane judges the result with
 * `validateProjectConfig` and saves it like any hand-edited text.
 */
export function editProjectConfig(toml: unknown, set: unknown, unset: unknown): { toml: string } {
  const text = requireToml(toml);
  const sets = set ?? {};
  if (typeof sets !== 'object' || Array.isArray(sets) || Object.values(sets).some((v) => typeof v !== 'string')) {
    throw new RpcError(400, 'set must be an object of strings');
  }
  const unsets = unset ?? [];
  if (!Array.isArray(unsets) || unsets.some((k) => typeof k !== 'string')) {
    throw new RpcError(400, 'unset must be an array of strings');
  }
  try {
    return { toml: requireToml(editConfigText(text, sets as Record<string, string>, unsets as string[])) };
  } catch (err) {
    if (err instanceof SettingEditError) throw new RpcError(400, err.message);
    throw err;
  }
}

export interface ProjectConfigApplied {
  applied: boolean;
  /** False when the file already held exactly this text. */
  changed: boolean;
  verdict: ProjectConfigVerdict;
  /** Changed keys that take effect only after a daemon restart. */
  restartRequired: string[];
  path: string | null;
  /** sha256 of the text now in the file; null when nothing was applied. */
  sha256: string | null;
}

/**
 * `version` is the control plane's number for this text. It is recorded beside
 * the file with the text's hash (../config/config-provenance), so
 * `readProjectConfig` and `lazy daemon status` can say which version the daemon
 * is on. Optional: a control plane that sends none gets a file reported with no
 * version, which is the truth.
 */
export async function applyProjectConfig(
  projectRoot: string,
  rawToml: unknown,
  rawVersion?: unknown,
  rawOrigin?: unknown,
): Promise<ProjectConfigApplied> {
  const toml = requireToml(rawToml);
  // Whose text this is (src/config/config-provenance.ts `controlPlaneTextOrigin`):
  // only an owner's own edit is `control-plane`. An import is the repository's,
  // and so is anything a caller does not label.
  if (rawOrigin !== undefined && rawOrigin !== null && rawOrigin !== 'repository' && rawOrigin !== 'control-plane') {
    throw new RpcError(400, 'origin must be "repository" or "control-plane"');
  }
  const origin = rawOrigin === 'control-plane' ? 'control-plane' : 'repository';
  if (rawVersion !== undefined && rawVersion !== null
    && !(typeof rawVersion === 'number' && Number.isInteger(rawVersion) && rawVersion > 0)) {
    throw new RpcError(400, 'version must be a positive integer');
  }
  const version = typeof rawVersion === 'number' ? rawVersion : null;
  const path = managedConfigPath(projectRoot);
  if (!path) {
    throw new RpcError(
      409,
      'This daemon has no control-plane config file (LAZY_MANAGED_CONFIG_PATH is not set), ' +
      'so there is nowhere to apply a config to. Its lazy.toml is the repository\'s own file.',
    );
  }

  // Applying is not authoring: the control plane already judged an edit, and an
  // IMPORT is verbatim. A setting the managed rules refuse is withheld when the
  // daemon loads the file (src/config/managed-withhold.ts), so the only thing
  // that refuses an apply is text the daemon could not run on at all.
  const verdict = validateProjectConfigText(toml, { kept: toml, origin });
  if (!verdict.ok) return { applied: false, changed: false, verdict, restartRequired: [], path, sha256: null };

  // Compared with what the RUNNING proxy was built from, not with the previous
  // file: a restart owed by an earlier save and never performed stays owed.
  // With no proxy in this process (a test, a CLI), the config in force stands in.
  const base = runningProxyFingerprint()
    ?? proxyFingerprint(projectRoot, await loadConfig(projectRoot));
  const restartRequired = proxyDifferences(base,
    proxyFingerprint(projectRoot, resolveConfigText(toml, path, { install: false })));

  const sha256 = sha256Text(toml);
  // Written AFTER the file, so a record never names bytes that are not there;
  // a crash between the two leaves a file reported with no version, not a wrong one.
  const record = async () => {
    // Always written: the record is what tells the loader whose rules these
    // bytes are judged by. With no version, the version is 0 (none recorded).
    await writeAppliedRecord(path, { version: version ?? 0, sha256, appliedAt: new Date().toISOString(), origin });
  };
  const current = await readIfPresent(path);
  if (current === toml) {
    // Same bytes, possibly under a new version number (a save that went back
    // to an earlier text): the record follows the version.
    await record();
    return { applied: true, changed: false, verdict, restartRequired, path, sha256 };
  }

  // Atomic: a sibling temp file renamed over the target, so a reader sees the
  // old file or the new one and never half of either.
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(staging, toml, { encoding: 'utf-8', mode: 0o600 });
    await rename(staging, path);
  } catch (err) {
    await rm(staging, { force: true });
    throw new Error(`failed to write the project config to ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  await record();
  return { applied: true, changed: true, verdict, restartRequired, path, sha256 };
}

/**
 * The endpoints and agent profiles `toml` defines, judged by `origin`'s rules,
 * with what a project admin's confirmation would make usable and the blocks
 * only the repository's lazy.toml has (../config/connection-consent). Writes
 * nothing: confirming is the control plane recording a version judged by its
 * own rules, through `applyProjectConfig`, naming who confirmed.
 */
export async function readProjectConnections(projectRoot: string, rawToml: unknown, rawOrigin: unknown): Promise<ConnectionsRead & { blockedBy: ProjectConfigVerdict['issues'] }> {
  const toml = requireToml(rawToml);
  if (rawOrigin !== 'repository' && rawOrigin !== 'control-plane') {
    throw new RpcError(400, 'origin must be "repository" or "control-plane"');
  }
  const read = readConnections(toml, rawOrigin, await readRegularFile(join(projectRoot, 'lazy.toml')));
  // Judged exactly as the confirmation will be, so a Confirm that would be
  // refused is never offered: its errors are listed instead.
  const copied = read.fromRepository.toml;
  const draft = copied ? `${toml.trimEnd()}\n\n${copied}` : toml;
  const verdict = validateProjectConfigText(draft, { kept: toml, origin: 'control-plane', keptOrigin: rawOrigin });
  return { ...read, blockedBy: verdict.issues.filter((i) => i.severity === 'error') };
}

/** A regular file's text, or null: the repository is untrusted, and a symlink to a FIFO would hang the read. */
async function readRegularFile(path: string): Promise<string | null> {
  try {
    if (!(await lstat(path)).isFile()) return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return readIfPresent(path);
}
