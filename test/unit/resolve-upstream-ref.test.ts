import { describe, test, expect } from 'bun:test';
import { GitHubDriver } from '../../src/remote/github-driver';
import { GitLabDriver } from '../../src/remote/gitlab-driver';
import { LocalDriver } from '../../src/remote/local-driver';
import type { ResolvedConfig } from '../../src/config/types';
import type { DriverDeps, GhResult } from '../../src/remote/github-driver';
import type { GitLabDriverDeps, GlResult } from '../../src/remote/gitlab-driver';

/**
 * Unit tests for resolveUpstreamRef behavior across all drivers.
 *
 * INVARIANT: resolveUpstreamRef must fetch the remote before returning a ref.
 * The supervisor runs in a container with no network access — it can only merge
 * refs the host has already fetched. If the fetch fails, resolveUpstreamRef must
 * throw so the caller can warn loudly (not silently use a stale local ref).
 */

// Minimal config for testing
const mockConfig: ResolvedConfig = {
  models: { default: 'claude-sonnet-4-5-20250929', roles: { builder: { backend: 'anthropic', model: '', endpoint: '' }, agent: { backend: 'anthropic', model: '', endpoint: '' } } },
  session: { verbose: false, debug: false, auto_commit_instructions: false },
  data: { path: '/tmp/test/.lazy' },
  storage: { backend: 'external', external_path: '', postgres_ssl: false },
  git: { default_branch_prefix: 'lazy' },
  output: { shortid_length: 8 },
  agent: { agent_id: 'test-agent', watchdog_output_timeout_ms: 0, graceful_exit_timeout_ms: 0, effort: 'medium' },
  builder: { effort: 'high' },
  chattiness: { default: '', builder: '', agent: '' },
  server: { port: 3000, sync_interval: 1000, bind: '127.0.0.1' },
  remote: {
    driver: 'github',
    git_remote: 'origin',
    auto_approve: false,
    github_auto_push: true,
    github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: false,
    gitlab_auto_push: true,
    gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: false,
  },
  docker: { dockerfile: '' },
  runner: { type: 'docker' as const },
  documents: { path: '' },
  features: {},
  worktree: { include: [] },
  permissions: { protected: [] },
  automation: { maintain: [] },
  checks: { post_turn: '', post_turn_timeout: 300 },
  ollama: { enabled: false, model: '', endpoint: 'http://host.docker.internal:11434' },
  daemon: {
    auto_react_ci: true,
    auto_react_comments: true,
    auto_react_max_retries: 3,
    auto_react_backoff: 'exponential' as const,
    auto_react_daily_budget: 50,
    max_auto_turns: 3,
  },
};

describe('resolveUpstreamRef', () => {
  describe('GitHubDriver', () => {
    // INVARIANT: resolveUpstreamRef must throw on fetch failure so the caller
    // can warn loudly. Silent fallback to local ref causes stale merges.
    test('throws on fetch failure instead of silently falling back', async () => {
      const mockDeps: DriverDeps = {
        runGh: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        runGit: async (args: string[]) => {
          if (args[0] === 'fetch') {
            return {
              stdout: '',
              stderr: 'fatal: could not read from remote repository',
              exitCode: 128,
            };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };

      const driver = new GitHubDriver(mockConfig, mockDeps);
      await expect(driver.resolveUpstreamRef('main', '/tmp/worktree')).rejects.toThrow(
        'Failed to fetch origin/main from origin',
      );
    });

    test('returns remote ref on successful fetch', async () => {
      const mockDeps: DriverDeps = {
        runGh: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        runGit: async (args: string[]) => {
          if (args[0] === 'fetch') {
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };

      const driver = new GitHubDriver(mockConfig, mockDeps);
      const ref = await driver.resolveUpstreamRef('main', '/tmp/worktree');
      expect(ref).toBe('origin/main');
    });

    test('uses configured remote name, not hardcoded origin', async () => {
      let fetchedRemote: string | undefined;
      const customConfig = {
        ...mockConfig,
        remote: { ...mockConfig.remote, git_remote: 'upstream' },
      };

      const mockDeps: DriverDeps = {
        runGh: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        runGit: async (args: string[]) => {
          if (args[0] === 'fetch') {
            fetchedRemote = args[1]; // capture which remote was fetched
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };

      const driver = new GitHubDriver(customConfig, mockDeps);
      const ref = await driver.resolveUpstreamRef('main', '/tmp/worktree');
      expect(fetchedRemote).toBe('upstream');
      expect(ref).toBe('upstream/main');
    });
  });

  describe('GitLabDriver', () => {
    const gitlabConfig = {
      ...mockConfig,
      remote: { ...mockConfig.remote, driver: 'gitlab' as const },
    };

    // INVARIANT: Same as GitHub — must throw on fetch failure.
    test('throws on fetch failure instead of silently falling back', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        runGit: async (args: string[]) => {
          if (args[0] === 'fetch') {
            return {
              stdout: '',
              stderr: 'fatal: could not read from remote repository',
              exitCode: 128,
            };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };

      const driver = new GitLabDriver(gitlabConfig, mockDeps);
      await expect(driver.resolveUpstreamRef('main', '/tmp/worktree')).rejects.toThrow(
        'Failed to fetch origin/main from origin',
      );
    });

    test('returns remote ref on successful fetch', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        runGit: async (args: string[]) => {
          if (args[0] === 'fetch') {
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };

      const driver = new GitLabDriver(gitlabConfig, mockDeps);
      const ref = await driver.resolveUpstreamRef('main', '/tmp/worktree');
      expect(ref).toBe('origin/main');
    });
  });

  describe('LocalDriver', () => {
    // INVARIANT: Local driver has no remote — resolveUpstreamRef returns
    // the branch name as-is without attempting any fetch.
    test('returns local branch name without error', async () => {
      const driver = new LocalDriver();
      const ref = await driver.resolveUpstreamRef('main', '/tmp/worktree');
      expect(ref).toBe('main');
    });
  });

  describe('no silent stale/local fallback (sync merges the LIVE remote)', () => {
    // INVARIANT: Sync's entire job is to deliver the LIVE remote upstream into a
    // task branch. A remote driver must resolve to the remote-tracking ref
    // (`<remote>/<branch>`), NEVER a bare local branch name — merging the local
    // branch silently drops upstream changes and lets accepts fail later with
    // "MR has merge conflicts" that no local sync surfaced. Two guarantees the
    // callers (launchTask, syncTask) depend on:
    //   1. On success the resolved ref is the remote-tracking form (live).
    //   2. On fetch failure the driver THROWS — callers must propagate, not
    //      swallow into a stale local ref. This guards the regression where
    //      launchTask had an empty `catch {}` that fell back to the local
    //      branch name (a stale/local-ref merge); per CLAUDE.md "fail hard on
    //      remote failures — no silent fallbacks" that fallback is forbidden
    //      unless the caller explicitly opted into --force-local.
    test('GitLab: success resolves remote-tracking ref, not the local branch', async () => {
      const gitlabConfig = {
        ...mockConfig,
        remote: { ...mockConfig.remote, driver: 'gitlab' as const },
      };
      const driver = new GitLabDriver(gitlabConfig, {
        runGl: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        runGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      });
      const ref = await driver.resolveUpstreamRef('lazy/release-v017', '/tmp/worktree');
      // The merge target must be the remote-tracking ref so the pinned SHA
      // reflects the live remote, not whatever the local branch happens to be.
      expect(ref).toBe('origin/lazy/release-v017');
      expect(ref).not.toBe('lazy/release-v017');
    });

    test('GitLab: fetch failure throws (so callers cannot silently use a stale local ref)', async () => {
      const gitlabConfig = {
        ...mockConfig,
        remote: { ...mockConfig.remote, driver: 'gitlab' as const },
      };
      const driver = new GitLabDriver(gitlabConfig, {
        runGl: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        runGit: async (args: string[]) =>
          args[0] === 'fetch'
            ? { stdout: '', stderr: 'fatal: could not read from remote', exitCode: 128 }
            : { stdout: '', stderr: '', exitCode: 0 },
      });
      await expect(
        driver.resolveUpstreamRef('lazy/release-v017', '/tmp/worktree'),
      ).rejects.toThrow(/Failed to fetch/);
    });
  });
});
