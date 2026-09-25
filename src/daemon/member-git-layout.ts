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

import { lstat, readFile, realpath } from 'fs/promises';
import { writeRegularFileUnder } from './link-safe-files';
import { basename, dirname, isAbsolute, join } from 'path';
import type { GitMountPaths } from '../capture/git-mounts';

export interface MemberGitLayout extends GitMountPaths {
  /**
   * `<worktree>/.git`, `<gitdir>/commondir`, `<gitdir>/gitdir`: the exact text
   * that was checked, and the path the container sees it at.
   */
  pointerFiles: Array<{ name: 'dotgit' | 'commondir' | 'gitdir'; content: string; target: string }>;
}

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
 * A real directory (never itself a link), returned as its realpath. With
 * `expected`, the realpath must be exactly that — a system link higher up
 * (macOS /var → /private/var) is fine, a redirection is not.
 */
async function realDir(path: string, what: string, expected?: string): Promise<string> {
  const st = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    throw new GitLayoutRefusedError(`${what} ${path} is missing (${err.code ?? err.message})`);
  });
  if (st.isSymbolicLink()) throw new GitLayoutRefusedError(`${what} ${path} is a symbolic link`);
  if (!st.isDirectory()) throw new GitLayoutRefusedError(`${what} ${path} is not a directory`);
  const real = await realpath(path);
  if (expected !== undefined && real !== expected) throw new GitLayoutRefusedError(`${what} ${path} resolves to ${real}, not ${expected}`);
  return real;
}

/** The file's exact text (compared with {@link chomp}, copied as read). */
async function regularFileText(path: string, what: string): Promise<string> {
  const st = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    throw new GitLayoutRefusedError(`${what} ${path} is missing (${err.code ?? err.message})`);
  });
  if (st.isSymbolicLink()) throw new GitLayoutRefusedError(`${what} ${path} is a symbolic link`);
  if (!st.isFile()) throw new GitLayoutRefusedError(`${what} ${path} is not a regular file`);
  if (st.size > 4096) throw new GitLayoutRefusedError(`${what} ${path} is unexpectedly large`);
  return readFile(path, 'utf-8');
}

const chomp = (text: string) => text.replace(/\r?\n$/, '');

/**
 * The worktree's git layout, checked against what lazy created, or a
 * GitLayoutRefusedError naming the first thing that differs.
 */
export async function validateMemberGitLayout(projectRoot: string, worktreePath: string): Promise<MemberGitLayout> {
  const root = await realpath(projectRoot);
  const commonDir = await realDir(join(root, '.git'), "the project's git directory", join(root, '.git'));
  const worktree = await realDir(await realpath(worktreePath), 'the worktree');

  const dotGit = join(worktree, '.git');
  const pointerText = await regularFileText(dotGit, "the worktree's .git file");
  const m = /^gitdir: (.+)$/.exec(chomp(pointerText));
  if (!m) throw new GitLayoutRefusedError(`${dotGit} does not name a gitdir`);
  const gitDir = m[1]!;
  if (!isAbsolute(gitDir)) throw new GitLayoutRefusedError(`${dotGit} names a relative gitdir (${gitDir})`);
  const id = basename(gitDir);
  if (!id || id.startsWith('.')) throw new GitLayoutRefusedError(`${dotGit} points at ${gitDir}, not a worktree of ${commonDir}`);
  const worktreeGitDir = await realDir(gitDir, "the worktree's gitdir", join(commonDir, 'worktrees', id));

  const commondirFile = join(worktreeGitDir, 'commondir');
  const commondirText = await regularFileText(commondirFile, 'the commondir file');
  const commondir = chomp(commondirText);
  if (commondir !== '../..' && commondir !== commonDir) {
    throw new GitLayoutRefusedError(`${commondirFile} points at ${commondir}`);
  }
  const gitdirFile = join(worktreeGitDir, 'gitdir');
  const backText = await regularFileText(gitdirFile, 'the gitdir file');
  const back = chomp(backText);
  const backReal = await realpath(dirname(back)).then((d) => join(d, basename(back)), () => back);
  if (backReal !== dotGit) {
    throw new GitLayoutRefusedError(`${gitdirFile} points at ${back}, not ${dotGit}`);
  }
  const configWorktree = join(worktreeGitDir, 'config.worktree');
  const cw = await lstat(configWorktree).then(() => true, (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return false;
    throw err;
  });
  if (cw) throw new GitLayoutRefusedError(`${configWorktree} exists; lazy never writes one`);

  const objectsDir = await realDir(join(commonDir, 'objects'), 'the object store', join(commonDir, 'objects'));
  return {
    commonDir,
    objectsDir,
    worktreeGitDir,
    pointerFiles: [
      // The worktree is mounted at the path lazy knows it by.
      { name: 'dotgit', content: pointerText, target: join(worktreePath, '.git') },
      { name: 'commondir', content: commondirText, target: commondirFile },
      { name: 'gitdir', content: backText, target: gitdirFile },
    ],
  };
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
  const copies: Array<{ source: string; target: string }> = [];
  for (const f of layout.pointerFiles) {
    await writeRegularFileUnder(homeDir, join(MEMBER_GIT_POINTER_DIR, f.name), f.content, 0o444);
    copies.push({ source: join(homeDir, MEMBER_GIT_POINTER_DIR, f.name), target: f.target });
  }
  return copies;
}

/** `-v` args binding each copy read-only over the original's path. */
export function memberGitPointerMounts(copies: Array<{ source: string; target: string }>): string[] {
  return copies.flatMap((f) => ['-v', `${f.source}:${f.target}:ro`]);
}
