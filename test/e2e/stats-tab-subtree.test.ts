/**
 * The Stats tab's scope toggle, end to end through the dashboard.
 *
 * The derivation is unit-tested; what goes through the real page here is the
 * WIRING, which a renderer test cannot catch: that a hub defaults to the
 * subtree view, that `?scope=task` narrows back, and that a child's turns and
 * commits actually reach the rolled-up numbers.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTaskBeforeDaemon, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { extractTaskId, expectSuccess } from '../helpers/assertions';
import { signInToDashboard } from '../helpers/dashboard-session';

describe('Stats tab subtree rollup', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** A hub that never ran, with a child and a grandchild that did. */
  async function hubWithWorkBelow(): Promise<{ hub: string; child: string }> {
    const hub = await createTaskBeforeDaemon(ctx, 'Release hub', 'Drive the release');

    const childResult = await ctx.lazy(['create', '--goal', 'Real work', '--prompt', 'Do the work', '--parent', hub]);
    expectSuccess(childResult);
    const child = extractTaskId(childResult.stdout);

    const grandResult = await ctx.lazy(['create', '--goal', 'Deeper work', '--prompt', 'Go deeper', '--parent', child]);
    expectSuccess(grandResult);
    const grandchild = extractTaskId(grandResult.stdout);

    // Every level runs one turn. The hub has to run at all — a child cannot
    // start before its parent has a worktree — so the shape under test is the
    // real one: a hub with a handful of its own turns, and the work below it.
    for (const id of [hub, child, grandchild]) {
      const started = await ctx.lazyMocked(['start', id, '--yes'], MOCK_CLAUDE_SUCCESS, {
        env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
      });
      expectSuccess(started);
      const waited = await ctx.lazy(['wait', id]);
      if (waited.exitCode !== 0) {
        throw new Error(`wait failed for ${id}: ${waited.stderr}\n${waited.stdout}`);
      }
    }
    return { hub, child };
  }

  test('a hub defaults to the subtree view and says what it folded in', async () => {
    const { hub } = await hubWithWorkBelow();
    const { base, fetch: authed } = await signInToDashboard(ctx);

    const html = await (await authed(`${base}/tasks/${hub}/stats`)).text();
    expect(html).toContain('These numbers cover this task and 2 nested task(s).');
    expect(html).toContain('lz-stats-scope');
    expect(html).toContain('Including subtasks (2 nested tasks)');
    // The descendants' turns are in the rolled-up count; the hub ran none.
    expect(html).toContain('Per-turn numbers');
  });

  test('?scope=task narrows back to the task alone', async () => {
    const { hub } = await hubWithWorkBelow();
    const { base, fetch: authed } = await signInToDashboard(ctx);

    const own = await (await authed(`${base}/tasks/${hub}/stats?scope=task`)).text();
    expect(own).toContain('These numbers cover this task alone.');
    // The toggle is still there, pointing back at the rollup.
    expect(own).toContain('scope=subtree');
    // No union-vs-sum note: there is nothing folded in to explain.
    expect(own).not.toContain('Added up per task instead');
  });

  test('the rolled-up view counts more turns than the task alone', async () => {
    const { hub } = await hubWithWorkBelow();
    const { base, fetch: authed } = await signInToDashboard(ctx);

    const turnsIn = (html: string): number => {
      const match = html.match(/<div class="lz-stat-label">Turns<\/div><div class="lz-stat-value">([\d,]+)</);
      if (!match) throw new Error(`no Turns tile in:\n${html.slice(0, 2000)}`);
      return Number(match[1].replace(/,/g, ''));
    };

    const rolled = turnsIn(await (await authed(`${base}/tasks/${hub}/stats`)).text());
    const own = turnsIn(await (await authed(`${base}/tasks/${hub}/stats?scope=task`)).text());
    // The hub ran one turn; the two tasks below it ran one each. The whole
    // complaint this view answers is that the first number was the only one
    // a reader of a hub could see.
    expect(own).toBeGreaterThan(0);
    expect(rolled).toBe(own * 3);
  });

  test('a leaf task gets no toggle, because both views are the same numbers', async () => {
    const leaf = await createTaskBeforeDaemon(ctx, 'Leaf task', 'Do one thing');
    const { base, fetch: authed } = await signInToDashboard(ctx);

    const html = await (await authed(`${base}/tasks/${leaf}/stats`)).text();
    expect(html).toContain('These numbers cover this task alone.');
    expect(html).not.toContain('lz-stats-scope');
  });
});
