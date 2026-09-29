/**
 * Check, on the host and WITHOUT running git, that a task worktree's git
 * pointers are exactly what lazy's `git worktree add` wrote, before a member's
 * container is launched on it (./member-container.ts).
 *
 * The pointers live where turns can write them: `<worktree>/.git` (a file
 * naming the per-worktree gitdir) and, in that gitdir, `commondir` and
 * `gitdir`. A turn that rewrites them redirects git — to a gitdir it controls,
 * with a `config` carrying `core.fsmonitor`, `core.sshCommand` or hooks — and
 * whatever git the member then runs in their terminal, next to their
 * credential, executes it. So is a `config.worktree` in the per-worktree gitdir
 * (git reads it once `extensions.worktreeConfig` is on). Running git on the
 * HOST to find out where things are (`git rev-parse`) would follow the same
 * redirection, so this reads the files directly.
 *
 * On success the member's container never sees the three pointer files
 * themselves: the daemon writes COPIES of the text it checked into the
 * member's home ({@link writeMemberGitPointerCopies}) and bind-mounts those,
 * read-only, over the originals' paths. A rewrite of an original after the
 * check — by anything still running beside the worktree — changes nothing the
 * member's git reads. Nothing of a turn should still be running (the member's
 * entry stops the task's container, ./member-entry.ts); this is the second
 * line.
 */

import {
  GitPointerTamperError,
  UnsupportedGitLayoutError,
  gitPointerMountArgs,
  validateWorktreeGitPointers,
  writeGitPointerCopies,
  type WorktreeGitPointers,
} from '../git/worktree-pointers';

/** The check itself is shared with task containers: ../git/worktree-pointers.ts. */
export type MemberGitLayout = WorktreeGitPointers;

export class GitLayoutRefusedError extends Error {
  constructor(detail: string) {
    super(
      `This task's git setup has been changed from what lazy created (${detail}), so a terminal of your own ` +
      `cannot be opened on it safely. Ask the task's agent to leave .git alone, or recreate the task.`,
    );
    this.name = 'GitLayoutRefusedError';
  }
}

/**
 * The worktree's git layout, checked against what lazy created, or a
 * GitLayoutRefusedError naming the first thing that differs.
 */
export async function validateMemberGitLayout(projectRoot: string, worktreePath: string): Promise<MemberGitLayout> {
  try {
    return await validateWorktreeGitPointers(projectRoot, worktreePath);
  } catch (err) {
    if (err instanceof GitPointerTamperError || err instanceof UnsupportedGitLayoutError) throw new GitLayoutRefusedError(err.detail);
    throw err;
  }
}

/** Where, under a member's home, the copies of the pointer files are written. */
export const MEMBER_GIT_POINTER_DIR = 'git-pointers';

/**
 * Write the checked pointer texts into the member's home (daemon-owned, never
 * turn-writable) and return what to mount where.
 */
export async function writeMemberGitPointerCopies(
  homeDir: string,
  layout: Pick<MemberGitLayout, 'pointerFiles'>,
): Promise<Array<{ source: string; target: string }>> {
  return writeGitPointerCopies(homeDir, MEMBER_GIT_POINTER_DIR, layout);
}

/** `-v` args binding each copy read-only over the original's path. */
export const memberGitPointerMounts = gitPointerMountArgs;
