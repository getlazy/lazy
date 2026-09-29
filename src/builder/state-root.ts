/**
 * Where the daemon keeps per-builder state that is NOT in the store: the
 * per-member builder homes (each member's `.claude` tree, credential store and
 * per-launch files — src/builder/claude-home.ts) and the per-project builder
 * scratch dirs (src/builder/scratch.ts).
 *
 * THE ONE RESOLVER. Both subtrees derive from `builderStateRoot()`, so they move
 * together and no caller computes a location of its own.
 *
 * - Default: `~/.lazy` on the machine running the daemon (unchanged layout:
 *   `~/.lazy/builder-homes/`, `~/.lazy/scratch/`).
 * - `LAZY_BUILDER_STATE_DIR`: set by a Teams fleet supervisor to a directory on
 *   a HOST-mounted disk. A Teams daemon runs inside a machine whose rootfs is
 *   destroyed by every machine replacement, and destroying a machine must never
 *   destroy anything of value — members' `.claude` trees included.
 *
 * The narrower `LAZY_BUILDER_HOMES_BASE_DIR` / `LAZY_SCRATCH_BASE_DIR` test
 * seams still win over this for their own subtree.
 */
import { cp, mkdir, readdir, rename, rm } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';
import { getDaemonBaseDir } from '../daemon/paths';
import { getHome } from '../utils/home';
import { logger } from '../utils/logger';

export const BUILDER_STATE_DIR_ENV = 'LAZY_BUILDER_STATE_DIR';

/** The directory under which `builder-homes/` and `scratch/` live. */
export function builderStateRoot(): string {
  return process.env[BUILDER_STATE_DIR_ENV] || defaultBuilderStateRoot();
}

function defaultBuilderStateRoot(): string {
  return join(getHome(), '.lazy');
}

/** Subtrees that are per-builder state, relative to the state root. */
export const BUILDER_STATE_SUBDIRS = ['builder-homes', 'scratch', 'member-homes'] as const;

/**
 * Where each subtree lived BEFORE relocation. Member homes (Shell/Pair/Chat —
 * src/daemon/member-container.ts) sit beside the daemon base dir, not under
 * ~/.lazy, which in a Teams guest is the machine's rootfs too.
 */
function defaultSubdirLocation(subdir: (typeof BUILDER_STATE_SUBDIRS)[number], fromRoot: string | undefined): string {
  if (fromRoot) return join(fromRoot, subdir);
  if (subdir === 'member-homes') return join(dirname(getDaemonBaseDir()), 'member-homes');
  return join(defaultBuilderStateRoot(), subdir);
}

async function listOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`failed to read ${dir}: ${(err as Error).message}`);
  }
}

export interface BuilderStateMove {
  subdir: string;
  from: string;
  to: string;
}

/**
 * One-time move of builder state from the default location to a relocated
 * root (`LAZY_BUILDER_STATE_DIR`), run at daemon start.
 *
 * Per subtree: moved only when the OLD location has content and the NEW one is
 * empty or absent — never merged, so there are never two live roots with
 * diverging content. If both have content the old one is left alone and named
 * at WARN. Copy-then-remove rather than rename: the new root is typically a
 * different filesystem (a virtiofs mount), where rename fails with EXDEV.
 */
export async function migrateBuilderStateRoot(opts: { fromRoot?: string; toRoot?: string } = {}): Promise<BuilderStateMove[]> {
  const toRoot = opts.toRoot ?? process.env[BUILDER_STATE_DIR_ENV];
  if (!toRoot) return [];
  const fromRoot = opts.fromRoot;

  const moved: BuilderStateMove[] = [];
  for (const subdir of BUILDER_STATE_SUBDIRS) {
    const from = defaultSubdirLocation(subdir, fromRoot);
    const to = join(toRoot, subdir);
    if (resolve(from) === resolve(to)) continue;
    const oldEntries = await listOrEmpty(from);
    if (oldEntries.length === 0) continue;
    const newEntries = await listOrEmpty(to);
    if (newEntries.length > 0) {
      logger.warn(
        `Builder state: both ${from} and ${to} have content; using ${to} and leaving ${from} untouched. ` +
        `Remove ${from} once you have confirmed nothing in it is needed.`,
      );
      continue;
    }
    // Copy into a staging dir beside the target and rename it into place, so a
    // move that dies mid-copy leaves the target EMPTY (and is simply redone on
    // the next start) rather than half-populated.
    const staging = `${to}.moving`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(toRoot, { recursive: true });
    await cp(from, staging, { recursive: true, preserveTimestamps: true });
    await rm(to, { recursive: true, force: true });
    await rename(staging, to);
    await rm(from, { recursive: true, force: true });
    logger.info(`Builder state: moved ${from} to ${to} (${BUILDER_STATE_DIR_ENV})`);
    moved.push({ subdir, from, to });
  }
  return moved;
}

/**
 * True when `dir` is the relocated builder state root or inside it. Under Teams
 * that root sits INSIDE the daemon base dir, so the daemon registry must skip
 * it — otherwise it reads as an orphaned daemon dir and `--prune-dirs` deletes
 * every member's home.
 */
export function isBuilderStateDir(dir: string): boolean {
  const root = process.env[BUILDER_STATE_DIR_ENV];
  if (!root) return false;
  const r = resolve(root);
  const d = resolve(dir);
  return d === r || d.startsWith(r + sep);
}
