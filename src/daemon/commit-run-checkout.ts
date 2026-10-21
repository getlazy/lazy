/**
 * The git half of a COMMIT RUN (./commit-run.ts): finding what to run on the
 * project's remote, and the detached checkout lazy owns for it.
 *
 * Everything that names a commit is checked against the REMOTE: a branch must
 * exist there (a branch only this machine has is somebody's work in progress),
 * and a sha must be reachable from one of its branches. Offline, nothing is
 * resolved at all — there is no silent fallback to whatever this clone happens
 * to hold (AGENTS.md "fail hard on remote failures").
 *
 * The checkout is a linked worktree at `<root>/.lazy/worktrees/lazy-run-<slug>`
 * with a DETACHED HEAD: a run owns no branch, so nothing it does can move one,
 * and the container mounts refs read-only besides. It is lazy's, but a person
 * may change files in it through the run's shell — so moving or removing it
 * never discards anything without being told to, and then names what went.
 */

import { join } from 'path';
import { runGit } from '../utils/git';
import { logger } from '../utils/logger';
import { withRemoteRetry } from '../utils/retry';
import { isOfflineMode } from '../utils/offline';
import { pathExists } from '../utils/fs';
import { loadConfig } from '../config/loader';
import { getDataDir } from '../project-paths';
import {
  checkoutProgressParser,
  remoteExists,
  removeWorktree,
  resolveRemoteDefaultBranch,
  WORKTREE_ADD_TIMEOUT,
} from '../git/operations';
import { ensureLazyExcludeBestEffort } from '../git/lazy-exclude';
import { looksLikeTaskBranch } from '../git/branch-prefix';
import { TaskMutex } from '../utils/task-mutex';
import { RpcError } from './rpc-error';
import { isShaLike, runWorktreePath } from '../run/identity';
import type { CommitRun } from '../storage/types';

/** How long one fetch may take. A large repository's first fetch is slow; a hung one must still end. */
const FETCH_TIMEOUT_MS = 10 * 60_000;

/**
 * One operation per run at a time, keyed by its SLUG — which a create knows
 * before any row exists, so two people pressing Run on the same branch queue
 * behind each other and the second finds the first's run.
 */
const runMutex = new TaskMutex();

export function withRunLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  return runMutex.withLock(`run:${slug}`, fn);
}

/** The project's configured git remote — the one runs resolve against. */
export async function runRemoteName(projectRoot: string): Promise<string> {
  return (await loadConfig(projectRoot)).remote.git_remote;
}

/**
 * Refuse anything that needs the remote when lazy cannot or may not reach it.
 * A refusal names the state and the way out.
 */
export async function assertRemoteReachable(projectRoot: string, remote: string): Promise<void> {
  const config = await loadConfig(projectRoot);
  if (await isOfflineMode(join(projectRoot, getDataDir(projectRoot)), config.remote.offline)) {
    throw new RpcError(409,
      `This project is offline, and what to run is checked against its remote '${remote}'. ` +
      `Go back online (\`lazy system online\`, or remove \`offline = true\` from [remote] in lazy.toml) and try again.`);
  }
  if (!(await remoteExists(remote, projectRoot))) {
    throw new RpcError(409,
      `This project has no git remote named '${remote}', and a run can only check out what is on the project's remote.`);
  }
}

async function fetch(projectRoot: string, args: string[], what: string): Promise<{ missing: boolean }> {
  let missing = false;
  await withRemoteRetry(async () => {
    const result = await runGit(['fetch', ...args], { cwd: projectRoot, timeout: FETCH_TIMEOUT_MS });
    if (result.exitCode === 0) return;
    const stderr = result.stderr.toLowerCase();
    if (stderr.includes("couldn't find remote ref") || stderr.includes('no such remote ref')) {
      missing = true;
      return;
    }
    throw new Error(result.stderr.trim() || `git fetch exited ${result.exitCode}`);
  }, what).catch((err) => {
    throw new RpcError(502, `Could not reach the project's remote to ${what}: ${err instanceof Error ? err.message : String(err)}`);
  });
  return { missing };
}

/** Fetch every branch of the remote (pruning the ones it no longer has). */
export async function fetchAllRemoteBranches(projectRoot: string, remote: string): Promise<void> {
  await fetch(projectRoot, ['--prune', remote], `fetch ${remote}`);
}

/** Refuse a name git would not accept as a branch, before it reaches a refspec. */
export async function assertBranchName(projectRoot: string, branch: string): Promise<void> {
  if (!branch || branch.startsWith('-')) throw new RpcError(400, `'${branch}' is not a branch name.`);
  const check = await runGit(['check-ref-format', `refs/heads/${branch}`], { cwd: projectRoot });
  if (check.exitCode !== 0) throw new RpcError(400, `'${branch}' is not a valid branch name.`);
}

/**
 * Fetch one branch from the remote and return its HEAD. A branch the remote
 * does not have is refused — including one that exists only in this clone or
 * in a task's checkout, which is somebody's unpushed work.
 */
export async function fetchRemoteBranchHead(projectRoot: string, remote: string, branch: string): Promise<string> {
  await assertBranchName(projectRoot, branch);
  const { missing } = await fetch(
    projectRoot,
    [remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
    `fetch branch ${branch} from ${remote}`,
  );
  if (missing) {
    throw new RpcError(404,
      `Branch '${branch}' is not on the project's remote '${remote}'. Only what is pushed there can be run — ` +
      `a branch that exists only on this machine is somebody's work in progress. Push it first.`);
  }
  const sha = await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}^{commit}`], { cwd: projectRoot });
  if (sha.exitCode !== 0 || !sha.stdout) {
    throw new RpcError(500, `Fetched branch '${branch}' from ${remote}, but its commit could not be read.`);
  }
  return sha.stdout.trim();
}

/** The remote's default branch: its recorded HEAD, else asked of the remote itself. */
export async function remoteDefaultBranch(projectRoot: string, remote: string): Promise<string> {
  const recorded = await resolveRemoteDefaultBranch(projectRoot, remote);
  if (recorded) return recorded;
  const asked = await withRemoteRetry(async () => {
    const result = await runGit(['ls-remote', '--symref', remote, 'HEAD'], { cwd: projectRoot, timeout: FETCH_TIMEOUT_MS });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ls-remote exited ${result.exitCode}`);
    return result.stdout;
  }, `ask ${remote} for its default branch`).catch((err) => {
    throw new RpcError(502, `Could not ask the project's remote '${remote}' for its default branch: ${err instanceof Error ? err.message : String(err)}`);
  });
  const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(asked);
  if (!m) throw new RpcError(409, `The project's remote '${remote}' does not name a default branch. Pick a branch to run.`);
  return m[1]!;
}

/**
 * Resolve a sha a person typed against the REMOTE: fetch every branch, expand
 * it to the full commit id, and require that some remote branch contains it.
 * Returns the full sha and the branches that contain it.
 */
export async function resolveRemoteCommit(projectRoot: string, remote: string, input: string): Promise<{ sha: string; branches: string[] }> {
  const typed = input.trim().toLowerCase();
  if (!isShaLike(typed)) {
    throw new RpcError(400, `'${input}' is not a commit id: give 7 to 40 hexadecimal characters.`);
  }
  await fetchAllRemoteBranches(projectRoot, remote);
  const resolved = await runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${typed}^{commit}`], { cwd: projectRoot });
  if (resolved.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(resolved.stdout.trim())) {
    // rev-parse says nothing on --quiet; ask once more for WHY (ambiguous vs unknown).
    const why = await runGit(['rev-parse', '--verify', '--end-of-options', `${typed}^{commit}`], { cwd: projectRoot });
    if (/ambiguous/i.test(why.stderr)) {
      throw new RpcError(400, `'${input}' matches more than one commit. Give more of the commit id.`);
    }
    throw new RpcError(404, `No commit '${input}' is on the project's remote '${remote}'.`);
  }
  const sha = resolved.stdout.trim();
  const branches = await remoteBranchesContaining(projectRoot, remote, sha);
  if (branches.length === 0) {
    throw new RpcError(404,
      `Commit ${sha.slice(0, 12)} is not on any branch of the project's remote '${remote}'. ` +
      `Only commits that are pushed can be run.`);
  }
  return { sha, branches };
}

async function remoteBranchesContaining(projectRoot: string, remote: string, sha: string): Promise<string[]> {
  const prefix = `refs/remotes/${remote}/`;
  const out = await runGit(['for-each-ref', '--contains', sha, '--format=%(refname)', prefix], { cwd: projectRoot });
  if (out.exitCode !== 0) throw new RpcError(500, `Could not list the remote branches containing ${sha.slice(0, 12)}: ${out.stderr.trim()}`);
  return out.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(prefix) && l !== `${prefix}HEAD`).map((l) => l.slice(prefix.length));
}

/** One commit's one-line description, or null when this clone does not have it. */
export async function describeCommit(projectRoot: string, sha: string): Promise<{ sha: string; committedAt: string; subject: string } | null> {
  const out = await runGit(['log', '-1', '--format=%H%x00%cI%x00%s', sha, '--'], { cwd: projectRoot });
  if (out.exitCode !== 0) return null;
  const [full, committedAt, subject] = out.stdout.split('\0');
  return full ? { sha: full, committedAt: committedAt ?? '', subject: subject ?? '' } : null;
}

export interface RemoteBranch {
  name: string;
  sha: string;
  committedAt: string;
  subject: string;
  /** The remote's default branch — listed first. */
  isDefault: boolean;
  /** A lazy task's branch (`<prefix>/<task>`): clients hide these behind a toggle. */
  isTaskBranch: boolean;
}

/**
 * The remote's branches as this clone last fetched them, the default branch
 * first and the rest by most recent commit. `refresh` fetches first.
 */
export async function listRemoteBranches(projectRoot: string, remote: string, opts: { refresh?: boolean } = {}): Promise<{
  remote: string;
  defaultBranch: string | null;
  fetched: boolean;
  branches: RemoteBranch[];
}> {
  if (opts.refresh) {
    await assertRemoteReachable(projectRoot, remote);
    await fetchAllRemoteBranches(projectRoot, remote);
  }
  const prefix = `refs/remotes/${remote}/`;
  const out = await runGit(
    ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)%00%(subject)', prefix],
    { cwd: projectRoot },
  );
  if (out.exitCode !== 0) throw new RpcError(500, `Could not list the remote's branches: ${out.stderr.trim()}`);
  // The recorded default (a clone records it); a refresh may ask the remote
  // itself when this clone never recorded one.
  const defaultBranch = (await resolveRemoteDefaultBranch(projectRoot, remote))
    ?? (opts.refresh ? await remoteDefaultBranch(projectRoot, remote).catch((err) => {
      // The list is still worth answering without its default marked; the
      // reason is logged, and `runs.create` with no target asks again and
      // refuses with it.
      logger.warn(`listBranches: could not ask ${remote} for its default branch: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }) : null);
  const branches: RemoteBranch[] = [];
  for (const line of out.stdout.split('\n')) {
    const [ref, sha, committedAt, subject] = line.split('\0');
    if (!ref || !sha || !ref.startsWith(prefix)) continue;
    const name = ref.slice(prefix.length);
    if (name === 'HEAD') continue;
    branches.push({
      name,
      sha,
      committedAt: committedAt ?? '',
      subject: subject ?? '',
      isDefault: name === defaultBranch,
      isTaskBranch: looksLikeTaskBranch(name),
    });
  }
  branches.sort((a, b) => (a.isDefault !== b.isDefault ? (a.isDefault ? -1 : 1) : b.committedAt.localeCompare(a.committedAt)));
  return { remote, defaultBranch, fetched: opts.refresh === true, branches };
}

/** The remote branch's HEAD as last fetched, or null when this clone has no such ref. */
export async function lastFetchedBranchHead(projectRoot: string, remote: string, branch: string): Promise<string | null> {
  const out = await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}^{commit}`], { cwd: projectRoot });
  return out.exitCode === 0 && out.stdout ? out.stdout.trim() : null;
}

/** How many commits `to` has that `from` lacks; null when it cannot be counted. */
export async function commitsAhead(projectRoot: string, from: string, to: string): Promise<number | null> {
  const out = await runGit(['rev-list', '--count', `${from}..${to}`], { cwd: projectRoot });
  if (out.exitCode !== 0) return null;
  const n = Number.parseInt(out.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// --- The checkout ---

/** Paths lazy itself writes into a checkout, never counted as somebody's change. */
const LAZY_OWN_PATHS = [':!.lazy-task-sandbox', ':!.lazy-lock'];

export interface CheckoutChanges {
  /** Tracked files edited (staged or not) against the checkout's HEAD. */
  tracked: string[];
  /** Untracked files. */
  untracked: string[];
  /**
   * Commits somebody made in the checkout (`<short sha> <subject>`) that no
   * remote branch and not the run's recorded commit contain — the commits a
   * move or a removal would leave unreachable. A person in the run's shell can
   * commit: the container's per-worktree gitdir and objects are writable.
   */
  localCommits: string[];
}

/** Whether a checkout holds anything of somebody's that a move or removal would lose. */
export function hasChanges(c: CheckoutChanges): boolean {
  return c.tracked.length + c.untracked.length + c.localCommits.length > 0;
}

/**
 * What a person changed in the checkout: tracked edits, untracked files and
 * commits of their own — lazy's own files and the run's delivered secret files
 * excluded (runGit points git at their exclude list). `recordedSha` is the
 * commit lazy checked out; commits it contains are not somebody's. Throws when
 * git cannot answer — a check that cannot read the checkout is never "nothing
 * changed".
 */
export async function checkoutChanges(worktreePath: string, recordedSha?: string): Promise<CheckoutChanges> {
  const tracked = await runGit(['diff', '--name-only', '-z', 'HEAD', '--', ...LAZY_OWN_PATHS], { cwd: worktreePath });
  const untracked = await runGit(['ls-files', '-z', '--others', '--exclude-standard', '--', ...LAZY_OWN_PATHS], { cwd: worktreePath });
  // Everything HEAD reaches that neither the recorded commit nor any
  // remote-tracking branch does. Capped: a list nobody can read helps nobody,
  // and the count is what the refusal needs.
  const commits = await runGit(
    ['log', '--format=%h %s', '-n', '200', 'HEAD', '--not', ...(recordedSha ? [recordedSha] : []), '--remotes', '--'],
    { cwd: worktreePath },
  );
  if (tracked.exitCode !== 0 || untracked.exitCode !== 0 || commits.exitCode !== 0) {
    throw new RpcError(500, `Could not read what changed in the run's checkout ${worktreePath}: ${(tracked.stderr || untracked.stderr || commits.stderr).trim()}`);
  }
  const split = (s: string) => s.split('\0').filter(Boolean).sort();
  return {
    tracked: split(tracked.stdout),
    untracked: split(untracked.stdout),
    localCommits: commits.stdout.split('\n').map((l) => l.trim()).filter(Boolean),
  };
}

/** The commit the checkout is actually at, or null when it cannot be read (or does not exist). */
export async function checkoutHead(worktreePath: string): Promise<string | null> {
  if (!(await pathExists(worktreePath))) return null;
  const out = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: worktreePath });
  return out.exitCode === 0 && out.stdout ? out.stdout.trim() : null;
}

/**
 * The refusal when a checkout holds somebody's changes and nobody said they
 * may go. Its `dirtyFiles` detail is what a client shows beside a confirm
 * button; calling again with `confirmDiscard: true` is the confirmation.
 */
export function dirtyCheckoutRefusal(what: string, changes: CheckoutChanges): RpcError {
  const files = [...changes.tracked, ...changes.untracked].sort();
  const parts: string[] = [];
  if (files.length > 0) parts.push(files.slice(0, 10).join(', ') + (files.length > 10 ? ` and ${files.length - 10} more` : ''));
  if (changes.localCommits.length > 0) {
    const n = changes.localCommits.length;
    parts.push(`${n} commit${n === 1 ? '' : 's'} made in it and pushed nowhere (${changes.localCommits.slice(0, 3).join('; ')}${n > 3 ? '; …' : ''})`);
  }
  return new RpcError(409,
    `The run's checkout has changes somebody made in it: ${parts.join('; and ')}. ${what} would discard them. ` +
    `Confirm to go ahead (confirmDiscard), or keep them first — they are in the run's shell.`,
    'run_checkout_dirty',
    { dirtyFiles: files, tracked: changes.tracked, untracked: changes.untracked, localCommits: changes.localCommits });
}

/** Paths among `paths` that the commit `sha` tracks — the untracked files a move to it overwrites. */
async function trackedAt(projectRoot: string, sha: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const out = await runGit(['ls-tree', '-r', '-z', '--name-only', sha, '--', ...paths], { cwd: projectRoot });
  if (out.exitCode !== 0) throw new RpcError(500, `Could not read commit ${sha.slice(0, 12)}: ${out.stderr.trim()}`);
  return out.stdout.split('\0').filter(Boolean).sort();
}

export interface CheckoutMove {
  /** Files somebody changed that the move discarded (tracked edits, and untracked files the commit overwrote). */
  discarded: string[];
  /** Commits made in the checkout that the move left unreachable (`<short sha> <subject>`). */
  discardedCommits: string[];
  /** Untracked files the move left where they were. */
  kept: string[];
}

/**
 * Move an existing checkout to `sha`. A checkout with changes is refused
 * unless `confirmDiscard`; then tracked edits are discarded and so is any
 * untracked file the commit tracks (it is overwritten) — both named in the
 * result. Other untracked files stay. Never a stash: nobody comes back for one.
 */
export async function moveCheckout(
  projectRoot: string,
  worktreePath: string,
  sha: string,
  opts: { confirmDiscard?: boolean; what: string; recordedSha?: string },
): Promise<CheckoutMove> {
  const changes = await checkoutChanges(worktreePath, opts.recordedSha);
  const dirty = hasChanges(changes);
  if (dirty && !opts.confirmDiscard) throw dirtyCheckoutRefusal(opts.what, changes);
  const overwritten = await trackedAt(projectRoot, sha, changes.untracked);
  const result = dirty
    ? await runGit(['reset', '--hard', '--quiet', sha], { cwd: worktreePath })
    : await runGit(['checkout', '--quiet', '--detach', sha], { cwd: worktreePath });
  if (result.exitCode !== 0) {
    throw new RpcError(500, `Could not move the run's checkout to ${sha.slice(0, 12)}: ${result.stderr.trim()}`);
  }
  return {
    discarded: [...changes.tracked, ...overwritten].sort(),
    discardedCommits: changes.localCommits,
    kept: changes.untracked.filter((p) => !overwritten.includes(p)),
  };
}

/**
 * Make sure the run's checkout exists at the run's commit. A missing one is
 * created detached (narrated through `notify`, LFS downloads included); an
 * existing one is left exactly as it is — whatever a person did in it is
 * theirs until Pull latest or Remove asks.
 */
export async function ensureRunCheckout(
  projectRoot: string,
  run: Pick<CommitRun, 'slug' | 'head_sha'>,
  notify?: (detail: string) => void,
): Promise<{ worktreePath: string; created: boolean }> {
  const worktreePath = runWorktreePath(projectRoot, run.slug);
  if (await pathExists(worktreePath)) return { worktreePath, created: false };
  await ensureLazyExcludeBestEffort(projectRoot);
  // A registration left behind by a checkout someone deleted by hand would
  // make `worktree add` refuse the path.
  await runGit(['worktree', 'prune'], { cwd: projectRoot });
  notify?.(`checking out ${run.head_sha.slice(0, 12)}`);
  const result = await runGit(['worktree', 'add', '--detach', worktreePath, run.head_sha], {
    cwd: projectRoot,
    timeout: WORKTREE_ADD_TIMEOUT,
    onStderr: notify ? checkoutProgressParser(notify) : undefined,
  });
  if (result.exitCode !== 0) {
    throw new RpcError(500,
      `Could not check out ${run.head_sha.slice(0, 12)} into ${worktreePath}: ` +
      `${result.stderr.split(/[\r\n]+/).filter((l) => /^(fatal|error):/.test(l.trim())).slice(0, 3).join(' ') || `git exited ${result.exitCode}`}`);
  }
  return { worktreePath, created: true };
}

/**
 * Remove the run's checkout. Refused while it holds changes unless
 * `confirmDiscard`; returns what was discarded.
 */
export async function removeRunCheckout(
  projectRoot: string,
  slug: string,
  opts: { confirmDiscard?: boolean; recordedSha?: string },
): Promise<{ discarded: string[]; discardedCommits: string[] }> {
  const worktreePath = runWorktreePath(projectRoot, slug);
  if (!(await pathExists(worktreePath))) {
    await runGit(['worktree', 'prune'], { cwd: projectRoot });
    return { discarded: [], discardedCommits: [] };
  }
  const changes = await checkoutChanges(worktreePath, opts.recordedSha);
  const files = [...changes.tracked, ...changes.untracked].sort();
  if (hasChanges(changes) && !opts.confirmDiscard) throw dirtyCheckoutRefusal('Removing the run', changes);
  try {
    await removeWorktree(worktreePath, projectRoot);
  } catch (err) {
    throw new RpcError(500, `Could not remove the run's checkout ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { discarded: files, discardedCommits: changes.localCommits };
}
