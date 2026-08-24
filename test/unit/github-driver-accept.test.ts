import { describe, test, expect } from 'bun:test';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import { GitHubDriver } from '../../src/remote/github-driver';
import type { Task } from '../../src/types';
import type { ResolvedConfig } from '../../src/config/types';
import type { DriverDeps, GhResult } from '../../src/remote/github-driver';

/**
 * Unit tests for GitHubDriver.merge() — especially metadata persistence
 * when replacement PRs are created and the merge subsequently fails.
 */

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

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'test-task-id',
    code: null,
    goal: 'Test goal',
    prompt: 'Test prompt',
    type: 'task',
    status: 'working' as const,
    priority: 'normal',
    created_at: Date.now(),
    completed_at: null,
    target: { kind: 'branch' as const, branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    metadata: { remote_ref_id: '42', remote_ref_url: 'https://github.com/o/r/pull/42' },
    pending_sync: 0,
    runner_type: null,
    tags: [],
    ...overrides,
  };
}

const ok = (stdout = ''): GhResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'error'): GhResult => ({ stdout: '', stderr, exitCode: 1 });

function makeDeps(ghHandler: (args: string[], cwd?: string) => Promise<GhResult>): DriverDeps {
  return {
    runGh: ghHandler,
    runGit: async (args: string[]) => {
      if (args[0] === 'push') return ok();
      if (args[0] === 'merge-base') return fail('not ancestor');
      return fail('unexpected git call');
    },
  };
}

describe('GitHubDriver merge', () => {
  test('merges PR when existing PR is open', async () => {
    const ghCalls: string[][] = [];

    const deps = makeDeps(async (args) => {
      ghCalls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
        return Promise.resolve(ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'OPEN' })));
      }
      if (args[0] === 'pr' && args[1] === 'checks') {
        return Promise.resolve(ok(JSON.stringify([]))); // No checks
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('reviewDecision')) {
        return Promise.resolve(ok(JSON.stringify({ reviewDecision: '' })));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('body')) {
        return Promise.resolve(ok(JSON.stringify({ body: 'PR body' })));
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        return Promise.resolve(ok());
      }
      return Promise.resolve(fail('unexpected gh call'));
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

    const deps = makeDeps(async (args) => {
      ghCalls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
        return Promise.resolve(ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'CLOSED' })));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
        return Promise.resolve(ok(JSON.stringify({ number: 99 })));
      }
      if (args[0] === 'pr' && args[1] === 'checks') {
        return Promise.resolve(ok(JSON.stringify([])));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('reviewDecision')) {
        return Promise.resolve(ok(JSON.stringify({ reviewDecision: '' })));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('body')) {
        return Promise.resolve(ok(JSON.stringify({ body: 'PR body' })));
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        return Promise.resolve(ok('https://github.com/o/r/pull/99'));
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        return Promise.resolve(ok());
      }
      return Promise.resolve(fail('unexpected gh call'));
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

    const deps = makeDeps(async (args) => {
      ghCalls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
        return Promise.resolve(ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'CLOSED' })));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
        return Promise.resolve(ok(JSON.stringify({ number: 99 })));
      }
      // Pre-merge checks pass
      if (args[0] === 'pr' && args[1] === 'checks') {
        return Promise.resolve(ok(JSON.stringify([])));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('reviewDecision')) {
        return Promise.resolve(ok(JSON.stringify({ reviewDecision: '' })));
      }
      // gh pr view --json mergeable (conflict detection after merge failure)
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('mergeable')) {
        return Promise.resolve(ok(JSON.stringify({ mergeable: 'CONFLICTING' })));
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        return Promise.resolve(ok('https://github.com/o/r/pull/99'));
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        return Promise.resolve(fail('PR has merge conflicts'));
      }
      return Promise.resolve(fail('unexpected gh call'));
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

    const deps = makeDeps(async (args) => {
      ghCalls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
        return Promise.resolve(ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'CLOSED' })));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
        return Promise.resolve(ok(JSON.stringify({ number: 99 })));
      }
      // gh pr view --json mergeable (not conflicting — fall through to checks)
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('mergeable')) {
        return Promise.resolve(ok(JSON.stringify({ mergeable: 'MERGEABLE' })));
      }
      // gh pr checks --json (pending checks detected)
      if (args[0] === 'pr' && args[1] === 'checks') {
        return Promise.resolve(ok(JSON.stringify([{ name: 'ci/build', state: 'PENDING', bucket: 'pending', link: null }])));
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        return Promise.resolve(ok('https://github.com/o/r/pull/99'));
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        return Promise.resolve(fail('required status check is expected'));
      }
      return Promise.resolve(fail('unexpected gh call'));
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
    const deps = makeDeps(async (args) => {
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
        return Promise.resolve(ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'OPEN' })));
      }
      if (args[0] === 'pr' && args[1] === 'checks') {
        return Promise.resolve(ok(JSON.stringify([])));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('reviewDecision')) {
        return Promise.resolve(ok(JSON.stringify({ reviewDecision: '' })));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('body')) {
        return Promise.resolve(ok(JSON.stringify({ body: 'PR body' })));
      }
      // gh pr view --json mergeable (conflict detection after merge failure)
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('mergeable')) {
        return Promise.resolve(ok(JSON.stringify({ mergeable: 'CONFLICTING' })));
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        return Promise.resolve(fail('PR has merge conflicts'));
      }
      return Promise.resolve(fail('unexpected'));
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
      runGh: async (args) => {
        ghCalls.push([...args]);
        return fail('should not be called');
      },
      runGit: async (args: string[]) => {
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
  // Now caught by pre-merge CI check rather than post-merge-failure detection.
  test('returns pending when required checks are pending', async () => {
    const deps = makeDeps(async (args) => {
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
        return Promise.resolve(ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'OPEN' })));
      }
      // Pre-merge CI check: pending checks detected
      if (args[0] === 'pr' && args[1] === 'checks') {
        return Promise.resolve(ok(JSON.stringify([{ name: 'ci/build', state: 'PENDING', bucket: 'pending', link: null }])));
      }
      return Promise.resolve(fail('unexpected'));
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

  // INVARIANT (moved to checkAcceptGates): pre-merge gate checks (CI, reviews)
  // are the responsibility of `checkAcceptGates`, not `merge()`. The original
  // tests asserted that `merge()` itself refused to merge on failing/pending CI
  // or missing reviews; that gate behavior was deliberately relocated to
  // `checkAcceptGates` (caller `acceptTask` throws 409 on any warning). The
  // gate-level coverage now lives in `checkAcceptGates (mocked)` below — this
  // mirrors the GitLab driver tests, which were migrated when the gate moved.

  // INVARIANT: merge() proceeds when checks pass and reviews are approved.
  test('merges when CI passes and reviews are approved', async () => {
    const ghCalls: string[][] = [];

    const deps = makeDeps(async (args) => {
      ghCalls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
        return Promise.resolve(ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'OPEN' })));
      }
      if (args[0] === 'pr' && args[1] === 'checks') {
        return Promise.resolve(ok(JSON.stringify([
          { name: 'ci/build', state: 'SUCCESS', bucket: 'pass', link: null },
        ])));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('reviewDecision')) {
        return Promise.resolve(ok(JSON.stringify({ reviewDecision: 'APPROVED' })));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('body')) {
        return Promise.resolve(ok(JSON.stringify({ body: 'PR body' })));
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        return Promise.resolve(ok());
      }
      return Promise.resolve(fail('unexpected gh call'));
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
    expect(ghCalls.find(c => c[0] === 'pr' && c[1] === 'merge')).toBeDefined();
  });

  // merge() proceeds when no reviews are required (empty reviewDecision).
  test('merges when no reviews are required', async () => {
    const ghCalls: string[][] = [];

    const deps = makeDeps(async (args) => {
      ghCalls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
        return Promise.resolve(ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'OPEN' })));
      }
      if (args[0] === 'pr' && args[1] === 'checks') {
        return Promise.resolve(ok(JSON.stringify([]))); // No checks configured
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('reviewDecision')) {
        return Promise.resolve(ok(JSON.stringify({ reviewDecision: '' }))); // No reviews required
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('body')) {
        return Promise.resolve(ok(JSON.stringify({ body: 'PR body' })));
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        return Promise.resolve(ok());
      }
      return Promise.resolve(fail('unexpected gh call'));
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
  });

  // When the PR is already MERGED on the remote and the branch is also merged
  // locally, merge() should detect it early and return merged without side effects.
  test('returns merged when existing PR state is MERGED', async () => {
    const ghCalls: string[][] = [];

    const deps: DriverDeps = {
      runGh: async (args) => {
        ghCalls.push([...args]);
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
          return ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'MERGED' }));
        }
        return fail('unexpected');
      },
      runGit: async (args: string[]) => {
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
      runGh: async () => fail('unexpected'),
      runGit: async (args: string[]) => {
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

  // INVARIANT: When creating a replacement PR with multiple GitHub remotes,
  // the driver MUST pass --repo to gh pr create to avoid ambiguity.
  // Without this, gh might pick the wrong repository, causing "Head sha can't be blank" errors.
  test('passes --repo flag when creating replacement PR', async () => {
    const ghCalls: string[][] = [];
    const gitCalls: string[][] = [];

    const deps: DriverDeps = {
      runGh: async (args) => {
        ghCalls.push([...args]);
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
          return ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'CLOSED' }));
        }
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
          return ok(JSON.stringify({ number: 99 }));
        }
        if (args[0] === 'pr' && args[1] === 'create') {
          return ok('https://github.com/o/r/pull/99');
        }
        if (args[0] === 'pr' && args[1] === 'checks') {
          return ok(JSON.stringify([]));
        }
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('reviewDecision')) {
          return ok(JSON.stringify({ reviewDecision: '' }));
        }
        if (args[0] === 'pr' && args[1] === 'merge') {
          return ok();
        }
        return fail('unexpected gh call');
      },
      runGit: async (args: string[]) => {
        gitCalls.push([...args]);
        if (args[0] === 'push') return ok();
        if (args[0] === 'merge-base') return fail('not ancestor');
        if (args[0] === 'remote' && args[1] === 'get-url') {
          return ok('git@github.com:owner/repo.git');
        }
        return fail('unexpected git call');
      },
    };

    const driver = new GitHubDriver(mockConfig, deps);
    const result = await driver.merge({
      sourceBranch: 'lazy/test1234',
      targetBranch: 'main',
      task: makeTask({ metadata: {} }), // No PR metadata, forces creation
      taskShortId: 'test1234',
      root: '/tmp/test',
    });

    expect(result.status).toBe('merged');

    // Find the gh pr create call
    const createCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'create');
    expect(createCall).toBeDefined();

    // Verify --repo flag is present
    const repoIndex = createCall!.indexOf('--repo');
    expect(repoIndex).toBeGreaterThan(-1);
    expect(createCall![repoIndex + 1]).toBe('owner/repo');
  });
});

// Gate-level coverage migrated from the deleted `merge() refuses to merge ...`
// tests. Pre-merge CI/review gating now lives in checkAcceptGates(), which the
// daemon's acceptTask() consults before calling merge(). See the migration note
// in the `GitHubDriver merge` describe above and the GitLab equivalent.
describe('GitHubDriver checkAcceptGates', () => {
  // INVARIANT: a failing CI check surfaces a 'ci' warning so accept is blocked.
  test('warns when CI checks are failing', async () => {
    const deps = makeDeps(async (args) => {
      if (args[0] === 'pr' && args[1] === 'checks') {
        return Promise.resolve(ok(JSON.stringify([
          { name: 'ci/build', state: 'FAILURE', bucket: 'fail', link: 'https://example.com/1' },
        ])));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('reviewDecision,reviewThreads')) {
        return Promise.resolve(ok(JSON.stringify({ reviewDecision: 'APPROVED', reviewThreads: [] })));
      }
      return Promise.resolve(fail('unexpected gh call'));
    });

    const driver = new GitHubDriver(mockConfig, deps);
    const warnings = await driver.checkAcceptGates(makeTask());

    const ciWarning = warnings.find(w => w.gate === 'ci');
    expect(ciWarning).toBeDefined();
    expect(ciWarning?.message).toContain('ci/build');
  });

  // INVARIANT: pending CI checks surface a 'ci' warning (accept waits/merging).
  test('warns when CI checks are still running', async () => {
    const deps = makeDeps(async (args) => {
      if (args[0] === 'pr' && args[1] === 'checks') {
        return Promise.resolve(ok(JSON.stringify([
          { name: 'ci/build', state: 'PENDING', bucket: 'pending', link: null },
        ])));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('reviewDecision,reviewThreads')) {
        return Promise.resolve(ok(JSON.stringify({ reviewDecision: 'APPROVED', reviewThreads: [] })));
      }
      return Promise.resolve(fail('unexpected gh call'));
    });

    const driver = new GitHubDriver(mockConfig, deps);
    const warnings = await driver.checkAcceptGates(makeTask());

    const ciWarning = warnings.find(w => w.gate === 'ci');
    expect(ciWarning).toBeDefined();
    expect(ciWarning?.message).toContain('ci/build');
  });

  // INVARIANT: a non-APPROVED review decision surfaces a 'reviews' warning.
  test('warns when required reviews are not approved', async () => {
    const deps = makeDeps(async (args) => {
      if (args[0] === 'pr' && args[1] === 'checks') {
        return Promise.resolve(ok(JSON.stringify([
          { name: 'ci/build', state: 'SUCCESS', bucket: 'pass', link: null },
        ])));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('reviewDecision,reviewThreads')) {
        return Promise.resolve(ok(JSON.stringify({ reviewDecision: 'REVIEW_REQUIRED', reviewThreads: [] })));
      }
      return Promise.resolve(fail('unexpected gh call'));
    });

    const driver = new GitHubDriver(mockConfig, deps);
    const warnings = await driver.checkAcceptGates(makeTask());

    const reviewWarning = warnings.find(w => w.gate === 'reviews');
    expect(reviewWarning).toBeDefined();
    expect(reviewWarning?.message).toContain('REVIEW_REQUIRED');
  });

  // Negative case: green CI, approved reviews, no unresolved threads → no warnings.
  test('returns no warnings when all gates pass', async () => {
    const deps = makeDeps(async (args) => {
      if (args[0] === 'pr' && args[1] === 'checks') {
        return Promise.resolve(ok(JSON.stringify([
          { name: 'ci/build', state: 'SUCCESS', bucket: 'pass', link: null },
        ])));
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('reviewDecision,reviewThreads')) {
        return Promise.resolve(ok(JSON.stringify({ reviewDecision: 'APPROVED', reviewThreads: [] })));
      }
      return Promise.resolve(fail('unexpected gh call'));
    });

    const driver = new GitHubDriver(mockConfig, deps);
    const warnings = await driver.checkAcceptGates(makeTask());

    expect(warnings).toEqual([]);
  });
});
