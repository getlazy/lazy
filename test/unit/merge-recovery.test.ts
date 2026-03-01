/**
 * Unit tests for merge crash recovery and validation in merge.ts.
 *
 * These tests create real git repos to simulate crash scenarios:
 * - In-progress merge left behind by a crash (MERGE_HEAD exists)
 * - Unmerged files (conflict markers) in the worktree
 * - Detection and cleanup of both states
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import {
  hasMergeInProgress,
  hasUnmergedFiles,
  abortMergeIfInProgress,
} from '../../src/supervisor/merge';

/** Helper to run git commands in a directory */
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

/** Create a temp git repo with an initial commit */
async function createTestRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lazy-merge-test-'));
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@lazy.test');
  git(dir, 'config', 'user.name', 'Lazy Test');
  git(dir, 'checkout', '-b', 'main');
  await writeFile(join(dir, 'README.md'), '# Test\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Initial commit');
  return dir;
}

/**
 * Set up a repo with a conflicting branch. Returns the repo path.
 * Creates:
 * - main branch with file.txt containing "main content"
 * - feature branch with file.txt containing "feature content"
 * - Leaves HEAD on the feature branch
 */
async function createConflictingRepo(): Promise<string> {
  const dir = await createTestRepo();

  // Create a file on main
  await writeFile(join(dir, 'file.txt'), 'main content\n');
  git(dir, 'add', 'file.txt');
  git(dir, 'commit', '-m', 'Add file on main');

  // Create a feature branch from the initial commit (before the file was added)
  git(dir, 'checkout', '-b', 'feature', 'HEAD~1');
  await writeFile(join(dir, 'file.txt'), 'feature content\n');
  git(dir, 'add', 'file.txt');
  git(dir, 'commit', '-m', 'Add file on feature');

  return dir;
}

describe('merge recovery utilities', () => {
  let repoDir: string;

  afterEach(async () => {
    if (repoDir) {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  describe('hasMergeInProgress', () => {
    test('returns false when no merge is in progress', async () => {
      repoDir = await createTestRepo();
      expect(hasMergeInProgress(repoDir)).toBe(false);
    });

    test('returns true when MERGE_HEAD exists (merge in progress)', async () => {
      repoDir = await createConflictingRepo();

      // Start a merge that will conflict — don't abort it
      const mergeResult = git(repoDir, 'merge', 'main');
      expect(mergeResult.exitCode).not.toBe(0); // should fail with conflicts

      // MERGE_HEAD should exist
      expect(hasMergeInProgress(repoDir)).toBe(true);
    });

    test('returns false after merge is completed', async () => {
      repoDir = await createConflictingRepo();

      // Do a merge that conflicts
      git(repoDir, 'merge', 'main');

      // Resolve and commit
      await writeFile(join(repoDir, 'file.txt'), 'resolved content\n');
      git(repoDir, 'add', 'file.txt');
      git(repoDir, 'commit', '-m', 'Resolve merge conflict');

      expect(hasMergeInProgress(repoDir)).toBe(false);
    });
  });

  describe('hasUnmergedFiles', () => {
    test('returns false in a clean repo', async () => {
      repoDir = await createTestRepo();
      expect(hasUnmergedFiles(repoDir)).toBe(false);
    });

    test('returns true when there are unmerged files', async () => {
      repoDir = await createConflictingRepo();

      // Start a conflicting merge
      git(repoDir, 'merge', 'main');

      expect(hasUnmergedFiles(repoDir)).toBe(true);
    });

    test('returns false after conflicts are resolved', async () => {
      repoDir = await createConflictingRepo();

      // Start a conflicting merge
      git(repoDir, 'merge', 'main');

      // Resolve the conflict
      await writeFile(join(repoDir, 'file.txt'), 'resolved content\n');
      git(repoDir, 'add', 'file.txt');
      git(repoDir, 'commit', '-m', 'Resolve merge');

      expect(hasUnmergedFiles(repoDir)).toBe(false);
    });
  });

  describe('abortMergeIfInProgress', () => {
    test('returns false when no merge is in progress', async () => {
      repoDir = await createTestRepo();
      expect(abortMergeIfInProgress(repoDir)).toBe(false);
    });

    test('aborts an in-progress merge and returns true', async () => {
      repoDir = await createConflictingRepo();

      // Start a conflicting merge
      git(repoDir, 'merge', 'main');
      expect(hasMergeInProgress(repoDir)).toBe(true);

      // Abort it
      const result = abortMergeIfInProgress(repoDir);
      expect(result).toBe(true);

      // MERGE_HEAD should be gone
      expect(hasMergeInProgress(repoDir)).toBe(false);

      // Worktree should be clean (no conflict markers)
      expect(hasUnmergedFiles(repoDir)).toBe(false);
    });

    test('restores the pre-merge state after aborting', async () => {
      repoDir = await createConflictingRepo();

      // Record the pre-merge HEAD
      const preHeadResult = git(repoDir, 'rev-parse', 'HEAD');
      const preHead = preHeadResult.stdout;

      // Start a conflicting merge
      git(repoDir, 'merge', 'main');

      // Abort it
      abortMergeIfInProgress(repoDir);

      // HEAD should be back to where it was
      const postHeadResult = git(repoDir, 'rev-parse', 'HEAD');
      expect(postHeadResult.stdout).toBe(preHead);
    });
  });

  describe('crash simulation: in-progress merge recovery', () => {
    test('simulates crash during merge and verifies recovery cleans up', async () => {
      repoDir = await createConflictingRepo();

      // Simulate a crash: start a merge and leave it in-progress
      git(repoDir, 'merge', 'main');
      expect(hasMergeInProgress(repoDir)).toBe(true);
      expect(hasUnmergedFiles(repoDir)).toBe(true);

      // Now simulate what recoverWorktreeState does:
      // 1. Detect in-progress merge
      expect(hasMergeInProgress(repoDir)).toBe(true);

      // 2. Abort it
      const aborted = abortMergeIfInProgress(repoDir);
      expect(aborted).toBe(true);

      // 3. Verify clean state
      expect(hasMergeInProgress(repoDir)).toBe(false);
      expect(hasUnmergedFiles(repoDir)).toBe(false);

      // 4. Verify git status is clean
      const status = git(repoDir, 'status', '--porcelain');
      expect(status.stdout).toBe('');
    });
  });
});
