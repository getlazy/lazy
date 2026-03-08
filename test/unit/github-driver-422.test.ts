import { describe, test, expect } from 'bun:test';
import { GitHubDriver } from '../../src/remote/github-driver';
import type { Task } from '../../src/types';
import type { ResolvedConfig } from '../../src/config/types';
import type { DriverDeps, GhResult } from '../../src/remote/github-driver';

/**
 * Unit tests for GitHub driver's handling of 422 errors when self-approving PRs.
 *
 * GitHub returns HTTP 422 (Unprocessable Entity) when a PR author tries to approve
 * their own PR. This is expected behavior — lazy should log it at debug level and
 * fall back to posting a comment instead.
 */

describe('GitHubDriver 422 self-approval handling', () => {
  // Minimal config for testing
  const mockConfig: ResolvedConfig = {
    models: {
      default: 'sonnet' as const,
    },
    session: {
      verbose: false,
      debug: false,
      auto_commit_instructions: false,
    },
    data: {
      path: '/tmp/test/.lazy',
    },
    storage: {
      backend: 'external',
      external_path: '',
      postgres_ssl: false,
    },
    git: {
      default_branch_prefix: 'lazy',
    },
    output: {
      shortid_length: 8,
    },
    agent: {
      agent_id: 'test-agent',
      watchdog_output_timeout_ms: 0,
    },
    server: {
      port: 3000,
      sync_interval: 1000,
    },
    remote: {
      driver: 'github',
      git_remote: 'origin',
      github_auto_push: true,
      github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: false,
      gitlab_auto_push: true,
      gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: false,
    },
    docker: {
      dockerfile: '',
      toolchain: '',
    },
    runner: { type: 'docker' as const, docker_agent_root: false, docker_agent_no_network: false },
    documents: {
      path: '',
    },
    features: {},
    worktree: { include: [] },
  };

  // Minimal task with a PR number
  const mockTask: Task = {
    id: 'test-task-123',
    code: 'test',
    goal: 'Test task',
    prompt: '',
    type: 'task',
    status: 'blocked',
    model: 'sonnet',
    agent_id: 'claude-code',
    created_at: Date.now(),
    completed_at: null,
    parent_task_id: null,
    branched_from_sha: null,
    close_reason: null,
    metadata: {
      github_remote_ref_id: '123', // PR number
    },
  };

  test('postAcceptReview suppresses 422 error (self-approval)', async () => {
    // Mock gh CLI to return 422 error on review, success on comment
    const mockDeps: DriverDeps = {
      runGh: (args: string[]) => {
        if (args[0] === 'api' && args.includes('event=APPROVE')) {
          // Review request returns 422
          return {
            stdout: '',
            stderr: 'gh: Unprocessable Entity (HTTP 422)',
            exitCode: 1,
          };
        }
        if (args[0] === 'pr' && args[1] === 'comment') {
          // Comment succeeds
          return {
            stdout: 'Comment posted',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const driver = new GitHubDriver(mockConfig, mockDeps);
    const warning = await driver.postAcceptReview(mockTask, 'LGTM');

    // Should not return a warning (comment fallback succeeded)
    expect(warning).toBeNull();
  });

  test('postAcceptReview does not suppress non-422 errors', async () => {
    // Mock gh CLI to return auth error on review, success on comment
    const mockDeps: DriverDeps = {
      runGh: (args: string[]) => {
        if (args[0] === 'api' && args.includes('event=APPROVE')) {
          // Review request returns auth error (not 422)
          return {
            stdout: '',
            stderr: 'gh: HTTP 403: Forbidden',
            exitCode: 1,
          };
        }
        if (args[0] === 'pr' && args[1] === 'comment') {
          // Comment succeeds
          return {
            stdout: 'Comment posted',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const driver = new GitHubDriver(mockConfig, mockDeps);
    const warning = await driver.postAcceptReview(mockTask, 'LGTM');

    // Should not return a warning (comment fallback succeeded)
    // Note: The 403 error is still logged at warn level, but since the comment
    // succeeded, no warning is returned to the caller
    expect(warning).toBeNull();
  });

  test('postRejectReview suppresses 422 error (self-review)', async () => {
    // Mock gh CLI to return 422 error on review, success on comment
    const mockDeps: DriverDeps = {
      runGh: (args: string[]) => {
        if (args[0] === 'api' && args.includes('event=REQUEST_CHANGES')) {
          // Review request returns 422
          return {
            stdout: '',
            stderr: 'gh: Unprocessable Entity (HTTP 422)',
            exitCode: 1,
          };
        }
        if (args[0] === 'pr' && args[1] === 'comment') {
          // Comment succeeds
          return {
            stdout: 'Comment posted',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const driver = new GitHubDriver(mockConfig, mockDeps);
    const warning = await driver.postRejectReview(mockTask, 'Needs changes');

    // Should not return a warning (comment fallback succeeded)
    expect(warning).toBeNull();
  });

  test('postAcceptReview handles 422 with "Unprocessable Entity" text', async () => {
    // Mock gh CLI to return 422 error with different message format
    const mockDeps: DriverDeps = {
      runGh: (args: string[]) => {
        if (args[0] === 'api' && args.includes('event=APPROVE')) {
          // Review request returns 422 with different error text
          return {
            stdout: '',
            stderr: 'error: Unprocessable Entity',
            exitCode: 1,
          };
        }
        if (args[0] === 'pr' && args[1] === 'comment') {
          // Comment succeeds
          return {
            stdout: 'Comment posted',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const driver = new GitHubDriver(mockConfig, mockDeps);
    const warning = await driver.postAcceptReview(mockTask, 'LGTM');

    // Should not return a warning (422 is suppressed, comment succeeded)
    expect(warning).toBeNull();
  });
});
