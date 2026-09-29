/**
 * Keep a task's writable paths owned by the uid its container runs as, when the
 * daemon is root.
 *
 * On a real Linux dockerd (a Linux self-host, the daemon image inside a Teams
 * microVM) the daemon runs as root while the runner image's `user` is uid 1000,
 * and nothing fakes bind-mount ownership the way Docker Desktop does. The
 * supervisor wrapper's `adopt` step hands the worktree, its per-worktree gitdir
 * and the objects dir to the container user — but it runs only when the
 * one-shot supervisor (re)starts, and the daemon keeps writing into those paths
 * as root afterwards: a host-side sync between turns, a child accept landing on
 * a cluster, the forwarded merges the sync phase resolves conflicts against,
 * `lazy_commit` creating a new objects fan-out directory, `lazy_sync`. Every one
 * of those leaves root-owned files the agent then cannot edit or stage into.
 *
 * So ownership is re-aligned at the two moments that matter, through this one
 * implementation: by the SUPERVISOR (via sudo) as it picks up each command,
 * before the sync phase or the agent touches anything; and by the DAEMON right
 * after a tool call that writes into the worktree. Only entries not already
 * owned by the target uid are touched, so on a Mac — or any daemon that is not
 * root — this finds nothing and changes nothing.
 */

import { stat } from 'fs/promises';
import { spawn } from './spawn';
import { resolveGitMountPaths } from '../capture/git-mounts';
import { logger } from './logger';

/**
 * `find` argv that chowns every entry under `paths` not owned by `uid` to
 * `uid:gid` (symlinks themselves, never their targets). Prefixed with
 * `sudo -n` when the caller is not root.
 */
export function realignOwnershipArgv(paths: string[], uid: number, gid: number, useSudo: boolean): string[] {
  return [
    ...(useSudo ? ['sudo', '-n'] : []),
    'find', ...paths, '!', '-uid', String(uid),
    '-exec', 'chown', '-h', `${uid}:${gid}`, '{}', '+',
  ];
}

/** Run the realignment. Throws with context when it fails. */
export async function realignOwnership(paths: string[], uid: number, gid: number, useSudo: boolean): Promise<void> {
  if (paths.length === 0) return;
  const proc = spawn(realignOwnershipArgv(paths, uid, gid, useSudo), { stdout: 'ignore', stderr: 'pipe', timeout: 120_000 });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) {
    throw new Error(`could not give ${paths.join(', ')} to uid ${uid}: ${stderr.trim() || `find exited ${code}`}`);
  }
}

/** The worktree plus the two git dirs the container writes, as git reports them. */
export async function taskWritablePaths(worktreePath: string): Promise<string[]> {
  const git = await resolveGitMountPaths(worktreePath);
  return [worktreePath, git.worktreeGitDir, git.objectsDir];
}

/**
 * Daemon side: after a root daemon wrote into a task's worktree, hand anything
 * it created back to whoever owns the worktree (the container user, once
 * adopted). A no-op unless the daemon is root and the worktree has been
 * adopted by someone else. Never throws: a failed realignment is logged, and
 * the next command's supervisor-side pass retries it.
 */
export async function realignAfterDaemonWrite(worktreePath: string): Promise<void> {
  if (process.getuid?.() !== 0) return;
  try {
    const owner = await stat(worktreePath);
    if (owner.uid === 0) return;
    await realignOwnership(await taskWritablePaths(worktreePath), owner.uid, owner.gid, false);
  } catch (err) {
    logger.warn(
      `Could not return ${worktreePath} to its container user after a daemon write ` +
      `(the next turn's supervisor retries): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** True when any entry under `paths` is owned by a uid other than `uid`. */
export async function hasForeignEntries(paths: string[], uid: number): Promise<boolean> {
  const proc = spawn(['find', ...paths, '!', '-uid', String(uid), '-print', '-quit'], { stdout: 'pipe', stderr: 'ignore' });
  const [, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return out.trim() !== '';
}

/**
 * Supervisor side (inside the container, as the unprivileged user): before a
 * command's sync phase or agent run, take back anything the root daemon wrote
 * since the last pass. Returns an error message for the caller to log, or null.
 */
export async function adoptBeforeCommand(worktreePath: string): Promise<string | null> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0) return null;
  try {
    const paths = await taskWritablePaths(worktreePath);
    if (!(await hasForeignEntries(paths, uid))) return null;
    await realignOwnership(paths, uid, gid, true);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
