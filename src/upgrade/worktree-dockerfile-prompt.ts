/**
 * Interactive adoption prompt when `lazy upgrade` is run from a task worktree.
 *
 * Task worktrees never auto-govern the container image (see
 * src/docker/worktree-image.ts and resolveCustomDockerfile). Developers working
 * on lazy itself often want the *whole system* — image build AND the restarted
 * daemon — to run a release worktree's Dockerfile.lazy until the next binary
 * rebuild. This asks once, on a TTY, before any image build starts, and on yes
 * persists adoption in daemon runtime state (not an env var, not lazy.toml).
 *
 * Part 1's per-task pin lives in src/docker/worktree-image.ts and never touches
 * daemon state. The old env-override path is gone — adoption is the only way
 * a worktree Dockerfile reaches the daemon's image.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { isTTY, promptYesNo } from '../cli/editor';
import { theme } from '../cli/theme';
import { IMAGE_TAG } from '../capture/image-tag';
import {
  clearAdoptedImage,
  hashDockerfileContent,
  writeAdoptedImage,
  type AdoptedImageState,
} from '../daemon/adopted-image';
import {
  lazyTaskWorktreeCwd,
  WORKTREE_DOCKERFILE,
} from '../docker/worktree-image';
import { pathExists } from '../utils/fs';

// Re-export so existing imports keep working; the canonical home is
// src/docker/worktree-image.ts (shared with the per-task image prompt).
export { lazyTaskWorktreeCwd } from '../docker/worktree-image';

async function filesEqual(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([readFile(a), readFile(b)]);
    return left.equals(right);
  } catch {
    // Either file unreadable: treat as different so we still ask (safer than
    // silently skipping when we cannot confirm they match).
    return false;
  }
}

/**
 * Every upgrade that rebuilds re-decides adoption: clear first, then optionally
 * rewrite on yes. Call this BEFORE any container image build (foreground or
 * background) so resolveCustomDockerfile / the build see the new state.
 *
 * Returns the written adoption on yes, null when skipped or declined.
 * No-op without a TTY or when the worktree has nothing different to offer —
 * but still clears any prior adoption so it cannot outlive this rebuild.
 */
export async function maybePromptWorktreeDockerfileAdoption(
  projectRoot: string,
): Promise<AdoptedImageState | null> {
  // Lifecycle: each rebuild clears, then the prompt may rewrite. Doing this
  // unconditionally (even without a TTY / worktree) is what stops an adoption
  // from silently outliving the next upgrade.
  await clearAdoptedImage(projectRoot);

  if (!isTTY()) return null;

  const worktreeCwd = await lazyTaskWorktreeCwd(projectRoot);
  if (!worktreeCwd) return null;

  const worktreeDockerfile = join(worktreeCwd, WORKTREE_DOCKERFILE);
  if (!(await pathExists(worktreeDockerfile))) return null;

  const rootDockerfile = join(projectRoot, WORKTREE_DOCKERFILE);
  if ((await pathExists(rootDockerfile)) && await filesEqual(worktreeDockerfile, rootDockerfile)) {
    return null;
  }

  console.log('');
  console.log(theme.warning('Running `lazy upgrade` from a task worktree.'));
  console.log(`  Directory:  ${worktreeCwd}`);
  console.log(`  Default:    ${rootDockerfile}`);
  console.log(`  Here:       ${worktreeDockerfile}`);
  console.log('');
  console.log('  By default the image build uses the project root Dockerfile, not this');
  console.log("  worktree's copy. Adopting builds from the worktree AND keeps the daemon");
  console.log('  and all non-pinned task launches on that image until the next upgrade');
  console.log('  rebuild (binary rebuild + daemon restart) decides again.');
  console.log('');

  const useWorktree = await promptYesNo(
    "Adopt this worktree's Dockerfile.lazy for the image build and the daemon?",
    false,
  );
  if (!useWorktree) {
    console.log('  Using the project root Dockerfile (no adoption).');
    console.log('');
    return null;
  }

  const content = await readFile(worktreeDockerfile, 'utf-8');
  const contentHash = hashDockerfileContent(content);
  const shortHash = contentHash.substring(0, 12);
  const imageName = `lazy-custom-${shortHash}:${IMAGE_TAG}`;

  // Snapshot the consented bytes at prompt time (adopted-Dockerfile) so the
  // later upgrade build cannot re-read a post-consent agent edit of the
  // worktree file.
  const state = await writeAdoptedImage(
    projectRoot,
    {
      dockerfilePath: worktreeDockerfile,
      contentHash,
      imageName,
    },
    { content },
  );

  console.log(
    `  ${theme.success('Adopted')} ${state.imageName} from ${worktreeDockerfile}`,
  );
  console.log(
    `  Daemon + launches will use it until the next \`lazy upgrade\` rebuild ` +
      `(lazy ${state.lazyVersion}).`,
  );
  console.log('');

  return state;
}
