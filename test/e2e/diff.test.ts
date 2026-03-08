import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes, extractTaskId } from '../helpers/assertions';
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

  // INVARIANT: Child task diffs exclude parent branch upstream changes.
  // When a parent branch merges main (lots of changes), and the child merges
  // the parent, the child's diff must show only its own changes, not the
  // accumulated upstream changes from main via the parent.
  test('child task diff excludes upstream changes from parent branch', async () => {
    // 1. Create and start a parent task (branches from main)
    const parentId = await createTask(ctx, 'Parent task', 'Parent work');
    await ctx.lazyMocked(['start', parentId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    await ctx.lazy(['show', parentId]);

    // 2. Add a large upstream change on main (simulating a big PR merge)
    writeFileSync(join(ctx.root, 'big-upstream-change.txt'), 'Lots of upstream content\n'.repeat(100));
    ctx.git('add', 'big-upstream-change.txt');
    ctx.git('commit', '-m', 'Big upstream PR merged into main');

    // 3. Merge main into the parent branch (parent now has upstream changes)
    const parentWorktree = join(ctx.root, '.lazy', 'worktrees', parentId);
    Bun.spawnSync(['git', 'merge', 'main', '--no-ff', '-m', 'Merge main into parent'], {
      cwd: parentWorktree,
    });

    // 4. Create a child task parented on the parent task
    const parentShowResult = await ctx.lazy(['show', parentId, '--json']);
    const parentData = JSON.parse(parentShowResult.stdout);
    const parentBranch = parentData.session.git_branch;

    const childResult = await ctx.lazy(['create', '--goal', 'Child task', '--prompt', 'Child work', '--parent', parentId]);
    expectSuccess(childResult);
    const childId = extractTaskId(childResult.stdout);

    // 5. Start the child task
    await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    await ctx.lazy(['show', childId]);

    // 6. Merge parent branch into child (child now has parent's upstream changes)
    const childWorktree = join(ctx.root, '.lazy', 'worktrees', childId);
    Bun.spawnSync(['git', 'merge', parentBranch, '--no-ff', '-m', 'Merge parent into child'], {
      cwd: childWorktree,
    });

    // 7. Add child-specific work
    writeFileSync(join(childWorktree, 'child-work.txt'), 'Child-specific changes\n');
    Bun.spawnSync(['git', 'add', 'child-work.txt'], { cwd: childWorktree });
    Bun.spawnSync(['git', 'commit', '-m', 'Child-specific commit'], { cwd: childWorktree });

    // 8. Diff should show child's work but NOT the big upstream change from main
    const diffResult = await ctx.lazy(['diff', childId, '--full']);
    expectSuccess(diffResult);
    expectOutput(diffResult, 'child-work');
    expectOutputExcludes(diffResult, 'big-upstream-change');

    // Stat should also exclude upstream
    const statResult = await ctx.lazy(['diff', childId]);
    expectSuccess(statResult);
    expectOutput(statResult, 'child-work');
    expectOutputExcludes(statResult, 'big-upstream-change');
  });
});
