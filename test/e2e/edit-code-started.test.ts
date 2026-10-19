import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { seedFinal } from '../helpers/final';

/**
 * `lazy edit --code` on a STARTED task is a cosmetic rename: the task answers
 * to the new code, while its branch, worktree and everything else a launch
 * derived keep the names pinned at first start.
 */
describe('lazy edit --code on a started task', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // start/sync/accept need the daemon reconciler to move tasks out of `working`.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function createAndStart(code: string, parent?: string): Promise<void> {
    const args = ['create', '--code', code, '--goal', `Goal ${code}`, '--prompt', 'Work'];
    if (parent) args.push('--parent', parent);
    expectSuccess(await ctx.lazy(args));
    expectSuccess(await ctx.lazyMocked(['start', code, '--yes'], MOCK_CLAUDE_SUCCESS));
    expect((await ctx.lazy(['wait', code])).exitCode).toBe(0);
  }

  function commitIn(ref: string, file: string, message: string): void {
    const wt = join(ctx.root, '.lazy', 'worktrees', ref);
    writeFileSync(join(wt, file), `${file}\n`);
    expect(ctx.git('-C', wt, 'add', file).exitCode).toBe(0);
    expect(ctx.git('-C', wt, 'commit', '-m', message).exitCode).toBe(0);
  }

  // INVARIANT: renaming a started task changes its code and nothing else; its
  // children keep syncing and accepting against the parent's ORIGINAL branch.
  // Every launch-derived name reads the pinned task ref, so a rename that moved
  // (or re-derived) the branch would strand the child's merge target.
  test('renamed parent: child syncs and accepts onto the unchanged branch', async () => {
    await createAndStart('hub-old');
    await createAndStart('hub-child', 'hub-old');

    const edit = await ctx.lazy(['edit', 'hub-old', '--code', 'hub-new']);
    expectSuccess(edit);
    expect(edit.stdout).toContain('hub-new');
    expect(edit.stdout).toContain('lazy/hub-old');
    expect(edit.stdout).toContain('keep their old names');

    // Lookups follow the new code; the branch and worktree did not move.
    expectSuccess(await ctx.lazy(['show', 'hub-new']));
    expect(ctx.git('show-ref', '--verify', 'refs/heads/lazy/hub-old').exitCode).toBe(0);
    expect(ctx.git('show-ref', '--verify', 'refs/heads/lazy/hub-new').exitCode).not.toBe(0);
    expect(existsSync(join(ctx.root, '.lazy', 'worktrees', 'hub-old'))).toBe(true);

    // New upstream work on the parent reaches the child through sync.
    commitIn('hub-old', 'parent.txt', 'Parent work after rename');
    expectSuccess(await ctx.lazyMocked(['sync', 'hub-child', '--yes'], MOCK_CLAUDE_SUCCESS));
    expect((await ctx.lazy(['wait', 'hub-child'])).exitCode).toBe(0);
    expect(existsSync(join(ctx.root, '.lazy', 'worktrees', 'hub-child', 'parent.txt'))).toBe(true);

    commitIn('hub-child', 'child.txt', 'Child work');
    await seedFinal(ctx, 'hub-child');
    expectSuccess(await ctx.lazy(['accept', 'hub-child', '--yes']));

    const onParent = ctx.git('show', 'lazy/hub-old:child.txt');
    expect(onParent.exitCode).toBe(0);
  });

  // INVARIANT: a new task given a code a started task was renamed away from
  // must not be cut onto that task's still-existing branch.
  test('a new task reusing the old code gets its own branch', async () => {
    await createAndStart('reused');
    expectSuccess(await ctx.lazy(['edit', 'reused', '--code', 'renamed']));

    await createAndStart('reused');
    const branches = ctx.git('for-each-ref', '--format=%(refname:short)', 'refs/heads/lazy/').stdout;
    const reusedBranches = branches.split('\n').filter(b => b.startsWith('lazy/reused'));
    expect(reusedBranches.length).toBe(2);
  });

  test('refuses a clash, a clear, and a rename combined with other edits', async () => {
    await createAndStart('alpha');
    expectSuccess(await ctx.lazy(['create', '--code', 'beta', '--goal', 'Other']));

    const clash = await ctx.lazy(['edit', 'alpha', '--code', 'beta']);
    expect(clash.exitCode).not.toBe(0);
    expect(clash.stderr + clash.stdout).toContain("A task with code 'beta' already exists");

    const combined = await ctx.lazy(['edit', 'alpha', '--code', 'gamma', '--model', 'opus']);
    expect(combined.exitCode).not.toBe(0);

    const cleared = await ctx.lazy(['edit', 'alpha', '--code', '']);
    expect(cleared.exitCode).not.toBe(0);
    expect(cleared.stderr + cleared.stdout).toContain('Cannot clear the code');

    expectSuccess(await ctx.lazy(['show', 'alpha']));
  });
});
