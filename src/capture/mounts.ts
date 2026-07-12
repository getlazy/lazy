import { isAbsolute, resolve } from 'path';
import type { MountConfigEntry } from '../config/types';

/**
 * Custom mounts ([[mounts]]) injected into task agent containers.
 *
 * Two flavors, both produce a `docker run -v` argument:
 *   - bind:   mount a host path into the container (`source:target[:ro]`).
 *   - volume: a container-local Docker volume (`name:target[:ro]` if named,
 *             or just `target` for an anonymous volume). The key use case is
 *             shadowing a path *inside* the bind-mounted worktree — e.g.
 *             `{worktree}/node_modules` — so container-installed Linux binaries
 *             never clobber the host's macOS ones (Docker resolves overlapping
 *             mounts by longest container-path match, so the inner volume wins).
 *
 * Validation lives here (and runs at config-load time) so an invalid entry
 * fails loudly with an actionable message naming the offending entry, rather
 * than being silently skipped or producing an opaque `docker run` failure.
 */

/** Placeholders expanded in `source`/`target` at launch time, when paths are known. */
export interface MountPaths {
  /** The task's worktree path — expands `{worktree}`. */
  worktreePath: string;
  /** The repo root — expands `{repo}`. */
  repoRoot: string;
}

/** A 1-based label for an entry, used in error messages. */
function entryLabel(index: number): string {
  return `lazy.toml [[mounts]] entry #${index + 1}`;
}

/**
 * Validate a single [[mounts]] entry's structure. Throws an actionable error
 * naming the offending entry on any problem. Does NOT expand placeholders —
 * structural validation runs at config-load time, before paths are known.
 */
export function validateMount(entry: MountConfigEntry, index: number): void {
  const where = entryLabel(index);
  const type = entry.type ?? 'bind';

  if (type !== 'bind' && type !== 'volume') {
    throw new Error(
      `${where}: unknown type "${entry.type}". Valid types: "bind" (default) or "volume".`,
    );
  }

  if (!entry.target || entry.target.trim() === '') {
    throw new Error(
      `${where}: missing required "target" (the absolute container path to mount at).`,
    );
  }

  // The target must be an absolute container path, or start with a placeholder
  // that expands to one ({worktree}/... or {repo}/...).
  if (!isAbsolute(entry.target) && !entry.target.startsWith('{')) {
    throw new Error(
      `${where}: target "${entry.target}" must be an absolute container path ` +
      `(e.g. "/work/node_modules") or start with a placeholder ("{worktree}/..." or "{repo}/...").`,
    );
  }

  if (type === 'bind') {
    if (!entry.source || entry.source.trim() === '') {
      throw new Error(
        `${where}: a bind mount requires "source" (a host path). ` +
        `For a container-local volume instead, set type = "volume".`,
      );
    }
    if (entry.name !== undefined) {
      throw new Error(
        `${where}: "name" is only valid for type = "volume", not for bind mounts. ` +
        `Remove "name" or set type = "volume".`,
      );
    }
  } else {
    // type === 'volume'
    if (entry.source !== undefined) {
      throw new Error(
        `${where}: a volume mount must not set "source". ` +
        `Use "name" for a named volume, or omit it for an anonymous volume.`,
      );
    }
    if (entry.name !== undefined && entry.name.trim() === '') {
      throw new Error(
        `${where}: "name" must be a non-empty volume name, or omit it for an anonymous volume.`,
      );
    }
  }
}

/** Validate every entry. Throws on the first invalid one. */
export function validateMounts(mounts: MountConfigEntry[]): void {
  mounts.forEach((entry, index) => validateMount(entry, index));
}

/** Expand `{worktree}` and `{repo}` placeholders in a path. */
function expandPlaceholders(value: string, paths: MountPaths): string {
  return value
    .replaceAll('{worktree}', paths.worktreePath)
    .replaceAll('{repo}', paths.repoRoot);
}

/**
 * Build the `docker run -v` argument array for the configured custom mounts.
 *
 * Pure: given the resolved [[mounts]] config and the worktree/repo paths, it
 * returns a flat `['-v', '<spec>', '-v', '<spec>', ...]` array — never touches
 * the filesystem or shells out, so it is fully unit-testable. Re-validates
 * defensively; callers normally validate once at config-load time.
 *
 * Bind sources may be absolute or project-relative (resolved against repoRoot).
 * Both `source` and `target` support the `{worktree}` and `{repo}` placeholders.
 */
export function buildMountArgs(mounts: MountConfigEntry[], paths: MountPaths): string[] {
  const args: string[] = [];

  mounts.forEach((entry, index) => {
    validateMount(entry, index);

    const target = expandPlaceholders(entry.target, paths);
    const ro = entry.readonly ? ':ro' : '';
    const type = entry.type ?? 'bind';

    if (type === 'volume') {
      // Named volume → "name:target"; anonymous volume → just "target".
      const spec = entry.name ? `${entry.name}:${target}` : target;
      args.push('-v', `${spec}${ro}`);
    } else {
      // Bind mount. Expand placeholders, then resolve a relative source against
      // the repo root so "project-relative" host paths work as documented.
      let source = expandPlaceholders(entry.source as string, paths);
      if (!isAbsolute(source)) {
        source = resolve(paths.repoRoot, source);
      }
      args.push('-v', `${source}:${target}${ro}`);
    }
  });

  return args;
}
