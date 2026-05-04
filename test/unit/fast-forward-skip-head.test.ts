import { describe, test, expect } from 'bun:test';
import { GitHubDriver } from '../../src/remote/github-driver';
import { GitLabDriver } from '../../src/remote/gitlab-driver';
import type { DriverDeps, GhResult } from '../../src/remote/github-driver';
import type { GitLabDriverDeps, GlResult } from '../../src/remote/gitlab-driver';
import type { GitResult } from '../../src/utils/git';
import type { ResolvedConfig } from '../../src/config/types';
import type { Task } from '../../src/storage/types';

/**
 * INVARIANT: fastForwardBranch must skip the literal "HEAD" ref.
 *
 * "HEAD" always passes `git rev-parse --verify`, and `git fetch origin HEAD:HEAD`
 * creates a phantom local branch named "HEAD". Both GitHub and GitLab drivers must
 * guard against this at the fastForwardBranch level so that even if "HEAD" leaks
 * into task metadata, sync never creates the phantom branch.
 */

const mockConfig: ResolvedConfig = {
  models: { default: 'claude-sonnet-4-5-20250929' },
  session: { verbose: false, debug: false, auto_commit_instructions: false },
  data: { path: '/tmp/test/.lazy' },
  storage: { backend: 'external', external_path: '', postgres_ssl: false },
  git: { default_branch_prefix: 'lazy' },
  output: { shortid_length: 8 },
  agent: { agent_id: 'test-agent', watchdog_output_timeout_ms: 0, effort: 'medium' },
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

const gitOk = (stdout = ''): GitResult => ({ stdout, stderr: '', exitCode: 0 });

describe('fastForwardBranch skips HEAD', () => {
  // INVARIANT: "HEAD" must never be passed to `git fetch origin HEAD:HEAD`.
  // That command creates a phantom local branch named "HEAD".
  test('GitHubDriver.fetchRemoteState does not call git fetch for HEAD branch', async () => {
    const gitCalls: string[][] = [];
    const deps: DriverDeps = {
      runGh: async (): Promise<GhResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
      runGit: async (args: string[]): Promise<GitResult> => {
        gitCalls.push([...args]);
        // git fetch origin (initial fetch) — success
        if (args[0] === 'fetch' && args.length === 2) return gitOk();
        // git rev-parse --verify <branch> — success for main
        if (args[0] === 'rev-parse' && args[1] === '--verify') return gitOk();
        // git symbolic-ref --short HEAD — return main
        if (args[0] === 'symbolic-ref') return gitOk('main');
        // git merge --ff-only — success
        if (args[0] === 'merge') return gitOk();
        // git fetch origin <refspec> — success
        if (args[0] === 'fetch') return gitOk();
        return gitOk();
      },
    };

    const driver = new GitHubDriver(mockConfig, deps);
    await driver.fetchRemoteState('/tmp/test', ['HEAD', 'develop']);

    // "HEAD" should never appear in a fetch refspec like HEAD:HEAD
    const fetchRefspecs = gitCalls.filter(
      args => args[0] === 'fetch' && args.length > 2 && args[2]?.includes(':'),
    );
    for (const call of fetchRefspecs) {
      expect(call[2]).not.toBe('HEAD:HEAD');
    }

    // But "develop" should be processed normally
    const developCalls = gitCalls.filter(
      args => args.includes('develop'),
    );
    expect(developCalls.length).toBeGreaterThan(0);
  });

  // INVARIANT: Same guard for GitLab driver.
  test('GitLabDriver.fetchRemoteState does not call git fetch for HEAD branch', async () => {
    const gitCalls: string[][] = [];
    const gitlabConfig = { ...mockConfig, remote: { ...mockConfig.remote, driver: 'gitlab' as const } };
    const deps: GitLabDriverDeps = {
      runGl: async (): Promise<GlResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
      runGit: async (args: string[]): Promise<GitResult> => {
        gitCalls.push([...args]);
        if (args[0] === 'fetch' && args.length === 2) return gitOk();
        if (args[0] === 'rev-parse' && args[1] === '--verify') return gitOk();
        if (args[0] === 'symbolic-ref') return gitOk('main');
        if (args[0] === 'merge') return gitOk();
        if (args[0] === 'fetch') return gitOk();
        return gitOk();
      },
    };

    const driver = new GitLabDriver(gitlabConfig, deps);
    await driver.fetchRemoteState('/tmp/test', ['HEAD', 'develop']);

    const fetchRefspecs = gitCalls.filter(
      args => args[0] === 'fetch' && args.length > 2 && args[2]?.includes(':'),
    );
    for (const call of fetchRefspecs) {
      expect(call[2]).not.toBe('HEAD:HEAD');
    }

    const developCalls = gitCalls.filter(
      args => args.includes('develop'),
    );
    expect(developCalls.length).toBeGreaterThan(0);
  });
});

/**
 * INVARIANT: targetBranch must never return literal "HEAD".
 *
 * When a task has "HEAD" stored as remote_target_branch (from legacy code that didn't
 * use resolveDetachedHead), the driver's targetBranch() method must resolve it to the
 * remote's default branch — never pass "HEAD" to the forge API as a PR/MR base.
 */

function makeTask(metadata: Record<string, string>): Task {
  return {
    id: 'test-task-id-12345678',
    code: 'test-code',
    goal: 'Test task',
    prompt: 'Test prompt',
    status: 'working',
    type: 'task',
    agent_id: 'test-agent',
    created_at: Date.now(),
    completed_at: null,
    parent_task_id: null,
    branched_from_sha: null,
    close_reason: null,
    model: null,
    metadata,
    pending_sync: 0,
  };
}

describe('targetBranch resolves HEAD to default branch', () => {
  // INVARIANT: GitLab driver must resolve "HEAD" in metadata to the remote's default branch,
  // not pass it through to `glab mr create --target-branch HEAD`.
  test('GitLabDriver.markReadyForReview resolves HEAD target branch', async () => {
    const glCalls: string[][] = [];
    const gitlabConfig = { ...mockConfig, remote: { ...mockConfig.remote, driver: 'gitlab' as const } };
    const deps: GitLabDriverDeps = {
      runGl: async (args: string[]): Promise<GlResult> => {
        glCalls.push([...args]);
        // mr create — return a fake MR URL
        if (args[0] === 'mr' && args[1] === 'create') {
          return { stdout: 'https://gitlab.com/test/repo/-/merge_requests/1', stderr: '', exitCode: 0 };
        }
        // mr list — no existing MR
        if (args[0] === 'mr' && args[1] === 'list') {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      runGit: async (args: string[]): Promise<GitResult> => {
        // symbolic-ref refs/remotes/origin/HEAD — return "develop" as default branch
        if (args[0] === 'symbolic-ref' && args[1]?.includes('remotes')) {
          return gitOk('refs/remotes/origin/develop');
        }
        return gitOk();
      },
    };

    const driver = new GitLabDriver(gitlabConfig, deps);
    const task = makeTask({ remote_target_branch: 'HEAD' });
    await driver.markReadyForReview(task);

    // Find the glab mr create call and check --target-branch value
    const mrCreateCall = glCalls.find(args => args[0] === 'mr' && args[1] === 'create');
    expect(mrCreateCall).toBeDefined();
    const targetIdx = mrCreateCall!.indexOf('--target-branch');
    expect(targetIdx).toBeGreaterThan(-1);
    // Should be "develop" (from symbolic-ref), not "HEAD"
    expect(mrCreateCall![targetIdx + 1]).toBe('develop');
  });

  // INVARIANT: When remote symbolic-ref fails, GitLab driver falls back to "main", not "HEAD".
  test('GitLabDriver.markReadyForReview falls back to main when default branch unresolvable', async () => {
    const glCalls: string[][] = [];
    const gitlabConfig = { ...mockConfig, remote: { ...mockConfig.remote, driver: 'gitlab' as const } };
    const deps: GitLabDriverDeps = {
      runGl: async (args: string[]): Promise<GlResult> => {
        glCalls.push([...args]);
        if (args[0] === 'mr' && args[1] === 'create') {
          return { stdout: 'https://gitlab.com/test/repo/-/merge_requests/1', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'mr' && args[1] === 'list') {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      runGit: async (args: string[]): Promise<GitResult> => {
        // symbolic-ref fails — can't determine default branch
        if (args[0] === 'symbolic-ref' && args[1]?.includes('remotes')) {
          return { stdout: '', stderr: 'fatal: ref not found', exitCode: 1 };
        }
        return gitOk();
      },
    };

    const driver = new GitLabDriver(gitlabConfig, deps);
    const task = makeTask({ remote_target_branch: 'HEAD' });
    await driver.markReadyForReview(task);

    const mrCreateCall = glCalls.find(args => args[0] === 'mr' && args[1] === 'create');
    expect(mrCreateCall).toBeDefined();
    const targetIdx = mrCreateCall!.indexOf('--target-branch');
    expect(targetIdx).toBeGreaterThan(-1);
    // Should fall back to "main", not "HEAD"
    expect(mrCreateCall![targetIdx + 1]).toBe('main');
  });

  // INVARIANT: GitHub driver also resolves "HEAD" in metadata via resolveDefaultBranch.
  test('GitHubDriver.markReadyForReview resolves HEAD target branch', async () => {
    const ghCalls: string[][] = [];
    const deps: DriverDeps = {
      runGh: async (args: string[]): Promise<GhResult> => {
        ghCalls.push([...args]);
        // pr create — return a fake PR URL
        if (args[0] === 'pr' && args[1] === 'create') {
          return { stdout: 'https://github.com/test/repo/pull/1', stderr: '', exitCode: 0 };
        }
        // pr list — no existing PR
        if (args[0] === 'pr' && args[1] === 'list') {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      runGit: async (args: string[]): Promise<GitResult> => {
        // symbolic-ref refs/remotes/origin/HEAD — return "develop" as default branch
        if (args[0] === 'symbolic-ref' && args[1]?.includes('remotes')) {
          return gitOk('refs/remotes/origin/develop');
        }
        return gitOk();
      },
    };

    const driver = new GitHubDriver(mockConfig, deps);
    const task = makeTask({ remote_target_branch: 'HEAD' });
    await driver.markReadyForReview(task);

    // Find the gh pr create call and check --base value
    const prCreateCall = ghCalls.find(args => args[0] === 'pr' && args[1] === 'create');
    expect(prCreateCall).toBeDefined();
    const baseIdx = prCreateCall!.indexOf('--base');
    expect(baseIdx).toBeGreaterThan(-1);
    // Should be "develop" (from symbolic-ref), not "HEAD"
    expect(prCreateCall![baseIdx + 1]).toBe('develop');
  });
});
