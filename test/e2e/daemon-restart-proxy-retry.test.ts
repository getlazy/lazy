/**
 * Task agents recover from a daemon restart with a fresh proxy URL on the next
 * launch — exercised through the fake-binary supervisor seam.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { goSilentScenario, successScenario } from '../helpers/fake-claude';
import { readTaskStatus } from '../helpers/storage';

const settle = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, budgetMs: number): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await settle(500);
    last = await read();
  }
  return last;
}

describe('daemon restart proxy refresh', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    await ctx.recordClaudeEnvKeys(['ANTHROPIC_BASE_URL']);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('after a daemon restart the auto-resumed agent gets a fresh proxy URL', async () => {
    const taskId = await createTask(ctx, 'Proxy refresh after daemon restart', 'Work slowly');
    await ctx.setClaudeScenario(
      goSilentScenario({ sessionId: 'proxy-restart-victim', silentMs: 120_000 }),
    );

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expect(await until(async () => readTaskStatus(ctx.root, taskId), s => s === 'working', 20_000)).toBe('working');

    const firstBatch = await until(
      async () => ctx.claudeInvocations(),
      inv => inv.length >= 1 && !!inv[0]?.env?.ANTHROPIC_BASE_URL,
      60_000,
    );
    const staleUrl = firstBatch[0]!.env!.ANTHROPIC_BASE_URL;

    await ctx.clearClaudeInvocations();
    await ctx.setClaudeScenario(successScenario({ result: 'done after restart', sessionId: 'proxy-restart-resume' }));

    expectSuccess(await ctx.lazy(['daemon', 'restart']));

    await until(async () => readTaskStatus(ctx.root, taskId), s => s === 'working', 60_000);

    const afterResume = await until(
      async () => ctx.claudeInvocations(),
      inv => inv.length >= 1 && !!inv[0]?.env?.ANTHROPIC_BASE_URL,
      60_000,
    );
    const freshUrl = afterResume[0]!.env!.ANTHROPIC_BASE_URL;
    expect(freshUrl).not.toBe(staleUrl);
  }, 180_000);
});
