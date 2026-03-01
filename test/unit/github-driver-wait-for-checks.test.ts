import { describe, test, expect } from 'bun:test';
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
    models: { default: 'sonnet' as const },
    session: { verbose: false, debug: false, auto_commit_instructions: false },
    data: { path: '/tmp/test/.lazy' },
    storage: { backend: 'in-repo', orphan_branch_name: 'lazy-data', external_path: '' },
    git: { default_branch_prefix: 'lazy' },
    output: { shortid_length: 8 },
    agent: { agent_id: 'test-agent' },
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
    runner: 'docker' as const,
    documents: { path: '' },
    features: {},
  };

  const mockTask: Task = {
    id: 'test-task-123',
    code: 'test',
    goal: 'Test task',
    prompt: '',
    type: 'task',
    status: 'blocked',
    model: 'sonnet',
    created_at: Date.now(),
    completed_at: null,
    parent_task_id: null,
    branched_from_sha: null,
    close_reason: null,
    metadata: {
      github_remote_ref_id: '42',
    },
  };

  // INVARIANT: When all checks pass, waitForChecks returns { passed: true }.
  test('returns passed when all checks succeed', async () => {
    const mockDeps: DriverDeps = {
      runGh: (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'checks') {
          return {
            stdout: JSON.stringify([
              { name: 'typecheck', state: 'SUCCESS', bucket: 'pass', detailUrl: 'https://example.com/1' },
              { name: 'tests', state: 'SUCCESS', bucket: 'pass', detailUrl: 'https://example.com/2' },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const driver = new GitHubDriver(mockConfig, mockDeps);
    const result = await driver.waitForChecks(mockTask, { pollInterval: 10 });

    expect(result.passed).toBe(true);
  });

  // INVARIANT: When checks fail, waitForChecks returns { passed: false } with failed check details.
  test('returns failed checks when any check fails', async () => {
    const mockDeps: DriverDeps = {
      runGh: (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'checks') {
          return {
            stdout: JSON.stringify([
              { name: 'typecheck', state: 'SUCCESS', bucket: 'pass', detailUrl: 'https://example.com/1' },
              { name: 'tests', state: 'FAILURE', bucket: 'fail', detailUrl: 'https://example.com/2' },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
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
      runGh: (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'checks') {
          return {
            stdout: '[]',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
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
      runGh: () => ({ stdout: '', stderr: 'unexpected call', exitCode: 1 }),
      runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const driver = new GitHubDriver(mockConfig, mockDeps);
    const result = await driver.waitForChecks(taskWithoutPR, { pollInterval: 10 });

    expect(result.passed).toBe(true);
  });

  // INVARIANT: waitForChecks polls until pending checks complete.
  test('polls until pending checks complete', async () => {
    let callCount = 0;

    const mockDeps: DriverDeps = {
      runGh: (args: string[]) => {
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
      runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const driver = new GitHubDriver(mockConfig, mockDeps);
    const result = await driver.waitForChecks(mockTask, { pollInterval: 10 });

    expect(result.passed).toBe(true);
    expect(callCount).toBe(3);
  });

  // INVARIANT: waitForChecks times out and reports remaining pending checks.
  test('times out when checks stay pending', async () => {
    const mockDeps: DriverDeps = {
      runGh: (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'checks') {
          return {
            stdout: JSON.stringify([
              { name: 'slow-check', state: 'IN_PROGRESS', bucket: 'pending', detailUrl: 'https://example.com/slow' },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
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
      runGh: (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'checks') {
          return {
            stdout: '',
            stderr: 'no checks reported',
            exitCode: 1,
          };
        }
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const driver = new GitHubDriver(mockConfig, mockDeps);
    const result = await driver.waitForChecks(mockTask, { pollInterval: 10 });

    expect(result.passed).toBe(true);
  });

  // INVARIANT: waitForChecks detects failure even when some checks pass.
  test('reports failure when some pass and some fail', async () => {
    const mockDeps: DriverDeps = {
      runGh: (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'checks') {
          return {
            stdout: JSON.stringify([
              { name: 'typecheck', state: 'SUCCESS', bucket: 'pass' },
              { name: 'tests', state: 'FAILURE', bucket: 'fail', detailUrl: 'https://example.com/fail' },
              { name: 'lint', state: 'SUCCESS', bucket: 'pass' },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
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
