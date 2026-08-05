import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { setTaskStatus } from '../helpers/storage';

/**
 * Create a task, start it, wait for the reconciler to move it out of 'working',
 * and put a real commit on its branch so accept has something to merge.
 *
 * All three steps are load-bearing (mirrors test/e2e/accept-reason.ts): `start`
 * launches the supervisor asynchronously so without the explicit `wait` accept
 * refuses with "still working", and under withDaemon the agent runs inside the
 * daemon with its own default mock response, so LAZY_MOCK_SHOULD_COMMIT never
 * reaches it and the branch would otherwise be empty.
 */
async function createTaskWithCommit(ctx: TestContext, goal: string): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Some work');
  expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  }));

  const waitResult = await ctx.lazy(['wait', taskId]);
  if (waitResult.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
  }

  const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');
  expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
  expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature').exitCode).toBe(0);

  return taskId;
}

describe('deferred PR creation (driver unit)', () => {
  test('publishBranch pushes the branch and creates no PR', async () => {
    // INVARIANT: publishBranch only PUSHES. PR creation is deferred to
    // markReadyForReview, so a task that never produces commits never opens a
    // spurious zero-commit PR.
    //
    // The driver is driven through its DriverDeps seam. Before, this test built
    // a bare `new GitHubDriver(config)` — which ran the REAL `git push` against
    // whatever repo `bun test` happened to be sitting in, i.e. lazy's own
    // worktree and its real origin (three retried pushes to gitlab.com per run).
    // It then wrapped everything in `try {} catch {}`, so every assertion was
    // unreachable and the test could not fail. Both problems are the same fix:
    // inject the subprocess runners and assert on what they were called with.
    const { GitHubDriver } = await import('../../src/remote/github-driver');
    const { DEFAULT_CONFIG } = await import('../../src/config/loader');

    const ghCalls: string[][] = [];
    const gitCalls: string[][] = [];
    const config = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, driver: 'github' } };
    const driver = new GitHubDriver(config, {
      runGh: async (args: string[]) => {
        ghCalls.push(args);
        // No PR exists for this branch yet — `gh pr view` exits non-zero.
        return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
      },
      runGit: async (args: string[]) => {
        gitCalls.push(args);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const task = {
      id: 'test1234test1234test1234test12345678',
      code: null,
      goal: 'test goal',
      prompt: 'test prompt',
      type: 'task' as const,
      status: 'working' as const,
      priority: 'normal' as const,
      created_at: Date.now(),
      completed_at: null,
      target: { kind: 'branch' as const, branch: 'main' },
      branched_from_sha: null,
      close_reason: null,
      model: null,
      agent_id: 'claude-code',
      metadata: null,
      runner_type: null,
      tags: [], pending_sync: 0,
    };

    const result = await driver.publishBranch({
      branch: 'lazy/test1234',
      targetBranch: 'main',
      task,
    });

    // The branch WAS pushed.
    expect(gitCalls.some(a => a[0] === 'push' && a.includes('lazy/test1234'))).toBe(true);

    // No PR was created — gh was only asked whether one already exists.
    expect(ghCalls.some(a => a[0] === 'pr' && a[1] === 'create')).toBe(false);

    // And no PR metadata is persisted: markReadyForReview derives the base from
    // task.target, so publishBranch has nothing to store.
    expect(result.metadata).toEqual({});
  });
});

describe('deferred PR creation (accept)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // `start` + `accept` need a real daemon: start launches the supervisor
    // asynchronously and the daemon reconciler is what moves the task out of
    // 'working'. Daemonless, the task stays 'working' and accept refuses.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: with a remote driver configured but no reachable `origin`,
  // accept FAILS LOUD on the upstream fetch. It does not fall back to a
  // local-only merge — that would leave the remote parent without the merge
  // (CLAUDE.md, "Fail hard on remote failures — no silent fallbacks").
  //
  // This test used to assert `No remote reference found` on stdout and
  // `lazy sync` on stderr. Both are stale, and accept's ordering is the correct
  // side: `No remote reference found` is a `logger.debug` line in
  // src/daemon/task-lifecycle.ts (invisible without --debug), and the push/PR
  // path it belongs to is only reached for a PROTECTED target since the
  // "PRs only for protected branches" invariant — see
  // test/e2e/accept-auto-sync.test.ts, which asserts that same string is
  // absent for an unprotected main. What is genuinely worth locking in here is
  // the no-origin case, which no other suite covers.
  test('accept with github driver and no origin fails loud on the fetch', async () => {
    const taskId = await createTaskWithCommit(ctx, 'No PR test');

    // Switch the EXISTING [remote] driver key — appending a second [remote]
    // table is a TOML redefinition error, and overwriting lazy.toml wholesale
    // drops the external storage path `lazy init` wrote.
    const configPath = join(ctx.root, 'lazy.toml');
    const before = readFileSync(configPath, 'utf-8');
    const after = before.replace(/^driver = "local"$/m, 'driver = "github"');
    expect(after).not.toBe(before);
    writeFileSync(configPath, after);

    const acceptResult = await ctx.lazy(['accept', taskId]);
    expectFailure(acceptResult);
    // Accurate, actionable error naming the real problem…
    expectError(acceptResult, "'origin' does not appear to be a git repository");
    expectError(acceptResult, 'Fix this before accepting');
    // …and NOT the old misleading "start the task" message.
    expect(acceptResult.stderr).not.toContain('start the task to push the branch');
  });
});

describe('reconciler no-push', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Turn on the github driver WITH auto-push, editing the keys `lazy init`
   * already wrote.
   *
   * These tests used to overwrite lazy.toml with a two-line stub, which also
   * threw away the `external_path` init had written — so the command under test
   * looked at an empty default store and "no push happened" was true for the
   * wrong reason. Each caller now also asserts its task is actually listed.
   */
  function enableGitHubAutoPush(): void {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = readFileSync(configPath, 'utf-8');
    // github_auto_push already defaults to true (src/config/loader.ts), so
    // flipping the driver is enough to arm every auto-push path.
    const after = before.replace(/^driver = "local"$/m, 'driver = "github"');
    expect(after).not.toBe(before);
    expect(after).toContain('external_path');
    writeFileSync(configPath, after);
  }

  test('list command does not trigger push (no network)', async () => {
    const taskId = await createTask(ctx, 'List test', 'Test list');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Even with github driver + auto-push configured, list must not push.
    enableGitHubAutoPush();

    const listResult = await ctx.lazy(['list']);
    expectSuccess(listResult);
    // The task IS listed — the assertion below is about a real listing, not an
    // empty store.
    expectOutput(listResult, 'List test');
    // Should NOT contain any push-related output
    const output = listResult.stdout + listResult.stderr;
    expect(output.includes('Pushing branch')).toBe(false);
  });

  test('blocked command does not trigger push', async () => {
    const taskId = await createTask(ctx, 'Blocked test', 'Test blocked');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Daemonless, nothing moves the task out of 'working', so `blocked` would
    // list nothing and the assertion below would hold vacuously.
    setTaskStatus(ctx.root, taskId, 'blocked');

    enableGitHubAutoPush();

    const blockedResult = await ctx.lazy(['blocked']);
    expectSuccess(blockedResult);
    expectOutput(blockedResult, 'Blocked test');
    // Should NOT contain push-related output
    const output = blockedResult.stdout + blockedResult.stderr;
    expect(output.includes('Pushing branch')).toBe(false);
  });
});
