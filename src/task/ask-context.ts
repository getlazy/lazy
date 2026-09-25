/**
 * Build the {@link AskContext} every ask surface routes on.
 *
 * The RULE lives in src/server/review-actions.ts (`resolveAskAvailability`) —
 * shared, pure, and the only place that decides live-vs-record. This module is
 * the other half: reading the facts that rule needs out of Storage and the
 * filesystem, once, so the daemon and the web page cannot drift into two
 * different ideas of what a task's session looks like.
 *
 * `projectRoot` is optional on purpose. With it, the worktree is checked for
 * real (the daemon's path). Without it, the context is optimistic about the
 * worktree — a browser has no business stat-ing the filesystem, and being wrong
 * there can only change which route the page PREDICTS, never whether the
 * question gets an answer.
 */

import { pathExists } from '../utils/fs';
import { getWorktreePathForRef, taskRef } from './identity';
import type { AskContext } from '../server/review-actions';
import type { Storage } from '../storage/interface';
import type { Task } from '../types';

export async function buildAskContext(
  storage: Storage,
  task: Task,
  opts: { projectRoot?: string } = {},
): Promise<AskContext> {
  const session = await storage.getSessionByTaskId(task.id);
  const turns = await storage.getTurnCountByTaskId(task.id);
  const worktreeExists = opts.projectRoot
    ? await pathExists(getWorktreePathForRef(opts.projectRoot, taskRef(task)))
    : true;

  return {
    status: task.status,
    liveSession: !!session && !session.ended_at,
    resumableAgentSession: !!session?.agent_session_id,
    worktreeExists,
    hasRecord: turns > 0,
  };
}
