/**
 * Builder scratch directory — a writable, host-accessible place for the builder
 * that lives entirely OUTSIDE the repository.
 *
 * WHY IT EXISTS: the repo is bind-mounted read-only into builder containers (and
 * the host builder runs under an OS sandbox confined to the worktree), so the
 * builder has nowhere to put an artifact. Yet leaving artifacts is genuinely
 * useful: a long accept/review message the engineer then passes as
 * `lazy accept <task> --message "$(cat <path>)"`, a throwaway analysis script, a
 * draft document, a data dump for the human to read.
 *
 * WHY OUTSIDE THE REPO (this is the load-bearing part — do not "simplify" it):
 * the scratch dir is a scratchpad for the BUILDER and for exchange with the
 * HUMAN. It is NOT a channel to agents. If the builder had a writable place that
 * task agents could also see, the builder would start writing code there and
 * telling agents to copy it in — dissolving the builder/agent separation, whose
 * whole point is that the builder does prompts and review, not implementation.
 *
 * Putting it under `~/.lazy/scratch/<project-slug>/` instead of somewhere under
 * the project root buys two structural guarantees that no `.gitignore` entry
 * could:
 *   1. It can never be committed — it is not in any git tree.
 *   2. It is not reachable from an agent worktree, and no agent launch path
 *      mounts it. See test/unit/builder-scratch-mount.test.ts.
 *
 * IDENTICAL-PATH CONVENTION: containers mount it at the SAME absolute path the
 * host uses (like the repo and data-dir mounts), so a path the builder prints
 * pastes straight into a host shell.
 *
 * LIFECYCLE: persistent, never auto-wiped. The point is handing artifacts to a
 * human who may read them hours or days later, possibly after the builder
 * session that wrote them is gone. Nothing in lazy prunes it; `lazy doctor`
 * reports its size and tells the human how to clear it themselves.
 */

import { chmod, mkdir, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { getHome } from '../utils/home';
import { projectSlug } from '../daemon/paths';

/** Env var carrying the scratch dir path into the builder process/container. */
export const SCRATCH_ENV_VAR = 'LAZY_SCRATCH_DIR';

/**
 * Root holding every project's scratch dir: `~/.lazy/scratch/`.
 *
 * `LAZY_SCRATCH_BASE_DIR` overrides the location. Same seam (and same reason) as
 * `LAZY_DAEMON_BASE_DIR` in src/daemon/paths.ts: tests must not write into — or
 * report on — the developer's real scratch dirs, and every scratch path flows
 * through this function so they all move together and nothing else does.
 */
export function getScratchBaseDir(): string {
  const override = process.env.LAZY_SCRATCH_BASE_DIR;
  if (override) return override;
  return join(getHome(), '.lazy', 'scratch');
}

/**
 * This project's builder scratch dir: `~/.lazy/scratch/<project-slug>/`.
 *
 * Pure — derived from the project root alone, with no config input, so BOTH
 * builder runners (container and host-process) compute the identical path and
 * cannot drift apart. A capability that exists only under one runner is worse
 * than no capability, because the builder cannot tell which one it has.
 */
export function builderScratchDir(projectRoot: string): string {
  return join(getScratchBaseDir(), projectSlug(projectRoot));
}

/**
 * Create the scratch dir if needed and return its absolute path.
 *
 * The mode is 0777 ON PURPOSE. A builder CONTAINER writes here as the image's
 * `user` account, whose uid need not match the host user's — the bind mount
 * carries host ownership through, so a 0700 dir is silently unwritable from
 * inside the container on any host where the uids differ. That would make the
 * capability work on some machines and not others, which is exactly the failure
 * mode this feature must not have.
 *
 * The sticky bit (1777, /tmp semantics) would be the natural companion, but
 * Bun's `chmod` masks mode to 0o777 and cannot set it — so this does not claim
 * a protection it does not have. The exposure is small and bounded: the dir
 * lives under the user's own `~/.lazy`, holds only scratch artifacts a human
 * reads, and nothing in lazy ever executes or trusts its contents. On a
 * multi-user host, `chmod 1777` on the dir by hand is harmless and survives —
 * lazy only ever widens the permission bits, never narrows them.
 */
export async function ensureBuilderScratchDir(projectRoot: string): Promise<string> {
  const dir = builderScratchDir(projectRoot);
  await mkdir(dir, { recursive: true });
  // Checked every launch, not just on create: a dir made by an older lazy (or
  // under a restrictive umask) is repaired rather than left half-working. Only
  // chmod when the bits are actually too narrow, so a sticky bit (or anything
  // else the human set deliberately) is never clobbered by a repair.
  const mode = (await stat(dir)).mode & 0o7777;
  if ((mode & 0o777) !== 0o777) await chmod(dir, mode | 0o777);
  return dir;
}

/** Total bytes of the files directly and recursively under `dir`, 0 if absent. */
export async function scratchDirSize(dir: string): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  const walk = async (current: string, top: boolean): Promise<void> => {
    let items;
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // never created yet
      throw new Error(`Failed to read builder scratch dir ${current}: ${(err as Error).message}`);
    }
    for (const item of items) {
      if (top) entries++;
      const full = join(current, item.name);
      if (item.isDirectory()) {
        await walk(full, false);
      } else if (item.isFile()) {
        try {
          bytes += (await stat(full)).size;
        } catch (err) {
          // A file that vanished mid-walk (the builder is live) contributes
          // nothing; anything else is a real problem worth surfacing.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
    }
  };
  await walk(dir, true);
  return { bytes, entries };
}

/** Human-readable byte size for doctor output (KB/MB/GB — scratch dirs get big). */
export function formatScratchBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
