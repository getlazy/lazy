import { describe, test, expect } from 'bun:test';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import { GitHubDriver } from '../../src/remote/github-driver';
import type { Task } from '../../src/types';
import type { ResolvedConfig } from '../../src/config/types';
import type { DriverDeps } from '../../src/remote/github-driver';

/**
 * Unit tests for GitHubDriver.waitForChecks().
 *
 * INVARIANT: waitForChecks polls CI check status via the RepositoryDriver
 * abstraction and returns when all checks complete (pass or fail), or on timeout.
 * This is the mechanism that allows `lazy accept --wait` to block on CI without
 * wasting an agent turn.
 */

describe('GitHubDriver waitForChecks', () => {
  const mockConfig: ResolvedConfig = {
    models: { default: 'claude-sonnet-4-5-20250929', roles: { builder: { backend: 'anthropic', model: '', endpoint: '' }, agent: { backend: 'anthropic', model: '', endpoint: '' } } },
    session: { verbose: false, debug: false, auto_commit_instructions: false },
    data: { path: '/tmp/test/.lazy' },
    storage: { backend: 'external', external_path: '', postgres_ssl: false },
    git: { default_branch_prefix: 'lazy', lfs_check: 'refuse' },
    output: { shortid_length: 8 },
    agent: { agent_id: 'test-agent', watchdog_output_timeout_ms: 0, wind_down_timeout_ms: 0, effort: 'medium' },
    builder: { effort: 'high' },
    chattiness: { default: '', builder: '', agent: '' },
    server: { port: 3000, sync_interval: 1000, bind: '127.0.0.1' },
    remote: {
      driver: 'github',
      git_remote: 'origin',
      auto_approve: false,
      offline: false,
      github_auto_push: true,
      github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: false,
      gitlab_auto_push: true,
      gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: false,
    },
    docker: { dockerfile: '' },
    runner: { type: 'docker' as const, permission_mode: 'sandbox' as const, sandbox_allowed_domains: ['*.anthropic.com'], sandbox_deny_read: [], sandbox_deny_write: [], sandbox_allow_weaker_nested: false },
    documents: { path: '' },
    features: {},
    worktree: { include: [] },
    permissions: { protected: [] },
    protection: { enabled: false, protected_branches: [], protected_tasks: [], gate_default_branch: true },
  automation: { maintain: [], pre_accept: { enabled: false, commands: [], timeout: 600 } },
  mounts: [],
    checks: { post_turn: '', post_turn_timeout: 300 },
    ollama: { enabled: false, model: '', endpoint: 'http://host.docker.internal:11434' },
    limits: { max_concurrent_agents: 8, max_concurrent_builders: 8, idle_grace_minutes: 10, max_turns_without_human: 10 },
    daemon: {
      auto_react_ci: true,
      auto_react_comments: true,
      auto_react_max_retries: 3,
      auto_react_backoff: 'exponential' as const,
      auto_react_daily_budget: 50,
      max_auto_turns: 3,
      auto_resume: true,
      auto_resume_interval_minutes: 30,
      auto_resume_gap_minutes: 5,
      auto_resume_max_attempts: 24,
    },
    memory: { warn_bytes: 4096 },
    docs: { url: 'https://docs.getlazy.dev' },
    proxy: DEFAULT_CONFIG.proxy,
  };

  const mockTask: Task = {
    id: 'test-task-123',
    code: 'test',
    goal: 'Test task',
    prompt: '',
    type: 'task',
    status: 'blocked',
    priority: 'normal',
    model: 'claude-sonnet-4-5-20250929',
    agent_id: 'claude-code',
    created_at: Date.now(),
    completed_at: null,
    target: { kind: 'branch' as const, branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    metadata: {
      github_remote_ref_id: '42',
    },
    runner_type: null,
    tags: [], pending_sync: 0,
  };

  // INVARIANT: When all checks pass, waitForChecks returns { passed: true }.
  test('returns passed when all checks succeed', async () => {
    const mockDeps: DriverDeps = {
      runGh: async (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'checks') {
          return {
            stdout: JSON.stringify([
              { name: 'typecheck', state: 'SUCCESS', bucket: 'pass', link: 'https://example.com/1' },
              { name: 'tests', state: 'SUCCESS', bucket: 'pass', link: 'https://example.com/2' },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const driver = new GitHubDriver(mockConfig, mockDeps);
    const result = await driver.waitForChecks(mockTask, { pollInterval: 10 });

    expect(result.passed).toBe(true);
  });

  // INVARIANT: When checks fail, waitForChecks returns { passed: false } with failed check details.
  test('returns failed checks when any check fails', async () => {
    const mockDeps: DriverDeps = {
      runGh: async (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'checks') {
          return {
            stdout: JSON.stringify([
              { name: 'typecheck', state: 'SUCCESS', bucket: 'pass', link: 'https://example.com/1' },
              { name: 'tests', state: 'FAILURE', bucket: 'fail', link: 'https://example.com/2' },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const driver = new GitHubDriver(mockConfig, mockDeps);
    const result = await driver.waitForChecks(mockTask, { pollInterval: 10 });

    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].name).toBe('tests');
      expect(result.failed[0].url).toBe('https://example.com/2');
    }
  });

  // INVARIANT: When no checks are configured, waitForChecks returns { passed: true }.
  test('returns passed when no checks are configured', async () => {
    const mockDeps: DriverDeps = {
      runGh: async (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'checks') {
          return {
            stdout: '[]',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const driver = new GitHubDriver(mockConfig, mockDeps);
    const result = await driver.waitForChecks(mockTask, { pollInterval: 10 });

    expect(result.passed).toBe(true);
  });

  // INVARIANT: waitForChecks returns { passed: true } when task has no PR number.
  test('returns passed when task has no PR number', async () => {
    const taskWithoutPR: Task = {
      ...mockTask,
      metadata: {},
    };

    const mockDeps: DriverDeps = {
      runGh: async () => ({ stdout: '', stderr: 'unexpected call', exitCode: 1 }),
      runGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const driver = new GitHubDriver(mockConfig, mockDeps);
    const result = await driver.waitForChecks(taskWithoutPR, { pollInterval: 10 });

    expect(result.passed).toBe(true);
  });

  // INVARIANT: waitForChecks polls until pending checks complete.
  test('polls until pending checks complete', async () => {
    let callCount = 0;

    const mockDeps: DriverDeps = {
      runGh: async (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'checks') {
          callCount++;
          if (callCount <= 2) {
            // First two polls: checks still pending
            return {
              stdout: JSON.stringify([
                { name: 'typecheck', state: 'IN_PROGRESS', bucket: 'pending' },
                { name: 'tests', state: 'QUEUED', bucket: 'pending' },
              ]),
              stderr: '',
              exitCode: 0,
            };
          }
          // Third poll: all pass
          return {
            stdout: JSON.stringify([
              { name: 'typecheck', state: 'SUCCESS', bucket: 'pass' },
              { name: 'tests', state: 'SUCCESS', bucket: 'pass' },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const driver = new GitHubDriver(mockConfig, mockDeps);
    const result = await driver.waitForChecks(mockTask, { pollInterval: 10 });

    expect(result.passed).toBe(true);
    expect(callCount).toBe(3);
  });

  // INVARIANT: waitForChecks times out and reports remaining pending checks.
  test('times out when checks stay pending', async () => {
    const mockDeps: DriverDeps = {
      runGh: async (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'checks') {
          return {
            stdout: JSON.stringify([
              { name: 'slow-check', state: 'IN_PROGRESS', bucket: 'pending', link: 'https://example.com/slow' },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const driver = new GitHubDriver(mockConfig, mockDeps);
    // Very short timeout to make the test fast
    const result = await driver.waitForChecks(mockTask, { timeout: 50, pollInterval: 10 });

    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.timedOut).toBe(true);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].name).toBe('slow-check');
    }
  });

  // INVARIANT: waitForChecks handles gh CLI failures gracefully (no checks found).
  test('returns passed when gh pr checks fails', async () => {
    const mockDeps: DriverDeps = {
      runGh: async (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'checks') {
          return {
            stdout: '',
            stderr: 'no checks reported',
            exitCode: 1,
          };
        }
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const driver = new GitHubDriver(mockConfig, mockDeps);
    const result = await driver.waitForChecks(mockTask, { pollInterval: 10 });

    expect(result.passed).toBe(true);
  });

  // INVARIANT: waitForChecks detects failure even when some checks pass.
  test('reports failure when some pass and some fail', async () => {
    const mockDeps: DriverDeps = {
      runGh: async (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'checks') {
          return {
            stdout: JSON.stringify([
              { name: 'typecheck', state: 'SUCCESS', bucket: 'pass' },
              { name: 'tests', state: 'FAILURE', bucket: 'fail', link: 'https://example.com/fail' },
              { name: 'lint', state: 'SUCCESS', bucket: 'pass' },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const driver = new GitHubDriver(mockConfig, mockDeps);
    const result = await driver.waitForChecks(mockTask, { pollInterval: 10 });

    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].name).toBe('tests');
    }
  });
});
