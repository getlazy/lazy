/**
 * Split `.git` bind-mount construction for agent containers.
 *
 * The agent container gets the repository's git common dir (`<repo>/.git`)
 * READ-ONLY, with exactly two writable carve-outs:
 *
 *   1. `<common>/objects` — content-addressed and append-only. Writing here can
 *      add blobs/trees/commits but cannot move anything: an object nobody
 *      references is unreachable garbage.
 *   2. `<common>/worktrees/<id>` — the per-worktree gitdir for THIS task only
 *      (index, HEAD, MERGE_HEAD, per-worktree logs). Enough for `git add`,
 *      `git status`, `git diff`, checkout of files.
 *
 * Everything else in the common dir — `refs/`, `packed-refs`, `config`,
 * `hooks/`, `logs/refs/`, and every sibling task's `worktrees/<other-id>` —
 * stays read-only, so the kernel refuses in-container ref moves, history
 * rewrites, sibling-branch merges, and `core.hooksPath` escapes. This is the
 * enforcement boundary; nothing at the tool/prompt layer is relied upon.
 *
 * Docker and Podman both resolve overlapping bind mounts by longest
 * container-path match, so a `:ro` mount of `<common>` with rw mounts of its
 * subpaths yields exactly this layout regardless of argument order. Lazy
 * already relies on that rule for the repo-`:ro` + worktree-rw pair.
 */

import { runGit } from '../utils/git';

export interface GitMountPaths {
  /** The shared git dir, `<repo>/.git` — mounted read-only. */
  commonDir: string;
  /** `<common>/objects` (or wherever git says it is) — mounted read-write. */
  objectsDir: string;
  /** `<common>/worktrees/<id>` for this worktree only — mounted read-write. */
  worktreeGitDir: string;
}

/**
 * Ask git itself where this worktree's dirs live.
 *
 * We ask git rather than composing paths by hand because the answer depends on
 * repo layout (`.git` file vs directory, relocated object stores, worktree ids
 * that don't match the directory name). The container mount table has to match
 * reality exactly or the agent silently loses `git add`.
 *
 * Throws when the path is not a linked worktree — in that case HEAD, the index
 * and the refs all live in the same directory and there is no way to make refs
 * read-only while keeping the index writable. Every lazy task runs in a linked
 * worktree, so this is a real misconfiguration, not a supported mode.
 */
export async function resolveGitMountPaths(worktreePath: string): Promise<GitMountPaths> {
  const result = await runGit(
    ['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--git-path', 'objects'],
    worktreePath,
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to resolve git directories for worktree ${worktreePath}: ${result.stderr || 'git rev-parse failed'}`,
    );
  }

  const lines = result.stdout.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length !== 3) {
    throw new Error(
      `Unexpected git rev-parse output while resolving git dirs for ${worktreePath}: ${JSON.stringify(result.stdout)}`,
    );
  }

  const [commonDir, gitDir, objectsDir] = lines as [string, string, string];

  if (gitDir === commonDir) {
    throw new Error(
      `Refusing to launch an agent container for ${worktreePath}: it is the main checkout, not a linked git worktree. ` +
      `Agent containers require a linked worktree so the shared git dir (refs, config, hooks) can be mounted read-only ` +
      `while the per-worktree gitdir stays writable.`,
    );
  }

  return { commonDir, objectsDir, worktreeGitDir: gitDir };
}

/**
 * Build the `-v` args for the split `.git` mount.
 *
 * INVARIANT: the common dir is mounted `:ro` and only `objects` and this
 * worktree's own gitdir are writable. Do not add a writable mount that covers
 * `refs/`, `packed-refs`, `config`, `hooks/`, or `worktrees/` as a whole — that
 * re-opens ref moves, history rewrites and sibling-worktree tampering, which
 * cannot be prevented anywhere else in the stack.
 */
export function buildGitMountArgs(paths: GitMountPaths): string[] {
  return [
    '-v', `${paths.commonDir}:${paths.commonDir}:ro`,
    '-v', `${paths.objectsDir}:${paths.objectsDir}`,
    '-v', `${paths.worktreeGitDir}:${paths.worktreeGitDir}`,
  ];
}

/** Convenience: resolve + build in one step. */
export async function buildGitMountArgsFor(worktreePath: string): Promise<string[]> {
  return buildGitMountArgs(await resolveGitMountPaths(worktreePath));
}
