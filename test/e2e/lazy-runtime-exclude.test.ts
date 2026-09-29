import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

// A project whose branch never carries lazy's .gitignore — the shape of a
// project cloned or created on a Teams install, where `lazy init` writes the
// root .gitignore and nobody commits it.
describe("lazy's runtime files stay out of a task worktree whose branch has no .gitignore", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    const tracked = Bun.spawnSync(['git', 'ls-files', '--error-unmatch', '.gitignore'], { cwd: ctx.root });
    if (tracked.exitCode === 0) {
      ctx.git('rm', '--cached', '-q', '.gitignore');
      ctx.git('commit', '-q', '-m', 'Drop .gitignore from the branch');
    }
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: lazy owns its ignore rules through the repository's
  // info/exclude, shared by every worktree. A branch without lazy's .gitignore
  // otherwise lists the agent sandbox as untracked, and `git add -A` (what
  // lazy_commit does with no file list) commits it as the task's work.
  test('first task worktree: sandbox files are ignored and absent from the diff', async () => {
    const commonDir = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ctx.root })
      .stdout.toString().trim();
    const exclude = readFileSync(join(commonDir, 'info', 'exclude'), 'utf-8');
    expect(exclude).toContain('.lazy-task-sandbox/');

    const taskId = await createTask(ctx, 'Runtime exclude test', 'Do nothing');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    await ctx.lazy(['show', taskId]);

    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    expect(Bun.spawnSync(['git', 'ls-files', '.gitignore'], { cwd: worktreePath }).stdout.toString().trim()).toBe('');
    mkdirSync(join(worktreePath, '.lazy-task-sandbox'), { recursive: true });
    writeFileSync(join(worktreePath, '.lazy-task-sandbox', '.claude.json'), '{}\n');
    writeFileSync(join(worktreePath, '.lazy-lock'), '1\n');

    const status = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=all'], { cwd: worktreePath });
    expect(status.stdout.toString().trim()).toBe('');

    // Real uncommitted work, so the diff renders its uncommitted section —
    // the section that showed staged sandbox files on a task with no commits.
    writeFileSync(join(worktreePath, 'work.txt'), 'agent work\n');
    // What an agent's `git add -A` (or lazy_commit with no file list) does.
    Bun.spawnSync(['git', 'add', '-A'], { cwd: worktreePath });
    expect(Bun.spawnSync(['git', 'diff', '--cached', '--name-only'], { cwd: worktreePath }).stdout.toString().trim()).toBe('work.txt');

    const diff = await ctx.lazy(['diff', taskId, '--full']);
    expectSuccess(diff);
    expect(diff.stdout).toContain('work.txt');
    expectOutputExcludes(diff, '.claude.json');
    expectOutputExcludes(diff, '.lazy-lock');
  });

  // INVARIANT: an existing project picks the exclude up without re-init —
  // creating a task worktree writes it first.
  test('worktree creation restores a missing exclude block without re-init', async () => {
    const commonDir = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ctx.root })
      .stdout.toString().trim();
    const excludePath = join(commonDir, 'info', 'exclude');
    writeFileSync(excludePath, '# user line\n');

    const taskId = await createTask(ctx, 'Exclude restored', 'Do nothing');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const exclude = readFileSync(excludePath, 'utf-8');
    expect(exclude).toContain('# user line');
    expect(exclude).toContain('.lazy-task-sandbox/');

    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    mkdirSync(join(worktreePath, '.lazy-task-sandbox'), { recursive: true });
    writeFileSync(join(worktreePath, '.lazy-task-sandbox', '.claude.json'), '{}\n');
    const status = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=all'], { cwd: worktreePath });
    expect(status.stdout.toString().trim()).toBe('');
  });
});
