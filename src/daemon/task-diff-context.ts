/**
 * The task, its worktree, and the refs its diff is rendered against.
 *
 * Shared by handleDiff, handleFileLines and the region carving so that
 * "expand the context around this hunk", "scope this diff to a region" and
 * "what does this task change" all read the same tree at the same refs. A
 * second copy of this resolution is the mistake the base-ref invariant exists
 * to prevent — see resolveTaskDiffBase and docs/task-diff-base-resolution.md.
 *
 * Takes its `storage` as a parameter rather than reaching for the daemon's
 * singleton: that is what keeps this module free of a cycle back through
 * rpc-handlers, which imports it.
 */

import { stat } from 'fs/promises';
import { loadConfig } from '../config/loader';
import { recoverMissingWorktreeWithFetch } from '../git/operations';
import type { Storage } from '../storage/interface';
import { resolveTaskDirectDiff } from '../task-diff-base';
import { displayId, getWorktreePath } from '../task/identity';
import { RpcError } from './rpc-error';

export async function resolveTaskDiffContext(
  storage: Storage,
  projectRoot: string,
  taskRefInput: string,
  opts: { fullBranch?: boolean } = {},
) {
  const result = await storage.resolveTask(taskRefInput);
  if (!result.task) {
    throw new RpcError(404, `Task not found: ${taskRefInput}`);
  }
  const task = result.task;

  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) {
    throw new RpcError(400, `Task ${displayId(task)} has no session`);
  }

  const worktreePath = getWorktreePath(projectRoot, task);
  // Async stat, not existsSync: this runs inside the daemon on every diff,
  // file-lines and region request, and a sync filesystem call there blocks the
  // whole event loop (CLAUDE.md, "Never use sync filesystem calls"). It was
  // sync where this code came from; moving it is the moment to fix it.
  if (!(await pathExists(worktreePath))) {
    // Worktree is gone — try to recover from local or remote branch
    const branchName = sess.git_branch;
    const config = await loadConfig(projectRoot);
    try {
      const recovery = await recoverMissingWorktreeWithFetch(
        worktreePath, branchName, config.remote.git_remote, projectRoot,
      );
      if (!recovery.recovered) {
        throw new RpcError(400,
          `Worktree is gone and branch '${branchName}' not found locally or on remote.`);
      }
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError(400,
        `Failed to recover worktree: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Three-dot diff against the ref the task branch was CUT from, resolved
  // through the one shared resolver the task launcher uses (see
  // src/task-diff-base.ts). Using the raw local parent branch here is
  // what produced the fleet 90k-file diff: in a fresh clone the local default
  // branch is frozen at clone time while the branch point is `origin/<default>`,
  // so the merge base fell back to the clone commit and every upstream commit
  // since provisioning was attributed to the task.
  const diffConfig = await loadConfig(projectRoot);
  // Direct-changes plan: same base as resolveTaskDiffBase, plus a path
  // restriction when this task has accepted children. fullBranch is the
  // escape hatch that restores today's whole-branch diff.
  const direct = await resolveTaskDirectDiff({
    task,
    session: sess,
    storage,
    projectRoot,
    worktreePath,
    config: diffConfig,
    fullBranch: opts.fullBranch === true,
  });

  return {
    storage,
    task,
    sess,
    worktreePath,
    fromRef: direct.base.ref,
    useTwoDotDiff: direct.base.twoDot,
    direct,
  };
}

/** Does this path exist? A missing path is ENOENT; anything else propagates. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(
      `Failed to check whether ${path} exists: ${err instanceof Error ? err.message : err}`,
    );
  }
}
