/**
 * Turn-launch observability: what the human sees while a turn-launching command
 * waits on the daemon.
 *
 * WHY: `lazy sync <task>` once sat for six minutes printing nothing. It was
 * waiting on the daemon, which fetches upstream and — if the container image is
 * missing or stale — builds it, all inside the RPC. Every command that launches
 * or resumes a turn has the same shape, so they all narrate through the same
 * phase channel `lazy accept` uses (src/daemon/progress.ts → src/cli/phase-display.ts).
 *
 * These tests assert the phases arrive, in execution order, on the commands that
 * were silent: sync and unblock.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { setTaskStatus } from '../helpers/storage';

describe('turn-launch observability', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Assert `needles` appear in `text` in this order. Phase narration is only
   * useful if it tracks what the daemon is doing — a set of lines in arbitrary
   * order would not tell anyone where a slow command is stuck.
   */
  function expectInOrder(text: string, needles: string[]): void {
    let cursor = 0;
    for (const needle of needles) {
      const at = text.indexOf(needle, cursor);
      if (at < 0) {
        throw new Error(`missing (or out of order) "${needle}" after index ${cursor} in:\n${text}`);
      }
      cursor = at + needle.length;
    }
  }

  /** A started task, forced to 'blocked' — daemonless nothing reconciles it. */
  async function blockedTask(goal: string): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Do work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    setTaskStatus(ctx.root, taskId, 'blocked');
    return taskId;
  }

  /** Add a commit to main so the task's upstream genuinely has changes. */
  function advanceUpstream(name: string): void {
    ctx.git('checkout', 'main');
    writeFileSync(join(ctx.root, `${name}.txt`), 'upstream\n');
    ctx.git('add', `${name}.txt`);
    ctx.git('commit', '-m', `upstream ${name}`);
    ctx.git('checkout', '-');
  }

  test('sync narrates upstream, compare, worktree and launch in order', async () => {
    const taskId = await blockedTask('Sync phase order');
    advanceUpstream('sync-phases');

    // lazyMocked so the in-process supervisor launch succeeds — otherwise the
    // launch phase fails on a missing docker rather than completing.
    const result = await ctx.lazyMocked(['sync', taskId], MOCK_CLAUDE_SUCCESS);
    const output = result.stdout + result.stderr;

    expectInOrder(output, [
      'Pre-flight validation',
      // Step 1 of the two-step reconcile: origin/<task-branch> before the
      // parent (see CLAUDE.md). Skipped here — the driver is `local` — but the
      // phase is still announced, which is the point of the narration.
      'Check task branch on origin',
      'Fetch and resolve upstream',
      'Compare with upstream',
      'Prepare worktree',
      'Launch agent to merge',
    ]);

    // The plan is announced up front, so the human knows how many steps remain.
    expect(output).toContain('sync ');
    expect(output).toContain('5 phases');
  });

  // Nothing to merge is still an outcome worth narrating: the compare phase
  // settles with the reason, and the phases that will not run are announced as
  // skipped rather than silently never appearing.
  test('an up-to-date sync settles compare and skips the rest with a reason', async () => {
    const taskId = await blockedTask('Sync up to date phases');

    const result = await ctx.lazy(['sync', taskId]);
    expectSuccess(result);
    const output = result.stdout + result.stderr;

    expectInOrder(output, [
      'Fetch and resolve upstream',
      'Compare with upstream',
      'already up to date',
    ]);
    expect(output).toContain('skipped');
    expect(output).toContain('nothing to merge');
    expectOutput(result, 'Already up to date');
  });

  test('unblock narrates its phases in order', async () => {
    const taskId = await blockedTask('Unblock phase order');

    const result = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Please continue'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    const output = result.stdout + result.stderr;

    expectInOrder(output, [
      'Prepare worktree',
      'Save unblock feedback',
      'Launch agent',
    ]);
  });
});
