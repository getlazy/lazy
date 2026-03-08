import { describe, test, expect } from 'bun:test';
import { GitHubDriver } from '../../src/remote/github-driver';
import type { Task } from '../../src/types';
import type { ResolvedConfig } from '../../src/config/types';
import type { DriverDeps, GhResult } from '../../src/remote/github-driver';

/**
 * Unit tests for GitHubDriver.merge() — especially metadata persistence
 * when replacement PRs are created and the merge subsequently fails.
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
  runner: { type: 'docker' as const, docker_agent_root: false, docker_agent_no_network: false },
  documents: { path: '' },
  features: {},
  worktree: { include: [] },
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
    metadata: { remote_ref_id: '42', remote_ref_url: 'https://github.com/o/r/pull/42' },
    ...overrides,
  };
}

const ok = (stdout = ''): GhResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'error'): GhResult => ({ stdout: '', stderr, exitCode: 1 });

function makeDeps(ghHandler: (args: string[], cwd?: string) => GhResult): DriverDeps {
  return {
    runGh: ghHandler,
    runGit: (args: string[]) => {
      if (args[0] === 'push') return ok();
      if (args[0] === 'merge-base') return fail('not ancestor');
      return fail('unexpected git call');
    },
  };
}

describe('GitHubDriver merge', () => {
  test('merges PR when existing PR is open', async () => {
    const ghCalls: string[][] = [];

    const deps = makeDeps((args) => {
      ghCalls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
        return ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'OPEN' }));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('body')) {
        return ok(JSON.stringify({ body: 'PR body' }));
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        return ok();
      }
      return fail('unexpected gh call');
    });

    const driver = new GitHubDriver(mockConfig, deps);
    const result = await driver.merge({
      sourceBranch: 'lazy/test1234',
      targetBranch: 'main',
      task: makeTask(),
      taskShortId: 'test1234',
      root: '/tmp/test',
    });

    expect(result.status).toBe('merged');
    const mergeCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'merge');
    expect(mergeCall).toBeDefined();
  });

  test('creates replacement PR when existing is closed', async () => {
    const ghCalls: string[][] = [];

    const deps = makeDeps((args) => {
      ghCalls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
        return ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'CLOSED' }));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
        return ok(JSON.stringify({ number: 99 }));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('body')) {
        return ok(JSON.stringify({ body: 'PR body' }));
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        return ok('https://github.com/o/r/pull/99');
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        return ok();
      }
      return fail('unexpected gh call');
    });

    const driver = new GitHubDriver(mockConfig, deps);
    const result = await driver.merge({
      sourceBranch: 'lazy/test1234',
      targetBranch: 'main',
      task: makeTask(),
      taskShortId: 'test1234',
      root: '/tmp/test',
    });

    expect(result.status).toBe('merged');
    const createCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'create');
    expect(createCall).toBeDefined();
    expect(result.metadata).toBeDefined();
    expect(result.metadata?.github_remote_ref_url).toBe('https://github.com/o/r/pull/99');
  });

  // INVARIANT: When merge() creates a replacement PR (because the original is stale),
  // the new PR metadata must be returned even when the merge subsequently fails.
  // Without this, the task keeps pointing to the stale PR forever, causing cascading
  // failures: external-close checks see the stale PR and incorrectly close the task.
  test('returns replacement PR metadata on merge conflict', async () => {
    const ghCalls: string[][] = [];

    const deps = makeDeps((args) => {
      ghCalls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
        return ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'CLOSED' }));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
        return ok(JSON.stringify({ number: 99 }));
      }
      // gh pr view --json mergeable (conflict detection after merge failure)
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('mergeable')) {
        return ok(JSON.stringify({ mergeable: 'CONFLICTING' }));
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        return ok('https://github.com/o/r/pull/99');
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        return fail('PR has merge conflicts');
      }
      return fail('unexpected gh call');
    });

    const driver = new GitHubDriver(mockConfig, deps);
    const result = await driver.merge({
      sourceBranch: 'lazy/test1234',
      targetBranch: 'main',
      task: makeTask(),
      taskShortId: 'test1234',
      root: '/tmp/test',
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.isConflict).toBe(true);
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.github_remote_ref_url).toBe('https://github.com/o/r/pull/99');
      expect(result.metadata?.github_remote_ref_id).toBe('99');
    }
  });

  // INVARIANT: Same as above but for pending checks (detected via gh pr checks --json).
  test('returns replacement PR metadata on pending checks', async () => {
    const ghCalls: string[][] = [];

    const deps = makeDeps((args) => {
      ghCalls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
        return ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'CLOSED' }));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
        return ok(JSON.stringify({ number: 99 }));
      }
      // gh pr view --json mergeable (not conflicting — fall through to checks)
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('mergeable')) {
        return ok(JSON.stringify({ mergeable: 'MERGEABLE' }));
      }
      // gh pr checks --json (pending checks detected)
      if (args[0] === 'pr' && args[1] === 'checks') {
        return ok(JSON.stringify([{ name: 'ci/build', state: 'PENDING', bucket: 'pending', detailUrl: null }]));
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        return ok('https://github.com/o/r/pull/99');
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        return fail('required status check is expected');
      }
      return fail('unexpected gh call');
    });

    const driver = new GitHubDriver(mockConfig, deps);
    const result = await driver.merge({
      sourceBranch: 'lazy/test1234',
      targetBranch: 'main',
      task: makeTask(),
      taskShortId: 'test1234',
      root: '/tmp/test',
    });

    expect(result.status).toBe('pending');
    if (result.status === 'pending') {
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.github_remote_ref_url).toBe('https://github.com/o/r/pull/99');
      expect(result.metadata?.github_remote_ref_id).toBe('99');
    }
  });

  // When no replacement PR is needed (original is still open), metadata should
  // be undefined on failure — there's nothing new to persist.
  test('does not return metadata on conflict when no replacement PR was created', async () => {
    const deps = makeDeps((args) => {
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
        return ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'OPEN' }));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('body')) {
        return ok(JSON.stringify({ body: 'PR body' }));
      }
      // gh pr view --json mergeable (conflict detection after merge failure)
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('mergeable')) {
        return ok(JSON.stringify({ mergeable: 'CONFLICTING' }));
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        return fail('PR has merge conflicts');
      }
      return fail('unexpected');
    });

    const driver = new GitHubDriver(mockConfig, deps);
    const result = await driver.merge({
      sourceBranch: 'lazy/test1234',
      targetBranch: 'main',
      task: makeTask(),
      taskShortId: 'test1234',
      root: '/tmp/test',
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.isConflict).toBe(true);
      expect(result.metadata).toBeUndefined();
    }
  });

  // INVARIANT: Calling merge() on an already-merged branch is a noop.
  // This ensures idempotency — the human can safely re-run accept on a
  // task that was already merged (e.g., via auto-merge while they were away).
  test('returns merged when branch is already merged into target', async () => {
    const ghCalls: string[][] = [];

    const deps: DriverDeps = {
      runGh: (args) => {
        ghCalls.push([...args]);
        return fail('should not be called');
      },
      runGit: (args: string[]) => {
        // isBranchMerged check: merge-base --is-ancestor returns success
        if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return ok();
        if (args[0] === 'push') return ok();
        return fail('unexpected git call');
      },
    };

    const driver = new GitHubDriver(mockConfig, deps);
    const result = await driver.merge({
      sourceBranch: 'lazy/test1234',
      targetBranch: 'main',
      task: makeTask(),
      taskShortId: 'test1234',
      root: '/tmp/test',
    });

    expect(result.status).toBe('merged');
    // Should not have called any gh commands (no need to check PR state)
    expect(ghCalls.length).toBe(0);
  });

  // INVARIANT: When checks are running, merge() returns 'pending' instead of 'failed'.
  // This tells the accept command to set the task to 'merging' status and exit cleanly.
  test('returns pending when required checks are pending', async () => {
    const deps = makeDeps((args) => {
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
        return ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'OPEN' }));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('body')) {
        return ok(JSON.stringify({ body: 'PR body' }));
      }
      // gh pr view --json mergeable (not conflicting — fall through to checks)
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('mergeable')) {
        return ok(JSON.stringify({ mergeable: 'MERGEABLE' }));
      }
      // gh pr checks --json (pending checks detected)
      if (args[0] === 'pr' && args[1] === 'checks') {
        return ok(JSON.stringify([{ name: 'ci/build', state: 'PENDING', bucket: 'pending', detailUrl: null }]));
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        return fail('merge requirements were not met');
      }
      return fail('unexpected');
    });

    const driver = new GitHubDriver(mockConfig, deps);
    const result = await driver.merge({
      sourceBranch: 'lazy/test1234',
      targetBranch: 'main',
      task: makeTask(),
      taskShortId: 'test1234',
      root: '/tmp/test',
    });

    expect(result.status).toBe('pending');
    if (result.status === 'pending') {
      expect(result.reason).toContain('check');
    }
  });

  // When the PR is already MERGED on the remote and the branch is also merged
  // locally, merge() should detect it early and return merged without side effects.
  test('returns merged when existing PR state is MERGED', async () => {
    const ghCalls: string[][] = [];

    const deps: DriverDeps = {
      runGh: (args) => {
        ghCalls.push([...args]);
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
          return ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'MERGED' }));
        }
        return fail('unexpected');
      },
      runGit: (args: string[]) => {
        // isBranchMerged: first check returns false (no --is-ancestor), then after
        // push + PR state check, the second check returns true
        if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return ok();
        if (args[0] === 'push') return ok();
        // rev-list for unique commits check
        if (args[0] === 'rev-list') return ok('abc123');
        // diff --quiet for tree comparison
        if (args[0] === 'diff' && args[1] === '--quiet') return ok();
        return fail('unexpected');
      },
    };

    const driver = new GitHubDriver(mockConfig, deps);
    const result = await driver.merge({
      sourceBranch: 'lazy/test1234',
      targetBranch: 'main',
      task: makeTask(),
      taskShortId: 'test1234',
      root: '/tmp/test',
    });

    expect(result.status).toBe('merged');
  });

  test('fails with push error', async () => {
    const deps: DriverDeps = {
      runGh: () => fail('unexpected'),
      runGit: (args: string[]) => {
        if (args[0] === 'push') return fail('no remote');
        return fail('unexpected');
      },
    };

    const driver = new GitHubDriver(mockConfig, deps);
    const result = await driver.merge({
      sourceBranch: 'lazy/test1234',
      targetBranch: 'main',
      task: makeTask(),
      taskShortId: 'test1234',
      root: '/tmp/test',
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.isConflict).toBeFalsy();
    }
  });
});
