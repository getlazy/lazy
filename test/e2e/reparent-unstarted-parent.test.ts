/**
 * Reparenting onto a parent that has not started yet.
 *
 * Background: a task's branch name used to be assigned when it STARTED, so a
 * cluster created but not yet started answered `lazy/<shortId>` — a branch it
 * would never have. Reparenting a started task under it fetched that phantom
 * branch, failed "after 3 attempts", blamed the network and suggested
 * `--offline-override`; the merge only happened minutes later, on a retry tick.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskJson } from '../helpers/storage';

describe('reparent onto an unstarted parent', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // A daemon: the child's sync after the parent starts runs in the daemon,
    // and the reconciler is what parks the started child.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a parent that has not started is "nothing to merge yet" — never
  // a fetch, a network failure or --offline-override — and once it starts, the
  // waiting child merges its REAL branch by itself. (That the merge is
  // immediate rather than a retry tick later is proven by parent-started-sync.)
  test('says there is nothing to merge yet, then merges the real branch when the parent starts', async () => {
    const childId = await createTask(ctx, 'Child task', 'Do work');
    expectSuccess(await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expectSuccess(await ctx.lazy(['wait', childId]));

    expectSuccess(await ctx.lazy(['create', '--goal', 'Landing cluster', '--prompt', 'Drive children', '--code', 'landing-c', '--type', 'cluster']));
    // The branch name is fixed at create: no `lazy/<shortId>` before start.
    expect((readTaskJson(ctx.root, 'landing-c') as any).metadata?.task_ref).toBe('landing-c');

    const reparent = await ctx.lazyMocked(['reparent', childId, '--parent', 'landing-c', '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(reparent);
    const out = reparent.stdout + reparent.stderr;
    expect(out).toContain("hasn't started, so there is nothing to merge yet");
    expect(out).not.toMatch(/fetch failed|network|offline-override/i);
    expect((readTaskJson(ctx.root, childId) as any).pending_sync).toBeGreaterThan(0);

    // Something on main the parent's branch will carry once it is cut.
    writeFileSync(join(ctx.root, 'from-parent.txt'), 'parent base\n');
    expect(ctx.git('add', 'from-parent.txt').exitCode).toBe(0);
    expect(ctx.git('commit', '-m', 'base for the cluster').exitCode).toBe(0);
    const baseSha = ctx.git('rev-parse', 'HEAD').stdout.trim();

    expectSuccess(await ctx.lazyMocked(['start', 'landing-c', '--yes'], MOCK_CLAUDE_SUCCESS));

    const childBranch = `lazy/${(readTaskJson(ctx.root, childId) as any).metadata.task_ref}`;
    const deadline = Date.now() + 20_000;
    let merged = false;
    while (Date.now() < deadline) {
      merged = ctx.git('merge-base', '--is-ancestor', baseSha, childBranch).exitCode === 0
        && (readTaskJson(ctx.root, childId) as any).pending_sync === 0;
      if (merged) break;
      await Bun.sleep(250);
    }
    expect(merged).toBe(true);
  }, 60_000);
});
