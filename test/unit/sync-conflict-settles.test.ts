/**
 * What a conflicted sync does when the resolution agent never succeeds.
 *
 * This is the exact shape of the live incident in fix-sync-silent-conflict: the
 * merge conflicted, resolution did not happen, and the sync came back with the
 * worktree still half-merged and nothing in the task history saying so. The
 * invariant now is that a sync ends in exactly one of three states, all loud —
 * merged and committed, conflicted WITH a resolution turn in flight, or aborted
 * with an error that names what happened.
 *
 * The resolution agent is a real fake `claude` on PATH that always exits 1, so
 * the failure being tested is the launch itself failing rather than a mocked
 * module boundary.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, readFile, chmod } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runSyncWithUpstream } from '../../src/supervisor/merge';
import { readWorktreeMergeState, isMidMerge } from '../../src/git/operations';
import { resetElevatedGitChannel } from '../../src/supervisor/elevated-git';

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

/** Repo on `feature`, whose merge of `main` conflicts on file.txt. */
async function createConflictingRepo(dir: string): Promise<void> {
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@lazy.test');
  git(dir, 'config', 'user.name', 'Lazy Test');
  git(dir, 'checkout', '-b', 'main');
  await writeFile(join(dir, 'README.md'), '# Test\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Initial commit');

  await writeFile(join(dir, 'file.txt'), 'main content\n');
  git(dir, 'add', 'file.txt');
  git(dir, 'commit', '-m', 'Add file on main');

  git(dir, 'checkout', '-b', 'feature', 'HEAD~1');
  await writeFile(join(dir, 'file.txt'), 'feature content\n');
  git(dir, 'add', 'file.txt');
  git(dir, 'commit', '-m', 'Add file on feature');
}

/**
 * Put a `claude` that always fails on PATH, logging the argv it was given and
 * whether the worktree it was handed was actually conflicted.
 */
async function installFailingClaude(root: string): Promise<string> {
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  const logPath = join(root, 'claude-invocations.log');
  await writeFile(
    join(binDir, 'claude'),
    [
      '#!/bin/sh',
      // The prompt argument is multi-line; flatten it so each invocation is one
      // greppable line.
      `echo "ARGS: $(echo "$*" | tr '\\n' ' ')" >> "${logPath}"`,
      `echo "UNMERGED: $(git diff --name-only --diff-filter=U | tr '\\n' ' ')" >> "${logPath}"`,
      'exit 1',
      '',
    ].join('\n'),
  );
  await chmod(join(binDir, 'claude'), 0o755);
  return logPath;
}

describe('a conflicted sync whose resolution never succeeds', () => {
  let root = '';
  let originalPath = '';

  afterEach(async () => {
    if (originalPath) process.env.PATH = originalPath;
    originalPath = '';
    resetElevatedGitChannel();
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  async function setup(): Promise<{ repo: string; logPath: string }> {
    root = await mkdtemp(join(tmpdir(), 'lazy-sync-settle-'));
    const repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    await createConflictingRepo(repo);

    const logPath = await installFailingClaude(root);
    originalPath = process.env.PATH ?? '';
    // Prepend rather than replace: git must still resolve, and the fake claude
    // shells out to it.
    process.env.PATH = `${join(root, 'bin')}:${originalPath}`;

    return { repo, logPath };
  }

  // INVARIANT (fix-sync-silent-conflict): a sync that cannot get its conflicts
  // resolved ABORTS the merge and throws. It never returns — successfully or
  // otherwise — over a worktree with unmerged files and no resolution in flight.
  test('aborts the merge and fails loudly instead of returning over UU files', async () => {
    const { repo } = await setup();
    const headBefore = git(repo, 'rev-parse', 'HEAD').stdout;

    let thrown: Error | null = null;
    try {
      await runSyncWithUpstream(repo, 'main');
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeTruthy();
    // The error names the agent failure AND the state of the files on disk.
    expect(thrown!.message).toContain('Merge-and-fix');
    expect(thrown!.message).toMatch(/worktree/i);

    const state = await readWorktreeMergeState(repo);
    expect(isMidMerge(state)).toBe(false);
    // Aborting restores the pre-merge commit; it does not invent one.
    expect(git(repo, 'rev-parse', 'HEAD').stdout).toBe(headBefore);
  }, 60_000);

  // INVARIANT (fix-sync-silent-conflict): every resolution attempt is handed a
  // worktree with the conflicted merge actually in progress. The resume →
  // standalone fallback rewinds the retry counter, and when the "re-create the
  // merge" step was keyed on that counter the fallback agent got an empty
  // worktree and the sync died with a baffling "HEAD did not advance".
  test('re-creates the conflicted merge for the standalone fallback after resume fails', async () => {
    const { repo, logPath } = await setup();

    await expect(
      runSyncWithUpstream(repo, 'main', undefined, 'prior-session-id'),
    ).rejects.toThrow();

    const log = await readFile(logPath, 'utf-8');
    const argLines = log.split('\n').filter(l => l.startsWith('ARGS:'));
    const unmergedLines = log.split('\n').filter(l => l.startsWith('UNMERGED:'));

    // First invocation resumes the prior session; the fallback ones do not.
    expect(argLines[0]).toContain('--resume');
    expect(argLines.length).toBeGreaterThan(1);
    expect(argLines.slice(1).every(l => !l.includes('--resume'))).toBe(true);

    // EVERY invocation — including the ones after the counter was rewound — saw
    // a genuinely conflicted worktree.
    expect(unmergedLines.length).toBe(argLines.length);
    for (const line of unmergedLines) {
      expect(line).toContain('file.txt');
    }
  }, 60_000);
});
