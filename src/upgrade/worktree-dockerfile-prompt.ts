/**
 * Interactive reminder when `lazy upgrade` is run from a task worktree.
 *
 * Task worktrees never govern the container image by default (see
 * resolveCustomDockerfile in src/capture/claude.ts) — that is deliberate and
 * load-bearing. Developers working on lazy itself often *want* the manual
 * override (`LAZY_DOCKERFILE_LAZY`) pointed at the worktree's Dockerfile.lazy
 * while testing a branch, and forget to export it. This asks once, on a TTY,
 * before any image build starts so the answer can actually change the outcome.
 */

import { readFile, realpath } from 'fs/promises';
import { isAbsolute, join, relative } from 'path';
import { getDataDir } from '../cli/init';
import { isTTY, promptYesNo } from '../cli/editor';
import { theme } from '../cli/theme';
import { pathExists } from '../utils/fs';

const WORKTREE_DOCKERFILE = 'Dockerfile.lazy';

/**
 * Return the absolute cwd when it is a lazy task worktree under `projectRoot`,
 * otherwise null. Uses realpath so symlink spellings (macOS /var vs /private/var)
 * do not false-negative.
 */
export async function lazyTaskWorktreeCwd(projectRoot: string): Promise<string | null> {
  let cwd: string;
  let root: string;
  try {
    cwd = await realpath(process.cwd());
    root = await realpath(projectRoot);
  } catch {
    // Unreadable cwd/root (gone, permission denied) — treat as "not a worktree"
    // so this optional prompt never fails the upgrade.
    return null;
  }

  if (cwd === root) return null;

  const worktreesDir = join(root, getDataDir(root), 'worktrees');
  if (!(await pathExists(worktreesDir))) return null;

  let worktreesReal: string;
  try {
    worktreesReal = await realpath(worktreesDir);
  } catch {
    // Worktrees dir exists but cannot be resolved (race/delete, permission) —
    // same "not a worktree" outcome as a missing dir.
    return null;
  }

  const rel = relative(worktreesReal, cwd);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;

  return cwd;
}

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
 * When upgrade is run interactively from a task worktree whose Dockerfile.lazy
 * differs from the project root's, ask whether to set LAZY_DOCKERFILE_LAZY for
 * this run. No-op without a TTY, when the override is already set, or when the
 * worktree has nothing different to offer.
 *
 * Must run BEFORE any container image build (foreground or background).
 */
export async function maybePromptWorktreeDockerfileOverride(projectRoot: string): Promise<void> {
  if (!isTTY()) return;
  if (process.env.LAZY_DOCKERFILE_LAZY) return;

  const worktreeCwd = await lazyTaskWorktreeCwd(projectRoot);
  if (!worktreeCwd) return;

  const worktreeDockerfile = join(worktreeCwd, WORKTREE_DOCKERFILE);
  if (!(await pathExists(worktreeDockerfile))) return;

  const rootDockerfile = join(projectRoot, WORKTREE_DOCKERFILE);
  if ((await pathExists(rootDockerfile)) && await filesEqual(worktreeDockerfile, rootDockerfile)) {
    return;
  }

  console.log('');
  console.log(theme.warning('Running `lazy upgrade` from a task worktree.'));
  console.log(`  Directory:  ${worktreeCwd}`);
  console.log(`  Default:    ${rootDockerfile}`);
  console.log(`  Here:       ${worktreeDockerfile}`);
  console.log('');
  console.log('  By default the image build uses the project root Dockerfile, not this');
  console.log("  worktree's copy. To build from the worktree instead, export:");
  console.log(`    export LAZY_DOCKERFILE_LAZY='${worktreeDockerfile}'`);
  console.log('');

  const useWorktree = await promptYesNo(
    'Use this worktree\'s Dockerfile.lazy for this upgrade?',
    false,
  );
  if (!useWorktree) return;

  process.env.LAZY_DOCKERFILE_LAZY = worktreeDockerfile;
  console.log(`  ${theme.success('Using')} LAZY_DOCKERFILE_LAZY=${worktreeDockerfile} for this upgrade.`);
  console.log('');
}
