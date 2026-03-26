import { describe, test, expect } from 'bun:test';
import { GitHubDriver } from '../../src/remote/github-driver';
import type { Task } from '../../src/types';
import type { ResolvedConfig } from '../../src/config/types';
import type { DriverDeps, GhResult } from '../../src/remote/github-driver';

/**
 * Unit tests for GitHubDriver.markReadyForReview() — especially --repo flag handling
 * to prevent "Head sha can't be blank" errors when multiple GitHub remotes exist.
 */

const mockConfig: ResolvedConfig = {
  models: { default: 'sonnet' as const },
  session: { verbose: false, debug: false, auto_commit_instructions: false },
  data: { path: '/tmp/test/.lazy' },
  storage: { backend: 'external', external_path: '', postgres_ssl: false },
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
  checks: { post_turn: '', post_turn_timeout: 300 },
};

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'test-task-id',
    code: null,
    goal: 'Test goal',
    prompt: 'Test prompt',
    type: 'task',
    status: 'working' as const,
    created_at: Date.now(),
    completed_at: null,
    parent_task_id: null,
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    metadata: {},
    ...overrides,
  };
}

const ok = (stdout = ''): GhResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'error'): GhResult => ({ stdout: '', stderr, exitCode: 1 });

describe('GitHubDriver markReadyForReview', () => {
  test('passes --repo flag when creating new PR', async () => {
    const ghCalls: string[][] = [];
    const gitCalls: string[][] = [];

    const deps: DriverDeps = {
      runGh: (args) => {
        ghCalls.push([...args]);
        if (args[0] === 'pr' && args[1] === 'create') {
          return ok('https://github.com/owner/repo/pull/123');
        }
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
          return ok(JSON.stringify({ number: 123 }));
        }
        return fail('unexpected gh call');
      },
      runGit: (args: string[]) => {
        gitCalls.push([...args]);
        if (args[0] === 'remote' && args[1] === 'get-url') {
          return ok('git@github.com:owner/repo.git');
        }
        return fail('unexpected git call');
      },
    };

    const task = makeTask({
      metadata: {
        remote_target_branch: 'main',
      },
    });

    const driver = new GitHubDriver(mockConfig, deps);
    const result = await driver.markReadyForReview(task);

    expect(result.metadata).toBeDefined();
    expect(result.metadata?.github_remote_ref_url).toBe('https://github.com/owner/repo/pull/123');

    // Find the gh pr create call
    const createCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'create');
    expect(createCall).toBeDefined();

    // Verify --repo flag is present
    const repoIndex = createCall!.indexOf('--repo');
    expect(repoIndex).toBeGreaterThan(-1);
    expect(createCall![repoIndex + 1]).toBe('owner/repo');
  });

  test('handles missing remote gracefully', async () => {
    const ghCalls: string[][] = [];

    const deps: DriverDeps = {
      runGh: (args) => {
        ghCalls.push([...args]);
        if (args[0] === 'pr' && args[1] === 'create') {
          // Even without --repo, gh will try to create the PR (may fail in practice)
          return ok('https://github.com/owner/repo/pull/123');
        }
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
          return ok(JSON.stringify({ number: 123 }));
        }
        return fail('unexpected gh call');
      },
      runGit: (args: string[]) => {
        if (args[0] === 'remote' && args[1] === 'get-url') {
          return fail('no remote');
        }
        return fail('unexpected git call');
      },
    };

    const task = makeTask({
      metadata: {
        remote_target_branch: 'main',
      },
    });

    const driver = new GitHubDriver(mockConfig, deps);
    const result = await driver.markReadyForReview(task);

    expect(result.metadata).toBeDefined();

    // gh pr create should still be called, but without --repo flag
    const createCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'create');
    expect(createCall).toBeDefined();

    // --repo should NOT be present when remote parsing fails
    const hasRepoFlag = createCall!.includes('--repo');
    expect(hasRepoFlag).toBe(false);
  });

  test('parses HTTPS remote URL correctly', async () => {
    const ghCalls: string[][] = [];

    const deps: DriverDeps = {
      runGh: (args) => {
        ghCalls.push([...args]);
        if (args[0] === 'pr' && args[1] === 'create') {
          return ok('https://github.com/acme/product/pull/456');
        }
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
          return ok(JSON.stringify({ number: 456 }));
        }
        return fail('unexpected gh call');
      },
      runGit: (args: string[]) => {
        if (args[0] === 'remote' && args[1] === 'get-url') {
          return ok('https://github.com/acme/product.git');
        }
        return fail('unexpected git call');
      },
    };

    const task = makeTask({
      metadata: {
        remote_target_branch: 'main',
      },
    });

    const driver = new GitHubDriver(mockConfig, deps);
    await driver.markReadyForReview(task);

    const createCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'create');
    expect(createCall).toBeDefined();

    const repoIndex = createCall!.indexOf('--repo');
    expect(repoIndex).toBeGreaterThan(-1);
    expect(createCall![repoIndex + 1]).toBe('acme/product');
  });
});
