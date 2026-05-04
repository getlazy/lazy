import { describe, test, expect } from 'bun:test';
import { GitHubDriver } from '../../src/remote/github-driver';
import { GitLabDriver } from '../../src/remote/gitlab-driver';
import { DEFAULT_CONFIG, getDefaultConfigTemplate } from '../../src/config/loader';
import type { ResolvedConfig } from '../../src/config/types';
import type { DriverDeps } from '../../src/remote/github-driver';
import type { GitLabDriverDeps, GlResult } from '../../src/remote/gitlab-driver';

/**
 * Tests that the configurable git_remote setting is threaded through
 * all git operations in both drivers. When git_remote is set to a
 * non-default value (e.g., 'upstream'), drivers must use that remote
 * name instead of 'origin' in all git commands.
 */

// INVARIANT: All git remote operations must use the configured git_remote
// name, not a hardcoded 'origin'. Users may have non-standard remote names
// (e.g., 'upstream', 'gitlab', 'github') and lazy must respect that.

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'error') => ({ stdout: '', stderr, exitCode: 1 });

function makeConfig(gitRemote: string, driver: 'github' | 'gitlab' = 'github'): ResolvedConfig {
  return {
    ...DEFAULT_CONFIG,
    remote: {
      ...DEFAULT_CONFIG.remote,
      driver,
      git_remote: gitRemote,
    },
  };
}

describe('configurable git_remote', () => {
  describe('GitHubDriver uses configured remote name', () => {
    test('pushBranch uses configured remote', async () => {
      const gitCalls: string[][] = [];
      const deps: DriverDeps = {
        runGh: async () => ok(),
        runGit: async (args) => {
          gitCalls.push([...args]);
          return ok();
        },
      };

      const driver = new GitHubDriver(makeConfig('upstream'), deps);
      await driver.pushBranch('lazy/test');

      const pushCall = gitCalls.find(c => c[0] === 'push');
      expect(pushCall).toBeDefined();
      // INVARIANT: Task branches must not set upstream tracking (-u flag)
      expect(pushCall).not.toContain('-u');
      expect(pushCall![1]).toBe('upstream');
      expect(pushCall![2]).toBe('lazy/test');
    });

    test('fetchBranch uses configured remote', async () => {
      const gitCalls: string[][] = [];
      const deps: DriverDeps = {
        runGh: async () => ok(),
        runGit: async (args) => {
          gitCalls.push([...args]);
          if (args[0] === 'fetch') return ok();
          if (args[0] === 'rev-list') return ok('3');
          return fail('unexpected');
        },
      };

      const driver = new GitHubDriver(makeConfig('upstream'), deps);
      const result = await driver.fetchBranch('lazy/test', '/tmp/worktree');

      expect(result).toBe(true);
      const fetchCall = gitCalls.find(c => c[0] === 'fetch');
      expect(fetchCall).toBeDefined();
      expect(fetchCall![1]).toBe('upstream');
      expect(fetchCall![2]).toBe('lazy/test');

      // rev-list should compare against upstream/<branch>
      const revListCall = gitCalls.find(c => c[0] === 'rev-list');
      expect(revListCall).toBeDefined();
      expect(revListCall![2]).toBe('HEAD..upstream/lazy/test');
    });

    test('resolveUpstreamRef uses configured remote', async () => {
      const gitCalls: string[][] = [];
      const deps: DriverDeps = {
        runGh: async () => ok(),
        runGit: async (args) => {
          gitCalls.push([...args]);
          if (args[0] === 'fetch') return ok();
          return fail('unexpected');
        },
      };

      const driver = new GitHubDriver(makeConfig('upstream'), deps);
      const ref = await driver.resolveUpstreamRef('main', '/tmp/worktree');

      expect(ref).toBe('upstream/main');
      const fetchCall = gitCalls.find(c => c[0] === 'fetch');
      expect(fetchCall![1]).toBe('upstream');
    });

    test('checkHealth checks configured remote', async () => {
      const gitCalls: string[][] = [];
      const deps: DriverDeps = {
        runGh: async (args) => {
          if (args[0] === '--version') return ok('gh version 2.0.0');
          if (args[0] === 'auth' && args[1] === 'status') return ok('Logged in');
          if (args[0] === 'api') return ok(JSON.stringify({ private: true }));
          return fail('unexpected');
        },
        runGit: async (args) => {
          gitCalls.push([...args]);
          if (args[0] === 'remote' && args[1] === 'get-url') return ok('git@github.com:owner/repo.git');
          return fail('unexpected');
        },
      };

      const driver = new GitHubDriver(makeConfig('upstream'), deps);
      const checks = await driver.checkHealth();

      // Should have checked the 'upstream' remote, not 'origin'
      const remoteGetUrlCall = gitCalls.find(c => c[0] === 'remote' && c[1] === 'get-url');
      expect(remoteGetUrlCall).toBeDefined();
      expect(remoteGetUrlCall![2]).toBe('upstream');

      // The health check result should mention 'upstream'
      const remoteCheck = checks.find(c => c.what.includes('upstream'));
      expect(remoteCheck).toBeDefined();
      expect(remoteCheck!.state).toBe('ok');
    });

    test('fastForwardLocal uses configured remote (target branch checked out)', async () => {
      const gitCalls: string[][] = [];
      const deps: DriverDeps = {
        runGh: async () => ok(),
        runGit: async (args) => {
          gitCalls.push([...args]);
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('main');
          if (args[0] === 'fetch' && args[1] === 'upstream') return ok();
          if (args[0] === 'merge' && args[1] === '--ff-only') return ok();
          return fail('unexpected');
        },
      };

      const driver = new GitHubDriver(makeConfig('upstream'), deps);
      const result = await driver.fastForwardLocal('main', '/tmp/repo');

      expect(result.success).toBe(true);

      const fetchCall = gitCalls.find(c => c[0] === 'fetch');
      expect(fetchCall![1]).toBe('upstream');

      const mergeCall = gitCalls.find(c => c[0] === 'merge');
      expect(mergeCall![2]).toBe('upstream/main');
    });

    test('fastForwardLocal uses configured remote (target branch not checked out)', async () => {
      const gitCalls: string[][] = [];
      const deps: DriverDeps = {
        runGh: async () => ok(),
        runGit: async (args) => {
          gitCalls.push([...args]);
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('lazy/abc12345');
          if (args[0] === 'fetch' && args[1] === 'upstream') return ok();
          return fail('unexpected');
        },
      };

      const driver = new GitHubDriver(makeConfig('upstream'), deps);
      const result = await driver.fastForwardLocal('main', '/tmp/repo');

      expect(result.success).toBe(true);

      const fetchCall = gitCalls.find(c => c[0] === 'fetch');
      expect(fetchCall![1]).toBe('upstream');
      expect(fetchCall![2]).toBe('main:main');
    });
  });

  describe('GitLabDriver uses configured remote name', () => {
    test('pushBranch uses configured remote', async () => {
      const gitCalls: string[][] = [];
      const deps: GitLabDriverDeps = {
        runGl: async () => ok(),
        runGit: async (args) => {
          gitCalls.push([...args]);
          return ok();
        },
      };

      const driver = new GitLabDriver(makeConfig('gitlab-remote', 'gitlab'), deps);
      await driver.pushBranch('lazy/test');

      const pushCall = gitCalls.find(c => c[0] === 'push');
      expect(pushCall).toBeDefined();
      // INVARIANT: Task branches must not set upstream tracking (-u flag)
      expect(pushCall).not.toContain('-u');
      expect(pushCall![1]).toBe('gitlab-remote');
      expect(pushCall![2]).toBe('lazy/test');
    });

    test('fetchBranch uses configured remote', async () => {
      const gitCalls: string[][] = [];
      const deps: GitLabDriverDeps = {
        runGl: async () => ok(),
        runGit: async (args) => {
          gitCalls.push([...args]);
          if (args[0] === 'fetch') return ok();
          if (args[0] === 'rev-list') return ok('2');
          return fail('unexpected');
        },
      };

      const driver = new GitLabDriver(makeConfig('gitlab-remote', 'gitlab'), deps);
      const result = await driver.fetchBranch('lazy/test', '/tmp/worktree');

      expect(result).toBe(true);
      const fetchCall = gitCalls.find(c => c[0] === 'fetch');
      expect(fetchCall![1]).toBe('gitlab-remote');

      const revListCall = gitCalls.find(c => c[0] === 'rev-list');
      expect(revListCall![2]).toBe('HEAD..gitlab-remote/lazy/test');
    });

    test('resolveUpstreamRef uses configured remote', async () => {
      const deps: GitLabDriverDeps = {
        runGl: async () => ok(),
        runGit: async (args) => {
          if (args[0] === 'fetch') return ok();
          return fail('unexpected');
        },
      };

      const driver = new GitLabDriver(makeConfig('gitlab-remote', 'gitlab'), deps);
      const ref = await driver.resolveUpstreamRef('main', '/tmp/worktree');

      expect(ref).toBe('gitlab-remote/main');
    });

    test('checkHealth checks configured remote', async () => {
      const gitCalls: string[][] = [];
      const deps: GitLabDriverDeps = {
        runGl: async (args) => {
          if (args[0] === '--version') return ok('glab version 1.0.0');
          if (args[0] === 'auth' && args[1] === 'status') return ok('Token scopes: api');
          if (args[0] === 'api' && args[1] === 'projects/:id') return ok(JSON.stringify({ visibility: 'private' }));
          return fail('unexpected');
        },
        runGit: async (args) => {
          gitCalls.push([...args]);
          if (args[0] === 'remote' && args[1] === 'get-url') return ok('git@gitlab.com:owner/repo.git');
          return fail('unexpected');
        },
      };

      const driver = new GitLabDriver(makeConfig('gitlab-remote', 'gitlab'), deps);
      const checks = await driver.checkHealth();

      const remoteGetUrlCall = gitCalls.find(c => c[0] === 'remote' && c[1] === 'get-url');
      expect(remoteGetUrlCall![2]).toBe('gitlab-remote');

      const remoteCheck = checks.find(c => c.what.includes('gitlab-remote'));
      expect(remoteCheck).toBeDefined();
      expect(remoteCheck!.state).toBe('ok');
    });

    test('fastForwardLocal uses configured remote', async () => {
      const gitCalls: string[][] = [];
      const deps: GitLabDriverDeps = {
        runGl: async () => ok(),
        runGit: async (args) => {
          gitCalls.push([...args]);
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('main');
          if (args[0] === 'fetch') return ok();
          if (args[0] === 'merge' && args[1] === '--ff-only') return ok();
          return fail('unexpected');
        },
      };

      const driver = new GitLabDriver(makeConfig('gitlab-remote', 'gitlab'), deps);
      const result = await driver.fastForwardLocal('main', '/tmp/repo');

      expect(result.success).toBe(true);
      const mergeCall = gitCalls.find(c => c[0] === 'merge');
      expect(mergeCall![2]).toBe('gitlab-remote/main');
    });
  });

  describe('default config uses origin', () => {
    // INVARIANT: The default git_remote is 'origin' so existing setups
    // continue to work without any config change.
    test('DEFAULT_CONFIG has git_remote set to origin', () => {
      expect(DEFAULT_CONFIG.remote.git_remote).toBe('origin');
    });

    test('drivers use origin by default', async () => {
      const gitCalls: string[][] = [];
      const deps: DriverDeps = {
        runGh: async () => ok(),
        runGit: async (args) => {
          gitCalls.push([...args]);
          return ok();
        },
      };

      const driver = new GitHubDriver(makeConfig('origin'), deps);
      await driver.pushBranch('lazy/test');

      const pushCall = gitCalls.find(c => c[0] === 'push');
      // INVARIANT: Task branches must not set upstream tracking (-u flag)
      expect(pushCall).not.toContain('-u');
      expect(pushCall![1]).toBe('origin');
      expect(pushCall![2]).toBe('lazy/test');
    });
  });

  describe('config template includes git_remote', () => {
    // INVARIANT: When git_remote is non-default, the config template
    // should include it as an uncommented setting so it's persisted.
    test('template comments out git_remote when it is origin (default)', () => {
      const template = getDefaultConfigTemplate('external', undefined, 'origin');
      expect(template).toContain('# git_remote = "origin"');
      // Should NOT have an uncommented git_remote line
      expect(template).not.toMatch(/^git_remote = /m);
    });

    test('template uncomments git_remote when it is not origin', () => {
      const template = getDefaultConfigTemplate('external', undefined, 'upstream');
      expect(template).toContain('git_remote = "upstream"');
      // Should NOT have the commented-out default
      expect(template).not.toContain('# git_remote = "origin"');
    });

    test('template defaults to commented origin when gitRemote is omitted', () => {
      const template = getDefaultConfigTemplate('external', undefined);
      expect(template).toContain('# git_remote = "origin"');
    });
  });
});
