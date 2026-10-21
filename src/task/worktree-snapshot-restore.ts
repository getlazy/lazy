/**
 * `lazy unblock`'s restore of a stored worktree snapshot: decide whether the
 * latest snapshot may be put back, put it back, and retire it.
 *
 * Its own module so the decision can be tested against a real git worktree and
 * a real store, not only through a full unblock.
 */

import type { Storage } from '../storage/interface';
import type { WorktreeSnapshot } from '../storage/types';
import { hasUncommittedChanges, getUncommittedDiff, applyPatch, patchIsAlreadyApplied, snapshotFiles, patchPaths } from '../git/operations';
import { snapshotIsRestorable } from './worktree-snapshot';
import { logger } from '../utils/logger';
import { runGit } from '../utils/git';

/**
 * The end-of-turn half of the lifecycle: a turn that ends DIRTY writes a
 * snapshot; a turn that ends CLEAN supersedes every still-live snapshot of the
 * session — the worktree moved on without those edits, so no later unblock may
 * put them back.
 */
export async function captureTurnEndWorktree(
  storage: Storage,
  sessionId: string,
  turnSequence: number,
  worktreePath: string,
): Promise<'captured' | 'superseded'> {
  if (await hasUncommittedChanges(worktreePath)) {
    const uncommittedDiff = await getUncommittedDiff(worktreePath);
    const gitStatus = (await runGit(['status', '--porcelain', '--', ':!.lazy-task-sandbox'], { cwd: worktreePath })).stdout;
    await storage.createWorktreeSnapshot(sessionId, turnSequence, uncommittedDiff, gitStatus);
    return 'captured';
  }
  await storage.retireWorktreeSnapshots(sessionId, 'superseded');
  return 'superseded';
}

export interface SnapshotRestoreResult {
  /** A line for the human (restored, or a genuine failure naming the files). */
  warning?: string;
}

/**
 * Restore the session's latest snapshot when the worktree is clean and the
 * snapshot is both LIVE (not retired) and restorable (no later work turn ran).
 *
 * A snapshot is retired once it has been applied, or found already in the
 * branch: before that, a human who read the restored edits and deliberately
 * reverted them got them back at the next unblock — the work-turn bound cannot
 * tell, because no work turn ran in between. Before ANY lifecycle existed, a
 * single dirty turn left its patch the candidate for every later unblock. A
 * clean turn end supersedes snapshots too (the reconciler's capture).
 *
 * Never throws for the bookkeeping: a failed retire is warned and the unblock
 * goes on — at worst the snapshot stays live, and the next unblock finds the
 * worktree dirty with the restored edits and skips it anyway.
 */
export async function restoreWorktreeSnapshot(
  storage: Storage,
  sessionId: string,
  worktreePath: string,
  taskLabel: string,
): Promise<SnapshotRestoreResult> {
  const snapshot = await storage.getLatestWorktreeSnapshot(sessionId);
  if (!snapshot || await hasUncommittedChanges(worktreePath)) return {};

  if (snapshot.retired_at !== undefined) {
    logger.debug(
      `Task ${taskLabel}: worktree snapshot from turn ${snapshot.turn_sequence} was already ` +
      `${snapshot.retired_reason ?? 'retired'} — not restoring it.`,
    );
    return {};
  }

  // A snapshot is restorable only while it describes the turn the worktree is
  // still sitting at the end of — the rule and its reasoning live in
  // `snapshotIsRestorable`.
  const turns = await storage.getSessionTurns(sessionId);
  if (!snapshotIsRestorable(snapshot.turn_sequence, turns)) {
    logger.debug(
      `Task ${taskLabel}: worktree snapshot is from turn ${snapshot.turn_sequence}, which ` +
      'a later agent turn has moved past — not restoring it over a worktree that went on without it.',
    );
    return {};
  }

  let patch = snapshot.uncommitted_diff;
  patch = patch.replace(/^--- STAGED CHANGES ---\n/gm, '');
  patch = patch.replace(/^--- UNSTAGED CHANGES ---\n/gm, '');
  patch = patch.replace(/^--- UNTRACKED FILES ---\n/gm, '');

  if (await applyPatch(patch, worktreePath)) {
    await retireConsumed(storage, sessionId, snapshot, taskLabel);
    return { warning: 'Restored uncommitted changes from backup.' };
  }

  if (await patchIsAlreadyApplied(patch, worktreePath)) {
    // THE COMMON CASE, AND IT IS NOT A FAILURE. The agent has since been sent
    // back and committed exactly those edits, and this unblock replays a patch
    // whose content is already in HEAD. Git refuses it, correctly. Reported as
    // a loss, that warning once sent a whole investigation after the backup
    // mechanism — it is the echo of that work being COMMITTED. It says nothing.
    await retireConsumed(storage, sessionId, snapshot, taskLabel);
    logger.debug(
      `Task ${taskLabel}: worktree snapshot from turn ${snapshot.turn_sequence} is ` +
      'already in the branch — nothing to restore.',
    );
    return {};
  }

  // A genuine failure: neither appliable nor already in the branch. The
  // snapshot stays LIVE — the warning points the human at it. Name the files
  // HONESTLY: the status capture lists everything the worktree held, while the
  // patch skips an untracked file that was binary or over the capture ceiling.
  const named = snapshotFiles(snapshot.git_status);
  const stored = new Set(patchPaths(patch));
  const recoverable = named.filter(f => stored.has(f));
  const nameOnly = named.filter(f => !stored.has(f));

  let warning = 'Could not restore uncommitted changes from backup. Continuing without them';
  if (recoverable.length > 0) {
    warning += ` (${recoverable.join(', ')}). They are still in the task's snapshot for turn ${snapshot.turn_sequence}.`;
  } else {
    warning += '.';
  }
  if (nameOnly.length > 0) {
    warning += ` The snapshot records ${nameOnly.join(', ')} by name only — its content was not captured` +
      ' (binary, or over the capture ceiling), so it cannot be restored from the store.';
  }
  return { warning };
}

async function retireConsumed(
  storage: Storage,
  sessionId: string,
  snapshot: WorktreeSnapshot,
  taskLabel: string,
): Promise<void> {
  try {
    await storage.retireWorktreeSnapshots(sessionId, 'consumed', snapshot.id);
  } catch (err) {
    logger.warn(
      `Task ${taskLabel}: could not mark the worktree snapshot from turn ${snapshot.turn_sequence} as restored ` +
      `(${err instanceof Error ? err.message : String(err)}); it stays a restore candidate.`,
    );
  }
}
