import { describe, test, expect } from 'bun:test';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/utils/role-target';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import { GitHubDriver } from '../../src/remote/github-driver';
import type { Task } from '../../src/types';
import type { ResolvedConfig } from '../../src/config/types';
import type { DriverDeps, GhResult } from '../../src/remote/github-driver';

/**
 * Unit tests for `GitHubDriver.approveForMerge` — the ONE review lazy still
 * writes to a PR, and only under `[remote] auto_approve` on a protected
 * target, where the forge refuses the merge without an approval.
 *
 * GitHub returns HTTP 422 (Unprocessable Entity) when a PR author tries to
 * approve their own PR. That is expected: it is logged at debug level and
 * returns null, so nothing reaches the human — warning about the normal
 * outcome on every accept would train the reader to ignore the warnings that
 * matter. Only a real failure returns a warning. It is NOT followed by a
 * comment either: lazy writes no comments to a forge, and a comment is not an
 * approval anyway. GitLab's twin needs a credential probe to draw the same
 * line, because there every refusal is a 401 — see gitlab-driver.test.ts.
 */

describe('GitHubDriver approveForMerge', () => {
  // Minimal config for testing
  const mockConfig: ResolvedConfig = {
    models: {
      default: 'claude-sonnet-4-5-20250929',
      roles: {
        builder: ANTHROPIC_DEFAULT_TARGET,
        agent: ANTHROPIC_DEFAULT_TARGET,
      },
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
    },
    git: {
      default_branch_prefix: 'lazy',
      lfs_check: 'refuse',
    },
    output: {
      shortid_length: 8,
    },
    agents: {},
    agent: {
      agent_id: 'test-agent',
      watchdog_output_timeout_ms: 0, wind_down_timeout_ms: 0,
      effort: 'medium',
    },
    review: { mode: 'low_high', auto_fix: false, gate: 'auto', draft_effort: 'low', review_effort: 'xhigh' },
    builder: {
      effort: 'high',
    },
    chattiness: { default: '', builder: '', agent: '' },
    server: {
      port: 3000,
      sync_interval: 1000,
      bind: '127.0.0.1',
      dashboard_url: '',
    },
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
    docker: {
      dockerfile: '',
      build_inputs: [],
      run_args: [],
    },
    runner: { type: 'docker' as const, permission_mode: 'sandbox' as const, sandbox_allowed_domains: ['*.anthropic.com'], sandbox_deny_read: [], sandbox_deny_write: [], sandbox_allow_weaker_nested: false, verify_sandbox_boundary: 'off' as const },
    documents: {
      path: '',
    },
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

  // Minimal task with a PR number
  const mockTask: Task = {
    id: 'test-task-123',
    code: 'test',
    goal: 'Test task',
    prompt: '',
    type: 'task',
    status: 'blocked',
    model: 'claude-sonnet-4-5-20250929',
    agent_id: 'claude-code',
    created_at: Date.now(),
    completed_at: null,
    target: { kind: 'branch' as const, branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    metadata: {
      github_remote_ref_id: '123', // PR number
    },
    runner_type: null,
    tags: [], pending_sync: 0,
  };

  /**
   * Every `gh` call the driver makes, so a test can assert what did NOT happen.
   */
  function recordingDeps(approveResult: GhResult): { deps: DriverDeps; calls: string[][] } {
    const calls: string[][] = [];
    const deps: DriverDeps = {
      runGh: async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'api' && args.includes('event=APPROVE')) return approveResult;
        return { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      },
      runGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };
    return { deps, calls };
  }

  test('approveForMerge returns null when the approval lands', async () => {
    const { deps, calls } = recordingDeps({ stdout: '{}', stderr: '', exitCode: 0 });
    const driver = new GitHubDriver(mockConfig, deps);

    expect(await driver.approveForMerge(mockTask, 'LGTM')).toBeNull();
    expect(calls.length).toBe(1);
  });

  // INVARIANT: the review body is passed with `--raw-field`, NEVER the typed
  // `--field`. `gh` reads a `--field` value beginning with `@` as a FILE to
  // read and send. The body here is the accept reason a human or the builder
  // typed, so with `[remote] auto_approve` on, an accept reason of
  // `@~/.claude/.credentials.json` would publish that file into a PR review.
  // Asserted on argv because that is where the difference lives — no amount
  // of escaping downstream can undo the wrong flag.
  test('the approve body is sent literally, never as a typed field', async () => {
    const { deps, calls } = recordingDeps({ stdout: '{}', stderr: '', exitCode: 0 });
    const driver = new GitHubDriver(mockConfig, deps);

    await driver.approveForMerge(mockTask, '@/home/user/.claude/.credentials.json');

    const argv = calls[0]!;
    // The body rides --raw-field with its value literally as typed…
    const rawIdx = argv.indexOf('--raw-field');
    expect(rawIdx).toBeGreaterThanOrEqual(0);
    expect(argv[rawIdx + 1]).toBe('body=@/home/user/.claude/.credentials.json');
    // …and no `--field` anywhere carries a body=, which is the file-read flag.
    const typedBody = argv.some(
      (arg, i) => arg === '--field' && String(argv[i + 1] ?? '').startsWith('body='),
    );
    expect(typedBody).toBe(false);
  });

  // INVARIANT: a 422 self-approval is SILENT — debug log, null return. It is
  // the normal outcome for the sole developer `[remote] auto_approve` is
  // documented for (they opened the PR, so GitHub will not let them approve
  // it), and returning a warning surfaces "Auto-approve warning: …422" on
  // every accept they run. It was quiet before this task too, swallowed by
  // the comment fallback that has since been removed.
  test('a 422 self-approval is quiet: no warning, and no comment', async () => {
    const { deps, calls } = recordingDeps({
      stdout: '',
      stderr: 'gh: Unprocessable Entity (HTTP 422)',
      exitCode: 1,
    });
    const driver = new GitHubDriver(mockConfig, deps);

    expect(await driver.approveForMerge(mockTask, 'LGTM')).toBeNull();
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'comment')).toBe(false);
  });

  test('a bare "422" in stderr is recognised as the same expected refusal', async () => {
    const { deps } = recordingDeps({
      stdout: '',
      stderr: 'gh: HTTP 422',
      exitCode: 1,
    });
    const driver = new GitHubDriver(mockConfig, deps);

    expect(await driver.approveForMerge(mockTask, 'LGTM')).toBeNull();
  });

  // INVARIANT: a failed approval reports itself and posts NOTHING. The old
  // code fell back to a `[Lazy Accept]` PR comment, which notified every
  // watcher and was not an approval anyway, so it never unblocked the merge.
  // Lazy writes no comments to a forge (engineer decision, 2026-09-21).
  test('a non-422 approval failure returns a warning and posts no comment', async () => {
    const { deps, calls } = recordingDeps({
      stdout: '',
      stderr: 'gh: HTTP 403: Forbidden',
      exitCode: 1,
    });
    const driver = new GitHubDriver(mockConfig, deps);

    const warning = await driver.approveForMerge(mockTask, 'LGTM');
    expect(warning).toContain('Could not approve PR #123');
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'comment')).toBe(false);
  });

  test('approveForMerge on a task with no PR is a silent no-op', async () => {
    const { deps, calls } = recordingDeps({ stdout: '{}', stderr: '', exitCode: 0 });
    const driver = new GitHubDriver(mockConfig, deps);

    expect(await driver.approveForMerge({ ...mockTask, metadata: null }, 'LGTM')).toBeNull();
    expect(calls).toEqual([]);
  });

  // INVARIANT: lazy writes no reviews or comments to a forge, so the driver
  // has no method that could (engineer decision, 2026-09-21). Typecheck does
  // NOT catch this: an EXTRA method on a class still satisfies the interface,
  // so a well-meaning reinstatement would compile clean. The sibling checks
  // live in test/e2e/remote-driver.test.ts (LocalDriver) and
  // test/unit/gitlab-driver.test.ts (GitLabDriver).
  test('postReviewReport / postAcceptReview / postRejectReview are gone', () => {
    const { deps } = recordingDeps({ stdout: '{}', stderr: '', exitCode: 0 });
    const driver = new GitHubDriver(mockConfig, deps) as unknown as Record<string, unknown>;

    expect(driver.postReviewReport).toBeUndefined();
    expect(driver.postAcceptReview).toBeUndefined();
    expect(driver.postRejectReview).toBeUndefined();
  });
});
