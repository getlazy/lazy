/**
 * Make a turn that ended with uncommitted work in its worktree LOUD.
 *
 * The supervisor already asks the agent once per turn whether it committed all
 * its work (the commit nudge; a final turn's `commit_leftovers` step asks
 * again to commit or discard) and records what is
 * STILL loose afterwards on the work turn (`uncommitted`). Until 2026-10-05
 * that record was the only trace: a small badge on one turn among dozens. Two
 * tasks parked that day with finished work uncommitted and nobody saw it until
 * the builder ran `git status` by hand.
 *
 * So a turn that ends with paths left loose also leaves:
 *  - a COMMENT on the task — read on the task page in the CLI, the dashboard and
 *    Teams, and carried to the agent by the next unblock, so the agent that
 *    left the work is the one told to commit it; and
 *  - a system NOTICE, which is where the engineer and the builder look for
 *    things that need them without opening every task.
 *
 * Nothing here commits. The supervisor never commits for the agent
 * (src/supervisor/leftovers.ts), and neither does the daemon.
 */

import type { Storage } from '../storage/interface';
import { logger } from '../utils/logger';

/** Prefix of the comment, so readers (and tests) can find it. */
export const UNCOMMITTED_LEFT_BEHIND_PREFIX = '[Uncommitted work left behind]';

/** How many paths the comment and message list before summarising the rest. */
const MAX_LISTED = 20;

function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED).map(p => `- \`${p}\``);
  if (paths.length > MAX_LISTED) shown.push(`- …and ${paths.length - MAX_LISTED} more`);
  return shown.join('\n');
}

export interface AnnounceOptions {
  /**
   * The turn FAILED (fatally) rather than parking normally. Nobody asked the
   * agent about these paths, and they may be edits nobody authorised — a
   * read-only self-review that wrote fails exactly this way — so the comment
   * never tells the agent to commit them: a person decides.
   */
  failedTurn?: boolean;
  /**
   * The previous turn already left exactly this set. The comment is still
   * written (it is what the agent reads next), but no second system notice is
   * filed: a worktree that stays dirty turn after turn is one problem, not one
   * notice per turn.
   */
  sameAsPreviousTurn?: boolean;
}

/**
 * Record the comment and the notice. Best-effort per write: a failure is
 * logged and never fails the turn it reports on — the turn record still carries
 * `uncommitted` either way.
 */
export async function announceUncommittedLeftBehind(
  storage: Pick<Storage, 'getTask' | 'createComment' | 'createSystemMessage'>,
  taskId: string,
  paths: readonly string[],
  opts: AnnounceOptions = {},
): Promise<void> {
  if (paths.length === 0) return;
  // The code only names the task in the text; an unreadable task falls back to
  // its short id rather than losing the announcement.
  const task = await storage.getTask(taskId).catch(() => null);
  const name = task?.code || taskId.substring(0, 8);
  const list = listPaths(paths);
  const comment = opts.failedTurn
    ? `${UNCOMMITTED_LEFT_BEHIND_PREFIX} The last turn FAILED with ${paths.length} path(s) uncommitted in ` +
      `the worktree. None of it is on the branch. Nobody was asked about these files and they may not be ` +
      `the task's work, so leave them as they are: a person decides what happens to them.\n\n${list}`
    : `${UNCOMMITTED_LEFT_BEHIND_PREFIX} The last turn ended with ${paths.length} path(s) uncommitted in ` +
      `the worktree. None of it is on the branch, so a review or accept will not see it:\n\n${list}\n\n` +
      `Commit what belongs to the task with \`lazy_commit\` and discard the rest.`;
  try {
    await storage.createComment(taskId, comment, 'system');
  } catch (err) {
    logger.warn(
      `Task ${name}: could not record the uncommitted-work comment: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (opts.sameAsPreviousTurn) return;
  try {
    await storage.createSystemMessage({
      source: 'daemon',
      kind: 'notice',
      title: `${name}: turn ended with uncommitted work left behind (${paths.length} path(s))`,
      body: opts.failedTurn
        ? `**${name}** failed and parked with files in its worktree that are not on its branch:\n\n${list}\n\n` +
          `Nobody asked its agent about them. Look at the worktree and decide what to keep.`
        : `**${name}** parked with work in its worktree that is not on its branch:\n\n${list}\n\n` +
          `Its agent was asked whether it had committed all its work and did not commit this. Unblock the task to have it commit ` +
          `the work (the request is already on the task as a comment), or look at the worktree yourself.`,
    });
  } catch (err) {
    logger.warn(
      `Task ${name}: could not file the uncommitted-work notice: ${err instanceof Error ? err.message : err}`,
    );
  }
}
