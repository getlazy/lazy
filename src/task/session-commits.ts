/**
 * Which commits a task RECORDED — one resolver, every recording site.
 *
 * A task's recorded commit list answers "what did this task commit", and the
 * store's copy of that answer feeds `lazy show`, the web Commits tab, search,
 * and provenance. It used to be derived per call site as
 * `getNewCommits(lastKnownSha, worktree)` with
 *
 *   lastKnownSha = <last recorded commit>.sha ?? session.git_start_sha
 *
 * and both halves of that expression were wrong in a way that COMPOUNDED:
 *
 * 1. `Storage.getSessionCommits` returns records sorted by the time they were
 *    WRITTEN, while `git log` hands its commits back newest-FIRST. Recording a
 *    batch in that order therefore leaves the array's LAST element pointing at
 *    the OLDEST commit of the last batch, not the newest. "Last known SHA"
 *    walked backwards every turn.
 * 2. `A..HEAD` is a reachability query, not "what this branch did". The first
 *    time a turn merges its upstream (a sync, or a cluster accepting a child),
 *    the answer contains every commit the merged-in line carried that `A` did
 *    not — months of other tasks' history.
 *
 * Together they ratcheted: each turn's oldest commit came from a little deeper
 * inside a merged-in line, and the next turn's range started there. On
 * `teams-quality-loop` the store ended up with 790 commits, back to the v0.15
 * release in May, for a branch carrying 28.
 *
 * The rule here removes both moving parts:
 *
 *   - the range ALWAYS starts at the branch point (`session.git_start_sha`),
 *     never at a previously recorded commit, so nothing can drift;
 *   - the walk is FIRST-PARENT, so a merge contributes the merge commit and
 *     never the merged-in ancestry;
 *   - already-recorded SHAs are filtered out and the rest are written
 *     OLDEST-first, so the stored order is history order.
 *
 * Because the range is recomputed from the branch point every time, the walk
 * is self-healing: a turn that failed to record converges on the next one.
 */

import type { Storage } from '../storage';
import type { GitCommitInfo } from '../git/operations';
import { getNewCommits, isAncestorCommit, getMergeBase } from '../git/operations';
import { logger } from '../utils/logger';

/** The subset of a session this module needs. */
export interface CommitScanSession {
  id: string;
  git_start_sha: string;
}

export interface CommitScan {
  /**
   * The commit the walk started from, or null when it could not be resolved —
   * in which case `commits` is empty and `reason` says why.
   */
  base: string | null;
  /** Commits on the branch since `base` that the store does not have, OLDEST first. */
  commits: GitCommitInfo[];
  /** Every first-parent commit since `base`, recorded or not, OLDEST first. */
  all: GitCommitInfo[];
  reason?: string;
}

/**
 * The commit the branch was cut from, as the range start.
 *
 * `session.git_start_sha` is written once when the session is created and is
 * never moved (reparent deliberately leaves it alone), so it is the only
 * anchor that cannot drift. It can still fail to be an ancestor of the tip —
 * a reopened task, a recovered worktree, a rewritten base — and a non-ancestor
 * start makes `A..tip` balloon again, so fall back to the merge base, which is
 * an ancestor by construction.
 */
export async function resolveCommitScanBase(
  gitStartSha: string | null | undefined,
  cwd: string,
  headRef = 'HEAD',
): Promise<{ base: string | null; reason?: string }> {
  const start = (gitStartSha ?? '').trim();
  if (!start) return { base: null, reason: 'session has no branch-point SHA' };

  if (await isAncestorCommit(start, headRef, cwd)) return { base: start };

  try {
    const mergeBase = (await getMergeBase(start, headRef, cwd)).trim();
    if (mergeBase) {
      return { base: mergeBase, reason: `branch point ${start.substring(0, 8)} is not an ancestor of ${headRef}; using merge base` };
    }
  } catch (err) {
    return {
      base: null,
      reason: `branch point ${start.substring(0, 8)} is not an ancestor of ${headRef} and has no merge base with it: ${err instanceof Error ? err.message : err}`,
    };
  }

  return { base: null, reason: `could not resolve a range start from ${start.substring(0, 8)}` };
}

/**
 * Commits on this task's branch that the store has not recorded yet.
 *
 * THROWS when git itself fails. A range it cannot RESOLVE comes back empty
 * with a `reason` — that is an answer — but a `git log` that exits non-zero is
 * not an answer at all, and `getNewCommits` propagates it rather than returning
 * an empty list that reads as "this branch has no commits". Callers that must
 * not fail guard the call and say why; `recordSessionCommits` below does, and
 * so does every caller in `src/daemon/repair-commits.ts`, where mistaking a
 * failed read for an empty branch would delete a task's whole commit list.
 */
export async function scanSessionCommits(
  storage: Storage,
  session: CommitScanSession,
  cwd: string,
  headRef = 'HEAD',
): Promise<CommitScan> {
  const { base, reason } = await resolveCommitScanBase(session.git_start_sha, cwd, headRef);
  if (!base) return { base: null, commits: [], all: [], reason };

  // INVARIANT: first-parent. A merge contributes the merge commit and nothing
  // from the merged-in line — that line's commits belong to whoever made them.
  const all = (await getNewCommits(base, cwd, { firstParent: true, headRef })).reverse();

  const recorded = await storage.getSessionCommits(session.id);
  const known = new Set(recorded.map(c => c.sha));
  return { base, all, commits: all.filter(c => !known.has(c.sha)), reason };
}

/**
 * Record every commit this branch gained that the store does not have yet.
 *
 * Returns the scan so a caller can tell "nothing new" from "could not look".
 */
export async function recordSessionCommits(
  storage: Storage,
  session: CommitScanSession,
  cwd: string,
  label: string,
): Promise<CommitScan> {
  let scan: CommitScan;
  try {
    scan = await scanSessionCommits(storage, session, cwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Task ${label}: could not detect new commits: ${message}`);
    return { base: null, commits: [], all: [], reason: message };
  }

  if (!scan.base) {
    logger.warn(`Task ${label}: not recording commits — ${scan.reason ?? 'no range start'}`);
    return scan;
  }
  if (scan.reason) logger.debug(`Task ${label}: commit scan — ${scan.reason}`);

  logger.debug(
    `Task ${label}: detected ${scan.commits.length} new commit(s) since ${scan.base.substring(0, 8)} in ${cwd}`,
  );

  for (const c of scan.commits) {
    try {
      await storage.createCommit(session.id, c.sha, c.message);
    } catch (err) {
      logger.debug(`Task ${label}: could not record commit ${c.sha.substring(0, 8)}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return scan;
}
