/**
 * Unit tests for LocalDriver's safe-merge guard.
 *
 * INVARIANT (fix-safe-branch-delete): If a squash merge silently produces no
 * commit on the target branch, LocalDriver.merge() MUST return failed and the
 * caller MUST NOT delete the source branch. Previously, a missing `await` on
 * squashMergeTaskBranch caused 8 task branches to be deleted with their work
 * becoming dangling git objects. This guard ensures any future silent failure
 * (disk full, race condition, swallowed git error) is caught before cleanup.
 */

import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { runGit } from '../../src/utils/git';

// Mock squashMergeTaskBranch to be a no-op that returns "success" without
// committing anything — simulating the silent-failure mode the guard protects against.
await mockModule(resolve(import.meta.dir, '../../src/git/operations.ts'), () => ({
  checkMergeConflicts: async () => false,
  checkMergeConflictsIntoTarget: async () => false,
  squashMergeTaskBranch: async () => {
    // Intentionally do nothing — simulates a silent squash failure.
  },
}));

// Import LocalDriver AFTER the mock so it picks up the mocked module.
import { LocalDriver } from '../../src/remote/local-driver';
import type { Task } from '../../src/types';

async function initRepo(dir: string): Promise<void> {
  await runGit(['init', '-q', '-b', 'main'], { cwd: dir });
  await runGit(['config', 'user.email', 'test@example.com'], { cwd: dir });
  await runGit(['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'init\n');
  await runGit(['add', '.'], { cwd: dir });
  await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });
}

async function branchExists(branch: string, cwd: string): Promise<boolean> {
  const r = await runGit(['rev-parse', '--verify', `refs/heads/${branch}`], { cwd });
  return r.exitCode === 0;
}

describe('LocalDriver.merge: safe-branch-delete guard', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'lazy-safe-delete-'));
    await initRepo(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test('returns failed when squash produces no commit, and source branch is preserved', async () => {
    // Create a task branch with a real commit so it has work that would be lost.
    await runGit(['checkout', '-q', '-b', 'lazy/task-1'], { cwd: repo });
    await writeFile(join(repo, 'work.txt'), 'task work\n');
    await runGit(['add', '.'], { cwd: repo });
    await runGit(['commit', '-q', '-m', 'task work'], { cwd: repo });
    await runGit(['checkout', '-q', 'main'], { cwd: repo });

    const driver = new LocalDriver();
    const task = { id: 'abc12345', goal: 'test goal', metadata: {} } as unknown as Task;

    const result = await driver.merge({
      sourceBranch: 'lazy/task-1',
      targetBranch: 'main',
      task,
      taskShortId: 'abc12345',
      root: repo,
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.error).toContain('squash merge produced no commit');
    expect(result.error).toContain('source branch not deleted');

    // The source branch — and its commits — must still exist.
    expect(await branchExists('lazy/task-1', repo)).toBe(true);
    const log = await runGit(['log', '--format=%s', 'lazy/task-1'], { cwd: repo });
    expect(log.stdout).toContain('task work');
  });
});

afterAll(() => {
  restoreMockedModules();
});
