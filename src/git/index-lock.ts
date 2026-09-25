/**
 * Git `index.lock` recovery for accept/squash-merge (and any other path that
 * must write a worktree's index).
 *
 * Background: git creates `<git-dir>/index.lock` with O_CREAT|O_EXCL, writes the
 * new index into it, then renames it over `index`. If the process dies mid-way
 * the lock file is left behind. Every later git that needs the index fails with
 * "Unable to create '.../index.lock': File exists" and tells the human to
 * delete the file by hand — which is what accept was surfacing, unmodified.
 *
 * Evidence from the wild (release-v022, 2026-08-25): a ZERO-BYTE lock ~11 hours
 * old permanently wedged every accept into that worktree. That is the stale
 * class, not a live concurrent writer. Age alone is NOT a safe signal though —
 * a freshly `touch`ed zero-byte lock with no live holder is also stale (and is
 * exactly the case an mtime heuristic gets wrong). The only safe question is:
 * does any process still have this file open?
 *
 * Rules enforced here:
 *  - Never blind-rm a lock. Removal requires a positive "no openers" result
 *    from a real open-file scan.
 *  - Never use mtime/size as the liveness check (size is diagnostic only).
 *  - If we cannot scan for openers (no procfs, no lsof), refuse to remove and
 *    tell the human what to look at — do not pretend the holder is gone.
 *  - Prefer scanning /proc/<pid>/fd over ps/lsof: builder/agent containers have
 *    been observed without ps, and the daemon host may lack lsof. Procfs works
 *    without any external binary on Linux.
 *  - ASSUMPTION (Linux procfs): unreadable /proc/<pid>/fd (EACCES on another
 *    user's processes) can hide an opener. When any fd dir was skipped for
 *    permissions and no holder was found, the scan fails closed (lsof is tried
 *    as a second opinion; if that also finds nothing, refuse to delete). Accept
 *    runs as the host daemon under the same uid as normal git work — the common
 *    case is complete. macOS has no procfs; we use lsof there instead.
 *  - ASSUMPTION (PID namespace): an empty opener scan is only authoritative when
 *    this process's process table can see every process that could hold the lock.
 *    Inside a PID namespace / container, empty scans fail closed (see
 *    processTableMayBeIncomplete). Positive sightings are always trusted.
 */

import { readdir, readFile, readlink, realpath, unlink } from 'fs/promises';
import { join } from 'path';
import { logger } from '../utils/logger';
import { pathExists } from '../utils/fs';
import { runGit } from '../utils/git';
import { spawnSyncUnsupervised } from '../utils/spawn';
import { isRunningInContainer } from '../utils/container';

/** A process that currently has the lock file open. */
export interface IndexLockHolder {
  pid: number;
  /** Best-effort command line; null when /proc/<pid>/cmdline is unreadable. */
  command: string | null;
}

/**
 * Result of probing who has a lock file open.
 * - `scanned: false` — we could not check (no /proc, no lsof). MUST NOT remove.
 * - `scanned: true` — check completed; `holders` is authoritative.
 */
export type HolderProbe =
  | { scanned: false; reason: string }
  | { scanned: true; holders: IndexLockHolder[] };

export interface ClearStaleIndexLockResult {
  /** True when a stale lock was removed. */
  cleared: boolean;
  /** Absolute path of the lock file that was (or would have been) considered. */
  lockPath: string | null;
}

export interface IndexLockDeps {
  runGit?: typeof runGit;
  pathExists?: (path: string) => Promise<boolean>;
  findHolders?: (lockPath: string) => Promise<HolderProbe>;
  unlink?: (path: string) => Promise<void>;
  /** Override logging — tests assert the human-visible message. */
  warn?: (message: string) => void;
  /**
   * Test seam / override for {@link processTableMayBeIncomplete}. When true,
   * an empty opener scan must not authorize deletion.
   */
  processTableMayBeIncomplete?: () => Promise<boolean>;
}

/** Reason when procfs skipped unreadable fd dirs and lsof did not find a holder. */
export const PROCFD_PERMISSION_DENIED_REASON =
  'some /proc/<pid>/fd directories were not readable (permission denied), so lazy cannot verify that no other-user process still holds the lock';

/** Reason string when an empty scan is untrustworthy (PID namespace / container). */
export const INCOMPLETE_PROCESS_TABLE_REASON =
  'this process appears to run in a PID namespace or container, so its process table ' +
  'may not see a host git that holds the lock — refusing to treat an empty scan as proof it is safe to delete';

/**
 * True when `/proc` / `lsof` from this process may miss processes that could
 * hold a lock on a host-visible path.
 *
 * Accept's squash merge runs in the host daemon today, where this is false.
 * Task agent containers (and any future path that called clear from inside a
 * PID namespace) must not auto-remove on an empty scan — that is the
 * corruption hazard the reviewer named.
 */
export async function processTableMayBeIncomplete(): Promise<boolean> {
  if (await isRunningInContainer()) return true;
  return await hasNestedPidNamespace();
}

/**
 * Linux `NSpid` lists this thread's PID in each nested PID namespace, innermost
 * first. More than one entry means we are not in the outermost (host) namespace.
 */
async function hasNestedPidNamespace(): Promise<boolean> {
  try {
    const status = await readFile('/proc/self/status', 'utf-8');
    const line = status.split('\n').find((l) => l.startsWith('NSpid:'));
    if (!line) return false;
    const pids = line.slice('NSpid:'.length).trim().split(/\s+/).filter(Boolean);
    return pids.length > 1;
  } catch {
    return false;
  }
}

/** True when git stderr is the classic index.lock collision. */
export function isIndexLockError(text: string): boolean {
  return /index\.lock['"]?: File exists/i.test(text) || /Unable to create '.*index\.lock'/i.test(text);
}

/**
 * Resolve the absolute path of `index.lock` for a worktree (or repo root).
 * Uses `git rev-parse --git-path index.lock` so linked worktrees resolve to
 * `.git/worktrees/<name>/index.lock`, not a file under the worktree checkout.
 */
export async function resolveIndexLockPath(
  cwd: string,
  deps: IndexLockDeps = {},
): Promise<string | null> {
  const git = deps.runGit ?? runGit;
  const result = await git(['rev-parse', '--path-format=absolute', '--git-path', 'index.lock'], {
    cwd,
  });
  if (result.exitCode !== 0) return null;
  const path = result.stdout.trim();
  return path.length > 0 ? path : null;
}

/**
 * Resolve the absolute git directory for a worktree — used as the serialization
 * key for concurrent merges into the same index.
 */
export async function resolveAbsoluteGitDir(
  cwd: string,
  deps: IndexLockDeps = {},
): Promise<string | null> {
  const git = deps.runGit ?? runGit;
  const result = await git(['rev-parse', '--path-format=absolute', '--absolute-git-dir'], {
    cwd,
  });
  if (result.exitCode !== 0) return null;
  const path = result.stdout.trim();
  return path.length > 0 ? path : null;
}

/**
 * Find processes that currently have `lockPath` open.
 *
 * Strategy (first that works wins):
 *  1. Linux procfs — scan `/proc/<pid>/fd/*` via readlink. No external binary.
 *  2. `lsof -t -- <path>` — macOS and Linux hosts that ship lsof.
 *
 * An empty result is only `{ scanned: true, holders: [] }` when the process
 * table is believed complete (host). Inside a PID namespace / container, empty
 * means `{ scanned: false }` — we must not authorize deletion. A non-empty
 * result is always trusted (we saw a holder; do not delete).
 *
 * Returns `{ scanned: false }` when neither strategy is available, so callers
 * refuse to delete rather than guessing.
 */
export async function findIndexLockHolders(
  lockPath: string,
  deps: Pick<IndexLockDeps, 'processTableMayBeIncomplete'> = {},
): Promise<HolderProbe> {
  const incomplete =
    deps.processTableMayBeIncomplete ?? processTableMayBeIncomplete;

  const viaProc = await findHoldersViaProcfs(lockPath);
  if (viaProc !== null) {
    if (viaProc.holders.length > 0) {
      return { scanned: true, holders: viaProc.holders };
    }
    // EACCES on another user's /proc/<pid>/fd can hide a live opener. An empty
    // procfs result with permission gaps is not proof the lock is stale — try
    // lsof, but fail closed if that also reports nobody.
    if (viaProc.permissionGaps) {
      const viaLsof = findHoldersViaLsof(lockPath);
      if (viaLsof !== null && viaLsof.length > 0) {
        return { scanned: true, holders: viaLsof };
      }
      return {
        scanned: false,
        reason:
          viaLsof === null
            ? `${PROCFD_PERMISSION_DENIED_REASON}, and lsof is not available for a second opinion`
            : `${PROCFD_PERMISSION_DENIED_REASON}, and lsof did not report a holder either`,
      };
    }
    return authorizeScanResult(viaProc.holders, await incomplete());
  }

  const viaLsof = findHoldersViaLsof(lockPath);
  if (viaLsof !== null) {
    return authorizeScanResult(viaLsof, await incomplete());
  }

  return {
    scanned: false,
    reason:
      'neither /proc/<pid>/fd nor lsof is available in this environment, so lazy cannot verify that no process still holds the lock',
  };
}

/**
 * Promote a raw opener list to a HolderProbe. Non-empty is always authoritative;
 * empty is only authoritative when the process table is complete.
 */
function authorizeScanResult(
  holders: IndexLockHolder[],
  tableIncomplete: boolean,
): HolderProbe {
  if (holders.length > 0) return { scanned: true, holders };
  if (tableIncomplete) {
    return { scanned: false, reason: INCOMPLETE_PROCESS_TABLE_REASON };
  }
  return { scanned: true, holders: [] };
}

/**
 * Scan /proc/<pid>/fd for openers of `lockPath`. Returns `null` when `/proc` is
 * missing or unreadable (macOS, restricted containers) — not an empty list.
 */
interface ProcfsScanResult {
  holders: IndexLockHolder[];
  /** True when one or more pid fd dirs were skipped due to EACCES/EPERM. */
  permissionGaps: boolean;
}

async function findHoldersViaProcfs(lockPath: string): Promise<ProcfsScanResult | null> {
  let resolved: string;
  try {
    resolved = await realpath(lockPath);
  } catch {
    // Lock vanished between existence check and scan — treat as no holders.
    return { holders: [], permissionGaps: false };
  }

  let procEntries: string[];
  try {
    procEntries = await readdir('/proc');
  } catch {
    return null;
  }

  const holders: IndexLockHolder[] = [];
  const seen = new Set<number>();
  let permissionGaps = false;

  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isFinite(pid) || pid <= 0) continue;

    let fds: string[];
    try {
      fds = await readdir(join('/proc', entry, 'fd'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        // Another user's process may hold the lock — an empty scan is not safe.
        permissionGaps = true;
      }
      // Process exited (ENOENT) or transient error — skip this pid only.
      continue;
    }

    let holds = false;
    for (const fd of fds) {
      let target: string;
      try {
        target = await readlink(join('/proc', entry, 'fd', fd));
      } catch {
        continue;
      }
      // Strip the " (deleted)" suffix Linux adds for unlinked-but-open files.
      const normalized = target.replace(/ \(deleted\)$/, '');
      if (normalized === resolved || normalized === lockPath) {
        holds = true;
        break;
      }
    }
    if (!holds || seen.has(pid)) continue;
    seen.add(pid);
    holders.push({ pid, command: await readCmdline(pid) });
  }

  return { holders, permissionGaps };
}

async function readCmdline(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`);
    const cmd = raw.toString('utf8').replace(/\0/g, ' ').trim();
    return cmd.length > 0 ? cmd : null;
  } catch {
    return null;
  }
}

/**
 * Ask `lsof` which PIDs have `lockPath` open. Returns `null` when lsof is
 * missing or failed in a way that does not mean "zero holders".
 */
function findHoldersViaLsof(lockPath: string): IndexLockHolder[] | null {
  let result: ReturnType<typeof spawnSyncUnsupervised>;
  try {
    result = spawnSyncUnsupervised(['lsof', '-t', '--', lockPath], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5_000,
    });
  } catch (err) {
    // spawn wrapper throws on missing binary (ENOENT diagnosis). Treat as
    // "lsof unavailable", not as "no holders".
    const message = err instanceof Error ? err.message : String(err);
    if (/not found|ENOENT/i.test(message)) return null;
    return null;
  }

  // lsof exit codes: 0 = found, 1 = none found (success for us), other = error.
  if (result.exitCode === null) {
    // Timed out or signalled — do not treat as "no holders".
    return null;
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return null;
  }

  const stdout = String(result.stdout ?? '').trim();
  if (!stdout) return [];

  const holders: IndexLockHolder[] = [];
  for (const line of stdout.split(/\n+/)) {
    const pid = Number(line.trim());
    if (!Number.isFinite(pid) || pid <= 0) continue;
    holders.push({ pid, command: null });
  }
  return holders;
}

/**
 * If `cwd`'s git dir has an `index.lock` with NO live openers, remove it and
 * return `{ cleared: true }`. If a live process holds it, throw a human error
 * that names the holder. If we cannot scan, throw without removing.
 *
 * Safe to call when no lock exists — returns `{ cleared: false }` quickly.
 */
export async function clearStaleIndexLock(
  cwd: string,
  deps: IndexLockDeps = {},
): Promise<ClearStaleIndexLockResult> {
  const exists = deps.pathExists ?? pathExists;
  const warn = deps.warn ?? ((msg: string) => logger.warn(msg));
  const remove = deps.unlink ?? unlink;
  // Default finder must receive deps so the PID-namespace guard is injectable.
  const findHolders =
    deps.findHolders ?? ((path: string) => findIndexLockHolders(path, deps));

  const lockPath = await resolveIndexLockPath(cwd, deps);
  if (!lockPath || !(await exists(lockPath))) {
    return { cleared: false, lockPath };
  }

  const probe = await findHolders(lockPath);

  if (!probe.scanned) {
    throw new Error(
      `Cannot proceed: git index lock exists at ${lockPath}, but lazy could not check whether a process still holds it (${probe.reason}). ` +
        `If you are sure no git process is using this worktree, remove the lock with: rm ${lockPath} — then retry. ` +
        `Deleting a lock while git is mid-write corrupts the repository.`,
    );
  }

  if (probe.holders.length > 0) {
    const named = probe.holders
      .map((h) => (h.command ? `pid ${h.pid} (${h.command})` : `pid ${h.pid}`))
      .join(', ');
    throw new Error(
      `Cannot proceed: git index lock at ${lockPath} is held by a live process (${named}). ` +
        `Another git operation is using this worktree — wait for it to finish, then retry. ` +
        `Do not delete the lock while that process is running.`,
    );
  }

  // Positive evidence: scanned, zero holders. Safe to remove.
  try {
    await remove(lockPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Race: another process created a new lock and we lost the unlink, or the
    // file vanished. Re-check; if it's gone, we're fine.
    if (!(await exists(lockPath))) {
      return { cleared: true, lockPath };
    }
    throw new Error(
      `Found a stale git index lock at ${lockPath} with no live holder, but could not remove it: ${message}. ` +
        `Remove it manually with: rm ${lockPath} — then retry.`,
    );
  }

  warn(
    `Removed stale git index lock at ${lockPath} (no process had it open). ` +
      `A previous git process likely crashed or was killed mid-write.`,
  );
  return { cleared: true, lockPath };
}

/**
 * Build a human-facing error when a git command failed on index.lock after we
 * already tried (or could not try) recovery. Keeps git's path and adds what to do.
 */
export function formatIndexLockFailure(stderr: string, lockPath: string | null): string {
  const path = lockPath ?? '(unknown path)';
  return (
    `git could not update the index because a lock file already exists at ${path}. ` +
    `Lazy checked for a live holder and either found one or could not clear it safely. ` +
    `Original git error:\n${stderr.trim()}\n` +
    `If no git process is using this worktree, remove the lock with: rm ${path} — then retry the accept. ` +
    `Never delete the lock while a git process still has it open.`
  );
}

