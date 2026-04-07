import { describe, test, expect } from 'bun:test';
import {
  tryFastForwardInWorktree,
  validateBranchInSyncWithRemote,
  type GitResult,
} from '../../src/utils/git';

/** Helper: create a mock git function */
function mockGit(handler: (args: string[], cwd?: string) => Promise<GitResult>) {
  return handler;
}

const ok = (stdout = ''): GitResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'error'): GitResult => ({ stdout: '', stderr, exitCode: 1 });

// INVARIANT: A failed merge is a failure. `success: true` with a warning when
// the operation actually failed is NEVER acceptable.
describe('tryFastForwardInWorktree — fail hard on failures', () => {
  // INVARIANT: Fetch failure must return success:false, not success:true with warning.
  test('fetch failure returns success:false', async () => {
    const git = mockGit(async (args) => {
      if (args[0] === 'fetch') return fail('fatal: Could not resolve host: github.com');
      return ok();
    });

    const result = await tryFastForwardInWorktree(
      'main', '/repo/.lazy/worktrees/task-abc', 'origin/main', 'origin', '/repo', git,
    );

    expect(result.success).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('fetch failed');
    expect(result.warning).toContain('Could not resolve host');
  });

  // INVARIANT: Merge failure must return success:false.
  test('merge ff-only failure returns success:false', async () => {
    const git = mockGit(async (args) => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'merge' && args.includes('--ff-only')) {
        return fail('fatal: Not possible to fast-forward, aborting.');
      }
      return ok();
    });

    const result = await tryFastForwardInWorktree(
      'main', '/repo/.lazy/worktrees/task-abc', 'origin/main', 'origin', '/repo', git,
    );

    expect(result.success).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('could not be fast-forwarded');
  });

  test('successful ff-only merge returns success:true', async () => {
    const git = mockGit(async (args) => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'merge' && args.includes('--ff-only')) return ok('Fast-forward');
      return ok();
    });

    const result = await tryFastForwardInWorktree(
      'main', '/repo/.lazy/worktrees/task-abc', 'origin/main', 'origin', '/repo', git,
    );

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  test('already up to date returns success:true', async () => {
    const git = mockGit(async (args) => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'merge' && args.includes('--ff-only')) {
        return { stdout: 'Already up to date.', stderr: '', exitCode: 1 };
      }
      return ok();
    });

    const result = await tryFastForwardInWorktree(
      'main', '/repo/.lazy/worktrees/task-abc', 'origin/main', 'origin', '/repo', git,
    );

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
  });
});

// INVARIANT: validateBranchInSyncWithRemote must fail on fetch failure,
// never silently proceed with inSync:true.
describe('validateBranchInSyncWithRemote — no silent fallbacks', () => {
  // INVARIANT: Fetch failure must return inSync:false, not inSync:true.
  test('fetch failure returns inSync:false with actionable error', async () => {
    const git = mockGit(async (args) => {
      if (args[0] === 'fetch') return fail('fatal: Could not resolve host: github.com');
      return ok();
    });

    const result = await validateBranchInSyncWithRemote('main', 'origin', '/repo', git);

    expect(result.inSync).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Failed to fetch');
    expect(result.error).toContain('Could not resolve host');
  });

  // INVARIANT: Can't resolve refs must return inSync:false.
  test('ref resolution failure returns inSync:false', async () => {
    const git = mockGit(async (args) => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'rev-parse') return fail('fatal: not a valid ref');
      return ok();
    });

    const result = await validateBranchInSyncWithRemote('main', 'origin', '/repo', git);

    expect(result.inSync).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Failed to resolve refs');
  });

  test('same SHA returns inSync:true', async () => {
    const git = mockGit(async (args) => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'rev-parse' && args[1] === 'main') return ok('aaa111');
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return ok('aaa111');
      return ok();
    });

    const result = await validateBranchInSyncWithRemote('main', 'origin', '/repo', git);
    expect(result.inSync).toBe(true);
  });

  test('local behind remote (ancestor) returns inSync:true', async () => {
    const git = mockGit(async (args) => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'rev-parse' && args[1] === 'main') return ok('aaa111');
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return ok('bbb222');
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return ok();
      return ok();
    });

    const result = await validateBranchInSyncWithRemote('main', 'origin', '/repo', git);
    expect(result.inSync).toBe(true);
  });

  test('local diverged from remote returns inSync:false', async () => {
    const git = mockGit(async (args) => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'rev-parse' && args[1] === 'main') return ok('aaa111');
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return ok('bbb222');
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return fail('not ancestor');
      return ok();
    });

    const result = await validateBranchInSyncWithRemote('main', 'origin', '/repo', git);

    expect(result.inSync).toBe(false);
    expect(result.error).toContain('diverged');
  });
});
