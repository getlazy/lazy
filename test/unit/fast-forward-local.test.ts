import { describe, test, expect } from 'bun:test';
import { GitHubDriver } from '../../src/remote/github-driver';
import { GitLabDriver } from '../../src/remote/gitlab-driver';
import type { ResolvedConfig } from '../../src/config/types';
import type { DriverDeps, GhResult } from '../../src/remote/github-driver';
import type { GitLabDriverDeps, GlResult } from '../../src/remote/gitlab-driver';

/**
 * Unit tests for fastForwardLocal on both GitHub and GitLab drivers.
 *
 * These tests verify that the checked-out branch path correctly disambiguates
 * between true divergence and transient failures (dirty working tree, lock file, etc.)
 * instead of always reporting "diverged" on any ff-only failure.
 */

const githubConfig: ResolvedConfig = {
  models: { default: 'sonnet' as const },
  session: { verbose: false, debug: false, auto_commit_instructions: false },
  data: { path: '/tmp/test/.lazy' },
  storage: {
    backend: 'external',
    external_path: '',
    postgres_ssl: false,
  },
  git: { default_branch_prefix: 'lazy' },
  output: { shortid_length: 8 },
  agent: { agent_id: 'test-agent', watchdog_output_timeout_ms: 0 },
  server: { port: 3000, sync_interval: 1000 },
  remote: {
    driver: 'github',
    git_remote: 'origin',
    github_auto_push: true,
    github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: false,
    gitlab_auto_push: true,
    gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: false,
  },
  docker: { dockerfile: '', toolchain: '' },
  runner: { type: 'docker' as const, docker_agent_no_network: false },
  documents: { path: '' },
  features: {},
  worktree: { include: [] },
  permissions: { protected: [] },
};

const gitlabConfig: ResolvedConfig = {
  ...githubConfig,
  remote: { ...githubConfig.remote, driver: 'gitlab' },
};

const ok = (stdout = ''): GhResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'error'): GhResult => ({ stdout: '', stderr, exitCode: 1 });

/**
 * Build DriverDeps for GitHubDriver that simulates the checked-out branch path.
 * gitHandler maps git command arrays to results.
 */
function makeGitHubDeps(gitHandler: (args: string[], cwd?: string) => GhResult): DriverDeps {
  return {
    runGh: () => fail('unexpected gh call'),
    runGit: gitHandler,
  };
}

/**
 * Build GitLabDriverDeps that simulates the checked-out branch path.
 */
function makeGitLabDeps(gitHandler: (args: string[], cwd?: string) => GlResult): GitLabDriverDeps {
  return {
    runGl: () => fail('unexpected glab call') as GlResult,
    runGit: gitHandler,
  };
}

// INVARIANT: ff-only failure due to dirty working tree should NOT report divergence.
// When local is an ancestor of remote (not diverged), the warning should describe the
// actual git error, not claim "diverged". This prevents false positives that cause
// accept to fail even though the remote merge already landed.
describe('fastForwardLocal — checked-out branch disambiguation', () => {
  describe('GitHubDriver', () => {
    test('ff-only failure due to dirty working tree does NOT report divergence', async () => {
      const deps = makeGitHubDeps((args) => {
        // HEAD check: target branch is checked out
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('main');
        // fetch succeeds
        if (args[0] === 'fetch') return ok();
        // merge --ff-only fails due to dirty working tree
        if (args[0] === 'merge' && args.includes('--ff-only')) {
          return fail('error: Your local changes to the following files would be overwritten by merge:\n\tfile.txt\nPlease commit your changes or stash them before you merge.');
        }
        // rev-parse for local/remote SHAs
        if (args[0] === 'rev-parse' && args[1] === 'main') return ok('aaa111');
        if (args[0] === 'rev-parse' && args[1] === 'origin/main') return ok('bbb222');
        // merge-base --is-ancestor: local IS ancestor of remote (not diverged)
        if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return ok();
        return fail('unexpected git call: ' + args.join(' '));
      });

      const driver = new GitHubDriver(githubConfig, deps);
      const result = await driver.fastForwardLocal('main', '/tmp/test');

      expect(result.success).toBe(false);
      expect(result.warning).toBeDefined();
      // Should NOT say "diverged"
      expect(result.warning).not.toContain('diverged');
      // Should contain the actual error
      expect(result.warning).toContain('local changes');
    });

    // INVARIANT: True divergence (local has commits not in remote) should still
    // report "diverged" — the merge-base check confirms it.
    test('ff-only failure due to true divergence reports divergence', async () => {
      const deps = makeGitHubDeps((args) => {
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('main');
        if (args[0] === 'fetch') return ok();
        if (args[0] === 'merge' && args.includes('--ff-only')) {
          return fail('fatal: Not possible to fast-forward, aborting.');
        }
        if (args[0] === 'rev-parse' && args[1] === 'main') return ok('aaa111');
        if (args[0] === 'rev-parse' && args[1] === 'origin/main') return ok('bbb222');
        // merge-base --is-ancestor: local is NOT ancestor (truly diverged)
        if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return fail('not ancestor');
        return fail('unexpected git call: ' + args.join(' '));
      });

      const driver = new GitHubDriver(githubConfig, deps);
      const result = await driver.fastForwardLocal('main', '/tmp/test');

      expect(result.success).toBe(false);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('diverged');
    });

    // INVARIANT: Fetch failure should report the fetch error, not claim "diverged".
    // Network errors, auth failures, and lock files are not divergence.
    test('fetch failure reports fetch error, not divergence', async () => {
      const deps = makeGitHubDeps((args) => {
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('main');
        if (args[0] === 'fetch') return fail('fatal: unable to access \'https://github.com/o/r.git/\': Could not resolve host: github.com');
        return fail('unexpected git call: ' + args.join(' '));
      });

      const driver = new GitHubDriver(githubConfig, deps);
      const result = await driver.fastForwardLocal('main', '/tmp/test');

      expect(result.success).toBe(false);
      expect(result.warning).toBeDefined();
      // Should NOT say "diverged"
      expect(result.warning).not.toContain('diverged');
      // Should mention fetch failure
      expect(result.warning).toContain('Failed to fetch');
      expect(result.warning).toContain('Could not resolve host');
    });

    test('successful ff-only merge returns success', async () => {
      const deps = makeGitHubDeps((args) => {
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('main');
        if (args[0] === 'fetch') return ok();
        if (args[0] === 'merge' && args.includes('--ff-only')) return ok('Updating aaa111..bbb222');
        return fail('unexpected git call: ' + args.join(' '));
      });

      const driver = new GitHubDriver(githubConfig, deps);
      const result = await driver.fastForwardLocal('main', '/tmp/test');

      expect(result.success).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    test('already up to date returns success', async () => {
      const deps = makeGitHubDeps((args) => {
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('main');
        if (args[0] === 'fetch') return ok();
        if (args[0] === 'merge' && args.includes('--ff-only')) {
          return { stdout: 'Already up to date.', stderr: '', exitCode: 1 };
        }
        return fail('unexpected git call: ' + args.join(' '));
      });

      const driver = new GitHubDriver(githubConfig, deps);
      const result = await driver.fastForwardLocal('main', '/tmp/test');

      expect(result.success).toBe(true);
    });
  });

  describe('GitLabDriver', () => {
    test('ff-only failure due to dirty working tree does NOT report divergence', async () => {
      const deps = makeGitLabDeps((args) => {
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('main');
        if (args[0] === 'fetch') return ok();
        if (args[0] === 'merge' && args.includes('--ff-only')) {
          return fail('error: Your local changes to the following files would be overwritten by merge:\n\tfile.txt\nPlease commit your changes or stash them before you merge.');
        }
        if (args[0] === 'rev-parse' && args[1] === 'main') return ok('aaa111');
        if (args[0] === 'rev-parse' && args[1] === 'origin/main') return ok('bbb222');
        if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return ok();
        return fail('unexpected git call: ' + args.join(' '));
      });

      const driver = new GitLabDriver(gitlabConfig, deps);
      const result = await driver.fastForwardLocal('main', '/tmp/test');

      expect(result.success).toBe(false);
      expect(result.warning).toBeDefined();
      expect(result.warning).not.toContain('diverged');
      expect(result.warning).toContain('local changes');
    });

    test('ff-only failure due to true divergence reports divergence', async () => {
      const deps = makeGitLabDeps((args) => {
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('main');
        if (args[0] === 'fetch') return ok();
        if (args[0] === 'merge' && args.includes('--ff-only')) {
          return fail('fatal: Not possible to fast-forward, aborting.');
        }
        if (args[0] === 'rev-parse' && args[1] === 'main') return ok('aaa111');
        if (args[0] === 'rev-parse' && args[1] === 'origin/main') return ok('bbb222');
        if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return fail('not ancestor');
        return fail('unexpected git call: ' + args.join(' '));
      });

      const driver = new GitLabDriver(gitlabConfig, deps);
      const result = await driver.fastForwardLocal('main', '/tmp/test');

      expect(result.success).toBe(false);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('diverged');
    });

    test('fetch failure reports fetch error, not divergence', async () => {
      const deps = makeGitLabDeps((args) => {
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('main');
        if (args[0] === 'fetch') return fail('fatal: unable to access \'https://gitlab.com/o/r.git/\': Could not resolve host: gitlab.com');
        return fail('unexpected git call: ' + args.join(' '));
      });

      const driver = new GitLabDriver(gitlabConfig, deps);
      const result = await driver.fastForwardLocal('main', '/tmp/test');

      expect(result.success).toBe(false);
      expect(result.warning).toBeDefined();
      expect(result.warning).not.toContain('diverged');
      expect(result.warning).toContain('Failed to fetch');
      expect(result.warning).toContain('Could not resolve host');
    });
  });
});
