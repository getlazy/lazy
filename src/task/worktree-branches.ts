/**
 * The branch each task worktree must have HEAD on, keyed by the worktree's
 * folder name (the task ref) — for the redirected-HEAD scan and repair in
 * src/git/worktree-pointers.ts. Only tasks with a live session are judged.
 *
 * `excludeLive` leaves out tasks someone is working in right now (`working`,
 * `pairing`): the daemon's automatic repair must not rewrite HEAD under a live
 * turn or a human mid-rebase — HEAD alone would move while the index stays,
 * and the next commit would land a reversal. The writing paths already refuse
 * there, so skipping them loses nothing.
 */
import type { Storage } from '../storage';
import { taskRef } from './identity';

export async function taskWorktreeBranches(
  storage: Storage,
  opts: { excludeLive?: boolean } = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const task of await storage.listTasksWithOptions({ nonTerminalOnly: true, withSessionsOnly: true })) {
    if (opts.excludeLive && (task.status === 'working' || task.status === 'pairing')) continue;
    const sess = await storage.getSessionByTaskId(task.id);
    if (sess?.git_branch && !sess.ended_at) out.set(taskRef(task), sess.git_branch);
  }
  return out;
}
