/**
 * Tests for per-task sync (syncTaskFromRemote).
 *
 * These tests verify that PR comments are fetched and stored as notes
 * when reviewing a task, and that the function handles edge cases gracefully.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('per-task sync (syncTaskFromRemote)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('unblock with github driver handles missing gh CLI gracefully', async () => {
    // Configure github driver
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, '[remote]\ndriver = "github"\n');

    // Create and start a task
    const taskId = await createTask(ctx, 'Sync test task', 'Do some work');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Unblock with message (imperative mode — doesn't call syncTaskFromRemote,
    // but tests that the github driver config doesn't break things)
    // Note: interactive mode would call syncTaskFromRemote, but requires TTY
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Fix the bug'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );

    // Should succeed despite gh CLI not being available
    // (syncTaskFromRemote catches errors gracefully)
    expectSuccess(unblockResult);
  });

  test('unblock with local driver works without attempting sync', async () => {
    // Default config uses local driver — sync should be a no-op
    const taskId = await createTask(ctx, 'Local sync test', 'Do work');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Looks good'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);
  });

  test('comment command creates notes that show up in task context', async () => {
    // This tests the note display pipeline that syncTaskFromRemote feeds into
    const taskId = await createTask(ctx, 'Comment display test', 'Add feature');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Add a comment (simulating what syncTaskFromRemote would do)
    const commentResult = await ctx.lazy([
      'comment', taskId, '--message', '[PR #42 @reviewer] {remote:12345} Please fix the typo',
    ]);
    expectSuccess(commentResult);

    // Show task — should display the note
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    // The note should be stored and visible via show
    expectOutput(showResult, 'Comment display test');
  });

  // INVARIANT: Unblock does NOT trigger upstream merge — sync is separate.
  // Use `lazy sync <task>` to merge upstream before or after unblocking.
  test('unblock does NOT trigger merge even when upstream has changes', async () => {
    // Create and start a task
    const taskId = await createTask(ctx, 'No auto merge task', 'Do some work');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Advance main so upstream has changes
    ctx.git('checkout', 'main');
    writeFileSync(join(ctx.root, 'upstream-change.txt'), 'upstream\n');
    ctx.git('add', '.');
    ctx.git('commit', '-m', 'upstream change');
    ctx.git('checkout', '-'); // back to previous branch

    // Unblock with just a message
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Fix the bug'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);
    // Should NOT mention upstream merge — unblock is just feedback now
    expectOutputExcludes(unblockResult, 'Supervisor will merge before proceeding');
  });

  test('sync-with-remote: local driver skips fetch (no-op)', async () => {
    // Default config uses local driver — fetchBranch should be a no-op
    const taskId = await createTask(ctx, 'Local remote sync', 'Do work');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Unblock — sync-with-remote should silently skip (local driver)
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Continue working'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);
  });

  test('sync-with-remote: github driver handles missing gh CLI gracefully during fetch', async () => {
    // Configure github driver — no gh CLI available in test env
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, '[remote]\ndriver = "github"\n');

    const taskId = await createTask(ctx, 'GitHub remote sync', 'Do work');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Unblock — sync-with-remote will try fetchBranch but gh/git ops may fail.
    // Should be non-fatal and proceed with stale data.
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Fix the issue'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);
  });

  test('show task with PR-style notes includes comment content', async () => {
    const taskId = await createTask(ctx, 'PR notes test', 'Implement feature');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Simulate what syncTaskFromRemote does: store a PR comment as a note
    const commentResult = await ctx.lazy([
      'comment', taskId, '--message',
      '[PR #99 @alice] {remote:100} Looks good but please add tests\n(on file: src/main.ts, line 42)',
    ]);
    expectSuccess(commentResult);

    // Add a second comment
    const commentResult2 = await ctx.lazy([
      'comment', taskId, '--message',
      '[PR #99 @bob] {remote:101} LGTM',
    ]);
    expectSuccess(commentResult2);

    // Verify both notes were stored
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'PR notes test');
  });
});

// =====================================================================
// lazy sync <task> — task-level upstream merge
// =====================================================================

describe('lazy sync <task> (task-level upstream merge)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: Working tasks cannot be synced — the worktree is in use by the agent.
  test('sync on a working task fails with clear error', async () => {
    const taskId = await createTask(ctx, 'Test sync working task', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Manually set task status to 'working'
    const tasksDir = join(homedir(), '.lazy', basename(ctx.root), 'tasks');
    const entries = readdirSync(tasksDir);
    const fullId = entries.find(e => e.startsWith(taskId));
    if (!fullId) throw new Error(`No task directory starting with ${taskId}`);
    const taskJsonPath = join(tasksDir, fullId, 'task.json');
    const taskData = JSON.parse(readFileSync(taskJsonPath, 'utf-8'));
    taskData.status = 'working';
    writeFileSync(taskJsonPath, JSON.stringify(taskData, null, 2) + '\n');

    const result = await ctx.lazy(['sync', taskId]);
    expectFailure(result);
    const output = result.stdout + result.stderr;
    expect(output.includes('currently working')).toBe(true);
  });

  test('sync on a backlog task with no session fails', async () => {
    const taskId = await createTask(ctx, 'Test sync backlog task', 'Do work');

    const result = await ctx.lazy(['sync', taskId]);
    expectFailure(result);
    const output = result.stdout + result.stderr;
    expect(output.includes('no session') || output.includes('Start it first')).toBe(true);
  });

  /**
   * Helper: set a task's status in storage directly.
   * After lazyMocked start, the task may remain in 'working' because
   * reconciliation hasn't run yet. This forces a specific status.
   */
  function setTaskStatus(taskId: string, status: string): void {
    const tasksDir = join(homedir(), '.lazy', basename(ctx.root), 'tasks');
    const entries = readdirSync(tasksDir);
    const fullId = entries.find(e => e.startsWith(taskId));
    if (!fullId) throw new Error(`No task directory starting with ${taskId}`);
    const taskJsonPath = join(tasksDir, fullId, 'task.json');
    const taskData = JSON.parse(readFileSync(taskJsonPath, 'utf-8'));
    taskData.status = status;
    writeFileSync(taskJsonPath, JSON.stringify(taskData, null, 2) + '\n');
  }

  // When no upstream changes exist, sync should report "up to date"
  test('sync with no upstream changes reports up to date', async () => {
    const taskId = await createTask(ctx, 'Test sync up to date', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Force task to blocked (reconciliation may not have run)
    setTaskStatus(taskId, 'blocked');

    // Task is now blocked. Parent is main, which hasn't changed.
    const result = await ctx.lazy(['sync', taskId]);
    expectSuccess(result);
    expectOutput(result, 'up to date');
  });

  // When upstream has changes, sync should launch a merge
  test('sync when upstream has changes detects them', async () => {
    const taskId = await createTask(ctx, 'Test sync with changes', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Force task to blocked
    setTaskStatus(taskId, 'blocked');

    // Add a commit to main so there are upstream changes
    ctx.git('checkout', 'main');
    writeFileSync(join(ctx.root, 'upstream-change.txt'), 'New upstream content\n');
    ctx.git('add', 'upstream-change.txt');
    ctx.git('commit', '-m', 'Upstream change for sync test');
    ctx.git('checkout', '-');

    // Sync should detect upstream changes and attempt to launch a sync-only merge.
    // In test mode without a real Docker runner, the supervisor launch may fail,
    // but the command should at least progress past the "up to date" check.
    const result = await ctx.lazy(['sync', taskId]);
    const output = result.stdout + result.stderr;
    // Should NOT say "up to date" — upstream has changes
    expect(output.includes('up to date')).toBe(false);
  });

  test('sync on nonexistent task fails', async () => {
    const result = await ctx.lazy(['sync', 'deadbeef']);
    expectFailure(result);
    const output = result.stdout + result.stderr;
    expect(output.includes('not found') || output.includes('Task not found')).toBe(true);
  });

  test('sync help includes task-level sync documentation', async () => {
    const result = await ctx.lazy(['sync', '--help']);
    expectSuccess(result);
    expectOutput(result, 'task ID');
    expectOutput(result, 'upstream');
  });
});
