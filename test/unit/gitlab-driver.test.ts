import { describe, test, expect } from 'bun:test';
import { GitLabDriver } from '../../src/remote/gitlab-driver';
import type { Task } from '../../src/types';
import type { ResolvedConfig } from '../../src/config/types';
import type { GitLabDriverDeps, GlResult } from '../../src/remote/gitlab-driver';

/**
 * Unit tests for GitLabDriver.
 *
 * Tests use mocked glab/git subprocess calls to verify driver behavior
 * without requiring a real GitLab instance.
 */

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
    driver: 'gitlab',
    git_remote: 'origin',
    github_auto_push: true,
    github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: false,
    gitlab_auto_push: true,
    gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: false,
  },
  docker: { dockerfile: '', toolchain: '' },
  runner: { type: 'docker' as const },
  documents: { path: '' },
  features: {},
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
    metadata: { gitlab_remote_ref_id: '42', gitlab_remote_ref_url: 'https://gitlab.com/o/r/-/merge_requests/42' },
    ...overrides,
  };
}

const ok = (stdout = ''): GlResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'error'): GlResult => ({ stdout: '', stderr, exitCode: 1 });

describe('GitLabDriver', () => {
  describe('postAcceptReview', () => {
    test('approves MR and posts comment', async () => {
      const glCalls: string[][] = [];
      const mockDeps: GitLabDriverDeps = {
        runGl: (args: string[]) => {
          glCalls.push([...args]);
          if (args[0] === 'mr' && args[1] === 'approve') return ok();
          if (args[0] === 'mr' && args[1] === 'comment') return ok();
          return fail('unexpected call');
        },
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      const warning = await driver.postAcceptReview(makeTask(), 'LGTM');

      expect(warning).toBeNull();
      // Should have called both approve and comment
      expect(glCalls.some(c => c[0] === 'mr' && c[1] === 'approve')).toBe(true);
      expect(glCalls.some(c => c[0] === 'mr' && c[1] === 'comment')).toBe(true);
    });

    test('posts comment even when approve fails (self-approval)', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: (args: string[]) => {
          if (args[0] === 'mr' && args[1] === 'approve') return fail('You cannot approve your own MR');
          if (args[0] === 'mr' && args[1] === 'comment') return ok();
          return fail('unexpected call');
        },
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      const warning = await driver.postAcceptReview(makeTask(), 'LGTM');

      // Should still succeed (comment posted)
      expect(warning).toBeNull();
    });

    test('returns warning when comment fails', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: (args: string[]) => {
          if (args[0] === 'mr' && args[1] === 'approve') return ok();
          if (args[0] === 'mr' && args[1] === 'comment') return fail('Network error');
          return fail('unexpected call');
        },
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      const warning = await driver.postAcceptReview(makeTask(), 'LGTM');

      expect(warning).not.toBeNull();
      expect(warning).toContain('Could not post accept review');
    });

    test('skips when no MR number', async () => {
      let glCalled = false;
      const mockDeps: GitLabDriverDeps = {
        runGl: () => { glCalled = true; return fail(); },
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      const warning = await driver.postAcceptReview(makeTask({ metadata: null }), 'LGTM');

      expect(warning).toBeNull();
      expect(glCalled).toBe(false);
    });
  });

  describe('postRejectReview', () => {
    // INVARIANT: GitLab has no "request changes" review state.
    // Reject review is implemented as a comment.
    test('posts reject comment (GitLab has no request-changes state)', async () => {
      let postedBody = '';
      const mockDeps: GitLabDriverDeps = {
        runGl: (args: string[]) => {
          if (args[0] === 'mr' && args[1] === 'comment') {
            const msgIdx = args.indexOf('--message');
            postedBody = msgIdx >= 0 ? args[msgIdx + 1] : '';
            return ok();
          }
          return fail('unexpected call');
        },
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      const warning = await driver.postRejectReview(makeTask(), 'Needs changes');

      expect(warning).toBeNull();
      expect(postedBody).toContain('[Lazy Reject]');
      expect(postedBody).toContain('Needs changes');
    });

    test('returns warning when comment fails', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: () => fail('Network error'),
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      const warning = await driver.postRejectReview(makeTask(), 'Needs changes');

      expect(warning).not.toBeNull();
      expect(warning).toContain('Could not post reject review');
    });

    test('skips when no MR number', async () => {
      let glCalled = false;
      const mockDeps: GitLabDriverDeps = {
        runGl: () => { glCalled = true; return fail(); },
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      const warning = await driver.postRejectReview(makeTask({ metadata: null }), 'Needs changes');

      expect(warning).toBeNull();
      expect(glCalled).toBe(false);
    });
  });

  describe('postTurnSummary', () => {
    test('posts comment with lazy marker to MR', async () => {
      let postedBody = '';
      const mockDeps: GitLabDriverDeps = {
        runGl: (args: string[]) => {
          if (args[0] === 'mr' && args[1] === 'comment') {
            const msgIdx = args.indexOf('--message');
            postedBody = msgIdx >= 0 ? args[msgIdx + 1] : '';
            return ok();
          }
          return fail('unexpected');
        },
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      await driver.postTurnSummary(makeTask(), 'Turn 1: did things');

      expect(postedBody).toContain('<!-- lazy:turn -->');
      expect(postedBody).toContain('Turn 1: did things');
      expect(postedBody.startsWith('<!-- lazy:turn -->\n')).toBe(true);
    });

    test('skips when no MR number', async () => {
      let glCalled = false;
      const mockDeps: GitLabDriverDeps = {
        runGl: () => { glCalled = true; return fail(); },
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      await driver.postTurnSummary(makeTask({ metadata: null }), 'summary');

      expect(glCalled).toBe(false);
    });

    test('does not throw when posting fails', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: () => fail('Network error'),
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      await driver.postTurnSummary(makeTask(), 'summary');
    });
  });

  describe('getPRState', () => {
    test('returns null when no MR number in metadata', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: () => fail('should not be called'),
        runGit: () => fail('should not be called'),
      };
      const driver = new GitLabDriver(mockConfig, mockDeps);
      const result = await driver.getPRState(makeTask({ metadata: null }));
      expect(result).toBeNull();
    });

    // INVARIANT: GitLab states (opened, closed, merged) must be mapped
    // to the canonical PRState type (OPEN, CLOSED, MERGED).
    test('returns OPEN for opened MR', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: (args: string[]) => {
          if (args[0] === 'mr' && args[1] === 'view') {
            return ok(JSON.stringify({ state: 'opened' }));
          }
          return fail('unexpected');
        },
        runGit: () => ok(),
      };
      const driver = new GitLabDriver(mockConfig, mockDeps);
      const result = await driver.getPRState(makeTask());
      expect(result).toBe('OPEN');
    });

    test('returns MERGED for merged MR', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: (args: string[]) => {
          if (args[0] === 'mr' && args[1] === 'view') {
            return ok(JSON.stringify({ state: 'merged' }));
          }
          return fail('unexpected');
        },
        runGit: () => ok(),
      };
      const driver = new GitLabDriver(mockConfig, mockDeps);
      const result = await driver.getPRState(makeTask());
      expect(result).toBe('MERGED');
    });

    test('returns CLOSED for closed MR', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: (args: string[]) => {
          if (args[0] === 'mr' && args[1] === 'view') {
            return ok(JSON.stringify({ state: 'closed' }));
          }
          return fail('unexpected');
        },
        runGit: () => ok(),
      };
      const driver = new GitLabDriver(mockConfig, mockDeps);
      const result = await driver.getPRState(makeTask());
      expect(result).toBe('CLOSED');
    });

    test('returns null when glab fails', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: () => fail('network error'),
        runGit: () => ok(),
      };
      const driver = new GitLabDriver(mockConfig, mockDeps);
      const result = await driver.getPRState(makeTask());
      expect(result).toBeNull();
    });
  });

  describe('syncComments', () => {
    /** glab handler that reports project as private and delegates API calls */
    function privateRepoGl(apiHandler: (args: string[]) => GlResult): (args: string[]) => GlResult {
      return (args: string[]) => {
        if (args[0] === 'api' && args[1] === 'projects/:id' && args.length === 2) {
          return ok(JSON.stringify({ visibility: 'private' }));
        }
        return apiHandler(args);
      };
    }

    test('returns empty array when no MR number in metadata', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: () => fail('should not be called'),
        runGit: () => fail('should not be called'),
      };
      const driver = new GitLabDriver(mockConfig, mockDeps);
      const result = await driver.syncComments(makeTask({ metadata: null }), '2024-01-01T00:00:00Z');
      expect(result).toEqual([]);
    });

    test('fetches and returns MR notes', async () => {
      const notes = [
        { id: 1, body: 'Looks good!', author: { username: 'alice' }, created_at: '2024-06-01T10:00:00Z', system: false },
        { id: 2, body: 'Fix the typo', author: { username: 'bob' }, created_at: '2024-06-01T11:00:00Z', system: false },
      ];

      const mockDeps: GitLabDriverDeps = {
        runGl: privateRepoGl((args) => {
          if (args[0] === 'api' && args[1].includes('notes')) {
            return ok(JSON.stringify(notes));
          }
          return fail('unexpected');
        }),
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      const result = await driver.syncComments(makeTask(), '2024-06-01T00:00:00Z');

      expect(result.length).toBe(2);
      expect(result[0].author).toBe('alice');
      expect(result[0].body).toBe('Looks good!');
      expect(result[1].author).toBe('bob');
    });

    test('filters out system notes', async () => {
      const notes = [
        { id: 1, body: 'User comment', author: { username: 'alice' }, created_at: '2024-06-01T10:00:00Z', system: false },
        { id: 2, body: 'merged commit abc into main', author: { username: 'gitlab' }, created_at: '2024-06-01T11:00:00Z', system: true },
      ];

      const mockDeps: GitLabDriverDeps = {
        runGl: privateRepoGl((args) => {
          if (args[0] === 'api' && args[1].includes('notes')) {
            return ok(JSON.stringify(notes));
          }
          return fail('unexpected');
        }),
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      const result = await driver.syncComments(makeTask(), '2024-06-01T00:00:00Z');

      expect(result.length).toBe(1);
      expect(result[0].body).toBe('User comment');
    });

    test('filters out comments with lazy marker', async () => {
      const notes = [
        { id: 1, body: 'External comment', author: { username: 'alice' }, created_at: '2024-06-01T10:00:00Z', system: false },
        { id: 2, body: '<!-- lazy:turn -->\nTurn 1 summary', author: { username: 'lazy' }, created_at: '2024-06-01T11:00:00Z', system: false },
      ];

      const mockDeps: GitLabDriverDeps = {
        runGl: privateRepoGl((args) => {
          if (args[0] === 'api' && args[1].includes('notes')) {
            return ok(JSON.stringify(notes));
          }
          return fail('unexpected');
        }),
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      const result = await driver.syncComments(makeTask(), '2024-06-01T00:00:00Z');

      expect(result.length).toBe(1);
      expect(result[0].body).toBe('External comment');
    });

    test('skips comments for public repos by default', async () => {
      let apiCalled = false;
      const mockDeps: GitLabDriverDeps = {
        runGl: (args) => {
          if (args[0] === 'api' && args[1] === 'projects/:id' && args.length === 2) {
            return ok(JSON.stringify({ visibility: 'public' }));
          }
          apiCalled = true;
          return fail('should not reach API');
        },
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      const result = await driver.syncComments(makeTask(), '2024-06-01T00:00:00Z');

      expect(result).toEqual([]);
      expect(apiCalled).toBe(false);
    });

    test('syncs comments for public repos when dangerous flag is enabled', async () => {
      const publicOkConfig: ResolvedConfig = {
        ...mockConfig,
        remote: {
          ...mockConfig.remote,
          gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: true,
        },
      };

      const notes = [
        { id: 1, body: 'Public comment', author: { username: 'alice' }, created_at: '2024-06-01T10:00:00Z', system: false },
      ];

      const mockDeps: GitLabDriverDeps = {
        runGl: (args) => {
          if (args[0] === 'api' && args[1] === 'projects/:id' && args.length === 2) {
            return ok(JSON.stringify({ visibility: 'public' }));
          }
          if (args[0] === 'api' && args[1].includes('notes')) {
            return ok(JSON.stringify(notes));
          }
          return fail('unexpected');
        },
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(publicOkConfig, mockDeps);
      const result = await driver.syncComments(makeTask(), '2024-06-01T00:00:00Z');

      expect(result.length).toBe(1);
      expect(result[0].body).toBe('Public comment');
    });
  });

  describe('checkHealth', () => {
    function healthyDeps(projectViewResult: GlResult): GitLabDriverDeps {
      return {
        runGl: (args) => {
          if (args[0] === '--version') return ok('glab version 1.0.0');
          if (args[0] === 'auth' && args[1] === 'status') return ok('Token scopes: api');
          if (args[0] === 'api' && args[1] === 'projects/:id') return projectViewResult;
          return fail('unexpected glab call');
        },
        runGit: (args) => {
          if (args[0] === 'remote' && args[1] === 'get-url') return ok('git@gitlab.com:owner/repo.git');
          return fail('unexpected git call');
        },
      };
    }

    test('returns structured health checks on success', async () => {
      const deps = healthyDeps(ok(JSON.stringify({ visibility: 'private' })));
      const driver = new GitLabDriver(mockConfig, deps);
      const checks = await driver.checkHealth();

      expect(Array.isArray(checks)).toBe(true);
      expect(checks.length).toBeGreaterThan(0);
      for (const check of checks) {
        expect(['ok', 'warn', 'fail']).toContain(check.state);
        expect(typeof check.what).toBe('string');
      }
    });

    test('reports private repo with comment sync enabled', async () => {
      const deps = healthyDeps(ok(JSON.stringify({ visibility: 'private' })));
      const driver = new GitLabDriver(mockConfig, deps);
      const checks = await driver.checkHealth();

      const repoCheck = checks.find(c => c.what.includes('Private repo'));
      expect(repoCheck).toBeDefined();
      expect(repoCheck!.state).toBe('ok');
    });

    test('warns about public repo with comment sync disabled', async () => {
      const deps = healthyDeps(ok(JSON.stringify({ visibility: 'public' })));
      const driver = new GitLabDriver(mockConfig, deps);
      const checks = await driver.checkHealth();

      const repoCheck = checks.find(c => c.what.includes('Public repo'));
      expect(repoCheck).toBeDefined();
      expect(repoCheck!.state).toBe('warn');
      expect(repoCheck!.what).toContain('disabled');
    });

    test('fails when glab is not installed', async () => {
      const deps: GitLabDriverDeps = {
        runGl: () => fail('glab: command not found'),
        runGit: () => ok(),
      };
      const driver = new GitLabDriver(mockConfig, deps);
      const checks = await driver.checkHealth();

      expect(checks[0].state).toBe('fail');
      expect(checks[0].what).toBe('glab CLI installed');
    });

    test('fails when not authenticated', async () => {
      const deps: GitLabDriverDeps = {
        runGl: (args) => {
          if (args[0] === '--version') return ok('glab version 1.0.0');
          if (args[0] === 'auth') return fail('not authenticated');
          return fail('unexpected');
        },
        runGit: () => ok(),
      };
      const driver = new GitLabDriver(mockConfig, deps);
      const checks = await driver.checkHealth();

      expect(checks.length).toBe(2);
      expect(checks[0].state).toBe('ok'); // glab installed
      expect(checks[1].state).toBe('fail'); // auth failed
      expect(checks[1].what).toBe('GitLab authentication');
    });

    test('warns when remote does not point to GitLab', async () => {
      const deps: GitLabDriverDeps = {
        runGl: (args) => {
          if (args[0] === '--version') return ok('glab version 1.0.0');
          if (args[0] === 'auth' && args[1] === 'status') return ok('Token scopes: api');
          if (args[0] === 'api') return ok(JSON.stringify({ visibility: 'private' }));
          return fail('unexpected');
        },
        runGit: (args) => {
          if (args[0] === 'remote' && args[1] === 'get-url') return ok('git@github.com:owner/repo.git');
          return fail('unexpected');
        },
      };
      const driver = new GitLabDriver(mockConfig, deps);
      const checks = await driver.checkHealth();

      const remoteCheck = checks.find(c => c.what === 'Git remote origin');
      expect(remoteCheck).toBeDefined();
      expect(remoteCheck!.state).toBe('warn');
      expect(remoteCheck!.reason).toContain('does not appear to be GitLab');
    });
  });

  describe('waitForChecks', () => {
    // INVARIANT: waitForChecks polls CI pipeline status and returns
    // when all checks complete or on timeout.
    test('returns passed when pipeline succeeds', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: (args: string[]) => {
          if (args[0] === 'api' && args[1].includes('pipelines')) {
            return ok(JSON.stringify([
              { id: 1, status: 'success', web_url: 'https://gitlab.com/pipeline/1' },
            ]));
          }
          return fail('unexpected');
        },
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      const result = await driver.waitForChecks(makeTask(), { pollInterval: 10 });

      expect(result.passed).toBe(true);
    });

    test('returns failed when pipeline fails', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: (args: string[]) => {
          if (args[0] === 'api' && args[1].includes('pipelines')) {
            return ok(JSON.stringify([
              { id: 1, status: 'failed', web_url: 'https://gitlab.com/pipeline/1' },
            ]));
          }
          return fail('unexpected');
        },
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      const result = await driver.waitForChecks(makeTask(), { pollInterval: 10 });

      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0].name).toContain('Pipeline');
      }
    });

    test('returns passed when no pipelines exist', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: (args: string[]) => {
          if (args[0] === 'api' && args[1].includes('pipelines')) {
            return ok('[]');
          }
          return fail('unexpected');
        },
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      const result = await driver.waitForChecks(makeTask(), { pollInterval: 10 });

      expect(result.passed).toBe(true);
    });

    test('returns passed when no MR number', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: () => fail('should not be called'),
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      const result = await driver.waitForChecks(makeTask({ metadata: {} }), { pollInterval: 10 });

      expect(result.passed).toBe(true);
    });

    test('times out when pipeline stays running', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: (args: string[]) => {
          if (args[0] === 'api' && args[1].includes('pipelines')) {
            return ok(JSON.stringify([
              { id: 1, status: 'running', web_url: 'https://gitlab.com/pipeline/1' },
            ]));
          }
          return fail('unexpected');
        },
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      const result = await driver.waitForChecks(makeTask(), { timeout: 50, pollInterval: 10 });

      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.timedOut).toBe(true);
      }
    });
  });

  describe('merge (mocked)', () => {
    function makeDeps(glHandler: (args: string[], cwd?: string) => GlResult): GitLabDriverDeps {
      return {
        runGl: glHandler,
        runGit: (args: string[]) => {
          if (args[0] === 'push') return ok();
          return fail('unexpected git call');
        },
      };
    }

    test('merges MR when existing MR is open', async () => {
      const glCalls: string[][] = [];

      const deps = makeDeps((args) => {
        glCalls.push([...args]);
        if (args[0] === 'mr' && args[1] === 'view' && args.includes('json')) {
          // After merge command has been called, getPRState should see 'merged'
          const mergeAlreadyCalled = glCalls.some(c => c[0] === 'mr' && c[1] === 'merge');
          const state = mergeAlreadyCalled ? 'merged' : 'opened';
          return ok(JSON.stringify({ web_url: 'https://gitlab.com/o/r/-/merge_requests/42', iid: 42, state }));
        }
        if (args[0] === 'mr' && args[1] === 'merge') {
          return ok();
        }
        return fail('unexpected glab call');
      });

      const driver = new GitLabDriver(mockConfig, deps);
      const result = await driver.merge({
        sourceBranch: 'lazy/test1234',
        targetBranch: 'main',
        task: makeTask(),
        taskShortId: 'test1234',
        root: '/tmp/test',
      });

      expect(result.status).toBe('merged');
      const mergeCall = glCalls.find(c => c[0] === 'mr' && c[1] === 'merge');
      expect(mergeCall).toBeDefined();
    });

    test('creates replacement MR when existing is closed', async () => {
      const glCalls: string[][] = [];

      const deps = makeDeps((args) => {
        glCalls.push([...args]);
        if (args[0] === 'mr' && args[1] === 'view' && args.includes('json') && !args.includes('number')) {
          // First call: findExistingMR returns closed
          if (!glCalls.some(c => c[0] === 'mr' && c[1] === 'create')) {
            return ok(JSON.stringify({ web_url: 'https://gitlab.com/o/r/-/merge_requests/42', iid: 42, state: 'closed' }));
          }
          // After create: getMRNumber call
          return ok(JSON.stringify({ iid: 99 }));
        }
        if (args[0] === 'mr' && args[1] === 'create') {
          return ok('https://gitlab.com/o/r/-/merge_requests/99');
        }
        if (args[0] === 'mr' && args[1] === 'merge') {
          return ok();
        }
        return fail('unexpected glab call');
      });

      const driver = new GitLabDriver(mockConfig, deps);
      const result = await driver.merge({
        sourceBranch: 'lazy/test1234',
        targetBranch: 'main',
        task: makeTask(),
        taskShortId: 'test1234',
        root: '/tmp/test',
      });

      expect(result.status).toBe('merged');
      const createCall = glCalls.find(c => c[0] === 'mr' && c[1] === 'create');
      expect(createCall).toBeDefined();
    });

    test('fails with push error', async () => {
      const deps: GitLabDriverDeps = {
        runGl: () => fail('unexpected'),
        runGit: (args: string[]) => {
          if (args[0] === 'push') return fail('no remote');
          return fail('unexpected');
        },
      };

      const driver = new GitLabDriver(mockConfig, deps);
      const result = await driver.merge({
        sourceBranch: 'lazy/test1234',
        targetBranch: 'main',
        task: makeTask(),
        taskShortId: 'test1234',
        root: '/tmp/test',
      });

      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.isConflict).toBeFalsy();
    });

    test('detects conflicts', async () => {
      const deps = makeDeps((args) => {
        if (args[0] === 'mr' && args[1] === 'view') {
          return ok(JSON.stringify({
            web_url: 'https://gitlab.com/o/r/-/merge_requests/42', iid: 42, state: 'opened',
            has_conflicts: true, merge_status: 'cannot_be_merged',
          }));
        }
        if (args[0] === 'mr' && args[1] === 'merge') {
          return fail('cannot be merged');
        }
        return fail('unexpected');
      });

      const driver = new GitLabDriver(mockConfig, deps);
      const result = await driver.merge({
        sourceBranch: 'lazy/test1234',
        targetBranch: 'main',
        task: makeTask(),
        taskShortId: 'test1234',
        root: '/tmp/test',
      });

      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.isConflict).toBe(true);
    });

    // INVARIANT: When merge() creates a replacement MR (because the original is stale),
    // the new MR metadata must be returned even when the merge subsequently fails.
    // Without this, the task keeps pointing to the stale MR forever, causing cascading
    // failures: external-close checks see the stale MR and incorrectly close the task.
    test('returns replacement MR metadata on merge conflict', async () => {
      const glCalls: string[][] = [];

      const deps = makeDeps((args) => {
        glCalls.push([...args]);
        if (args[0] === 'mr' && args[1] === 'view' && args.includes('json')) {
          const mergeWasCalled = glCalls.some(c => c[0] === 'mr' && c[1] === 'merge');
          if (mergeWasCalled) {
            // Post-merge failure detection: return conflict data
            return ok(JSON.stringify({ has_conflicts: true, merge_status: 'cannot_be_merged' }));
          }
          // Pre-merge: findExistingMR or getMRNumber
          if (!glCalls.some(c => c[0] === 'mr' && c[1] === 'create')) {
            return ok(JSON.stringify({ web_url: 'https://gitlab.com/o/r/-/merge_requests/42', iid: 42, state: 'closed' }));
          }
          // After create: getMRNumber call
          return ok(JSON.stringify({ iid: 99 }));
        }
        if (args[0] === 'mr' && args[1] === 'create') {
          return ok('https://gitlab.com/o/r/-/merge_requests/99');
        }
        if (args[0] === 'mr' && args[1] === 'merge') {
          return fail('cannot be merged');
        }
        return fail('unexpected glab call');
      });

      const driver = new GitLabDriver(mockConfig, deps);
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
        expect(result.metadata?.gitlab_remote_ref_url).toBe('https://gitlab.com/o/r/-/merge_requests/99');
        expect(result.metadata?.gitlab_remote_ref_id).toBe('99');
      }
    });

    // INVARIANT: Same as above but for generic (non-conflict) merge errors.
    test('returns replacement MR metadata on generic merge error', async () => {
      const glCalls: string[][] = [];

      const deps = makeDeps((args) => {
        glCalls.push([...args]);
        if (args[0] === 'mr' && args[1] === 'view' && args.includes('json') && !args.includes('number')) {
          if (!glCalls.some(c => c[0] === 'mr' && c[1] === 'create')) {
            return ok(JSON.stringify({ web_url: 'https://gitlab.com/o/r/-/merge_requests/42', iid: 42, state: 'closed' }));
          }
          return ok(JSON.stringify({ iid: 99 }));
        }
        if (args[0] === 'mr' && args[1] === 'create') {
          return ok('https://gitlab.com/o/r/-/merge_requests/99');
        }
        if (args[0] === 'mr' && args[1] === 'merge') {
          return fail('branch protection rule violation');
        }
        return fail('unexpected glab call');
      });

      const driver = new GitLabDriver(mockConfig, deps);
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
        expect(result.metadata).toBeDefined();
        expect(result.metadata?.gitlab_remote_ref_url).toBe('https://gitlab.com/o/r/-/merge_requests/99');
        expect(result.metadata?.gitlab_remote_ref_id).toBe('99');
      }
    });

    // When no replacement MR is needed (original is still open), metadata should
    // be undefined on failure — there's nothing new to persist.
    test('does not return metadata on conflict when no replacement MR was created', async () => {
      const deps = makeDeps((args) => {
        if (args[0] === 'mr' && args[1] === 'view') {
          return ok(JSON.stringify({
            web_url: 'https://gitlab.com/o/r/-/merge_requests/42', iid: 42, state: 'opened',
            has_conflicts: true, merge_status: 'cannot_be_merged',
          }));
        }
        if (args[0] === 'mr' && args[1] === 'merge') {
          return fail('cannot be merged');
        }
        return fail('unexpected');
      });

      const driver = new GitLabDriver(mockConfig, deps);
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

    // INVARIANT: When the pipeline is running and glab mr merge fails with
    // a pipeline-related error, merge() returns 'pending' instead of 'failed'.
    // This tells the accept command to set the task to 'merging' status.
    test('returns pending when pipeline must succeed', async () => {
      const deps = makeDeps((args) => {
        if (args[0] === 'mr' && args[1] === 'view') {
          return ok(JSON.stringify({
            web_url: 'https://gitlab.com/o/r/-/merge_requests/42', iid: 42, state: 'opened',
            head_pipeline: { status: 'running' },
            detailed_merge_status: 'ci_still_running',
          }));
        }
        if (args[0] === 'mr' && args[1] === 'merge') {
          return fail('Pipeline must succeed before merging');
        }
        return fail('unexpected');
      });

      const driver = new GitLabDriver(mockConfig, deps);
      const result = await driver.merge({
        sourceBranch: 'lazy/test1234',
        targetBranch: 'main',
        task: makeTask(),
        taskShortId: 'test1234',
        root: '/tmp/test',
      });

      expect(result.status).toBe('pending');
      if (result.status === 'pending') {
        expect(result.reason).toContain('Pipeline');
      }
    });

    // INVARIANT: When glab mr merge succeeds but the MR is still open (auto-merge
    // was set), merge() returns 'pending' instead of 'merged'. The task should be
    // set to 'merging' to wait for the pipeline to finish and auto-merge to complete.
    test('returns pending when auto-merge is set (MR still open after merge command)', async () => {
      const deps = makeDeps((args) => {
        if (args[0] === 'mr' && args[1] === 'view') {
          // MR is still open even after the merge command succeeded (auto-merge was set)
          return ok(JSON.stringify({ web_url: 'https://gitlab.com/o/r/-/merge_requests/42', iid: 42, state: 'opened' }));
        }
        if (args[0] === 'mr' && args[1] === 'merge') {
          return ok(); // glab mr merge succeeds (sets auto-merge)
        }
        return fail('unexpected');
      });

      const driver = new GitLabDriver(mockConfig, deps);
      const result = await driver.merge({
        sourceBranch: 'lazy/test1234',
        targetBranch: 'main',
        task: makeTask(),
        taskShortId: 'test1234',
        root: '/tmp/test',
      });

      expect(result.status).toBe('pending');
      if (result.status === 'pending') {
        expect(result.reason).toContain('Auto-merge');
      }
    });

    // INVARIANT: When the branch is already merged into the target, merge()
    // returns 'merged' immediately without making any glab API calls.
    test('returns merged when branch is already merged into target', async () => {
      const glCalls: string[][] = [];

      const deps: GitLabDriverDeps = {
        runGl: (args) => {
          glCalls.push([...args]);
          return fail('should not be called');
        },
        runGit: (args: string[]) => {
          // isBranchMerged check: merge-base --is-ancestor returns success
          if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return ok();
          if (args[0] === 'push') return ok();
          return fail('unexpected git call');
        },
      };

      const driver = new GitLabDriver(mockConfig, deps);
      const result = await driver.merge({
        sourceBranch: 'lazy/test1234',
        targetBranch: 'main',
        task: makeTask(),
        taskShortId: 'test1234',
        root: '/tmp/test',
      });

      expect(result.status).toBe('merged');
      // Should not have called any glab commands
      expect(glCalls.length).toBe(0);
    });
  });

  describe('cleanup', () => {
    test('closes open MR', async () => {
      const glCalls: string[][] = [];
      const mockDeps: GitLabDriverDeps = {
        runGl: (args: string[]) => {
          glCalls.push([...args]);
          if (args[0] === 'mr' && args[1] === 'view') {
            return ok(JSON.stringify({ web_url: 'https://gitlab.com/o/r/-/merge_requests/42', iid: 42, state: 'opened' }));
          }
          if (args[0] === 'mr' && args[1] === 'close') {
            return ok();
          }
          return fail('unexpected');
        },
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      await driver.cleanup('lazy/test1234');

      const closeCall = glCalls.find(c => c[0] === 'mr' && c[1] === 'close');
      expect(closeCall).toBeDefined();
    });

    test('skips when no MR exists', async () => {
      let closeCalled = false;
      const mockDeps: GitLabDriverDeps = {
        runGl: (args: string[]) => {
          if (args[0] === 'mr' && args[1] === 'view') return fail('not found');
          if (args[0] === 'mr' && args[1] === 'close') { closeCalled = true; return ok(); }
          return fail('unexpected');
        },
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      await driver.cleanup('lazy/test1234');

      expect(closeCalled).toBe(false);
    });
  });

  describe('metadata accessors', () => {
    // INVARIANT: GitLab driver uses gitlab_remote_* prefixed keys to avoid
    // collision with GitHub driver metadata when switching drivers.
    test('metadata key methods return gitlab_remote_* prefixed names', () => {
      const driver = new GitLabDriver(mockConfig);
      expect(driver.commentSyncedAtKey()).toBe('gitlab_remote_last_comment_synced_at');
      expect(driver.postedTurnSeqKey()).toBe('gitlab_remote_last_posted_turn_seq');
      expect(driver.postedNoteAtKey()).toBe('gitlab_remote_last_posted_note_at');
    });

    test('getLastCommentSyncedAt reads only gitlab_remote_* key', () => {
      const driver = new GitLabDriver(mockConfig);

      const task1 = makeTask({ metadata: { gitlab_remote_last_comment_synced_at: '2024-06-01T00:00:00Z' } });
      expect(driver.getLastCommentSyncedAt(task1)).toBe('2024-06-01T00:00:00Z');

      // Does NOT fall back to unprefixed keys (isolation from GitHub)
      const task2 = makeTask({ metadata: { remote_last_comment_synced_at: '2024-01-01T00:00:00Z' } });
      expect(driver.getLastCommentSyncedAt(task2)).toBeUndefined();

      const task3 = makeTask({ metadata: null });
      expect(driver.getLastCommentSyncedAt(task3)).toBeUndefined();
    });

    test('getLastPostedTurnSeq reads only gitlab_remote_* key', () => {
      const driver = new GitLabDriver(mockConfig);

      const task1 = makeTask({ metadata: { gitlab_remote_last_posted_turn_seq: '5' } });
      expect(driver.getLastPostedTurnSeq(task1)).toBe(5);

      // Does NOT fall back to unprefixed keys
      const task2 = makeTask({ metadata: { remote_last_posted_turn_seq: '3' } });
      expect(driver.getLastPostedTurnSeq(task2)).toBe(-1);

      const task3 = makeTask({ metadata: null });
      expect(driver.getLastPostedTurnSeq(task3)).toBe(-1);
    });

    test('getLastPostedNoteAt reads only gitlab_remote_* key', () => {
      const driver = new GitLabDriver(mockConfig);

      const task1 = makeTask({ metadata: { gitlab_remote_last_posted_note_at: '2024-06-01' } });
      expect(driver.getLastPostedNoteAt(task1)).toBe('2024-06-01');

      // Does NOT fall back to unprefixed keys
      const task2 = makeTask({ metadata: { remote_last_posted_note_at: '2024-01-01' } });
      expect(driver.getLastPostedNoteAt(task2)).toBeUndefined();
    });

    test('validateAccept returns error when no remote ref', () => {
      const driver = new GitLabDriver(mockConfig);
      const task = makeTask({ metadata: null });
      const result = driver.validateAccept(task);
      expect(result).toContain('no remote reference');
    });

    test('validateAccept returns null when remote ref exists', () => {
      const driver = new GitLabDriver(mockConfig);
      const task = makeTask({ metadata: { gitlab_remote_ref_id: '42' } });
      expect(driver.validateAccept(task)).toBeNull();
    });
  });

  describe('canImport', () => {
    test('matches GitLab MR URLs', () => {
      const driver = new GitLabDriver(mockConfig);
      expect(driver.canImport('https://gitlab.com/org/repo/-/merge_requests/42')).toBe(true);
      expect(driver.canImport('https://gitlab.com/some-org/my-repo/-/merge_requests/1')).toBe(true);
    });

    test('matches self-hosted GitLab URLs', () => {
      const driver = new GitLabDriver(mockConfig);
      expect(driver.canImport('https://gitlab.company.com/org/repo/-/merge_requests/42')).toBe(true);
    });

    test('rejects non-GitLab URLs', () => {
      const driver = new GitLabDriver(mockConfig);
      expect(driver.canImport('https://github.com/org/repo/pull/42')).toBe(false);
      expect(driver.canImport('https://example.com/something')).toBe(false);
    });

    test('rejects non-MR GitLab URLs', () => {
      const driver = new GitLabDriver(mockConfig);
      expect(driver.canImport('https://gitlab.com/org/repo')).toBe(false);
      expect(driver.canImport('https://gitlab.com/org/repo/-/issues/42')).toBe(false);
    });
  });

  describe('importUrl', () => {
    test('imports MR with title, branch, and metadata', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: (args) => {
          if (args[0] === 'mr' && args[1] === 'view') {
            return ok(JSON.stringify({
              title: 'Fix authentication bug',
              source_branch: 'fix/auth-bug',
              state: 'opened',
              web_url: 'https://gitlab.com/org/repo/-/merge_requests/42',
              iid: 42,
              description: 'This fixes the auth bug',
            }));
          }
          if (args[0] === 'api' && args[1].includes('notes')) {
            return ok(JSON.stringify([]));
          }
          return fail('unexpected');
        },
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      const result = await driver.importUrl('https://gitlab.com/org/repo/-/merge_requests/42', {});

      expect(result.goal).toBe('Fix authentication bug');
      expect(result.branch).toBe('fix/auth-bug');
      expect(result.metadata.gitlab_remote_ref_url).toBe('https://gitlab.com/org/repo/-/merge_requests/42');
      expect(result.metadata.gitlab_remote_ref_id).toBe('42');
      expect(result.metadata.gitlab_remote_ref_state).toBe('opened');
    });

    test('throws when URL has no MR number', async () => {
      const driver = new GitLabDriver(mockConfig);
      await expect(driver.importUrl('https://gitlab.com/org/repo', {}))
        .rejects.toThrow('Cannot parse MR number');
    });

    test('throws when glab mr view fails', async () => {
      const mockDeps: GitLabDriverDeps = {
        runGl: () => fail('not found'),
        runGit: () => ok(),
      };

      const driver = new GitLabDriver(mockConfig, mockDeps);
      await expect(driver.importUrl('https://gitlab.com/org/repo/-/merge_requests/999', {}))
        .rejects.toThrow('Failed to fetch MR !999');
    });
  });

  describe('formatImportedComment', () => {
    test('formats MR comment with remote dedup marker', () => {
      const driver = new GitLabDriver(mockConfig);
      const comment = { id: '123', body: 'Review comment', author: 'alice', createdAt: '2024-06-01' };
      const task = makeTask();

      const result = driver.formatImportedComment(comment, task);

      expect(result).toContain('[MR !42 @alice]');
      expect(result).toContain('{remote:123}');
      expect(result).toContain('Review comment');
    });

    test('includes file path and line for inline comments', () => {
      const driver = new GitLabDriver(mockConfig);
      const comment = { id: '123', body: 'Fix this', author: 'bob', createdAt: '2024-06-01', path: 'src/main.ts', line: 42 };
      const task = makeTask();

      const result = driver.formatImportedComment(comment, task);

      expect(result).toContain('(on file: src/main.ts, line 42)');
    });
  });

  describe('isImportedComment', () => {
    test('detects comments imported from GitLab', () => {
      const driver = new GitLabDriver(mockConfig);
      expect(driver.isImportedComment('[MR !42 @alice] {remote:123} Some comment')).toBe(true);
      expect(driver.isImportedComment('[MR !42 @alice] {gl:123} Some comment')).toBe(true);
    });

    test('rejects non-imported comments', () => {
      const driver = new GitLabDriver(mockConfig);
      expect(driver.isImportedComment('Regular comment')).toBe(false);
      expect(driver.isImportedComment('[PR #42 @alice] {remote:123} GitHub comment')).toBe(false);
    });
  });

  describe('fetchBranch (mocked)', () => {
    test('returns false when remote branch has no new commits', async () => {
      const gitCalls: string[][] = [];
      const deps: GitLabDriverDeps = {
        runGl: () => fail('should not be called'),
        runGit: (args) => {
          gitCalls.push([...args]);
          if (args[0] === 'fetch') return ok();
          if (args[0] === 'rev-list') return ok('0');
          return fail('unexpected');
        },
      };

      const driver = new GitLabDriver(mockConfig, deps);
      const result = await driver.fetchBranch('lazy/test1234', '/tmp/worktree');

      expect(result).toBe(false);
    });

    test('returns true when remote has new commits', async () => {
      const deps: GitLabDriverDeps = {
        runGl: () => fail('should not be called'),
        runGit: (args) => {
          if (args[0] === 'fetch') return ok();
          if (args[0] === 'rev-list') return ok('3');
          return fail('unexpected');
        },
      };

      const driver = new GitLabDriver(mockConfig, deps);
      const result = await driver.fetchBranch('lazy/test1234', '/tmp/worktree');

      expect(result).toBe(true);
    });

    test('throws when fetch fails', async () => {
      const deps: GitLabDriverDeps = {
        runGl: () => fail('should not be called'),
        runGit: (args) => {
          if (args[0] === 'fetch') return fail('Could not resolve host');
          return fail('unexpected');
        },
      };

      const driver = new GitLabDriver(mockConfig, deps);
      await expect(driver.fetchBranch('lazy/test1234', '/tmp/worktree'))
        .rejects.toThrow('Failed to fetch branch');
    });
  });

  describe('resolveUpstreamRef (mocked)', () => {
    test('fetches and returns origin/<branch> on success', async () => {
      const deps: GitLabDriverDeps = {
        runGl: () => fail('should not be called'),
        runGit: (args) => {
          if (args[0] === 'fetch') return ok();
          return fail('unexpected');
        },
      };

      const driver = new GitLabDriver(mockConfig, deps);
      const result = await driver.resolveUpstreamRef('main', '/tmp/worktree');

      expect(result).toBe('origin/main');
    });

    // INVARIANT: resolveUpstreamRef must throw on fetch failure so the caller
    // can warn loudly. Silent fallback to local ref causes stale merges.
    test('throws on fetch failure instead of silently falling back', async () => {
      const deps: GitLabDriverDeps = {
        runGl: () => fail('should not be called'),
        runGit: (args) => {
          if (args[0] === 'fetch') return fail('Could not resolve host');
          return fail('unexpected');
        },
      };

      const driver = new GitLabDriver(mockConfig, deps);
      await expect(driver.resolveUpstreamRef('main', '/tmp/worktree'))
        .rejects.toThrow('Failed to fetch origin/main from origin');
    });
  });

  describe('fastForwardLocal (mocked)', () => {
    // INVARIANT: After a successful remote accept, the local parent branch
    // must be fast-forwarded to match origin.
    test('uses fetch + merge --ff-only when target branch is checked out', async () => {
      const gitCalls: string[][] = [];
      const deps: GitLabDriverDeps = {
        runGl: () => fail('should not be called'),
        runGit: (args) => {
          gitCalls.push([...args]);
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('main');
          if (args[0] === 'fetch' && args[1] === 'origin' && args[2] === 'main') return ok();
          if (args[0] === 'merge' && args[1] === '--ff-only') return ok();
          return fail('unexpected');
        },
      };

      const driver = new GitLabDriver(mockConfig, deps);
      const result = await driver.fastForwardLocal('main', '/tmp/repo');

      expect(result.success).toBe(true);
      expect(gitCalls.some(c => c[0] === 'merge' && c[1] === '--ff-only')).toBe(true);
    });

    test('uses refspec fetch when target branch is NOT checked out', async () => {
      const gitCalls: string[][] = [];
      const deps: GitLabDriverDeps = {
        runGl: () => fail('should not be called'),
        runGit: (args) => {
          gitCalls.push([...args]);
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('lazy/abc12345');
          if (args[0] === 'fetch' && args[1] === 'origin' && args[2] === 'main:main') return ok();
          return fail('unexpected');
        },
      };

      const driver = new GitLabDriver(mockConfig, deps);
      const result = await driver.fastForwardLocal('main', '/tmp/repo');

      expect(result.success).toBe(true);
      expect(gitCalls.some(c => c[0] === 'fetch' && c[2] === 'main:main')).toBe(true);
    });

    test('returns warning when branch has diverged', async () => {
      const deps: GitLabDriverDeps = {
        runGl: () => fail('should not be called'),
        runGit: (args) => {
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('main');
          if (args[0] === 'fetch') return ok();
          if (args[0] === 'merge' && args[1] === '--ff-only') return fail('Not possible to fast-forward');
          return fail('unexpected');
        },
      };

      const driver = new GitLabDriver(mockConfig, deps);
      const result = await driver.fastForwardLocal('main', '/tmp/repo');

      expect(result.success).toBe(false);
      expect(result.warning).toContain('diverged');
    });
  });
});
