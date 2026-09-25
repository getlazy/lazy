/**
 * Tearing a task's run down: its worktree, its branch, its container.
 *
 * Every close form routes through here — `lazy accept`/`reject`/`close`, redo,
 * a loop interruption, and the daemon's remote-sync when a PR was merged or
 * closed on the forge. That last caller is why this is not CLI code: the daemon
 * finalizes tasks nobody typed a command for. The ordering inside
 * `cleanupWorktree` (capture the agent session log BEFORE the worktree is
 * removed) is load-bearing and documented on the function.
 */

import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { removeWorktree, deleteBranch } from '../git/operations';
import { createRunner } from '../runner';
import { captureAgentSessionLog } from '../import/capture-agent-session-log';
import { logger } from '../utils/logger';
import { runGit } from '../utils/git';
import type { Storage } from '../storage';

/**
 * Remove a task's worktree only (preserve the branch for recovery).
 * Falls back to manual cleanup if git worktree remove fails.
 *
 * This is the single chokepoint for worktree teardown — every close form
 * (accept/reject/close/abandon, redo, loop-interruption, remote-sync) routes
 * through here, directly or via cleanupWorktreeAndBranch. We capture the raw
 * agent session JSONL FIRST, before removeWorktree, because the sandbox copy
 * lives inside the worktree (`<worktree>/.lazy-task-sandbox/...`) and is
 * destroyed with it. The capture context (storage/taskId/sessionId) is
 * REQUIRED so the type checker forces every caller — current and future — to
 * supply it; this is what prevents teardown paths from silently dropping the
 * session log again.
 */
export async function cleanupWorktree(
  worktreePath: string,
  root: string,
  storage: Storage,
  taskId: string,
  sessionId: string | null,
): Promise<void> {
  // Capture before teardown — ordering is load-bearing (sandbox JSONL is
  // inside the worktree). Best-effort: never throws, so cleanup can't break.
  await captureAgentSessionLog(storage, taskId, sessionId, worktreePath);

  if (existsSync(worktreePath)) {
    console.log('Removing worktree...');
    try {
      await removeWorktree(worktreePath, root);
    } catch {
      // Worktree may be corrupted (e.g. .git is a dir instead of file).
      // Fall back to manual removal + prune.
      console.log('Worktree remove failed, cleaning up manually...');
      // fs.rm (not a spawned `rm -rf`): fs beats spawning a process (CLAUDE.md),
      // and it's async so teardown never blocks the event loop — cleanupWorktree
      // is reachable from async daemon/storage close paths.
      await rm(worktreePath, { recursive: true, force: true });
      await runGit(['worktree', 'prune'], { cwd: root });
    }
  }
}

/**
 * Remove a task's worktree and delete its branch.
 * Falls back to manual cleanup if git worktree remove fails.
 *
 * Delegates worktree teardown (and the session-log capture) to cleanupWorktree.
 */
export async function cleanupWorktreeAndBranch(
  worktreePath: string,
  branch: string,
  root: string,
  storage: Storage,
  taskId: string,
  sessionId: string | null,
): Promise<void> {
  await cleanupWorktree(worktreePath, root, storage, taskId, sessionId);
  try {
    await deleteBranch(branch, root);
  } catch (err) {
    // Non-fatal: a leftover local branch is recoverable and must never break
    // finalize (the merge has already landed by the time we get here). But we
    // do NOT silently swallow it (CLAUDE.md) — surface it as a warning so a
    // failed deletion is visible instead of accumulating invisibly. The most
    // common benign cause is the branch already being gone; rarer causes
    // (still checked out in another worktree, git error) are exactly what we
    // want to see in the logs.
    logger.warn(`Failed to delete local branch ${branch}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Stop and remove a task's run (container or process) if it exists.
 * Uses the session's container_name if available, otherwise derives it from the task ref.
 * Clears the container_name in the session after removal.
 */
export async function cleanupTaskContainer(
  storage: Storage,
  session: { id: string; container_name: string | null },
  tRef: string,
  lazyRoot: string,
): Promise<void> {
  const runner = await createRunner(lazyRoot);
  const runName = session.container_name ?? runner.runNameForTask(tRef);
  await runner.removeRun(runName);
  if (session.container_name) {
    await storage.updateSessionContainerName(session.id, null);
  }
}
