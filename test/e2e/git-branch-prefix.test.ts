import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS, disablePreAccept } from '../helpers/fixtures';

/**
 * Regression tests for task `fix-branch-prefix-and-auto-push-config`.
 *
 * The bug (reported against a released build): `[git] default_branch_prefix`
 * was documented and validated, but no branch-naming code read it — every task
 * branch was built from a hard-coded `lazy/` literal (`getBranchName()` in
 * src/cli/helpers.ts and the launcher's own `lazy/${tRef}`). A user who set a
 * custom prefix still got `lazy/<ref>` branches.
 *
 * INVARIANT: the configured prefix is the ONLY source of a task branch's
 * namespace. If a test here fails because someone reintroduced a `lazy/`
 * literal on a branch-naming path, fix the literal — do not relax the test.
 */
describe('[git] default_branch_prefix', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite: the pre-accept turn has no runner to launch against,
    // and this file asserts on branch naming rather than on that turn.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Rewrite the prefix key in the init-produced lazy.toml. Editing the key (as
   * opposed to overwriting the file) keeps `external_path` — the test store
   * lives outside the temp repo, so a stub lazy.toml would silently point the
   * CLI at an empty store and every assertion would pass for the wrong reason.
   */
  function setPrefix(prefix: string): void {
    const tomlPath = join(ctx.root, 'lazy.toml');
    const before = readFileSync(tomlPath, 'utf-8');
    const after = before.replace('default_branch_prefix = "lazy"', `default_branch_prefix = "${prefix}"`);
    expect(after).not.toBe(before);
    writeFileSync(tomlPath, after);
  }

  /** All local branch names in the test repo. */
  function branches(): string[] {
    const r = ctx.git('branch', '--format=%(refname:short)');
    expect(r.exitCode).toBe(0);
    return r.stdout.split('\n').map(l => l.trim()).filter(Boolean);
  }

  test('a started task gets its branch under the configured prefix', async () => {
    setPrefix('wip');

    const taskId = await createTask(ctx, 'Prefixed task', 'Do the thing');
    const start = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(start);

    const taskBranches = branches().filter(b => b !== 'main');
    expect(taskBranches.length).toBe(1);
    expect(taskBranches[0]!.startsWith('wip/')).toBe(true);
    // The literal the bug shipped: no branch may land under `lazy/` when the
    // user configured something else.
    expect(taskBranches.some(b => b.startsWith('lazy/'))).toBe(false);
  });

  test('a subtask branches under the configured prefix too', async () => {
    setPrefix('wip');

    const parentId = await createTask(ctx, 'Parent task', 'Parent prompt');
    expectSuccess(await ctx.lazyMocked(['start', parentId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));

    const childResult = await ctx.lazy([
      'create', '--goal', 'Child task', '--prompt', 'Child prompt', '--parent', parentId,
    ]);
    expectSuccess(childResult);
    const childId = childResult.stdout.match(/([a-f0-9]{8})/)![1];

    expectSuccess(await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));

    const taskBranches = branches().filter(b => b !== 'main');
    expect(taskBranches.length).toBe(2);
    for (const b of taskBranches) {
      expect(b.startsWith('wip/')).toBe(true);
    }
  });

  test('the default prefix is still "lazy" when nothing is configured', async () => {
    const taskId = await createTask(ctx, 'Default prefix task', 'Do the thing');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));

    const taskBranches = branches().filter(b => b !== 'main');
    expect(taskBranches.length).toBe(1);
    expect(taskBranches[0]!.startsWith('lazy/')).toBe(true);
  });
});
