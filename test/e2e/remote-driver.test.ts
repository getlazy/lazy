import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { createDriver, LocalDriver, GitHubDriver, GitLabDriver } from '../../src/remote';
import type { GhResult, DriverDeps, RemoteComment } from '../../src/remote';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import type { ResolvedConfig } from '../../src/config/types';
import type { Task } from '../../src/types';
import { buildRemoteCommentsContext } from '../../src/cli/commands/shared';
import { formatAgentTurnSummary, formatHumanReviewTurn, formatNoteComment } from '../../src/cli/commands/sync';

describe('remote driver', () => {
  describe('createDriver factory', () => {
    test('returns LocalDriver for "local" config', () => {
      const config: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'local' } };
      const driver = createDriver(config);
      expect(driver).toBeInstanceOf(LocalDriver);
    });

    test('returns LocalDriver for default config', () => {
      const driver = createDriver(DEFAULT_CONFIG);
      expect(driver).toBeInstanceOf(LocalDriver);
    });

    test('returns GitHubDriver for "github" config', () => {
      const config: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };
      const driver = createDriver(config);
      expect(driver).toBeInstanceOf(GitHubDriver);
    });

    test('returns GitLabDriver for "gitlab" config', () => {
      const config: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'gitlab' } };
      const driver = createDriver(config);
      expect(driver).toBeInstanceOf(GitLabDriver);
    });

    test('throws for unknown driver', () => {
      const config: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'unknown' } };
      expect(() => createDriver(config)).toThrow('Unknown remote driver');
    });
  });

  describe('LocalDriver no-op methods', () => {
    test('pushBranch is a no-op', async () => {
      const driver = new LocalDriver();
      await driver.pushBranch('some-branch');
    });

    test('publishBranch is a no-op', async () => {
      const driver = new LocalDriver();
      const task = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: null };
      const result = await driver.publishBranch({ branch: 'some-branch', targetBranch: 'main', task });
      expect(result).toEqual({});
    });

    test('syncComments returns empty array', async () => {
      const driver = new LocalDriver();
      const task = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: null };
      const result = await driver.syncComments(task, '2024-01-01');
      expect(result).toEqual([]);
    });

    test('getPRState returns null', async () => {
      const driver = new LocalDriver();
      const task = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: null };
      const result = await driver.getPRState(task);
      expect(result).toBeNull();
    });

    test('postTurnSummary is a no-op', async () => {
      const driver = new LocalDriver();
      const task = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: null };
      await driver.postTurnSummary(task, 'summary');
    });

    test('markReadyForReview is a no-op', async () => {
      const driver = new LocalDriver();
      const task = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: null };
      await driver.markReadyForReview(task);
    });

    test('cleanup is a no-op', async () => {
      const driver = new LocalDriver();
      await driver.cleanup('some-branch');
    });

    test('checkHealth returns ok', async () => {
      const driver = new LocalDriver();
      const result = await driver.checkHealth();
      expect(result).toEqual([{ state: 'ok', what: 'Local driver (no remote)' }]);
    });

    test('validateAccept always returns null (no preconditions)', () => {
      const driver = new LocalDriver();
      const task = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: null };
      expect(driver.validateAccept(task)).toBeNull();
    });

    test('fetchRemoteState throws (no remote to sync)', async () => {
      const driver = new LocalDriver();
      await expect(driver.fetchRemoteState('/tmp/test')).rejects.toThrow('Sync requires a remote driver');
    });

    test('getLastCommentSyncedAt returns undefined', () => {
      const driver = new LocalDriver();
      const task = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: null };
      expect(driver.getLastCommentSyncedAt(task)).toBeUndefined();
    });

    test('getLastPostedTurnSeq returns -1', () => {
      const driver = new LocalDriver();
      const task = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: null };
      expect(driver.getLastPostedTurnSeq(task)).toBe(-1);
    });

    test('getLastPostedNoteAt returns undefined', () => {
      const driver = new LocalDriver();
      const task = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: null };
      expect(driver.getLastPostedNoteAt(task)).toBeUndefined();
    });

    test('metadata key methods return canonical remote_* names', () => {
      const driver = new LocalDriver();
      expect(driver.commentSyncedAtKey()).toBe('remote_last_comment_synced_at');
      expect(driver.postedTurnSeqKey()).toBe('remote_last_posted_turn_seq');
      expect(driver.postedNoteAtKey()).toBe('remote_last_posted_note_at');
    });

    // INVARIANT: LocalDriver.fastForwardLocal is a no-op because there is no
    // remote to sync from. It must always return success.
    test('fastForwardLocal is a no-op that returns success', async () => {
      const driver = new LocalDriver();
      const result = await driver.fastForwardLocal('main', '/tmp/nonexistent');
      expect(result).toEqual({ success: true });
    });
  });

  describe('merge with LocalDriver (e2e)', () => {
    let ctx: TestContext;

    beforeEach(async () => {
      ctx = await setupTestLazy();
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    test('merge uses LocalDriver by default and merges successfully', async () => {
      const taskId = await createTask(ctx, 'Driver accept test', 'Add a file');

      const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
        env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
      });
      expectSuccess(startResult);

      // Make a commit in the worktree
      const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
      const worktreeFile = join(worktreePath, 'driver-test.txt');
      writeFileSync(worktreeFile, 'driver test content\n');

      const gitAdd = await ctx.git('-C', worktreePath, 'add', 'driver-test.txt');
      expect(gitAdd.exitCode).toBe(0);

      const gitCommit = await ctx.git('-C', worktreePath, 'commit', '-m', 'Add driver test file');
      expect(gitCommit.exitCode).toBe(0);

      // Accept should succeed via LocalDriver
      const acceptResult = await ctx.lazy(['accept', taskId]);
      expectSuccess(acceptResult);
      expectOutput(acceptResult, 'accepted and merged');
    });

    test('unknown driver config is a hard failure at start time', async () => {
      // Write a lazy.toml with unknown driver
      const configPath = join(ctx.root, 'lazy.toml');
      writeFileSync(configPath, '[remote]\ndriver = "nonexistent"\n');

      const taskId = await createTask(ctx, 'Unknown driver test', 'Add a file');

      // Start should fail hard — invalid driver config cannot proceed
      const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
        env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
      });
      expectFailure(startResult);
    });
  });

  describe('GitHubDriver unit tests', () => {
    test('syncComments returns empty array when no PR metadata', async () => {
      const config: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };
      const driver = new GitHubDriver(config);
      const task = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: null };
      const result = await driver.syncComments(task, '2024-01-01');
      expect(result).toEqual([]);
    });

    test('postTurnSummary is a no-op when no PR metadata', async () => {
      const config: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };
      const driver = new GitHubDriver(config);
      const task = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: null };
      await driver.postTurnSummary(task, 'summary');
    });

    test('checkHealth returns structured health checks', async () => {
      const config: ResolvedConfig = {
        ...DEFAULT_CONFIG,
        remote: { ...DEFAULT_CONFIG.remote, driver: 'github' },
      };
      const driver = new GitHubDriver(config);
      const result = await driver.checkHealth();
      // In CI/test environments gh may or may not be installed,
      // so we just verify the structure is correct
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      for (const check of result) {
        expect(['ok', 'warn', 'fail']).toContain(check.state);
        expect(typeof check.what).toBe('string');
      }
    });

    test('markReadyForReview attempts PR creation without PR metadata', async () => {
      const config: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };
      const driver = new GitHubDriver(config);
      const task = { id: 'test1234test1234', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: null };
      // Should complete without error (PR creation fails gracefully when no remote)
      const result = await driver.markReadyForReview(task);
      expect(typeof result).toBe('object');
    });

    test('validateAccept returns error when no remote ref', () => {
      const config: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };
      const driver = new GitHubDriver(config);
      const task = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: null };
      const result = driver.validateAccept(task);
      expect(result).toContain('no remote reference');
    });

    test('validateAccept returns null when remote ref exists', () => {
      const config: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };
      const driver = new GitHubDriver(config);
      const task = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: { github_remote_ref_id: '42' } };
      expect(driver.validateAccept(task)).toBeNull();
    });

    // INVARIANT: GitHub driver uses github_remote_* prefixed keys to avoid
    // collision with GitLab driver metadata when switching drivers.
    test('getLastCommentSyncedAt reads github_remote_* key with fallback chain', () => {
      const config: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };
      const driver = new GitHubDriver(config);

      // New prefixed key takes precedence
      const task1 = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: { github_remote_last_comment_synced_at: '2024-06-01T00:00:00Z' } };
      expect(driver.getLastCommentSyncedAt(task1)).toBe('2024-06-01T00:00:00Z');

      // Falls back to unprefixed key (backward compat)
      const task1b = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: { remote_last_comment_synced_at: '2024-05-01T00:00:00Z' } };
      expect(driver.getLastCommentSyncedAt(task1b)).toBe('2024-05-01T00:00:00Z');

      // Falls back to old github_* key
      const task2 = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: { github_last_comment_synced_at: '2024-01-01T00:00:00Z' } };
      expect(driver.getLastCommentSyncedAt(task2)).toBe('2024-01-01T00:00:00Z');

      // Returns undefined when no metadata
      const task3 = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: null };
      expect(driver.getLastCommentSyncedAt(task3)).toBeUndefined();
    });

    test('getLastPostedTurnSeq reads github_remote_* key with fallback chain', () => {
      const config: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };
      const driver = new GitHubDriver(config);

      const task1 = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: { github_remote_last_posted_turn_seq: '5' } };
      expect(driver.getLastPostedTurnSeq(task1)).toBe(5);

      const task1b = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: { remote_last_posted_turn_seq: '4' } };
      expect(driver.getLastPostedTurnSeq(task1b)).toBe(4);

      const task2 = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: { github_last_posted_turn_seq: '3' } };
      expect(driver.getLastPostedTurnSeq(task2)).toBe(3);

      const task3 = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: null };
      expect(driver.getLastPostedTurnSeq(task3)).toBe(-1);
    });

    test('getLastPostedNoteAt reads github_remote_* key with fallback chain', () => {
      const config: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };
      const driver = new GitHubDriver(config);

      const task1 = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: { github_remote_last_posted_note_at: '2024-06-01' } };
      expect(driver.getLastPostedNoteAt(task1)).toBe('2024-06-01');

      const task1b = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: { remote_last_posted_note_at: '2024-05-01' } };
      expect(driver.getLastPostedNoteAt(task1b)).toBe('2024-05-01');

      const task2 = { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: { github_last_posted_note_at: '2024-01-01' } };
      expect(driver.getLastPostedNoteAt(task2)).toBe('2024-01-01');
    });

    test('metadata key methods return github_remote_* prefixed names', () => {
      const config: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };
      const driver = new GitHubDriver(config);
      expect(driver.commentSyncedAtKey()).toBe('github_remote_last_comment_synced_at');
      expect(driver.postedTurnSeqKey()).toBe('github_remote_last_posted_turn_seq');
      expect(driver.postedNoteAtKey()).toBe('github_remote_last_posted_note_at');
    });

    test('merge fails with error when push fails (no remote)', async () => {
      const config: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };
      const driver = new GitHubDriver(config);
      const result = await driver.merge({
        sourceBranch: 'test-branch',
        targetBranch: 'main',
        task: { id: 'test', code: null, goal: 'test', prompt: '', type: 'task' as const, status: 'working' as const, created_at: Date.now(), completed_at: null, parent_task_id: null, branched_from_sha: null, close_reason: null, model: null, metadata: null },
        taskShortId: 'test1234',
        root: '/tmp/nonexistent',
      });
      // Should fail because there's no git remote to push to
      expect(result.status).toBe('failed');
      expect(result.status === 'failed' && result.isConflict).toBeFalsy();
    });
  });

  describe('merge with github driver (e2e)', () => {
    let ctx: TestContext;

    beforeEach(async () => {
      ctx = await setupTestLazy();
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    test('merge with github driver auto-syncs when no PR exists', async () => {
      // Start task with local driver (default)
      const taskId = await createTask(ctx, 'GitHub PR test', 'Add a file');

      const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
        env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
      });
      expectSuccess(startResult);

      // Make a commit in the worktree
      const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
      const worktreeFile = join(worktreePath, 'github-test.txt');
      writeFileSync(worktreeFile, 'github test content\n');

      const gitAdd = ctx.git('-C', worktreePath, 'add', 'github-test.txt');
      expect(gitAdd.exitCode).toBe(0);

      const gitCommit = ctx.git('-C', worktreePath, 'commit', '-m', 'Add github test file');
      expect(gitCommit.exitCode).toBe(0);

      // Now switch to github driver for accept
      const configPath = join(ctx.root, 'lazy.toml');
      writeFileSync(configPath, '[remote]\ndriver = "github"\n');

      // Accept should attempt auto-sync (push + create PR) instead of immediately failing.
      // Since there's no origin remote, the push will fail with an accurate error.
      const acceptResult = await ctx.lazy(['accept', taskId]);
      expectFailure(acceptResult);
      // Should show the auto-sync attempt, not the old "has no remote reference" message
      expect(acceptResult.stdout.includes('No remote reference found')).toBe(true);
      // Should suggest lazy sync as the fallback
      expect(acceptResult.stderr.includes('lazy sync')).toBe(true);
      // Should NOT show the old misleading "start the task" message
      expect(acceptResult.stderr.includes('start the task to push the branch')).toBe(false);
    });
  });

  describe('GitHubDriver stale PR handling (mocked)', () => {
    const ghConfig: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };

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
        metadata: { github_remote_ref_id: '42', github_remote_ref_url: 'https://github.com/o/r/pull/42' },
        ...overrides,
      };
    }

    const ok = (stdout = ''): GhResult => ({ stdout, stderr: '', exitCode: 0 });
    const fail = (stderr = 'error'): GhResult => ({ stdout: '', stderr, exitCode: 1 });

    function makeDeps(ghHandler: (args: string[], cwd?: string) => GhResult): DriverDeps {
      return {
        runGh: ghHandler,
        runGit: (args: string[]) => {
          // pushBranch calls git push — always succeed
          if (args[0] === 'push') return ok();
          return fail('unexpected git call');
        },
      };
    }

    test('merge creates replacement PR when existing PR is MERGED', async () => {
      const ghCalls: string[][] = [];

      const deps = makeDeps((args) => {
        ghCalls.push([...args]);
        // findExistingPR: pr view → returns MERGED state
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
          return ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'MERGED' }));
        }
        // pr create → success, return new PR URL
        if (args[0] === 'pr' && args[1] === 'create') {
          return ok('https://github.com/o/r/pull/99');
        }
        // getPRNumber: pr view --json number → return new PR number
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
          return ok(JSON.stringify({ number: 99 }));
        }
        // pr merge → success
        if (args[0] === 'pr' && args[1] === 'merge') {
          return ok();
        }
        return fail('unexpected gh call');
      });

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.merge({
        sourceBranch: 'lazy/test1234',
        targetBranch: 'main',
        task: makeTask(),
        taskShortId: 'test1234',
        root: '/tmp/test',
      });

      expect(result.status).toBe('merged');
      // Should have created a replacement PR
      const createCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'create');
      expect(createCall).toBeDefined();
      expect(createCall).toContain('lazy/test1234');
      // Should NOT be a draft PR
      expect(createCall).not.toContain('--draft');

      // Should return updated metadata
      if (result.status === 'merged') {
        expect(result.metadata?.github_remote_ref_url).toBe('https://github.com/o/r/pull/99');
        expect(result.metadata?.github_remote_ref_id).toBe('99');
      }

      // Should have merged the new PR number
      const mergeCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'merge');
      expect(mergeCall).toBeDefined();
      expect(mergeCall).toContain('99');
    });

    test('merge creates replacement PR when existing PR is CLOSED', async () => {
      const ghCalls: string[][] = [];

      const deps = makeDeps((args) => {
        ghCalls.push([...args]);
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
          return ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'CLOSED' }));
        }
        if (args[0] === 'pr' && args[1] === 'create') {
          return ok('https://github.com/o/r/pull/100');
        }
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
          return ok(JSON.stringify({ number: 100 }));
        }
        if (args[0] === 'pr' && args[1] === 'merge') {
          return ok();
        }
        return fail('unexpected gh call');
      });

      const driver = new GitHubDriver(ghConfig, deps);
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
    });

    test('merge creates PR when no PR exists at all', async () => {
      const ghCalls: string[][] = [];

      const deps = makeDeps((args) => {
        ghCalls.push([...args]);
        // findExistingPR: pr view → no PR found
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
          return fail('no pull requests found');
        }
        if (args[0] === 'pr' && args[1] === 'create') {
          return ok('https://github.com/o/r/pull/101');
        }
        // getPRNumber fallback: pr view --json number also fails (new PR might not be viewable by branch yet)
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
          return ok(JSON.stringify({ number: 101 }));
        }
        if (args[0] === 'pr' && args[1] === 'merge') {
          return ok();
        }
        return fail('unexpected gh call');
      });

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.merge({
        sourceBranch: 'lazy/test1234',
        targetBranch: 'main',
        task: makeTask({ metadata: null }),
        taskShortId: 'test1234',
        root: '/tmp/test',
      });

      expect(result.status).toBe('merged');
      if (result.status === 'merged') {
        expect(result.metadata?.github_remote_ref_url).toBe('https://github.com/o/r/pull/101');
        expect(result.metadata?.github_remote_ref_id).toBe('101');
      }
    });

    test('merge skips PR creation when PR is OPEN (normal flow)', async () => {
      const ghCalls: string[][] = [];

      const deps = makeDeps((args) => {
        ghCalls.push([...args]);
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
          return ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'OPEN' }));
        }
        if (args[0] === 'pr' && args[1] === 'merge') {
          return ok();
        }
        return fail('unexpected gh call');
      });

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.merge({
        sourceBranch: 'lazy/test1234',
        targetBranch: 'main',
        task: makeTask(),
        taskShortId: 'test1234',
        root: '/tmp/test',
      });

      expect(result.status).toBe('merged');
      // Should NOT have created a replacement PR
      const createCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'create');
      expect(createCall).toBeUndefined();
      // No metadata update needed
      if (result.status === 'merged') {
        expect(result.metadata).toBeUndefined();
      }
    });

    test('merge fails when replacement PR creation fails and branch not merged', async () => {
      const deps: DriverDeps = {
        runGh: (args) => {
          if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
            return ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'CLOSED' }));
          }
          if (args[0] === 'pr' && args[1] === 'create') {
            return fail('already exists');
          }
          return fail('unexpected gh call');
        },
        runGit: (args) => {
          if (args[0] === 'push') return ok();
          // merge-base --is-ancestor → branch is NOT merged
          if (args[0] === 'merge-base') return fail('not ancestor');
          return fail('unexpected git call');
        },
      };

      const driver = new GitHubDriver(ghConfig, deps);
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
        expect(result.error).toContain('Failed to create replacement PR');
      }
    });

    test('merge succeeds when PR creation fails but branch is already merged', async () => {
      const deps: DriverDeps = {
        runGh: (args) => {
          // No PR exists
          if (args[0] === 'pr' && args[1] === 'view') {
            return fail('no pull requests found');
          }
          // PR creation fails (no unique commits)
          if (args[0] === 'pr' && args[1] === 'create') {
            return fail('No commits between main and lazy/test1234');
          }
          return fail('unexpected gh call');
        },
        runGit: (args) => {
          if (args[0] === 'push') return ok();
          // merge-base --is-ancestor → branch IS already merged
          if (args[0] === 'merge-base') return ok();
          return fail('unexpected git call');
        },
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.merge({
        sourceBranch: 'lazy/test1234',
        targetBranch: 'main',
        task: makeTask({ metadata: null }),
        taskShortId: 'test1234',
        root: '/tmp/test',
      });

      expect(result.status).toBe('merged');
    });

    test('merge detects conflicts on replacement PR merge', async () => {
      const deps = makeDeps((args) => {
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
          return ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'CLOSED' }));
        }
        if (args[0] === 'pr' && args[1] === 'create') {
          return ok('https://github.com/o/r/pull/99');
        }
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('number')) {
          return ok(JSON.stringify({ number: 99 }));
        }
        if (args[0] === 'pr' && args[1] === 'merge') {
          return fail('merge conflict detected');
        }
        return fail('unexpected gh call');
      });

      const driver = new GitHubDriver(ghConfig, deps);
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
      }
    });

    test('merge detects GitHub "not mergeable" error as conflict', async () => {
      const deps = makeDeps((args) => {
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('url,number,state')) {
          return ok(JSON.stringify({ url: 'https://github.com/o/r/pull/42', number: 42, state: 'OPEN' }));
        }
        if (args[0] === 'pr' && args[1] === 'merge') {
          // GitHub returns "not mergeable" error when PR has unresolved conflicts
          return fail('GraphQL: Pull Request is not mergeable (mergePullRequest)');
        }
        return fail('unexpected gh call');
      });

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.merge({
        sourceBranch: 'lazy/test1234',
        targetBranch: 'main',
        task: makeTask(),
        taskShortId: 'test1234',
        root: '/tmp/test',
      });

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        // Should be detected as conflict, not generic error
        expect(result.isConflict).toBe(true);
        expect(result.error).toContain('not mergeable');
      }
    });
  });

  describe('GitHubDriver fetchBranch (mocked)', () => {
    const ghConfig: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };

    const ok = (stdout = ''): GhResult => ({ stdout, stderr: '', exitCode: 0 });
    const fail = (stderr = 'error'): GhResult => ({ stdout: '', stderr, exitCode: 1 });

    test('returns false when remote branch has no new commits', async () => {
      const gitCalls: string[][] = [];
      const deps: DriverDeps = {
        runGh: () => fail('should not be called'),
        runGit: (args) => {
          gitCalls.push([...args]);
          if (args[0] === 'fetch') return ok();
          if (args[0] === 'rev-list') return ok('0'); // no new commits
          return fail('unexpected git call');
        },
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.fetchBranch('lazy/test1234', '/tmp/worktree');

      expect(result).toBe(false);
      // Should have fetched but NOT merged (fetch-only)
      expect(gitCalls.some(c => c[0] === 'fetch')).toBe(true);
      expect(gitCalls.some(c => c[0] === 'merge')).toBe(false);
    });

    test('returns true when remote has new commits (fetch only, no merge)', async () => {
      const gitCalls: string[][] = [];
      const deps: DriverDeps = {
        runGh: () => fail('should not be called'),
        runGit: (args) => {
          gitCalls.push([...args]);
          if (args[0] === 'fetch') return ok();
          if (args[0] === 'rev-list') return ok('3'); // 3 new commits
          return fail('unexpected git call');
        },
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.fetchBranch('lazy/test1234', '/tmp/worktree');

      expect(result).toBe(true);
      // Should have fetched but NOT merged — merge is supervisor's job
      expect(gitCalls.some(c => c[0] === 'fetch')).toBe(true);
      expect(gitCalls.some(c => c[0] === 'merge')).toBe(false);
    });

    test('throws when fetch fails', async () => {
      const deps: DriverDeps = {
        runGh: () => fail('should not be called'),
        runGit: (args) => {
          if (args[0] === 'fetch') return fail('Could not resolve host');
          return fail('unexpected');
        },
      };

      const driver = new GitHubDriver(ghConfig, deps);
      await expect(driver.fetchBranch('lazy/test1234', '/tmp/worktree'))
        .rejects.toThrow('Failed to fetch branch');
    });

    test('returns false when rev-list fails (no tracking ref)', async () => {
      const deps: DriverDeps = {
        runGh: () => fail('should not be called'),
        runGit: (args) => {
          if (args[0] === 'fetch') return ok();
          if (args[0] === 'rev-list') return fail('unknown revision');
          return fail('unexpected');
        },
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.fetchBranch('lazy/test1234', '/tmp/worktree');

      expect(result).toBe(false);
    });
  });

  describe('LocalDriver fetchBranch', () => {
    test('returns false (no-op)', async () => {
      const driver = new LocalDriver();
      const result = await driver.fetchBranch('some-branch', '/tmp/worktree');
      expect(result).toBe(false);
    });
  });

  describe('GitHubDriver fastForwardLocal (mocked)', () => {
    const ghConfig: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };

    const ok = (stdout = ''): GhResult => ({ stdout, stderr: '', exitCode: 0 });
    const fail = (stderr = 'error'): GhResult => ({ stdout: '', stderr, exitCode: 1 });

    // INVARIANT: After a successful remote accept, the local parent branch
    // must be fast-forwarded to match origin. This prevents the next task
    // from starting on a stale SHA and producing a confusing merge on turn 1.
    // When the target branch IS checked out (common case — user on main),
    // we must use fetch + merge --ff-only instead of refspec fetch.
    test('uses fetch + merge --ff-only when target branch is checked out (common case)', async () => {
      const gitCalls: string[][] = [];
      const deps: DriverDeps = {
        runGh: () => fail('should not be called'),
        runGit: (args) => {
          gitCalls.push([...args]);
          // HEAD is on main
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('main');
          // fetch origin main succeeds
          if (args[0] === 'fetch' && args[1] === 'origin' && args[2] === 'main') return ok();
          // merge --ff-only succeeds
          if (args[0] === 'merge' && args[1] === '--ff-only') return ok();
          return fail('unexpected git call');
        },
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.fastForwardLocal('main', '/tmp/repo');

      expect(result.success).toBe(true);
      expect(result.warning).toBeUndefined();
      // Should use fetch + merge --ff-only (NOT refspec fetch)
      expect(gitCalls.some(c => c[0] === 'fetch' && c[2] === 'main')).toBe(true);
      expect(gitCalls.some(c => c[0] === 'merge' && c[1] === '--ff-only')).toBe(true);
      expect(gitCalls.some(c => c[0] === 'fetch' && c[2] === 'main:main')).toBe(false);
    });

    // When the target branch is NOT checked out (e.g., child task merging into
    // parent's branch), use the refspec fetch which atomically advances the ref.
    test('uses refspec fetch when target branch is NOT checked out', async () => {
      const gitCalls: string[][] = [];
      const deps: DriverDeps = {
        runGh: () => fail('should not be called'),
        runGit: (args) => {
          gitCalls.push([...args]);
          // HEAD is on a different branch
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('lazy/abc12345');
          // refspec fetch succeeds
          if (args[0] === 'fetch' && args[1] === 'origin' && args[2] === 'main:main') return ok();
          return fail('unexpected git call');
        },
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.fastForwardLocal('main', '/tmp/repo');

      expect(result.success).toBe(true);
      expect(result.warning).toBeUndefined();
      expect(gitCalls.some(c => c[0] === 'fetch' && c[2] === 'main:main')).toBe(true);
      // Should NOT use merge
      expect(gitCalls.some(c => c[0] === 'merge')).toBe(false);
    });

    // INVARIANT: When local has diverged from origin, the driver must return
    // a warning so the user knows to reconcile manually.
    test('returns warning when checked-out branch has diverged (ff-only fails)', async () => {
      const deps: DriverDeps = {
        runGh: () => fail('should not be called'),
        runGit: (args) => {
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('main');
          if (args[0] === 'fetch') return ok();
          if (args[0] === 'merge' && args[1] === '--ff-only') {
            return fail('fatal: Not possible to fast-forward, aborting.');
          }
          return fail('unexpected git call');
        },
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.fastForwardLocal('main', '/tmp/repo');

      expect(result.success).toBe(false);
      expect(result.warning).toContain('diverged');
      expect(result.warning).toContain('git pull');
    });

    test('returns warning when non-checked-out branch has diverged (refspec rejected)', async () => {
      const deps: DriverDeps = {
        runGh: () => fail('should not be called'),
        runGit: (args) => {
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('lazy/abc12345');
          if (args[0] === 'fetch') {
            return fail('! [rejected]        main -> main  (non-fast-forward)');
          }
          return fail('unexpected git call');
        },
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.fastForwardLocal('main', '/tmp/repo');

      expect(result.success).toBe(false);
      expect(result.warning).toContain('diverged');
      expect(result.warning).toContain('git pull');
    });

    test('returns success when checked-out branch is already up to date', async () => {
      const deps: DriverDeps = {
        runGh: () => fail('should not be called'),
        runGit: (args) => {
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('main');
          if (args[0] === 'fetch') return ok();
          if (args[0] === 'merge' && args[1] === '--ff-only') {
            return { stdout: 'Already up to date.', stderr: '', exitCode: 0 };
          }
          return fail('unexpected git call');
        },
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.fastForwardLocal('main', '/tmp/repo');

      expect(result.success).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    test('works with non-main branches (e.g., parent task branch)', async () => {
      const gitCalls: string[][] = [];
      const deps: DriverDeps = {
        runGh: () => fail('should not be called'),
        runGit: (args) => {
          gitCalls.push([...args]);
          // HEAD is on a different branch
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('main');
          if (args[0] === 'fetch' && args[2] === 'lazy/abc12345:lazy/abc12345') return ok();
          return fail('unexpected git call');
        },
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.fastForwardLocal('lazy/abc12345', '/tmp/repo');

      expect(result.success).toBe(true);
      // Should use the exact branch name in the refspec
      expect(gitCalls.some(c => c[0] === 'fetch' && c[2] === 'lazy/abc12345:lazy/abc12345')).toBe(true);
    });
  });

  describe('GitHubDriver resolveUpstreamRef (mocked)', () => {
    const ghConfig: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };

    const ok = (stdout = ''): GhResult => ({ stdout, stderr: '', exitCode: 0 });
    const fail = (stderr = 'error'): GhResult => ({ stdout: '', stderr, exitCode: 1 });

    test('fetches and returns origin/<branch> on success', async () => {
      const gitCalls: string[][] = [];
      const deps: DriverDeps = {
        runGh: () => fail('should not be called'),
        runGit: (args) => {
          gitCalls.push([...args]);
          if (args[0] === 'fetch') return ok();
          return fail('unexpected git call');
        },
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.resolveUpstreamRef('main', '/tmp/worktree');

      expect(result).toBe('origin/main');
      // Should have fetched origin main
      expect(gitCalls.some(c => c[0] === 'fetch' && c[1] === 'origin' && c[2] === 'main')).toBe(true);
    });

    test('resolves parent task branch (lazy/<id>)', async () => {
      const deps: DriverDeps = {
        runGh: () => fail('should not be called'),
        runGit: (args) => {
          if (args[0] === 'fetch') return ok();
          return fail('unexpected git call');
        },
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.resolveUpstreamRef('lazy/abc12345', '/tmp/worktree');

      expect(result).toBe('origin/lazy/abc12345');
    });

    test('falls back to local branch name when fetch fails', async () => {
      const deps: DriverDeps = {
        runGh: () => fail('should not be called'),
        runGit: (args) => {
          if (args[0] === 'fetch') return fail('Could not resolve host');
          return fail('unexpected git call');
        },
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.resolveUpstreamRef('main', '/tmp/worktree');

      expect(result).toBe('main');
    });

    test('falls back to local branch name on exception', async () => {
      const deps: DriverDeps = {
        runGh: () => fail('should not be called'),
        runGit: () => {
          throw new Error('Network unreachable');
        },
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.resolveUpstreamRef('main', '/tmp/worktree');

      expect(result).toBe('main');
    });
  });

  describe('LocalDriver resolveUpstreamRef', () => {
    test('returns branch name as-is', async () => {
      const driver = new LocalDriver();
      const result = await driver.resolveUpstreamRef('main', '/tmp/worktree');
      expect(result).toBe('main');
    });

    test('returns parent task branch as-is', async () => {
      const driver = new LocalDriver();
      const result = await driver.resolveUpstreamRef('lazy/abc12345', '/tmp/worktree');
      expect(result).toBe('lazy/abc12345');
    });
  });

  describe('GitHubDriver syncComments (mocked)', () => {
    const ghConfig: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };

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
        metadata: { github_remote_ref_id: '42', github_remote_ref_url: 'https://github.com/o/r/pull/42' },
        ...overrides,
      };
    }

    const ok = (stdout = ''): GhResult => ({ stdout, stderr: '', exitCode: 0 });
    const fail = (stderr = 'error'): GhResult => ({ stdout: '', stderr, exitCode: 1 });

    /** gh handler that reports repo as private and delegates API calls to the given handler */
    function privateRepoGh(apiHandler: (args: string[]) => GhResult): (args: string[]) => GhResult {
      return (args: string[]) => {
        if (args[0] === 'repo' && args[1] === 'view') {
          return ok(JSON.stringify({ isPrivate: true }));
        }
        return apiHandler(args);
      };
    }

    test('returns empty array when no PR number in metadata', async () => {
      const deps: DriverDeps = {
        runGh: () => fail('should not be called'),
        runGit: () => fail('should not be called'),
      };
      const driver = new GitHubDriver(ghConfig, deps);
      const task = makeTask({ metadata: null });
      const result = await driver.syncComments(task, '2024-01-01T00:00:00Z');
      expect(result).toEqual([]);
    });

    test('fetches and returns issue comments and review comments', async () => {
      const issueComments = [
        { id: 1, body: 'Looks good!', user: { login: 'alice' }, created_at: '2024-06-01T10:00:00Z' },
        { id: 2, body: 'Fix the typo', user: { login: 'bob' }, created_at: '2024-06-01T11:00:00Z' },
      ];
      const reviewComments = [
        { id: 3, body: 'Nit: rename this', user: { login: 'carol' }, created_at: '2024-06-01T10:30:00Z', path: 'src/main.ts', line: 42 },
      ];

      const deps: DriverDeps = {
        runGh: privateRepoGh((args) => {
          if (args[0] === 'api' && args[1].includes('issues')) {
            return ok(JSON.stringify(issueComments));
          }
          if (args[0] === 'api' && args[1].includes('pulls')) {
            return ok(JSON.stringify(reviewComments));
          }
          return fail('unexpected gh call');
        }),
        runGit: () => fail('should not be called'),
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.syncComments(makeTask(), '2024-06-01T00:00:00Z');

      expect(result.length).toBe(3);
      // Should be sorted by createdAt (oldest first)
      expect(result[0].author).toBe('alice');
      expect(result[0].body).toBe('Looks good!');
      expect(result[1].author).toBe('carol');
      expect(result[1].path).toBe('src/main.ts');
      expect(result[1].line).toBe(42);
      expect(result[2].author).toBe('bob');
    });

    test('filters comments by since timestamp', async () => {
      const issueComments = [
        { id: 1, body: 'Old comment', user: { login: 'alice' }, created_at: '2024-01-01T00:00:00Z' },
        { id: 2, body: 'New comment', user: { login: 'bob' }, created_at: '2024-06-15T12:00:00Z' },
      ];

      const deps: DriverDeps = {
        runGh: privateRepoGh((args) => {
          if (args[0] === 'api' && args[1].includes('issues')) {
            return ok(JSON.stringify(issueComments));
          }
          if (args[0] === 'api' && args[1].includes('pulls')) {
            return ok('[]');
          }
          return fail('unexpected');
        }),
        runGit: () => fail('should not be called'),
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.syncComments(makeTask(), '2024-06-01T00:00:00Z');

      expect(result.length).toBe(1);
      expect(result[0].body).toBe('New comment');
    });

    test('handles paginated response (concatenated arrays)', async () => {
      const page1 = [{ id: 1, body: 'Page 1', user: { login: 'a' }, created_at: '2024-06-01T01:00:00Z' }];
      const page2 = [{ id: 2, body: 'Page 2', user: { login: 'b' }, created_at: '2024-06-01T02:00:00Z' }];

      const deps: DriverDeps = {
        runGh: privateRepoGh((args) => {
          if (args[0] === 'api' && args[1].includes('issues')) {
            // gh api --paginate concatenates arrays
            return ok(JSON.stringify(page1) + JSON.stringify(page2));
          }
          if (args[0] === 'api' && args[1].includes('pulls')) {
            return ok('[]');
          }
          return fail('unexpected');
        }),
        runGit: () => fail('should not be called'),
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.syncComments(makeTask(), '2024-01-01T00:00:00Z');

      expect(result.length).toBe(2);
      expect(result[0].body).toBe('Page 1');
      expect(result[1].body).toBe('Page 2');
    });

    test('returns partial results when one API call fails', async () => {
      const issueComments = [
        { id: 1, body: 'Comment', user: { login: 'alice' }, created_at: '2024-06-01T10:00:00Z' },
      ];

      const deps: DriverDeps = {
        runGh: privateRepoGh((args) => {
          if (args[0] === 'api' && args[1].includes('issues')) {
            return ok(JSON.stringify(issueComments));
          }
          if (args[0] === 'api' && args[1].includes('pulls')) {
            return fail('API rate limit exceeded');
          }
          return fail('unexpected');
        }),
        runGit: () => fail('should not be called'),
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.syncComments(makeTask(), '2024-06-01T00:00:00Z');

      // Should return what we got from the successful call
      expect(result.length).toBe(1);
      expect(result[0].body).toBe('Comment');
    });

    test('returns empty when both API calls fail', async () => {
      const deps: DriverDeps = {
        runGh: privateRepoGh(() => fail('Network error')),
        runGit: () => fail('should not be called'),
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.syncComments(makeTask(), '2024-06-01T00:00:00Z');

      expect(result).toEqual([]);
    });

    test('skips comments for public repos by default', async () => {
      let apiCalled = false;
      const deps: DriverDeps = {
        runGh: (args) => {
          if (args[0] === 'repo' && args[1] === 'view') {
            return ok(JSON.stringify({ isPrivate: false }));
          }
          apiCalled = true;
          return fail('should not reach API');
        },
        runGit: () => fail('should not be called'),
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.syncComments(makeTask(), '2024-06-01T00:00:00Z');

      expect(result).toEqual([]);
      expect(apiCalled).toBe(false);
    });

    test('syncs comments for public repos when dangerous flag is enabled', async () => {
      const publicOkConfig: ResolvedConfig = {
        ...DEFAULT_CONFIG,
        remote: {
          ...DEFAULT_CONFIG.remote,
          driver: 'github',
          github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: true,
        },
      };

      const issueComments = [
        { id: 1, body: 'Public comment', user: { login: 'alice' }, created_at: '2024-06-01T10:00:00Z' },
      ];

      const deps: DriverDeps = {
        runGh: (args) => {
          if (args[0] === 'repo' && args[1] === 'view') {
            return ok(JSON.stringify({ isPrivate: false }));
          }
          if (args[0] === 'api' && args[1].includes('issues')) {
            return ok(JSON.stringify(issueComments));
          }
          if (args[0] === 'api' && args[1].includes('pulls')) {
            return ok('[]');
          }
          return fail('unexpected');
        },
        runGit: () => fail('should not be called'),
      };

      const driver = new GitHubDriver(publicOkConfig, deps);
      const result = await driver.syncComments(makeTask(), '2024-06-01T00:00:00Z');

      expect(result.length).toBe(1);
      expect(result[0].body).toBe('Public comment');
    });

    test('treats repo as public when gh repo view fails (safe default)', async () => {
      let apiCalled = false;
      const deps: DriverDeps = {
        runGh: (args) => {
          if (args[0] === 'repo' && args[1] === 'view') {
            return fail('not found');
          }
          apiCalled = true;
          return fail('should not reach API');
        },
        runGit: () => fail('should not be called'),
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.syncComments(makeTask(), '2024-06-01T00:00:00Z');

      expect(result).toEqual([]);
      expect(apiCalled).toBe(false);
    });

    test('filters out comments with lazy marker', async () => {
      const issueComments = [
        { id: 1, body: 'External comment', user: { login: 'alice' }, created_at: '2024-06-01T10:00:00Z' },
        { id: 2, body: '<!-- lazy:turn -->\nTurn 1 summary', user: { login: 'lazy' }, created_at: '2024-06-01T11:00:00Z' },
        { id: 3, body: 'Another external comment', user: { login: 'bob' }, created_at: '2024-06-01T12:00:00Z' },
      ];
      const reviewComments = [
        { id: 4, body: 'Code review', user: { login: 'carol' }, created_at: '2024-06-01T10:30:00Z', path: 'src/main.ts', line: 42 },
        { id: 5, body: '<!-- lazy:turn -->\nInline turn summary', user: { login: 'lazy' }, created_at: '2024-06-01T11:30:00Z', path: 'src/main.ts', line: 50 },
      ];

      const deps: DriverDeps = {
        runGh: privateRepoGh((args) => {
          if (args[0] === 'api' && args[1].includes('issues')) {
            return ok(JSON.stringify(issueComments));
          }
          if (args[0] === 'api' && args[1].includes('pulls')) {
            return ok(JSON.stringify(reviewComments));
          }
          return fail('unexpected gh call');
        }),
        runGit: () => fail('should not be called'),
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.syncComments(makeTask(), '2024-06-01T00:00:00Z');

      // Should only have 3 comments: alice, bob, carol (ids 1, 3, 4)
      // Should skip ids 2 and 5 (which have the lazy marker)
      expect(result.length).toBe(3);
      expect(result[0].body).toBe('External comment');
      expect(result[0].author).toBe('alice');
      expect(result[1].body).toBe('Code review');
      expect(result[1].author).toBe('carol');
      expect(result[2].body).toBe('Another external comment');
      expect(result[2].author).toBe('bob');
      // Verify lazy comments are completely absent
      expect(result.every(c => !c.body.includes('<!-- lazy:'))).toBe(true);
    });

    test('postTurnSummary prepends lazy marker to comment', async () => {
      let postedBody = '';
      const deps: DriverDeps = {
        runGh: (args) => {
          if (args[0] === 'pr' && args[1] === 'comment') {
            const bodyIdx = args.indexOf('--body');
            postedBody = bodyIdx >= 0 ? args[bodyIdx + 1] : '';
            return ok();
          }
          return fail('unexpected');
        },
        runGit: () => fail('should not be called'),
      };

      const driver = new GitHubDriver(ghConfig, deps);
      await driver.postTurnSummary(makeTask(), 'Turn 1 summary: did things');

      expect(postedBody).toContain('<!-- lazy:turn -->');
      expect(postedBody).toContain('Turn 1 summary: did things');
      // Marker should be at the beginning
      expect(postedBody.startsWith('<!-- lazy:turn -->\n')).toBe(true);
    });
  });

  describe('GitHubDriver getPRState (mocked)', () => {
    const ghConfig: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };

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
        metadata: { github_remote_ref_id: '42', github_remote_ref_url: 'https://github.com/o/r/pull/42' },
        ...overrides,
      };
    }

    const ok = (stdout = ''): GhResult => ({ stdout, stderr: '', exitCode: 0 });
    const fail = (stderr = 'error'): GhResult => ({ stdout: '', stderr, exitCode: 1 });

    test('returns null when no PR number in metadata', async () => {
      const deps: DriverDeps = {
        runGh: () => fail('should not be called'),
        runGit: () => fail('should not be called'),
      };
      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.getPRState(makeTask({ metadata: null }));
      expect(result).toBeNull();
    });

    test('returns OPEN for open PR', async () => {
      const deps: DriverDeps = {
        runGh: (args) => {
          if (args[0] === 'pr' && args[1] === 'view') {
            return ok(JSON.stringify({ state: 'OPEN' }));
          }
          return fail('unexpected');
        },
        runGit: () => fail('should not be called'),
      };
      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.getPRState(makeTask());
      expect(result).toBe('OPEN');
    });

    test('returns MERGED for merged PR', async () => {
      const deps: DriverDeps = {
        runGh: (args) => {
          if (args[0] === 'pr' && args[1] === 'view') {
            return ok(JSON.stringify({ state: 'MERGED' }));
          }
          return fail('unexpected');
        },
        runGit: () => fail('should not be called'),
      };
      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.getPRState(makeTask());
      expect(result).toBe('MERGED');
    });

    test('returns CLOSED for closed PR', async () => {
      const deps: DriverDeps = {
        runGh: (args) => {
          if (args[0] === 'pr' && args[1] === 'view') {
            return ok(JSON.stringify({ state: 'CLOSED' }));
          }
          return fail('unexpected');
        },
        runGit: () => fail('should not be called'),
      };
      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.getPRState(makeTask());
      expect(result).toBe('CLOSED');
    });

    test('returns null when gh fails', async () => {
      const deps: DriverDeps = {
        runGh: () => fail('network error'),
        runGit: () => fail('should not be called'),
      };
      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.getPRState(makeTask());
      expect(result).toBeNull();
    });

    test('returns null when response is unparseable', async () => {
      const deps: DriverDeps = {
        runGh: (args) => {
          if (args[0] === 'pr' && args[1] === 'view') {
            return ok('not json');
          }
          return fail('unexpected');
        },
        runGit: () => fail('should not be called'),
      };
      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.getPRState(makeTask());
      expect(result).toBeNull();
    });
  });

  describe('GitHubDriver postTurnSummary (mocked)', () => {
    const ghConfig: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };

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
        metadata: { github_remote_ref_id: '42', github_remote_ref_url: 'https://github.com/o/r/pull/42' },
        ...overrides,
      };
    }

    const ok = (stdout = ''): GhResult => ({ stdout, stderr: '', exitCode: 0 });
    const fail = (stderr = 'error'): GhResult => ({ stdout: '', stderr, exitCode: 1 });

    test('posts comment to PR', async () => {
      let postedBody = '';
      const deps: DriverDeps = {
        runGh: (args) => {
          if (args[0] === 'pr' && args[1] === 'comment') {
            const bodyIdx = args.indexOf('--body');
            postedBody = bodyIdx >= 0 ? args[bodyIdx + 1] : '';
            return ok();
          }
          return fail('unexpected');
        },
        runGit: () => fail('should not be called'),
      };

      const driver = new GitHubDriver(ghConfig, deps);
      await driver.postTurnSummary(makeTask(), 'Turn 1 summary: did things');

      // Should have the lazy marker prepended
      expect(postedBody).toContain('<!-- lazy:turn -->');
      expect(postedBody).toContain('Turn 1 summary: did things');
      expect(postedBody.startsWith('<!-- lazy:turn -->\n')).toBe(true);
    });

    test('skips when no PR number', async () => {
      let ghCalled = false;
      const deps: DriverDeps = {
        runGh: () => { ghCalled = true; return fail('should not be called'); },
        runGit: () => fail('should not be called'),
      };

      const driver = new GitHubDriver(ghConfig, deps);
      await driver.postTurnSummary(makeTask({ metadata: null }), 'summary');

      expect(ghCalled).toBe(false);
    });

    test('does not throw when posting fails', async () => {
      const deps: DriverDeps = {
        runGh: () => fail('Network error'),
        runGit: () => fail('should not be called'),
      };

      const driver = new GitHubDriver(ghConfig, deps);
      // Should not throw
      await driver.postTurnSummary(makeTask(), 'summary');
    });
  });

  describe('GitHubDriver checkHealth (mocked)', () => {
    const ghConfig: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };
    const ok = (stdout = ''): GhResult => ({ stdout, stderr: '', exitCode: 0 });
    const fail = (stderr = 'error'): GhResult => ({ stdout: '', stderr, exitCode: 1 });

    /** Build deps where gh/git calls pass all basic checks, with custom repo view response */
    function healthyDeps(repoViewResult: GhResult): DriverDeps {
      return {
        runGh: (args) => {
          if (args[0] === '--version') return ok('gh version 2.0.0');
          if (args[0] === 'auth' && args[1] === 'status') return ok('Token scopes: repo');
          if (args[0] === 'repo' && args[1] === 'view') return repoViewResult;
          return fail('unexpected gh call');
        },
        runGit: (args) => {
          if (args[0] === 'remote' && args[1] === 'get-url') return ok('git@github.com:owner/repo.git');
          return fail('unexpected git call');
        },
      };
    }

    test('reports private repo with comment sync enabled', async () => {
      const deps = healthyDeps(ok(JSON.stringify({ isPrivate: true })));
      const driver = new GitHubDriver(ghConfig, deps);
      const checks = await driver.checkHealth();

      const repoCheck = checks.find(c => c.what.includes('Private repo'));
      expect(repoCheck).toBeDefined();
      expect(repoCheck!.state).toBe('ok');
      expect(repoCheck!.what).toContain('comment sync enabled');
    });

    test('warns about public repo with comment sync disabled', async () => {
      const deps = healthyDeps(ok(JSON.stringify({ isPrivate: false })));
      const driver = new GitHubDriver(ghConfig, deps);
      const checks = await driver.checkHealth();

      const repoCheck = checks.find(c => c.what.includes('Public repo'));
      expect(repoCheck).toBeDefined();
      expect(repoCheck!.state).toBe('warn');
      expect(repoCheck!.what).toContain('disabled');
    });

    test('warns about public repo with dangerous flag enabled', async () => {
      const dangerousConfig: ResolvedConfig = {
        ...DEFAULT_CONFIG,
        remote: {
          ...DEFAULT_CONFIG.remote,
          driver: 'github',
          github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: true,
        },
      };
      const deps = healthyDeps(ok(JSON.stringify({ isPrivate: false })));
      const driver = new GitHubDriver(dangerousConfig, deps);
      const checks = await driver.checkHealth();

      const repoCheck = checks.find(c => c.what.includes('Public repo'));
      expect(repoCheck).toBeDefined();
      expect(repoCheck!.state).toBe('warn');
      expect(repoCheck!.what).toContain('prompt injection risk');
    });

    test('skips repo visibility check when gh repo view fails', async () => {
      const deps = healthyDeps(fail('not found'));
      const driver = new GitHubDriver(ghConfig, deps);
      const checks = await driver.checkHealth();

      const repoCheck = checks.find(c => c.what.includes('repo'));
      // Should have the git remote check (ok) but no Private/Public repo check
      const visibilityCheck = checks.find(c => c.what.includes('Private repo') || c.what.includes('Public repo'));
      expect(visibilityCheck).toBeUndefined();
    });
  });

  describe('PR comment formatting (content and structure)', () => {
    // Note: the lazy marker (<!-- lazy:turn -->) is prepended by the driver's
    // postTurnSummary method, NOT by these formatters. See the
    // 'postTurnSummary prepends lazy marker to comment' test above.

    test('agent turn summary has correct header and content', () => {
      const result = formatAgentTurnSummary('Did some work', 1, 1, 'abc12345');
      expect(result).toContain('### Turn 1 — Agent Summary');
      expect(result).toContain('Did some work');
      expect(result).toContain('task `abc12345`');
    });

    test('agent turn summary truncates long content', () => {
      const longContent = 'x'.repeat(5000);
      const result = formatAgentTurnSummary(longContent, 2, 3, 'abc12345');
      expect(result.length).toBeLessThan(5000 + 200); // content + overhead
      expect(result).toContain('... (truncated)');
    });

    test('human review turn has Review Feedback header', () => {
      const result = formatHumanReviewTurn('Please fix the bug', 2, 2, 'abc12345');
      expect(result).toContain('### Turn 2 — Review Feedback');
      expect(result).toContain('Please fix the bug');
      expect(result).toContain('task `abc12345`');
    });

    test('human review turn truncates long feedback', () => {
      const longFeedback = 'y'.repeat(5000);
      const result = formatHumanReviewTurn(longFeedback, 1, 2, 'abc12345');
      expect(result).toContain('... (truncated)');
    });

    test('note comment has Note header', () => {
      const result = formatNoteComment('Important observation', 'note-uuid-123', 'abc12345');
      expect(result).toContain('### Note');
      expect(result).toContain('Important observation');
      expect(result).toContain('task `abc12345`');
    });

    test('note comment truncates long notes', () => {
      const longNote = 'z'.repeat(5000);
      const result = formatNoteComment(longNote, 'note-id', 'abc12345');
      expect(result).toContain('... (truncated)');
    });
  });

  describe('GitHubDriver.canImport', () => {
    const ghConfig: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };

    test('matches GitHub PR URLs', () => {
      const driver = new GitHubDriver(ghConfig);
      expect(driver.canImport('https://github.com/org/repo/pull/42')).toBe(true);
      expect(driver.canImport('https://github.com/some-org/my-repo/pull/1')).toBe(true);
      expect(driver.canImport('https://github.com/a/b/pull/999')).toBe(true);
    });

    test('matches URLs with trailing path segments', () => {
      const driver = new GitHubDriver(ghConfig);
      expect(driver.canImport('https://github.com/org/repo/pull/42/files')).toBe(true);
      expect(driver.canImport('https://github.com/org/repo/pull/42/commits')).toBe(true);
    });

    test('rejects non-GitHub URLs', () => {
      const driver = new GitHubDriver(ghConfig);
      expect(driver.canImport('https://gitlab.com/org/repo/pull/42')).toBe(false);
      expect(driver.canImport('https://example.com/something')).toBe(false);
    });

    test('rejects non-PR GitHub URLs', () => {
      const driver = new GitHubDriver(ghConfig);
      expect(driver.canImport('https://github.com/org/repo')).toBe(false);
      expect(driver.canImport('https://github.com/org/repo/issues/42')).toBe(false);
      expect(driver.canImport('https://github.com/org/repo/tree/main')).toBe(false);
    });
  });

  describe('GitHubDriver.importUrl', () => {
    const ghConfig: ResolvedConfig = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };
    const ok = (stdout = ''): GhResult => ({ stdout, stderr: '', exitCode: 0 });
    const fail = (stderr = 'error'): GhResult => ({ stdout: '', stderr, exitCode: 1 });

    test('imports PR with title, branch, and metadata', async () => {
      const deps: DriverDeps = {
        runGh: (args) => {
          if (args[0] === 'pr' && args[1] === 'view' && args.includes('title,headRefName,state,url,number,body')) {
            return ok(JSON.stringify({
              title: 'Fix authentication bug',
              headRefName: 'fix/auth-bug',
              state: 'OPEN',
              url: 'https://github.com/org/repo/pull/42',
              number: 42,
              body: 'This fixes the auth bug',
            }));
          }
          if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) {
            return ok(JSON.stringify({ comments: [] }));
          }
          return fail('unexpected gh call');
        },
        runGit: () => fail('unexpected git call'),
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.importUrl!('https://github.com/org/repo/pull/42', {});

      expect(result.goal).toBe('Fix authentication bug');
      expect(result.branch).toBe('fix/auth-bug');
      expect(result.metadata.github_remote_ref_url).toBe('https://github.com/org/repo/pull/42');
      expect(result.metadata.github_remote_ref_id).toBe('42');
      expect(result.metadata.github_remote_ref_state).toBe('OPEN');
      expect(result.metadata.import_source_url).toBe('https://github.com/org/repo/pull/42');
      expect(result.comments).toEqual([]);
    });

    test('imports PR comments as notes', async () => {
      const deps: DriverDeps = {
        runGh: (args) => {
          if (args[0] === 'pr' && args[1] === 'view' && args.includes('title,headRefName,state,url,number,body')) {
            return ok(JSON.stringify({
              title: 'Add feature',
              headRefName: 'feature/new',
              state: 'OPEN',
              url: 'https://github.com/org/repo/pull/10',
              number: 10,
              body: '',
            }));
          }
          if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) {
            return ok(JSON.stringify({
              comments: [
                { author: { login: 'alice' }, body: 'Looks good, but needs tests' },
                { author: { login: 'bob' }, body: 'Please add error handling' },
                { author: { login: 'carol' }, body: '' },  // empty comment should be skipped
              ],
            }));
          }
          return fail('unexpected gh call');
        },
        runGit: () => fail('unexpected git call'),
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.importUrl!('https://github.com/org/repo/pull/10', {});

      expect(result.comments).toHaveLength(2);
      expect(result.comments![0]).toBe('[alice] Looks good, but needs tests');
      expect(result.comments![1]).toBe('[bob] Please add error handling');
    });

    test('throws when gh pr view fails', async () => {
      const deps: DriverDeps = {
        runGh: () => fail('not found'),
        runGit: () => fail('unexpected git call'),
      };

      const driver = new GitHubDriver(ghConfig, deps);
      await expect(driver.importUrl!('https://github.com/org/repo/pull/999', {}))
        .rejects.toThrow('Failed to fetch PR #999');
    });

    test('throws when URL has no PR number', async () => {
      const driver = new GitHubDriver(ghConfig);
      await expect(driver.importUrl!('https://github.com/org/repo', {}))
        .rejects.toThrow('Cannot parse PR number');
    });

    test('continues without comments when comment fetch fails', async () => {
      const deps: DriverDeps = {
        runGh: (args) => {
          if (args[0] === 'pr' && args[1] === 'view' && args.includes('title,headRefName,state,url,number,body')) {
            return ok(JSON.stringify({
              title: 'Test PR',
              headRefName: 'test-branch',
              state: 'OPEN',
              url: 'https://github.com/org/repo/pull/5',
              number: 5,
              body: '',
            }));
          }
          if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) {
            return fail('API error');
          }
          return fail('unexpected gh call');
        },
        runGit: () => fail('unexpected git call'),
      };

      const driver = new GitHubDriver(ghConfig, deps);
      const result = await driver.importUrl!('https://github.com/org/repo/pull/5', {});

      expect(result.goal).toBe('Test PR');
      expect(result.comments).toEqual([]);
    });
  });

  describe('buildRemoteCommentsContext (security framing)', () => {
    test('returns empty string for no comments', () => {
      const result = buildRemoteCommentsContext([]);
      expect(result).toBe('');
    });

    test('includes untrusted input warning', () => {
      const comments: RemoteComment[] = [
        { id: '1', body: 'Please fix this', author: 'reviewer', createdAt: '2024-06-01T10:00:00Z' },
      ];
      const result = buildRemoteCommentsContext(comments);

      expect(result).toContain('UNTRUSTED EXTERNAL INPUT');
      expect(result).toContain('NOT as instructions');
      expect(result).toContain('EXTERNAL COMMENTS FROM GITHUB PR');
      expect(result).toContain('END OF EXTERNAL COMMENTS');
    });

    test('formats author, timestamp, and body', () => {
      const comments: RemoteComment[] = [
        { id: '1', body: 'Looks good!', author: 'alice', createdAt: '2024-06-01T10:00:00Z' },
      ];
      const result = buildRemoteCommentsContext(comments);

      expect(result).toContain('[alice] at 2024-06-01T10:00:00Z');
      expect(result).toContain('Looks good!');
    });

    test('includes file path and line for inline comments', () => {
      const comments: RemoteComment[] = [
        { id: '1', body: 'Rename this', author: 'bob', createdAt: '2024-06-01T10:00:00Z', path: 'src/main.ts', line: 42 },
      ];
      const result = buildRemoteCommentsContext(comments);

      expect(result).toContain('(on file: src/main.ts, line 42)');
    });

    test('includes file path without line when line is not present', () => {
      const comments: RemoteComment[] = [
        { id: '1', body: 'Review this file', author: 'carol', createdAt: '2024-06-01T10:00:00Z', path: 'README.md' },
      ];
      const result = buildRemoteCommentsContext(comments);

      expect(result).toContain('(on file: README.md)');
      expect(result).not.toContain('line');
    });

    test('uses clear delimiters that are distinct from other prompt sections', () => {
      const comments: RemoteComment[] = [
        { id: '1', body: 'Test', author: 'x', createdAt: '2024-01-01T00:00:00Z' },
      ];
      const result = buildRemoteCommentsContext(comments);

      // Uses ═══ delimiters (distinct from --- used by notes and turn history)
      expect(result).toContain('═══');
    });
  });
});
