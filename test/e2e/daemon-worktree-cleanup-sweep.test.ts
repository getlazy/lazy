/**
 * e2e: the daemon's automatic terminal-worktree cleanup sweep.
 *
 * INVARIANT: a worktree left behind on a task that finished (complete/
 * abandoned) — because something between the status flip and the cleanup step
 * threw, or the process was killed mid-accept — must be reclaimed on its own,
 * without a human running `lazy doctor --clean-worktrees`. That reclaim is
 * `lazy doctor`'s existing `--clean-worktrees` finder and cleanup
 * (`findTerminalTaskWorktrees` / `cleanupWorktree`), run automatically by the
 * daemon on its own timer.
 *
 * The sweep reuses the capture sweep's LAZY_FORCE_CAPTURE_SWEEP test hatch to
 * both disable the default LAZY_TEST no-op and speed up its tick.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { setTaskStatus, worktreePathFor } from '../helpers/storage';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function seedTerminalWorktree(
  ctx: TestContext,
  goal: string,
  status: string,
): Promise<{ taskId: string; path: string }> {
  const taskId = await createTask(ctx, goal);
  setTaskStatus(ctx.root, taskId, status);
  const path = worktreePathFor(ctx.root, taskId);
  await mkdir(join(path, 'node_modules'), { recursive: true });
  await writeFile(join(path, 'node_modules', 'big.bin'), 'x'.repeat(4096));
  return { taskId, path };
}

describe('daemon terminal-worktree cleanup sweep', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_FORCE_CAPTURE_SWEEP: '1' },
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('removes a leftover worktree for a finished task on its own', async () => {
    const seeded = await seedTerminalWorktree(ctx, 'Finished work', 'complete');
    expect(await exists(seeded.path)).toBe(true);

    const deadline = Date.now() + 20_000;
    let gone = false;
    while (Date.now() < deadline) {
      if (!(await exists(seeded.path))) {
        gone = true;
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    expect(gone).toBe(true);

    const doctor = await ctx.lazy(['doctor', '--clean-worktrees']);
    expect(doctor.stdout).toContain('No worktrees for finished tasks');
  }, 45_000);

  test('never touches the worktree of a task still in progress', async () => {
    const live = await seedTerminalWorktree(ctx, 'Still going', 'blocked');

    // Give the sweep several ticks' worth of time to (wrongly) act.
    await new Promise(r => setTimeout(r, 3_000));

    expect(await exists(live.path)).toBe(true);
  }, 15_000);
});
