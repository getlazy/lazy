/**
 * Unit tests for fastForwardLocal skipping worktrees that belong to working tasks.
 *
 * INVARIANT: When a branch is checked out in a worktree belonging to an
 * actively-working task, fastForwardLocal must NOT merge into that worktree.
 * Merging into an agent's working tree mid-turn would corrupt its state.
 * Instead, return success with a warning — the remote merge already succeeded,
 * and the local staleness can be resolved when the agent's turn ends.
 */

import { describe, test, expect } from 'bun:test';
import { fastForwardLocal, type GitResult } from '../../src/utils/git';
import { LocalDriver } from '../../src/remote/local-driver';
import type { DriverContext } from '../../src/remote/driver';
import type { Storage } from '../../src/storage';

/** Helper: create a mock git function that returns canned responses */
function mockGit(responses: Record<string, GitResult>) {
  return (args: string[], _cwd?: string): GitResult => {
    const cmd = args.join(' ');

    // Check for exact match first
    if (responses[cmd]) return responses[cmd];

    // Check for prefix match (for commands with variable args)
    for (const [pattern, result] of Object.entries(responses)) {
      if (cmd.startsWith(pattern)) return result;
    }

    // Default: success
    return { stdout: '', stderr: '', exitCode: 0 };
  };
}

describe('fastForwardLocal shouldSkipWorktree', () => {
  // INVARIANT: When a worktree belongs to a working task, the skip callback
  // prevents fastForwardLocal from merging into it.
  test('skips fast-forward when shouldSkipWorktree returns true (refspec path)', () => {
    const git = mockGit({
      // HEAD is on a different branch (not the target)
      'rev-parse --abbrev-ref HEAD': { stdout: 'main', stderr: '', exitCode: 0 },
      // Refspec fetch fails because branch is checked out in a worktree
      'fetch origin feature:feature': {
        stdout: '',
        stderr: "fatal: refusing to fetch into branch 'refs/heads/feature' checked out at '/repo/.lazy/worktrees/task-abc'",
        exitCode: 1,
      },
      // worktree list shows the branch is in a worktree
      'worktree list --porcelain': {
        stdout: [
          'worktree /repo',
          'HEAD abc123',
          'branch refs/heads/main',
          '',
          'worktree /repo/.lazy/worktrees/task-abc',
          'HEAD def456',
          'branch refs/heads/feature',
          '',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      },
    });

    // Skip callback: this worktree belongs to a working task
    const shouldSkip = (path: string) => path === '/repo/.lazy/worktrees/task-abc';

    const result = fastForwardLocal('feature', 'origin', '/repo', git, shouldSkip);

    expect(result.success).toBe(true);
    expect(result.warning).toContain('active task');
    expect(result.warning).toContain('Skipped fast-forward');
  });

  test('proceeds with fast-forward when shouldSkipWorktree returns false', () => {
    const git = mockGit({
      'rev-parse --abbrev-ref HEAD': { stdout: 'main', stderr: '', exitCode: 0 },
      'fetch origin feature:feature': {
        stdout: '',
        stderr: "fatal: refusing to fetch into branch 'refs/heads/feature' checked out at '/repo/.lazy/worktrees/task-abc'",
        exitCode: 1,
      },
      'worktree list --porcelain': {
        stdout: [
          'worktree /repo/.lazy/worktrees/task-abc',
          'HEAD def456',
          'branch refs/heads/feature',
          '',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      },
      // fetch in worktree succeeds
      'fetch origin feature': { stdout: '', stderr: '', exitCode: 0 },
      // ff-only merge succeeds
      'merge --ff-only origin/feature': { stdout: 'Fast-forward', stderr: '', exitCode: 0 },
    });

    // Skip callback: this worktree does NOT belong to a working task
    const shouldSkip = (_path: string) => false;

    const result = fastForwardLocal('feature', 'origin', '/repo', git, shouldSkip);

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  test('proceeds normally when no shouldSkipWorktree callback is provided', () => {
    const git = mockGit({
      'rev-parse --abbrev-ref HEAD': { stdout: 'main', stderr: '', exitCode: 0 },
      'fetch origin feature:feature': {
        stdout: '',
        stderr: "fatal: refusing to fetch into branch 'refs/heads/feature' checked out at '/repo/.lazy/worktrees/task-abc'",
        exitCode: 1,
      },
      'worktree list --porcelain': {
        stdout: [
          'worktree /repo/.lazy/worktrees/task-abc',
          'HEAD def456',
          'branch refs/heads/feature',
          '',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      },
      'fetch origin feature': { stdout: '', stderr: '', exitCode: 0 },
      'merge --ff-only origin/feature': { stdout: 'Fast-forward', stderr: '', exitCode: 0 },
    });

    // No callback — should proceed normally
    const result = fastForwardLocal('feature', 'origin', '/repo', git);

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  // INVARIANT: The skip check also applies in the branch -f fallback path.
  test('skips fast-forward when shouldSkipWorktree returns true (branch -f path)', () => {
    const git = mockGit({
      'rev-parse --abbrev-ref HEAD': { stdout: 'main', stderr: '', exitCode: 0 },
      // Refspec fetch fails for a non-worktree reason
      'fetch origin feature:feature': {
        stdout: '',
        stderr: '! [rejected] (non-fast-forward)',
        exitCode: 1,
      },
      // Remote fetch succeeds
      'fetch origin feature': { stdout: '', stderr: '', exitCode: 0 },
      // Local and remote SHAs differ
      'rev-parse feature': { stdout: 'aaa111', stderr: '', exitCode: 0 },
      'rev-parse origin/feature': { stdout: 'bbb222', stderr: '', exitCode: 0 },
      // Local is ancestor of remote (can ff)
      'merge-base --is-ancestor aaa111 bbb222': { stdout: '', stderr: '', exitCode: 0 },
      // branch -f fails because checked out in worktree
      'branch -f feature origin/feature': {
        stdout: '',
        stderr: "fatal: cannot force update the branch 'feature' checked out at '/repo/.lazy/worktrees/task-xyz'",
        exitCode: 1,
      },
      'worktree list --porcelain': {
        stdout: [
          'worktree /repo/.lazy/worktrees/task-xyz',
          'HEAD def456',
          'branch refs/heads/feature',
          '',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      },
    });

    const shouldSkip = (path: string) => path === '/repo/.lazy/worktrees/task-xyz';

    const result = fastForwardLocal('feature', 'origin', '/repo', git, shouldSkip);

    expect(result.success).toBe(true);
    expect(result.warning).toContain('active task');
    expect(result.warning).toContain('Skipped fast-forward');
  });
});

describe('LocalDriver DriverContext', () => {
  // INVARIANT: LocalDriver receives DriverContext the same as GitHub/GitLab
  // drivers. Even though its fastForwardLocal is a no-op (no remote), the
  // context is stored for consistency and future-proofing.
  test('LocalDriver accepts DriverContext in constructor', () => {
    const mockStorage = {} as Storage;
    const context: DriverContext = { storage: mockStorage, lazyRoot: '/tmp/repo' };

    // Should not throw — context is accepted and stored
    const driver = new LocalDriver(context);
    expect(driver).toBeDefined();
  });

  test('LocalDriver fastForwardLocal is no-op regardless of context', async () => {
    const mockStorage = {} as Storage;
    const context: DriverContext = { storage: mockStorage, lazyRoot: '/tmp/repo' };

    const driver = new LocalDriver(context);
    const result = await driver.fastForwardLocal('main', '/tmp/repo');

    // LocalDriver has no remote — fastForwardLocal is always a no-op success
    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  test('LocalDriver works without context (backward compatible)', async () => {
    const driver = new LocalDriver();
    const result = await driver.fastForwardLocal('main', '/tmp/repo');

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
  });
});
