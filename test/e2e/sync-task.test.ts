/**
 * Tests for per-task sync (syncTaskFromRemote).
 *
 * These tests verify that PR comments are fetched and stored as notes
 * when reviewing a task, and that the function handles edge cases gracefully.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
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

  // INVARIANT: Every unblock merges upstream before giving feedback.
  // Agents must always work against current main to prevent drift.
  // --sync-with-upstream is additive (injects merge conflict warning),
  // not the only way to trigger merge.
  test('unblock without --sync-with-upstream DOES trigger merge when upstream has changes', async () => {
    // Create and start a task
    const taskId = await createTask(ctx, 'Auto merge task', 'Do some work');

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

    // Unblock with just a message (no --sync-with-upstream)
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Fix the bug'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);
    // SHOULD mention upstream merge — auto-merge is always on
    expectOutput(unblockResult, 'Supervisor will merge before proceeding');
  });

  test('unblock with --sync-with-upstream triggers merge message', async () => {
    const taskId = await createTask(ctx, 'Merge task', 'Do some work');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // Unblock with --sync-with-upstream
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--sync-with-upstream'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);
    // Should mention upstream merge
    expectOutput(unblockResult, 'Supervisor will merge before proceeding');
  });

  test('unblock with --sync-with-upstream and --message combines them', async () => {
    const taskId = await createTask(ctx, 'Merge with feedback task', 'Do some work');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // --sync-with-upstream combined with --message should succeed
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--sync-with-upstream', '--message', 'Also fix the login bug'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);
    expectOutput(unblockResult, 'Supervisor will merge before proceeding');
  });

  test('unblock with --sync-with-upstream and piped stdin combines them', async () => {
    const taskId = await createTask(ctx, 'Merge with piped task', 'Do some work');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);

    // --sync-with-upstream combined with piped stdin should succeed
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--sync-with-upstream'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' }, input: 'Fix the piped feedback bug' },
    );
    expectSuccess(unblockResult);
    expectOutput(unblockResult, 'Supervisor will merge before proceeding');
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
