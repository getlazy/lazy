/**
 * WHICH config a process is running on: the file, the rule that chose it, a
 * hash of its bytes and — for a control plane's file — the configuration
 * version that control plane applied it from.
 *
 * Every one of these is REPORTED, never inferred. "Unknown agent profile" on a
 * project whose saved configuration plainly defines that profile is only
 * diagnosable if the reader can see which file the daemon loaded and whether it
 * is the version they think it is; a page that infers "applied" from its own
 * bookkeeping cannot see a daemon that is on something else.
 *
 * The applied version lives in a small record BESIDE the control plane's file
 * (`<file>.applied.json`), written by the apply RPC with the hash of the text
 * it wrote. A record whose hash no longer matches the file (somebody wrote the
 * file another way) names no version: a version is only claimed for the bytes
 * it was applied with.
 */

import { createHash, randomBytes } from 'crypto';
import { lstat, readFile, rename, rm, writeFile } from 'fs/promises';
import type { ConfigSourceRule } from './loader';
import type { WithheldSetting } from './managed-withhold';

export interface AppliedRecord {
  /** The control plane's configuration version the file was written from. */
  version: number;
  /** sha256 of the text written. */
  sha256: string;
  appliedAt: string;
  /**
   * Whose rules the text is judged by. `repository`: imported verbatim from a
   * repository and never edited — its endpoints and credential names stay
   * refused. Absent (an older record) reads as `repository`, the safe side.
   */
  origin?: 'repository' | 'control-plane';
}

export interface ConfigInForce {
  path: string;
  rule: ConfigSourceRule;
  /** False when no file is there and lazy's defaults apply. */
  exists: boolean;
  /** sha256 of the file's bytes, or null when there is no file. */
  sha256: string | null;
  /** The control-plane version these exact bytes were applied from, or null when none is recorded for them. */
  appliedVersion: number | null;
  appliedAt: string | null;
  /**
   * For a control plane's file only: the [agents.*] names the REPOSITORY's own
   * lazy.toml defines, so "Unknown agent profile" can say when the repository
   * has a profile the configuration in force does not. Absent when not read.
   */
  repositoryAgentNames?: string[];
  /**
   * For a control plane's file only: profiles the file DEFINES that the managed
   * rules withhold, with why — so "Unknown agent profile" can say the profile
   * is kept but not usable instead of claiming it does not exist.
   */
  withheldProfiles?: Record<string, string>;
  /**
   * Of {@link withheldProfiles}, the ones a project admin's confirmation of the
   * project's connections would make usable (./connection-consent), so the
   * refusal can say the profile waits for that rather than that it is refused.
   */
  awaitingConfirmation?: string[];
  /** On a managed host: every part of the loaded file the managed rules withheld. */
  withheld?: WithheldSetting[];
}

/**
 * The [agents.<name>] table names in a lazy.toml's text. A line scan, not a
 * parse: this only feeds an error message, and a repository file that no
 * longer parses must not stop the message naming what it can.
 */
export function agentTableNames(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/^\s*\[\s*agents\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]/gm)) {
    names.add(m[1] ?? m[2] ?? m[3]!);
  }
  return [...names];
}

/**
 * The repository lazy.toml's agent names, or null when it is not there or is
 * not a regular file. Only a REGULAR file is read: the repository is
 * untrusted, and a symlink to a FIFO or device would hang the caller.
 */
export async function repositoryAgentNames(repoConfigPath: string): Promise<string[] | null> {
  try {
    if (!(await lstat(repoConfigPath)).isFile()) return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const text = await readIfPresent(repoConfigPath);
  return text === null ? null : agentTableNames(text);
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

export function appliedRecordPath(managedPath: string): string {
  return `${managedPath}.applied.json`;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The applied record beside `managedPath`, or null when there is none or it cannot be read as one. */
export async function readAppliedRecord(managedPath: string): Promise<AppliedRecord | null> {
  const text = await readIfPresent(appliedRecordPath(managedPath));
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as Partial<AppliedRecord>;
    if (typeof raw.version !== 'number' || typeof raw.sha256 !== 'string') return null;
    return {
      version: raw.version,
      sha256: raw.sha256,
      appliedAt: String(raw.appliedAt ?? ''),
      origin: raw.origin === 'control-plane' ? 'control-plane' : 'repository',
    };
  } catch {
    // A torn or hand-edited record claims nothing: the version is then reported
    // as unknown, which is the honest answer, rather than failing the read of
    // the config itself.
    return null;
  }
}

/** Atomically record which version `managedPath` now holds. */
export async function writeAppliedRecord(managedPath: string, record: AppliedRecord): Promise<void> {
  const target = appliedRecordPath(managedPath);
  const staging = `${target}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(staging, JSON.stringify(record) + '\n', { encoding: 'utf-8', mode: 0o600 });
    await rename(staging, target);
  } catch (err) {
    await rm(staging, { force: true });
    throw new Error(`failed to record the applied configuration version in ${target}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Whose rules the control plane's file at `path` holding `text` is judged by.
 * `control-plane` ONLY when an applied record for exactly these bytes says the
 * control plane's owner wrote them; anything else — an import, a file written
 * another way, no record — is judged as the repository's, so a repository's
 * endpoint or credential name never takes effect by being copied.
 */
export async function controlPlaneTextOrigin(path: string, text: string): Promise<'repository' | 'control-plane'> {
  // An unreadable record proves nothing about who wrote the bytes: the safe side.
  const record = await readAppliedRecord(path).catch(() => null);
  return record !== null && record.sha256 === sha256Text(text) && record.origin === 'control-plane'
    ? 'control-plane'
    : 'repository';
}

/** Describe the file at `path` (chosen by `rule`) as it is on disk now. */
export async function describeConfigFile(path: string, rule: ConfigSourceRule): Promise<ConfigInForce> {
  return describeConfigText(path, rule, await readIfPresent(path));
}

/** Describe `text`, already read from `path` (null: no file there). */
export async function describeConfigText(path: string, rule: ConfigSourceRule, text: string | null): Promise<ConfigInForce> {
  if (text === null) {
    return { path, rule, exists: false, sha256: null, appliedVersion: null, appliedAt: null };
  }
  const sha256 = sha256Text(text);
  const record = rule === 'managed' ? await readAppliedRecord(path) : null;
  const matches = record !== null && record.sha256 === sha256;
  return {
    path,
    rule,
    exists: true,
    sha256,
    appliedVersion: matches && record.version > 0 ? record.version : null,
    appliedAt: matches ? record.appliedAt || null : null,
  };
}

/** One line naming the config in force, for an error message or a log. */
export function describeConfigInForceLine(c: ConfigInForce): string {
  if (!c.exists) return `${c.path} (not present — lazy's defaults apply)`;
  const source = c.rule === 'managed' ? "the control plane's copy" : c.rule === 'LAZY_CONFIG' ? 'LAZY_CONFIG' : "the repository's lazy.toml";
  const version = c.rule === 'managed'
    ? (c.appliedVersion !== null ? `, configuration version ${c.appliedVersion}` : ', no recorded configuration version')
    : '';
  return `${c.path} (${source}${version}, sha256 ${c.sha256!.slice(0, 12)})`;
}

// ── What this process last loaded ─────────────────────────────────────────
//
// Set by the loader after every successful load, so a synchronous error deep
// in a lookup (an unknown agent profile) can name the file it was judged
// against without re-reading anything.

let lastLoaded: ConfigInForce | null = null;

export function noteConfigLoaded(c: ConfigInForce | null): void {
  lastLoaded = c;
}

export function lastLoadedConfig(): ConfigInForce | null {
  return lastLoaded;
}
