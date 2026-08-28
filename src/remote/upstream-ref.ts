/**
 * One answer to "which ref does this parent branch actually live on?"
 *
 * `lazy accept` does NOT always merge into `origin/<parent>`. Its routing rule
 * (acceptTask, src/daemon/task-lifecycle.ts) is: a merge target that is
 * unprotected — every intermediate `lazy/...` task branch, plus any other
 * unprotected named branch — is merged LOCALLY into the local branch; only a
 * protected target (typically `main`) is merged on the forge, where
 * `origin/<parent>` is the source of truth.
 *
 * Everything that has to line up with accept — sync's merge target, the base a
 * new child branch is cut from, the base a turn diff is rendered against — must
 * make the SAME choice. Resolving unconditionally through
 * `driver.resolveUpstreamRef()` (which always returns `origin/<parent>` for a
 * hosted driver) does not: a parent task's own agent commits can never be on
 * origin, because task agents have no push credentials. That mismatch produced
 * the fix-sync-stale-origin-parent incident — `lazy sync` reported "Already up
 * to date" against a stale `origin/<parent>` while `lazy accept` refused with
 * conflicts against the local parent, and the advice "run lazy sync" was
 * unactionable from inside the task.
 *
 * The opposite miss is just as real and must not regress (fix-upstream-ref /
 * fix-upstream-remote): the LOCAL parent can be BEHIND origin after a
 * forge-side accept, and merging a stale local branch drops upstream work. So
 * the remote ref is still used whenever it CONTAINS the local branch — the only
 * case where the two disagree in a way that matters is local having commits
 * origin lacks, and that is exactly where accept's routing decides.
 */

import type { RepositoryDriver } from './driver';
import { runGit, type GitResult } from '../utils/git';
import { logger } from '../utils/logger';

type GitFn = (args: string[], cwd?: string) => Promise<GitResult>;

const defaultGit: GitFn = (args, cwd) => runGit(args, { cwd });

/**
 * Branches lazy cuts for its own tasks. They are intermediate by construction
 * and never protected on a forge, which is why accept short-circuits the
 * network protection check for them — and why we can too.
 */
export function isIntermediateBranch(branch: string): boolean {
  return branch.startsWith('lazy/');
}

/**
 * The single routing predicate accept and sync must agree on: does the merge
 * land in the LOCAL `<branch>` (true) or on the forge, into `origin/<branch>`
 * (false)?
 */
export function mergeLandsLocally(opts: { needsSync: boolean; targetIsProtected: boolean }): boolean {
  return !opts.needsSync || !opts.targetIsProtected;
}

/**
 * Is the branch accept would merge into protected on the forge? Mirrors
 * acceptTask's gate exactly: a driver with no remote has nothing to ask, and an
 * intermediate `lazy/...` branch is never protected, so neither makes a network
 * call.
 */
export async function isAcceptTargetProtected(
  driver: Pick<RepositoryDriver, 'needsSync' | 'isTargetBranchProtected'>,
  targetBranch: string,
): Promise<boolean> {
  if (!driver.needsSync) return false;
  if (isIntermediateBranch(targetBranch)) return false;
  return await driver.isTargetBranchProtected(targetBranch);
}

export interface UpstreamRefResolution {
  /** The ref to merge from / branch off — the one accept will merge into. */
  ref: string;
  /** `origin/<branch>`, or null when the driver has no remote at all. */
  remoteRef: string | null;
  /** Commits on the local branch that the remote ref does not have. */
  localOnly: number;
  /** Commits on the remote ref that the local branch does not have. */
  remoteOnly: number;
  /** Divergence warnings for the caller to surface verbatim. */
  warnings: string[];
}

/** How the local-only commits could reach origin, if at all. */
function pushabilityNote(parentBranch: string, remoteName: string): string {
  if (isIntermediateBranch(parentBranch)) {
    return (
      `\`${parentBranch}\` is a lazy task branch: its agent's commits are local-only by ` +
      `design (task agents have no push credentials), and \`lazy accept\` pushes the branch ` +
      `itself when a merge needs it on the remote. Sync never pushes a parent branch.`
    );
  }
  return (
    `\`${parentBranch}\` is pushable: run \`git push ${remoteName} ${parentBranch}\` yourself if ` +
    `origin should carry those commits. Sync never pushes a parent branch.`
  );
}

/**
 * Resolve the ref a caller should merge from / branch off for `parentBranch`.
 *
 * Fetches through the driver exactly as before (so a fetch failure still fails
 * hard — CLAUDE.md "no silent fallbacks"), then reconciles local against remote:
 *
 * - No remote (LocalDriver / offline): the local branch, as always.
 * - Remote contains local (local behind or equal): `origin/<branch>` — the
 *   fix-upstream-ref case, unchanged.
 * - Local has commits origin lacks: whichever ref accept will merge into, with
 *   a warning naming both refs, which one was used, and how the local commits
 *   could reach origin. NEVER auto-pushes the parent.
 */
export async function resolveUpstreamMergeRef(
  driver: Pick<RepositoryDriver, 'needsSync' | 'isTargetBranchProtected' | 'resolveUpstreamRef'>,
  parentBranch: string,
  cwd: string,
  opts: { remoteName?: string; git?: GitFn } = {},
): Promise<UpstreamRefResolution> {
  const git = opts.git ?? defaultGit;
  const remoteName = opts.remoteName ?? 'origin';

  const resolved = await driver.resolveUpstreamRef(parentBranch, cwd);
  const base: UpstreamRefResolution = {
    ref: resolved,
    remoteRef: resolved === parentBranch ? null : resolved,
    localOnly: 0,
    remoteOnly: 0,
    warnings: [],
  };

  // LocalDriver (and any offline driver) returns the branch unchanged — there
  // is no second ref to reconcile against.
  if (base.remoteRef === null) return base;
  const remoteRef = base.remoteRef;

  // A parent branch that exists only on the remote (nothing local to prefer).
  const localExists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${parentBranch}`], cwd);
  if (localExists.exitCode !== 0) return base;

  const counts = await git(['rev-list', '--left-right', '--count', `${parentBranch}...${remoteRef}`], cwd);
  if (counts.exitCode !== 0) {
    // Can't compare — keep the long-standing remote-ref behaviour rather than
    // guessing, but say so: a silent fallback here is how the incident hid.
    base.warnings.push(
      `Could not compare \`${parentBranch}\` with \`${remoteRef}\` ` +
      `(${counts.stderr.trim() || 'unknown git error'}). Using \`${remoteRef}\`.`,
    );
    return base;
  }
  const [localOnly, remoteOnly] = counts.stdout.trim().split(/\s+/).map(n => parseInt(n, 10));
  if (Number.isNaN(localOnly) || Number.isNaN(remoteOnly)) {
    base.warnings.push(
      `Could not compare \`${parentBranch}\` with \`${remoteRef}\` ` +
      `(unexpected git output ${JSON.stringify(counts.stdout)}). Using \`${remoteRef}\`.`,
    );
    return base;
  }
  base.localOnly = localOnly;
  base.remoteOnly = remoteOnly;

  // The remote contains everything local has: it is a strict superset, so using
  // it is both current AND compatible with a later local merge.
  if (localOnly === 0) return base;

  let targetIsProtected: boolean;
  try {
    targetIsProtected = await isAcceptTargetProtected(driver, parentBranch);
  } catch (err) {
    // Protection is a forge question and the forge is unreachable. Stay with
    // the remote ref (the behaviour that predates this resolution) and name the
    // uncertainty — do not quietly pick a side.
    const detail = err instanceof Error ? err.message : String(err);
    base.warnings.push(
      `\`${parentBranch}\` has ${localOnly} commit(s) that \`${remoteRef}\` does not, but ` +
      `whether \`${parentBranch}\` is protected could not be determined (${detail}). ` +
      `Using \`${remoteRef}\`; if \`lazy accept\` then reports conflicts, the local branch is ` +
      `the ref it merges into.`,
    );
    return base;
  }

  if (mergeLandsLocally({ needsSync: driver.needsSync, targetIsProtected })) {
    base.ref = parentBranch;
    base.warnings.push(
      `Local \`${parentBranch}\` and \`${remoteRef}\` differ: ${localOnly} commit(s) only local, ` +
      `${remoteOnly} only on the remote. Used \`${parentBranch}\` — \`${parentBranch}\` is ` +
      `unprotected, so \`lazy accept\` merges into the LOCAL branch. ${pushabilityNote(parentBranch, remoteName)}`,
    );
    logger.debug(
      `resolveUpstreamMergeRef: using local ${parentBranch} (${localOnly} local-only, ${remoteOnly} remote-only commits)`,
    );
    return base;
  }

  base.warnings.push(
    `Local \`${parentBranch}\` and \`${remoteRef}\` differ: ${localOnly} commit(s) only local, ` +
    `${remoteOnly} only on the remote. Used \`${remoteRef}\` — \`${parentBranch}\` is protected, ` +
    `so \`lazy accept\` merges on the remote and those local commits are not part of it until ` +
    `they are pushed. ${pushabilityNote(parentBranch, remoteName)}`,
  );
  return base;
}
