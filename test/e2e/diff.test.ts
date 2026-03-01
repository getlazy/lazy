import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('lazy diff uses three-dot diff against parent HEAD', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('diff excludes upstream changes merged into task branch', async () => {
    // Create and start a task (branches from main)
    const taskId = await createTask(ctx, 'Three-dot diff test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Trigger reconciliation so the agent turn is recorded
    await ctx.lazy(['show', taskId]);

    // Now add a commit on main (simulating another PR merged upstream)
    writeFileSync(join(ctx.root, 'upstream-only.txt'), 'This came from upstream\n');
    ctx.git('add', 'upstream-only.txt');
    ctx.git('commit', '-m', 'Upstream PR merged into main');

    // Merge main into the task branch's worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    Bun.spawnSync(['git', 'merge', 'main', '--no-ff', '-m', 'Merge main into task'], {
      cwd: worktreePath,
    });

    // Diff should show the agent's work but NOT the upstream-only.txt file
    const diffResult = await ctx.lazy(['diff', taskId, '--full']);
    expectSuccess(diffResult);
    expectOutput(diffResult, 'agent-output');
    expectOutputExcludes(diffResult, 'upstream-only');
  });

  test('diff stat excludes upstream changes merged into task branch', async () => {
    const taskId = await createTask(ctx, 'Three-dot stat test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    await ctx.lazy(['show', taskId]);

    // Add upstream commit on main
    writeFileSync(join(ctx.root, 'upstream-stat.txt'), 'upstream content\n');
    ctx.git('add', 'upstream-stat.txt');
    ctx.git('commit', '-m', 'Another upstream commit');

    // Merge main into task worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    Bun.spawnSync(['git', 'merge', 'main', '--no-ff', '-m', 'Merge main'], {
      cwd: worktreePath,
    });

    // Stat diff should not mention the upstream file
    const diffResult = await ctx.lazy(['diff', taskId]);
    expectSuccess(diffResult);
    expectOutputExcludes(diffResult, 'upstream-stat');
  });

  test('diff still shows task branch changes after merging upstream', async () => {
    const taskId = await createTask(ctx, 'Task changes visible', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    await ctx.lazy(['show', taskId]);

    // Add an extra commit on the task branch (in the worktree)
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'task-specific.txt'), 'task work\n');
    Bun.spawnSync(['git', 'add', 'task-specific.txt'], { cwd: worktreePath });
    Bun.spawnSync(['git', 'commit', '-m', 'Task-specific commit'], { cwd: worktreePath });

    // Full diff should show the task's changes
    const diffResult = await ctx.lazy(['diff', taskId, '--full']);
    expectSuccess(diffResult);
    expectOutput(diffResult, 'task-specific');
  });
});
