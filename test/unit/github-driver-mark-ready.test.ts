import { describe, test, expect } from 'bun:test';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import { GitHubDriver } from '../../src/remote/github-driver';
import type { Task } from '../../src/types';
import type { ResolvedConfig } from '../../src/config/types';
import type { DriverDeps, GhResult } from '../../src/remote/github-driver';

/**
 * Unit tests for GitHubDriver.markReadyForReview() — especially --repo flag handling
 * to prevent "Head sha can't be blank" errors when multiple GitHub remotes exist.
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
    metadata: {},
    pending_sync: 0,
    runner_type: null,
    tags: [],
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
      runGh: async (args) => {
        ghCalls.push([...args]);
        if (args[0] === 'pr' && args[1] === 'create') {
          return ok('https://github.com/owner/repo/pull/123');
        }
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
          return ok(JSON.stringify({ number: 123 }));
        }
        return fail('unexpected gh call');
      },
      runGit: async (args: string[]) => {
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
      runGh: async (args) => {
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
      runGit: async (args: string[]) => {
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
      runGh: async (args) => {
        ghCalls.push([...args]);
        if (args[0] === 'pr' && args[1] === 'create') {
          return ok('https://github.com/acme/product/pull/456');
        }
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
          return ok(JSON.stringify({ number: 456 }));
        }
        return fail('unexpected gh call');
      },
      runGit: async (args: string[]) => {
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

  // INVARIANT: "HEAD" is not a valid base ref for GitHub PRs.
  // When remote_target_branch is "HEAD" (from detached HEAD at start time),
  // the driver must resolve it to the actual default branch name.
  test('resolves literal "HEAD" in remote_target_branch to default branch', async () => {
    const ghCalls: string[][] = [];

    const deps: DriverDeps = {
      runGh: async (args) => {
        ghCalls.push([...args]);
        if (args[0] === 'pr' && args[1] === 'create') {
          return ok('https://github.com/owner/repo/pull/789');
        }
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
          return ok(JSON.stringify({ number: 789 }));
        }
        return fail('unexpected gh call');
      },
      runGit: async (args: string[]) => {
        if (args[0] === 'remote' && args[1] === 'get-url') {
          return ok('git@github.com:owner/repo.git');
        }
        // symbolic-ref for resolveDefaultBranch
        if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
          return ok('refs/remotes/origin/main');
        }
        return fail('unexpected git call');
      },
    };

    const task = makeTask({
      metadata: {
        remote_target_branch: 'HEAD',
      },
    });

    const driver = new GitHubDriver(mockConfig, deps);
    const result = await driver.markReadyForReview(task);

    expect(result.metadata).toBeDefined();

    // Find the gh pr create call and verify --base is NOT "HEAD"
    const createCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'create');
    expect(createCall).toBeDefined();

    const baseIndex = createCall!.indexOf('--base');
    expect(baseIndex).toBeGreaterThan(-1);
    // Should be "main" (resolved from symbolic-ref), NOT "HEAD"
    expect(createCall![baseIndex + 1]).toBe('main');
  });

  // INVARIANT: When "HEAD" can't be resolved, fall back to "main".
  test('falls back to "main" when "HEAD" resolution fails', async () => {
    const ghCalls: string[][] = [];

    const deps: DriverDeps = {
      runGh: async (args) => {
        ghCalls.push([...args]);
        if (args[0] === 'pr' && args[1] === 'create') {
          return ok('https://github.com/owner/repo/pull/790');
        }
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
          return ok(JSON.stringify({ number: 790 }));
        }
        return fail('unexpected gh call');
      },
      runGit: async (args: string[]) => {
        if (args[0] === 'remote' && args[1] === 'get-url') {
          return ok('git@github.com:owner/repo.git');
        }
        // symbolic-ref fails (no origin/HEAD configured)
        if (args[0] === 'symbolic-ref') {
          return fail('ref refs/remotes/origin/HEAD is not a symbolic ref');
        }
        return fail('unexpected git call');
      },
    };

    const task = makeTask({
      metadata: {
        remote_target_branch: 'HEAD',
      },
    });

    const driver = new GitHubDriver(mockConfig, deps);
    const result = await driver.markReadyForReview(task);

    expect(result.metadata).toBeDefined();

    const createCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'create');
    expect(createCall).toBeDefined();

    const baseIndex = createCall!.indexOf('--base');
    expect(baseIndex).toBeGreaterThan(-1);
    // Should fall back to "main", NOT "HEAD"
    expect(createCall![baseIndex + 1]).toBe('main');
  });

  // INVARIANT: When `gh pr create` fails, the driver must surface the stderr
  // instead of silently logging a warning and returning empty metadata. The
  // caller (acceptTask / submitTask) needs the real error to show the user.
  test('propagates gh pr create stderr on failure', async () => {
    const deps: DriverDeps = {
      runGh: async (args) => {
        if (args[0] === 'pr' && args[1] === 'create') {
          return {
            stdout: '',
            stderr: 'HTTP 422: Validation Failed — Head sha can\'t be blank',
            exitCode: 1,
          };
        }
        return fail('unexpected gh call');
      },
      runGit: async (args: string[]) => {
        if (args[0] === 'remote' && args[1] === 'get-url') {
          return ok('git@github.com:owner/repo.git');
        }
        return fail('unexpected git call');
      },
    };

    const task = makeTask({ metadata: { remote_target_branch: 'main' } });
    const driver = new GitHubDriver(mockConfig, deps);

    await expect(driver.markReadyForReview(task)).rejects.toThrow(/gh pr create failed/);
    await expect(driver.markReadyForReview(task)).rejects.toThrow(/Head sha can't be blank/);
    await expect(driver.markReadyForReview(task)).rejects.toThrow(/main/);
  });

  // INVARIANT: Idempotency for the "mark ready" path is resolved by querying
  // `gh pr view --json isDraft` rather than matching stderr substrings from a
  // failed `gh pr ready`. Substring matching was re-introducing the same class
  // of bug the main fix removes (English error strings are not a reliable
  // idempotency check).
  test('skips gh pr ready when PR is already non-draft (state check)', async () => {
    const ghCalls: string[][] = [];
    const deps: DriverDeps = {
      runGh: async (args) => {
        ghCalls.push([...args]);
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('isDraft')) {
          return ok(JSON.stringify({ isDraft: false }));
        }
        return fail('unexpected gh call');
      },
      runGit: async () => fail('unexpected git call'),
    };

    const task = makeTask({
      metadata: { remote_target_branch: 'main', github_remote_ref_id: '42' },
    });
    const driver = new GitHubDriver(mockConfig, deps);

    const result = await driver.markReadyForReview(task);
    expect(result).toEqual({});

    // `gh pr ready` must not be called when the PR is already non-draft.
    const readyCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'ready');
    expect(readyCall).toBeUndefined();
  });

  // INVARIANT: When the PR is actually in draft, we call `gh pr ready`. Any
  // failure from `gh pr ready` in that path is a real failure (not an
  // idempotency artifact) and must propagate with the raw stderr.
  test('propagates gh pr ready stderr when state check says PR is draft', async () => {
    const deps: DriverDeps = {
      runGh: async (args) => {
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('isDraft')) {
          return ok(JSON.stringify({ isDraft: true }));
        }
        if (args[0] === 'pr' && args[1] === 'ready') {
          return {
            stdout: '',
            stderr: 'HTTP 403: Resource not accessible by integration',
            exitCode: 1,
          };
        }
        return fail('unexpected gh call');
      },
      runGit: async () => fail('unexpected git call'),
    };

    const task = makeTask({
      metadata: { remote_target_branch: 'main', github_remote_ref_id: '42' },
    });
    const driver = new GitHubDriver(mockConfig, deps);

    await expect(driver.markReadyForReview(task)).rejects.toThrow(/gh pr ready failed/);
    await expect(driver.markReadyForReview(task)).rejects.toThrow(/Resource not accessible/);
  });

  // INVARIANT: `gh pr view` failure is itself a real failure (auth, missing
  // PR, network) and must propagate — silent fallback would hide real bugs.
  test('propagates gh pr view failure before attempting gh pr ready', async () => {
    const ghCalls: string[][] = [];
    const deps: DriverDeps = {
      runGh: async (args) => {
        ghCalls.push([...args]);
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('isDraft')) {
          return {
            stdout: '',
            stderr: 'HTTP 401: Bad credentials',
            exitCode: 1,
          };
        }
        return fail('unexpected gh call');
      },
      runGit: async () => fail('unexpected git call'),
    };

    const task = makeTask({
      metadata: { remote_target_branch: 'main', github_remote_ref_id: '42' },
    });
    const driver = new GitHubDriver(mockConfig, deps);

    await expect(driver.markReadyForReview(task)).rejects.toThrow(/gh pr view failed/);
    await expect(driver.markReadyForReview(task)).rejects.toThrow(/Bad credentials/);

    // Must not call `gh pr ready` after the state check failed.
    expect(ghCalls.find(c => c[0] === 'pr' && c[1] === 'ready')).toBeUndefined();
  });
});
