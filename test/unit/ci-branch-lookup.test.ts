/**
 * Unit tests for branch-based CI failure detection.
 *
 * INVARIANT: getFailedCIJobs must detect CI failures by branch name even
 * when no PR/MR exists. This is the primary lookup path — PR/MR-based
 * lookup is a fallback for when branch-based lookup fails.
 */

import { describe, test, expect } from 'bun:test';
import { GitHubDriver } from '../../src/remote/github-driver';
import type { Task } from '../../src/types';
import type { ResolvedConfig } from '../../src/config/types';
import type { DriverDeps, GhResult } from '../../src/remote/github-driver';

const mockConfig: ResolvedConfig = {
  models: { default: 'sonnet' as const },
  session: { verbose: false, debug: false, auto_commit_instructions: false },
  data: { path: '/tmp/test/.lazy' },
  storage: { backend: 'external', external_path: '', postgres_ssl: false },
  git: { default_branch_prefix: 'lazy' },
  output: { shortid_length: 8 },
  agent: { agent_id: 'test-agent', watchdog_output_timeout_ms: 0, graceful_exit_timeout_ms: 0, effort: 'medium' },
  builder: { effort: 'high' },
  server: { port: 3000, sync_interval: 1000 },
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

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'test-task-id',
    code: null,
    goal: 'Test goal',
    prompt: 'Test prompt',
    type: 'task',
    status: 'blocked' as const,
    created_at: Date.now(),
    completed_at: null,
    target: { kind: 'branch' as const, branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    metadata: {},
    pending_sync: 0,
    ...overrides,
  };
}

const ok = (stdout = ''): GhResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'error'): GhResult => ({ stdout: '', stderr, exitCode: 1 });

function makeDeps(ghHandler: (args: string[], cwd?: string) => GhResult): DriverDeps {
  return {
    runGh: async (args, cwd) => ghHandler(args, cwd),
    runGit: async () => fail('unexpected git call') as any,
  };
}

describe('GitHubDriver branch-based CI lookup', () => {
  // INVARIANT: getFailedCIJobs detects failures by branch name without a PR.
  // Uses gh run list to find the latest workflow run, then gh run view for failed jobs.
  test('detects CI failures by branch name when no PR exists', async () => {
    const deps = makeDeps((args) => {
      // getRepoIdentifier call
      if (args[0] === 'api' && args[1] === 'repos/{owner}/{repo}') {
        return ok(JSON.stringify({ full_name: 'owner/repo' }));
      }
      // gh run list --branch lazy/test-branch
      if (args[0] === 'run' && args[1] === 'list' && args.includes('lazy/test-branch')) {
        return ok(JSON.stringify([
          { databaseId: 123, status: 'completed', conclusion: 'failure' },
        ]));
      }
      // gh run view 123 --json jobs
      if (args[0] === 'run' && args[1] === 'view' && args[2] === '123') {
        return ok(JSON.stringify({
          jobs: [
            { name: 'lint', conclusion: 'failure', url: 'https://github.com/o/r/actions/runs/1/job/100' },
            { name: 'test', conclusion: 'failure', url: 'https://github.com/o/r/actions/runs/1/job/101' },
          ],
        }));
      }
      // Log fetch for job 100
      if (args[0] === 'api' && args[1]?.includes('/actions/jobs/100/logs')) {
        return ok('Error: lint failed on line 42');
      }
      // Log fetch for job 101
      if (args[0] === 'api' && args[1]?.includes('/actions/jobs/101/logs')) {
        return ok('FAIL: test suite failed');
      }
      return fail('unexpected call: ' + args.join(' '));
    });

    const driver = new GitHubDriver(mockConfig, deps);
    // Task has no PR metadata
    const task = makeTask({ metadata: {} });

    const failures = await driver.getFailedCIJobs(task, 'lazy/test-branch');

    expect(failures).toHaveLength(2);
    expect(failures[0].name).toBe('lint');
    expect(failures[0].log).toContain('lint failed');
    expect(failures[1].name).toBe('test');
    expect(failures[1].log).toContain('test suite failed');
  });

  // INVARIANT: Falls back to PR-based lookup if branch lookup returns no failures.
  test('falls back to PR-based lookup when branch has no failures', async () => {
    const deps = makeDeps((args) => {
      // getRepoIdentifier call
      if (args[0] === 'api' && args[1] === 'repos/{owner}/{repo}') {
        return ok(JSON.stringify({ full_name: 'owner/repo' }));
      }
      // gh run list returns no runs (or passing run)
      if (args[0] === 'run' && args[1] === 'list') {
        return ok(JSON.stringify([]));
      }
      // PR checks — has a failure
      if (args[0] === 'pr' && args[1] === 'checks') {
        return ok(JSON.stringify([
          { name: 'deploy', state: 'FAILURE', bucket: 'fail', link: 'https://example.com/deploy' },
        ]));
      }
      return fail('unexpected call: ' + args.join(' '));
    });

    const driver = new GitHubDriver(mockConfig, deps);
    const task = makeTask({
      metadata: { github_remote_ref_id: '42' },
    });

    const failures = await driver.getFailedCIJobs(task, 'lazy/test-branch');

    expect(failures).toHaveLength(1);
    expect(failures[0].name).toBe('deploy');
  });

  // INVARIANT: Returns empty when no branch name and no PR.
  test('returns empty when no branch name and no PR', async () => {
    const deps = makeDeps(() => fail('should not be called'));

    const driver = new GitHubDriver(mockConfig, deps);
    const task = makeTask({ metadata: {} });

    const failures = await driver.getFailedCIJobs(task);

    expect(failures).toHaveLength(0);
  });

  // INVARIANT: Branch lookup failure (API error) falls back to PR-based lookup.
  test('falls back to PR when branch API call fails', async () => {
    const deps = makeDeps((args) => {
      // getRepoIdentifier call
      if (args[0] === 'api' && args[1] === 'repos/{owner}/{repo}') {
        return ok(JSON.stringify({ full_name: 'owner/repo' }));
      }
      // gh run list fails
      if (args[0] === 'run' && args[1] === 'list') {
        return fail('API error');
      }
      // PR checks succeed with a failure
      if (args[0] === 'pr' && args[1] === 'checks') {
        return ok(JSON.stringify([
          { name: 'build', state: 'FAILURE', bucket: 'fail' },
        ]));
      }
      return fail('unexpected call: ' + args.join(' '));
    });

    const driver = new GitHubDriver(mockConfig, deps);
    const task = makeTask({
      metadata: { github_remote_ref_id: '99' },
    });

    const failures = await driver.getFailedCIJobs(task, 'lazy/test-branch');

    expect(failures).toHaveLength(1);
    expect(failures[0].name).toBe('build');
  });
});
