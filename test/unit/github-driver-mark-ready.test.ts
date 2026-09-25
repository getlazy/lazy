import { describe, test, expect } from 'bun:test';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/utils/role-target';
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
  models: { default: 'claude-sonnet-4-5-20250929', roles: { builder: ANTHROPIC_DEFAULT_TARGET, agent: ANTHROPIC_DEFAULT_TARGET } },
  session: { verbose: false, debug: false, auto_commit_instructions: false },
  data: { path: '/tmp/test/.lazy' },
  storage: { backend: 'external', external_path: '' },
  git: { default_branch_prefix: 'lazy', lfs_check: 'refuse' },
  output: { shortid_length: 8 },
  agents: {},
  agent: { agent_id: 'test-agent', watchdog_output_timeout_ms: 0, wind_down_timeout_ms: 0, effort: 'medium' },
  review: { mode: 'low_high', auto_fix: false, gate: 'auto', draft_effort: 'low', review_effort: 'xhigh' },
  builder: { effort: 'high' },
  chattiness: { default: '', builder: '', agent: '' },
  server: { port: 3000, sync_interval: 1000, bind: '127.0.0.1', dashboard_url: '' },
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
  docker: { dockerfile: '', build_inputs: [], run_args: [] },
  runner: { type: 'docker' as const, permission_mode: 'sandbox' as const, sandbox_allowed_domains: ['*.anthropic.com'], sandbox_deny_read: [], sandbox_deny_write: [], sandbox_allow_weaker_nested: false, verify_sandbox_boundary: 'off' as const },
  documents: { path: '' },
  features: {},
  worktree: { include: [] },
  permissions: { protected: [] },
  protection: { enabled: false, protected_branches: [], protected_tasks: [], gate_default_branch: true },
  automation: { maintain: [], react: [], pre_accept: { enabled: false, commands: [], timeout: 600 }, pre_turn: '', pre_turn_timeout: 120, pre_turn_required: false, post_turn: '', post_turn_timeout: 300, accept_check: '', accept_check_timeout: 300 },
  mounts: [],
  serve: { services: [], start_services_cmd: '' },
  credentials: { backend: 'auto' },
  limits: { max_concurrent_builders: 8, max_turns_without_human: 10 },
  cluster: { max_child_fix_rounds: 3 },
  usage_pause: { threshold_percent: 0, credentials: {} },
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

// The seams an explicit human `lazy submit` into an intermediate branch uses
// (src/daemon/submit-target.ts).
describe('GitHubDriver intermediate-branch submit seams', () => {
  const stacked = () => makeTask({ target: { kind: 'task' as const, parentTaskId: 'parent-id' } });

  // INVARIANT: with no explicit base, a task stacked on another task is still
  // REFUSED — the default "no PR for intermediate branches" lives in the
  // driver too, so an automatic caller cannot open one by accident.
  test('refuses a stacked task without an explicit base', async () => {
    const driver = new GitHubDriver(mockConfig, {
      runGh: async () => fail('gh must not be called'),
      runGit: async () => ok('git@github.com:owner/repo.git'),
    });
    await expect(driver.markReadyForReview(stacked())).rejects.toThrow('stacked on another task');
  });

  // INVARIANT: an explicit base is used verbatim as the PR's --base.
  test('opens the PR against an explicit base', async () => {
    const ghCalls: string[][] = [];
    const driver = new GitHubDriver(mockConfig, {
      runGh: async (args) => {
        ghCalls.push([...args]);
        if (args[1] === 'create') return ok('https://github.com/owner/repo/pull/9');
        if (args[1] === 'view') return ok(JSON.stringify({ number: 9 }));
        return fail('unexpected gh call');
      },
      runGit: async () => ok('git@github.com:owner/repo.git'),
    });
    const result = await driver.markReadyForReview(stacked(), { baseBranch: 'lazy/parent' });
    const create = ghCalls.find((c) => c[1] === 'create')!;
    expect(create[create.indexOf('--base') + 1]).toBe('lazy/parent');
    expect(result.metadata?.github_remote_ref_id).toBe('9');
  });

  test('findOpenReviewForBranch returns an open PR with its base, and null for none or closed', async () => {
    let reply: GhResult = ok(JSON.stringify({ url: 'https://github.com/o/r/pull/3', number: 3, state: 'OPEN', baseRefName: 'lazy/parent' }));
    const driver = new GitHubDriver(mockConfig, {
      runGh: async () => reply,
      runGit: async () => ok('git@github.com:owner/repo.git'),
    });
    expect(await driver.findOpenReviewForBranch('lazy/child')).toEqual({
      url: 'https://github.com/o/r/pull/3',
      baseBranch: 'lazy/parent',
      metadata: { github_remote_ref_url: 'https://github.com/o/r/pull/3', github_remote_ref_id: '3' },
    });
    reply = ok(JSON.stringify({ url: 'https://github.com/o/r/pull/3', number: 3, state: 'CLOSED', baseRefName: 'main' }));
    expect(await driver.findOpenReviewForBranch('lazy/child')).toBeNull();
    reply = fail('no pull requests found for branch "lazy/child"');
    expect(await driver.findOpenReviewForBranch('lazy/child')).toBeNull();
  });

  // INVARIANT: failing to ASK is not "no PR" — submit would then open a second one.
  test('findOpenReviewForBranch throws when the forge cannot be asked', async () => {
    const driver = new GitHubDriver(mockConfig, {
      runGh: async () => fail('HTTP 401: Bad credentials'),
      runGit: async () => ok('git@github.com:owner/repo.git'),
    });
    await expect(driver.findOpenReviewForBranch('lazy/child')).rejects.toThrow('Bad credentials');
  });

  test('remoteBranchHead: SHA when present, null when the remote has no such branch, throws otherwise', async () => {
    let reply: GhResult = ok('0123abcd\trefs/heads/lazy/parent\n');
    const driver = new GitHubDriver(mockConfig, {
      runGh: async () => fail('unused'),
      runGit: async () => reply,
    });
    expect(await driver.remoteBranchHead('lazy/parent')).toBe('0123abcd');
    reply = { stdout: '', stderr: '', exitCode: 2 };
    expect(await driver.remoteBranchHead('lazy/parent')).toBeNull();
    reply = { stdout: '', stderr: 'fatal: unable to access', exitCode: 128 };
    await expect(driver.remoteBranchHead('lazy/parent')).rejects.toThrow('unable to access');
  });
});

describe('GitHubDriver getReviewBase', () => {
  const withPr = () => makeTask({ metadata: { github_remote_ref_id: '9', github_remote_ref_url: 'https://github.com/o/r/pull/9' } });

  test('reads the recorded PR\'s base from the forge; null when the task records no PR', async () => {
    const calls: string[][] = [];
    const driver = new GitHubDriver(mockConfig, {
      runGh: async (args) => { calls.push([...args]); return ok(JSON.stringify({ baseRefName: 'lazy/parent' })); },
      runGit: async () => ok('git@github.com:owner/repo.git'),
    });
    expect(await driver.getReviewBase(withPr())).toBe('lazy/parent');
    expect(calls[0].slice(0, 5)).toEqual(['pr', 'view', '9', '--json', 'baseRefName']);
    expect(await driver.getReviewBase(makeTask())).toBeNull();
  });

  // INVARIANT: a base that cannot be read is an error, never "no PR" — a forge
  // merge checked against nothing would land wherever the PR points.
  test('throws when the forge cannot be asked or answers without a base', async () => {
    let reply: GhResult = fail('HTTP 502');
    const driver = new GitHubDriver(mockConfig, {
      runGh: async () => reply,
      runGit: async () => ok('git@github.com:owner/repo.git'),
    });
    await expect(driver.getReviewBase(withPr())).rejects.toThrow('HTTP 502');
    reply = ok('{}');
    await expect(driver.getReviewBase(withPr())).rejects.toThrow('no usable base');
  });
});

describe('GitHubDriver retargetReview', () => {
  const withPr = () => makeTask({ metadata: { github_remote_ref_id: '9' } });

  test('edits the recorded PR\'s base with gh pr edit --base', async () => {
    const calls: string[][] = [];
    const driver = new GitHubDriver(mockConfig, {
      runGh: async (args) => { calls.push([...args]); return ok(); },
      runGit: async () => ok('git@github.com:owner/repo.git'),
    });
    await driver.retargetReview(withPr(), 'main');
    expect(calls[0].slice(0, 5)).toEqual(['pr', 'edit', '9', '--base', 'main']);
  });

  // INVARIANT: a refused retarget throws — the caller then CLOSES the PR
  // rather than leave it merging into a branch the task no longer goes to.
  test('throws when the forge refuses, and when the task records no PR', async () => {
    const driver = new GitHubDriver(mockConfig, {
      runGh: async () => fail('base branch does not exist'),
      runGit: async () => ok('git@github.com:owner/repo.git'),
    });
    await expect(driver.retargetReview(withPr(), 'main')).rejects.toThrow('base branch does not exist');
    await expect(driver.retargetReview(makeTask(), 'main')).rejects.toThrow('records no PR');
  });
});
