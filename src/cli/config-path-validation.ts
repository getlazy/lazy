/**
 * Validate path-valued keys in lazy.toml.
 *
 * The filesystem preflight (preflight.ts) covers the directories lazy *always*
 * needs: cwd, ~/.lazy, project .lazy/. This module covers the additional paths
 * a user can configure in lazy.toml — `data.path`, `storage.external_path`,
 * `docker.dockerfile`, `documents.path`. When one of those is stale or wrong
 * (common after a machine migration or username change), we want a clear
 * error naming the config key and the value, not an opaque ENOENT/EACCES
 * deep inside storage or runner code.
 */
import { stat, access } from 'fs/promises';
import { constants } from 'fs';
import { isAbsolute, resolve } from 'path';
import { userInfo } from 'os';
import { expandTilde } from '../utils/home';
import { loadRawConfig, resolveConfigPath } from '../config/loader';

/** A path-valued config key we know how to validate. */
interface PathSpec {
  /** Dotted config key for error messages — e.g. "storage.external_path". */
  key: string;
  /** Raw value as the user wrote it in lazy.toml. */
  rawValue: string;
  /** Absolute, tilde-expanded path actually consumed by lazy. */
  resolvedPath: string;
  /** Expected filesystem type. */
  kind: 'file' | 'dir';
  /** True if lazy writes to this location (so we also probe write access). */
  needsWrite: boolean;
}

interface ValidationFailure {
  spec: PathSpec;
  /** What went wrong, in user-facing prose. */
  reason: string;
  /** Underlying error code if any, for tests and machine logs. */
  code?: string;
}

function readString(section: unknown, key: string): string | null {
  if (!section || typeof section !== 'object') return null;
  const v = (section as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Extract validatable path specs from a raw parsed lazy.toml. Only includes
 * keys the user actually set to a non-empty value — defaults like an empty
 * `storage.external_path` are auto-derived elsewhere and not the user's
 * intent to validate.
 */
function extractPathSpecs(raw: Record<string, unknown>, lazyRoot: string | null): PathSpec[] {
  const specs: PathSpec[] = [];
  const baseDir = lazyRoot ?? process.cwd();

  const dataPath = readString(raw.data, 'path');
  if (dataPath) {
    specs.push({
      key: 'data.path',
      rawValue: dataPath,
      resolvedPath: isAbsolute(dataPath) ? dataPath : resolve(baseDir, dataPath),
      kind: 'dir',
      needsWrite: true,
    });
  }

  const externalPath = readString(raw.storage, 'external_path');
  if (externalPath) {
    const expanded = expandTilde(externalPath);
    specs.push({
      key: 'storage.external_path',
      rawValue: externalPath,
      resolvedPath: isAbsolute(expanded) ? expanded : resolve(baseDir, expanded),
      kind: 'dir',
      needsWrite: true,
    });
  }

  const dockerfile = readString(raw.docker, 'dockerfile');
  if (dockerfile) {
    specs.push({
      key: 'docker.dockerfile',
      rawValue: dockerfile,
      resolvedPath: isAbsolute(dockerfile) ? dockerfile : resolve(baseDir, dockerfile),
      kind: 'file',
      needsWrite: false,
    });
  }

  const documentsPath = readString(raw.documents, 'path');
  if (documentsPath) {
    const expanded = expandTilde(documentsPath);
    specs.push({
      key: 'documents.path',
      rawValue: documentsPath,
      resolvedPath: isAbsolute(expanded) ? expanded : resolve(baseDir, expanded),
      kind: 'dir',
      needsWrite: true,
    });
  }

  return specs;
}

/**
 * If `p` looks like it was copied from another user's home directory
 * (`/Users/<other>/...` on darwin, `/home/<other>/...` on linux), return a
 * hint sentence. Returns null when the heuristic doesn't apply — we only want
 * to emit the "did your home dir move?" line when there's a real signal,
 * otherwise it's misleading noise.
 *
 * INVARIANT: stale-user-home heuristic triggers only when the path's user
 * component differs from the current user.
 */
export function staleUserHomeHint(p: string): string | null {
  let prefix: string;
  if (process.platform === 'darwin') prefix = '/Users/';
  else if (process.platform === 'linux') prefix = '/home/';
  else return null;
  if (!p.startsWith(prefix)) return null;
  const rest = p.slice(prefix.length);
  const userInPath = rest.split('/')[0];
  if (!userInPath || userInPath === 'Shared') return null;

  let currentUser: string;
  try {
    currentUser = userInfo().username;
  } catch {
    return null;
  }
  if (!currentUser || userInPath === currentUser) return null;

  return (
    `The path starts with ${prefix}${userInPath}/, but the current user is "${currentUser}". ` +
    `If you copied this config from another machine or your home directory moved, ` +
    `update the value to point at a directory the current user can access.`
  );
}

async function validateOne(spec: PathSpec): Promise<ValidationFailure | null> {
  let st;
  try {
    st = await stat(spec.resolvedPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { spec, reason: 'the path does not exist', code };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { spec, reason: `the path is not accessible (${code})`, code };
    }
    return {
      spec,
      reason: `failed to stat the path: ${(err as Error).message}`,
      code,
    };
  }

  if (spec.kind === 'dir' && !st.isDirectory()) {
    return {
      spec,
      reason: 'the path exists but is not a directory',
    };
  }
  if (spec.kind === 'file' && !st.isFile()) {
    return {
      spec,
      reason: 'the path exists but is not a regular file',
    };
  }

  try {
    await access(spec.resolvedPath, constants.R_OK);
  } catch (err) {
    return {
      spec,
      reason: 'the path is not readable by the current user',
      code: (err as NodeJS.ErrnoException).code,
    };
  }

  if (spec.needsWrite) {
    try {
      await access(spec.resolvedPath, constants.W_OK);
    } catch (err) {
      return {
        spec,
        reason: 'the path is not writable by the current user',
        code: (err as NodeJS.ErrnoException).code,
      };
    }
  }

  return null;
}

function formatFailure(failure: ValidationFailure, configPath: string): string {
  const { spec } = failure;
  const lines: string[] = [];
  lines.push(`Error: lazy.toml [${spec.key.split('.')[0]}] ${spec.key.split('.')[1]} points at a path that cannot be used: ${failure.reason}.`);
  lines.push('');
  lines.push(`  config key:   ${spec.key}`);
  lines.push(`  value:        ${spec.rawValue}`);
  if (spec.resolvedPath !== spec.rawValue) {
    lines.push(`  resolved to:  ${spec.resolvedPath}`);
  }
  lines.push(`  expected:     ${spec.kind === 'dir' ? 'directory' : 'file'}${spec.needsWrite ? ' (readable + writable)' : ' (readable)'}`);
  lines.push('');

  const hint = staleUserHomeHint(spec.resolvedPath);
  if (hint) {
    lines.push(hint);
    lines.push('');
  }

  lines.push(`Fix: edit ${configPath} and set ${spec.key} to a path that exists and is accessible,`);
  lines.push(`or remove the key to fall back to the default.`);
  return lines.join('\n');
}

/**
 * Validate path-valued keys in lazy.toml. Prints an actionable error and
 * exits with code 1 on the first failure — we don't try to batch-report,
 * because the first broken path almost always cascades into the rest.
 *
 * Silent on success and silent when no lazy.toml exists (defaults are
 * always valid).
 *
 * INVARIANT: a misconfigured path in lazy.toml fails with an error that
 * names the config key and path value, not an opaque ENOENT/EACCES.
 */
export async function validateConfigPaths(lazyRoot: string | null): Promise<void> {
  if (!lazyRoot) return;

  let raw: Record<string, unknown> | null;
  try {
    raw = await loadRawConfig(lazyRoot);
  } catch {
    // Parse errors are surfaced later by loadConfig with full context — don't
    // double-report here. We only validate path values when we can read them.
    return;
  }
  if (!raw) return;

  const specs = extractPathSpecs(raw, lazyRoot);
  if (specs.length === 0) return;

  const configPath = await resolveConfigPath(lazyRoot);
  for (const spec of specs) {
    const failure = await validateOne(spec);
    if (failure) {
      console.error(formatFailure(failure, configPath));
      process.exit(1);
    }
  }
}
