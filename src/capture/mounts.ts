import { isAbsolute, resolve, relative } from 'path';
import type { MountConfigEntry } from '../config/types';
import { getDaemonBaseDir } from '../daemon/paths';

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

/** True when `child` is inside `parent`, or IS `parent`. */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * INVARIANT: no container may see the daemon state dir (`~/.lazy/daemon/<slug>/`).
 *
 * It holds the shared daemon bearer token — which authenticates every `/rpc/*`
 * call — and `mcp-tokens.json`, the registry binding each per-task MCP token to
 * its identity. An agent that could read it would not need to impersonate anyone
 * over `/mcp`: it could call `/rpc/acceptTask` directly with the shared token, or
 * lift another task's (or the builder's) token straight out of the registry. The
 * whole per-task identity boundary rests on that directory being unreachable
 * from inside a container.
 *
 * Lazy's own launch paths honor that (asserted by
 * test/unit/daemon-dir-never-mounted.test.ts). `[[mounts]]` is the one remaining
 * way the directory could reach a container, so a mount that exposes it is
 * refused here — including a mount of an ANCESTOR (`~/.lazy`, `$HOME`), which
 * exposes it just as completely.
 *
 * The forbidden path is derived from src/daemon/paths.ts, never hardcoded, so it
 * follows `LAZY_DAEMON_BASE_DIR` and any future relocation. The base dir (not one
 * project's slug dir) is the boundary: another project's daemon dir is someone
 * else's shared token, which is no better.
 *
 * Lazy's own per-container MCP config mount is unaffected — it is added by the
 * launch paths themselves (a single `:ro` file under `<daemonDir>/mcp/`), never
 * routed through `[[mounts]]`.
 */
function assertSourceOutsideDaemonState(source: string, where: string): void {
  const daemonBaseDir = getDaemonBaseDir();
  const why =
    `The daemon state directory holds the shared daemon token (which authenticates every ` +
    `/rpc call) and the per-task MCP token registry. Mounting it into an agent container ` +
    `would let an agent bypass per-task identity entirely — acting as any other task, or as ` +
    `the builder. Mount a specific directory that does not contain it.`;

  if (isWithin(daemonBaseDir, source)) {
    throw new Error(
      `${where}: refusing source "${source}" — it is inside lazy's daemon state directory ` +
      `(${daemonBaseDir}). ${why}`,
    );
  }
  if (isWithin(source, daemonBaseDir)) {
    throw new Error(
      `${where}: refusing source "${source}" — it CONTAINS lazy's daemon state directory ` +
      `(${daemonBaseDir}), so the container would see it. ${why}`,
    );
  }
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
    // A daemon-state mount is refused at LOAD time when the source is already a
    // plain absolute path — the user hears about it from any lazy command, not
    // only at launch. Placeholder and relative sources are only knowable once
    // the worktree/repo paths exist; buildMountArgs checks those (and re-checks
    // these) after expansion.
    if (isAbsolute(entry.source as string) && !(entry.source as string).includes('{')) {
      assertSourceOutsideDaemonState(entry.source as string, where);
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
      // Authoritative daemon-state check: this is the fully resolved host path
      // that would reach `docker run -v`, so a placeholder or a `..` traversal
      // that lands in the daemon dir is caught here even though load-time
      // validation could not see it.
      assertSourceOutsideDaemonState(source, entryLabel(index));
      args.push('-v', `${source}:${target}${ro}`);
    }
  });

  return args;
}
