import { describe, test, expect } from 'bun:test';
import { validateBranchInSyncWithRemote } from '../../src/utils/git';
import type { GitResult } from '../../src/utils/git';

/**
 * Unit tests for validateBranchInSyncWithRemote.
 *
 * INVARIANT: Before accepting a root task with a remote driver, local main
 * must be in sync with the driver's configured remote. If local has diverged
 * (has commits not in remote), accept must fail BEFORE the remote merge —
 * otherwise the remote merge succeeds but the post-merge fast-forward fails,
 * leaving the task in a half-accepted state.
 *
 * Only the driver's configured remote is checked — not all git remotes.
 * Users may have other remotes (heroku, personal forks) that are irrelevant.
 */

const ok = (stdout = ''): GitResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'error'): GitResult => ({ stdout: '', stderr, exitCode: 1 });

describe('validateBranchInSyncWithRemote', () => {
  // INVARIANT: When local and remote are at the same SHA, the branch is in sync.
  test('returns inSync when local and remote SHAs match', async () => {
    const git = async (args: string[]): Promise<GitResult> => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'rev-parse' && args[1] === 'main') return ok('aaa111');
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return ok('aaa111');
      return fail('unexpected: ' + args.join(' '));
    };

    const result = await validateBranchInSyncWithRemote('main', 'origin', '/tmp/test', git);
    expect(result.inSync).toBe(true);
  });

  // INVARIANT: When local is behind remote (can fast-forward), this is fine.
  // The fast-forward after merge will succeed.
  test('returns inSync when local is behind remote (can fast-forward)', async () => {
    const git = async (args: string[]): Promise<GitResult> => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'rev-parse' && args[1] === 'main') return ok('aaa111');
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return ok('bbb222');
      // local IS ancestor of remote — local is behind
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return ok();
      return fail('unexpected: ' + args.join(' '));
    };

    const result = await validateBranchInSyncWithRemote('main', 'origin', '/tmp/test', git);
    expect(result.inSync).toBe(true);
  });

  // INVARIANT: When local is ahead of remote (has unpushed commits), this is fine.
  // Local has everything remote has plus more — the post-merge fast-forward will succeed.
  test('returns inSync when local is ahead of remote (unpushed commits)', async () => {
    const git = async (args: string[]): Promise<GitResult> => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'rev-parse' && args[1] === 'main') return ok('aaa111');
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return ok('bbb222');
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        // First call: is local ancestor of remote? No — local is not behind
        if (args[2] === 'aaa111' && args[3] === 'bbb222') return fail();
        // Second call: is remote ancestor of local? Yes — local is ahead
        if (args[2] === 'bbb222' && args[3] === 'aaa111') return ok();
      }
      return fail('unexpected: ' + args.join(' '));
    };

    const result = await validateBranchInSyncWithRemote('main', 'origin', '/tmp/test', git);
    expect(result.inSync).toBe(true);
  });

  // INVARIANT: When local has truly diverged from remote (both sides have commits
  // the other doesn't), must fail before the remote merge happens.
  test('returns not inSync when local has truly diverged from remote', async () => {
    const git = async (args: string[]): Promise<GitResult> => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'rev-parse' && args[1] === 'main') return ok('aaa111');
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return ok('bbb222');
      // Neither is ancestor of the other — true divergence
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return fail();
      return fail('unexpected: ' + args.join(' '));
    };

    const result = await validateBranchInSyncWithRemote('main', 'origin', '/tmp/test', git);
    expect(result.inSync).toBe(false);
    expect(result.error).toContain('diverged');
    expect(result.error).toContain('origin/main');
    expect(result.error).toContain('Reconcile');
  });

  // INVARIANT: If the remote can't be fetched (network issue, branch doesn't exist),
  // fail hard — no silent fallback. Proceeding without verification risks a
  // half-accepted state where the remote merge succeeds but local diverges.
  test('returns not inSync when fetch fails (fail hard)', async () => {
    const git = async (args: string[]): Promise<GitResult> => {
      if (args[0] === 'fetch') return fail('Could not resolve host');
      return fail('unexpected: ' + args.join(' '));
    };

    const result = await validateBranchInSyncWithRemote('main', 'origin', '/tmp/test', git);
    expect(result.inSync).toBe(false);
    expect(result.error).toContain('Failed to fetch');
    expect(result.error).toContain('Could not resolve host');
  });

  // INVARIANT: Works with non-main target branches (e.g., release branches).
  test('works with non-main target branches', async () => {
    const git = async (args: string[]): Promise<GitResult> => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'rev-parse' && args[1] === 'release-v1') return ok('aaa111');
      if (args[0] === 'rev-parse' && args[1] === 'origin/release-v1') return ok('bbb222');
      // Neither is ancestor of the other — true divergence
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return fail();
      return fail('unexpected: ' + args.join(' '));
    };

    const result = await validateBranchInSyncWithRemote('release-v1', 'origin', '/tmp/test', git);
    expect(result.inSync).toBe(false);
    expect(result.error).toContain('release-v1');
    expect(result.error).toContain('origin/release-v1');
  });

  // INVARIANT: Works with non-default remote names (e.g., 'upstream', 'gitlab').
  test('uses the provided remote name, not hardcoded origin', async () => {
    const git = async (args: string[]): Promise<GitResult> => {
      if (args[0] === 'fetch' && args[1] === 'upstream') return ok();
      if (args[0] === 'rev-parse' && args[1] === 'main') return ok('aaa111');
      if (args[0] === 'rev-parse' && args[1] === 'upstream/main') return ok('bbb222');
      // Neither is ancestor of the other — true divergence
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return fail();
      return fail('unexpected: ' + args.join(' '));
    };

    const result = await validateBranchInSyncWithRemote('main', 'upstream', '/tmp/test', git);
    expect(result.inSync).toBe(false);
    expect(result.error).toContain('upstream/main');
  });

  // INVARIANT: If rev-parse fails for either ref, fail hard — can't verify
  // means can't proceed safely.
  test('returns not inSync when rev-parse fails (fail hard)', async () => {
    const git = async (args: string[]): Promise<GitResult> => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'rev-parse') return fail('unknown revision');
      return fail('unexpected: ' + args.join(' '));
    };

    const result = await validateBranchInSyncWithRemote('main', 'origin', '/tmp/test', git);
    expect(result.inSync).toBe(false);
    expect(result.error).toContain('Failed to resolve refs');
  });
});
