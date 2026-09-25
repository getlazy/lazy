/**
 * Accepting a child starts its cluster fix-round budget over
 * (`[cluster] max_child_fix_rounds`).
 *
 * The promise is made in three places a user reads — `src/config/types.ts`,
 * `lazy.toml.example` and `public-docs/cluster-tasks.md` — as "reset when that
 * child is last STARTED OR ACCEPTED". Only the start half was ever wired up.
 *
 * WHY THIS ONE IS AN E2E AND THE OTHER RESET SITES ARE SOURCE SCANS. The reset
 * rides inside `acceptTaskRun`, past a real merge, so nothing short of a real
 * accept proves it RAN — and a scan proves only that a line of source exists.
 * The regression it exists to catch is silent by construction: wired to the
 * wrong task id, or dropped from one of the three accept exits, every surface
 * keeps promising the reset and nothing fails. What a user would see is a cluster
 * refused on a reopened child's budget it was told it had back.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { seedFinal } from '../helpers/final';
import { readTaskJson, setTaskMetadata } from '../helpers/storage';
import { CLUSTER_FIX_ROUND_KEY } from '../../src/daemon/cluster-fix-rounds';

describe('the cluster fix-round budget at accept', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // A real daemon: only its reconciler moves a task out of `working`, and
    // accept refuses otherwise (see accept-reason.test.ts for the same reason).
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('accepting the task clears the counter', async () => {
    const taskId = await createTask(ctx, 'Budget reset at accept', 'Some work');

    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // The in-daemon agent uses the daemon's own mock response, so the branch is
    // empty unless the test commits; accept refuses with no commits.
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');
    expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature').exitCode).toBe(0);

    await seedFinal(ctx, taskId);

    // Two rounds already spent — the state a cluster's child is in when the cluster
    // has sent it back twice.
    setTaskMetadata(ctx.root, taskId, CLUSTER_FIX_ROUND_KEY, '2');
    expect(readTaskJson(ctx.root, taskId).metadata?.[CLUSTER_FIX_ROUND_KEY]).toBe('2');

    expectSuccess(await ctx.lazy(['accept', taskId, '--reason', 'Good enough']));

    // Cleared — the counter is stored as the empty string, which
    // `getClusterFixRound` reads as 0. Not "2", and not left behind for a reopen
    // to inherit.
    const after = readTaskJson(ctx.root, taskId).metadata?.[CLUSTER_FIX_ROUND_KEY];
    expect(after).toBe('');
  }, 120_000);
});
