/**
 * Reopen gives back what was closed: the task branch at the task's LAST head.
 *
 * Accepting (or closing) a task deletes its LOCAL branch and worktree; the
 * remote task branch is never deleted. Reopen used to recreate the worktree
 * with `git worktree add -b <branch>`, which silently cut a FRESH branch from
 * the parent's tip — the task came back empty, with its work sitting on
 * origin. A fresh start is `lazy clone` / `lazy redo`, never reopen.
 *
 * The branch is restored from the first source that has it:
 *   1. the local branch (nothing to do);
 *   2. the task's branch on the configured remote, fetched through the driver —
 *      unless a recorded head it does not contain is newer (a stale remote);
 *   3. a commit lazy recorded for the task whose objects still exist locally.
 * If none resolves, reopen REFUSES — before any write, so a refused reopen
 * changes nothing.
 *
 * The restored branch keeps its own history. Bringing a moved parent in is
 * sync's job, never reopen's. Nothing is pushed: not the task branch, and
 * never the parent.
 */

import { join } from 'path';
import { runGit } from '../utils/git';
import { withRemoteRetry } from '../utils/retry';
import { isOfflineMode } from '../utils/offline';
import { createDriver } from '../remote';
import { RpcError } from './rpc-handlers';
import type { ResolvedConfig } from '../config/types';
import type { Storage } from '../storage/interface';
import type { Session } from '../types';

export type RestoreSource = 'local' | 'remote' | 'recorded';

export interface BranchRestore {
  branch: string;
  source: RestoreSource;
  sha: string;
  /** One line narrating what happened, for every reopen surface to show. */
  message: string;
  /** Set when the branch came back from somewhere other than a live local branch: the parent may have moved meanwhile, and bringing it in is sync's job. */
  syncHint: string | null;
}

async function localBranchSha(branch: string, root: string): Promise<string | null> {
  const r = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { cwd: root });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/**
 * Where is the task branch on the remote? Returns its sha, or null when absent. `ls-remote --exit-code` exits 2 when the
 * ref is simply absent — a definite "no". Any other failure is a remote
 * failure: retried, then thrown (never read as "not there").
 */
async function remoteBranchSha(remote: string, branch: string, root: string): Promise<string | null> {
  return withRemoteRetry(async () => {
    const r = await runGit(['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${branch}`], { cwd: root });
    if (r.exitCode === 0) {
      const sha = r.stdout.trim().split(/\s+/)[0];
      if (!sha) throw new Error(`git ls-remote ${remote} ${branch} printed no sha`);
      return sha;
    }
    if (r.exitCode === 2) return null;
    throw new Error(`git ls-remote ${remote} ${branch} failed: ${r.stderr.trim()}`);
  }, `look up ${branch} on ${remote}`);
}

/**
 * The task's newest head lazy recorded that still exists locally. Candidates:
 * every final claim's sha (accept gates on one), every turn's end_sha, and every
 * recorded commit — a commit made after the last turn-end scan is never a
 * commit record, but it is the head a final claim names. One
 * `merge-base --independent` keeps the tips; several tips are ranked by the
 * latest final claim, then by recording time.
 */
async function recordedHead(storage: Storage, session: Session, root: string): Promise<string | null> {
  const [turns, commits] = await Promise.all([
    storage.getSessionTurns(session.id),
    storage.getSessionCommits(session.id),
  ]);
  // sha → [rank class, time]: a final claim outranks any other record.
  const rank = new Map<string, [number, number]>();
  const note = (sha: string | null | undefined, cls: number, at: number) => {
    if (!sha) return;
    const prev = rank.get(sha);
    if (!prev || cls > prev[0] || (cls === prev[0] && at > prev[1])) rank.set(sha, [cls, at]);
  };
  for (const t of turns) {
    note(t.final?.sha, 1, t.final?.at ?? t.timestamp);
    note(t.end_sha, 0, t.timestamp);
  }
  for (const c of commits) note(c.sha, 0, c.timestamp);
  if (rank.size === 0) return null;

  // One spawn: rev-list prints the commits that exist and skips the missing.
  const listed = await runGit(['rev-list', '--no-walk', '--ignore-missing', ...rank.keys()], { cwd: root });
  const present = listed.exitCode === 0
    ? listed.stdout.split('\n').map(s => s.trim()).filter(s => rank.has(s))
    : [];
  if (present.length === 0) return null;

  const tips = await runGit(['merge-base', '--independent', ...present], { cwd: root });
  const candidates = tips.exitCode === 0
    ? tips.stdout.split('\n').map(s => s.trim()).filter(Boolean)
    : present;
  candidates.sort((a, b) => {
    const [ca, ta] = rank.get(a) ?? [0, 0];
    const [cb, tb] = rank.get(b) ?? [0, 0];
    return cb - ca || tb - ta;
  });
  return candidates[0] ?? null;
}

export async function restoreTaskBranchForReopen(args: {
  projectRoot: string;
  config: ResolvedConfig;
  storage: Storage;
  session: Session;
  displayId: string;
  /** Find the source and report it, but create no branch and fetch nothing. */
  checkOnly?: boolean;
}): Promise<BranchRestore> {
  const { projectRoot: root, config, storage, session, displayId, checkOnly } = args;
  const branch = session.git_branch;

  const local = await localBranchSha(branch, root);
  if (local) {
    return { branch, source: 'local', sha: local, message: `Reusing local branch ${branch} at ${local.slice(0, 12)}`, syncHint: null };
  }

  const remote = config.remote.git_remote;
  const offline = await isOfflineMode(join(root, '.lazy'), config.remote.offline);
  let remoteSkipped: string | null = null;
  if (config.remote.driver === 'local') {
    remoteSkipped = 'the remote driver is "local"';
  } else if (offline) {
    remoteSkipped = 'lazy is offline';
  } else {
    let remoteSha: string | null;
    try {
      remoteSha = await remoteBranchSha(remote, branch, root);
    } catch (err) {
      // Fail hard: a remote we could not ask is not a remote without the branch.
      throw new RpcError(502, `Cannot reopen ${displayId}: its branch ${branch} is gone locally and ${remote} could not be reached (${err instanceof Error ? err.message : err}). Nothing was changed — retry when the remote is reachable.`);
    }
    if (remoteSha) {
      if (checkOnly) {
        return { branch, source: 'remote', sha: remoteSha, message: `Would restore ${branch} from ${remote} at ${remoteSha.slice(0, 12)}`, syncHint: syncHint(displayId) };
      }
      const driver = createDriver(config, undefined, { offline });
      try {
        await driver.fetchBranch(branch, root);
      } catch (err) {
        throw new RpcError(502, `Cannot reopen ${displayId}: fetching ${remote}/${branch} failed (${err instanceof Error ? err.message : err}). Nothing was changed — retry when the remote is reachable.`);
      }
      // Branch at the exact sha ls-remote named — never a tracking ref or
      // FETCH_HEAD, either of which can be stale or another fetch's.
      const sha = remoteSha;
      const have = await runGit(['cat-file', '-e', `${sha}^{commit}`], { cwd: root });
      if (have.exitCode !== 0) {
        throw new RpcError(502, `Cannot reopen ${displayId}: fetched ${remote}/${branch} but its head ${sha.slice(0, 12)} is not in this repository (the branch may have moved during the fetch). Nothing was changed — retry.`);
      }
      // The remote can be STALE: the task's last commits may never have been
      // pushed (a failed after-turn push, lazy offline at the end) while their
      // objects are still here and a final claim or turn end names them. The
      // remote wins only when it already contains the recorded head; otherwise
      // the recorded head is the task's real last head. Nothing on the remote
      // is lost: sync's first step merges origin/<branch> when it has commits
      // the branch lacks.
      const recorded = await recordedHead(storage, session, root);
      if (recorded && recorded !== sha) {
        const contained = await runGit(['merge-base', '--is-ancestor', recorded, sha], { cwd: root });
        if (contained.exitCode !== 0) {
          const behind = await runGit(['merge-base', '--is-ancestor', sha, recorded], { cwd: root });
          const how = behind.exitCode === 0 ? 'is behind' : 'has diverged';
          await createBranch(branch, recorded, root, displayId);
          return {
            branch,
            source: 'recorded',
            sha: recorded,
            message: `Restored ${branch} from the task's last recorded head ${recorded.slice(0, 12)} — ${remote} ${how} at ${sha.slice(0, 12)}`,
            syncHint: syncHint(displayId),
          };
        }
      }
      await createBranch(branch, sha, root, displayId);
      return { branch, source: 'remote', sha, message: `Restored ${branch} from ${remote} at ${sha.slice(0, 12)}`, syncHint: syncHint(displayId) };
    }
    remoteSkipped = `${remote} has no branch ${branch}`;
  }

  const recorded = await recordedHead(storage, session, root);
  if (recorded) {
    if (checkOnly) {
      return { branch, source: 'recorded', sha: recorded, message: `Would restore ${branch} from the task's last recorded commit ${recorded.slice(0, 12)}`, syncHint: syncHint(displayId) };
    }
    await createBranch(branch, recorded, root, displayId);
    return { branch, source: 'recorded', sha: recorded, message: `Restored ${branch} from the task's last recorded commit ${recorded.slice(0, 12)} (${remoteSkipped})`, syncHint: syncHint(displayId) };
  }

  if (offline && config.remote.driver !== 'local') {
    throw new RpcError(409, `Cannot reopen ${displayId}: its branch ${branch} is gone locally, lazy is offline so ${remote} was not asked, and no commit recorded for the task exists in this repository. Nothing was changed. The work is most likely on ${remote} — retry once lazy is back online.`);
  }
  throw new RpcError(409, `Cannot reopen ${displayId}: its work cannot be found. The local branch ${branch} is gone, ${remoteSkipped}, and no commit recorded for the task exists in this repository. Nothing was changed. Reopen never starts a task empty — to start the same goal fresh, use 'lazy clone ${displayId}' or 'lazy redo ${displayId}'.`);
}

async function createBranch(branch: string, sha: string, root: string, displayId: string): Promise<void> {
  const r = await runGit(['branch', branch, sha], { cwd: root });
  if (r.exitCode !== 0) {
    throw new RpcError(500, `Cannot reopen ${displayId}: creating ${branch} at ${sha.slice(0, 12)} failed: ${r.stderr.trim()}. Nothing else was changed.`);
  }
}

function syncHint(displayId: string): string {
  return `The branch keeps its own history; its parent may have moved since — run 'lazy sync ${displayId}' to bring it in.`;
}
