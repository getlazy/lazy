/**
 * The rev-list exclusion that keeps a delivered-file check to THIS task's work:
 * everything already on the task's parent/target branch is not the task's.
 *
 * A sync merge's second parent brings the parent branch's history into
 * `startSha..HEAD`; without this exclusion an upstream commit that added a
 * tracked file at a delivered path was reported as the task carrying the
 * secret, blocking accept and filing a misleading comment.
 *
 * The parent ref comes from resolveTaskDiffBase (which goes through
 * resolveUpstreamMergeRef, as AGENTS.md requires). FAILS CLOSED: when no ref
 * resolves, nothing extra is excluded, so the check over-reports rather than
 * missing a secret.
 */

import type { ResolvedConfig } from '../config/types';
import type { Storage } from '../storage/interface';
import type { Session, Task } from '../types';
import { resolveTaskDiffBase } from '../task-diff-base';
import { runGit } from '../utils/git';
import { logger } from '../utils/logger';

export async function deliveredFilesUpstreamExclude(opts: {
  task: Task;
  session: Pick<Session, 'upstream_merge_sha'>;
  storage: Storage;
  projectRoot: string;
  worktreePath: string;
  config: ResolvedConfig;
}): Promise<string[]> {
  try {
    const base = await resolveTaskDiffBase(opts);
    const res = await runGit(['rev-parse', '--verify', '--quiet', `${base.ref}^{commit}`], { cwd: opts.worktreePath });
    const sha = res.stdout.trim();
    if (res.exitCode !== 0 || !sha) return [];
    return [`^${sha}`];
  } catch (err) {
    logger.debug(`Task ${opts.task.id}: no parent ref to exclude from the delivered-files check: ${(err as Error).message}`);
    return [];
  }
}
