import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Tests for offline-mode warnings on `lazy start` (builder startup),
 * `lazy accept`, and `lazy sync`.
 *
 * These warnings surface the fact that offline mode is active so users
 * don't silently operate in local-only mode for days while a remote driver
 * is configured.
 */
describe('offline-mode warnings', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function switchDriver(driver: 'github' | 'gitlab') {
    const tomlPath = join(ctx.root, 'lazy.toml');
    let toml = readFileSync(tomlPath, 'utf-8');
    if (toml.includes('driver = "local"')) {
      toml = toml.replace('driver = "local"', `driver = "${driver}"`);
    } else if (/driver\s*=\s*"[^"]+"/.test(toml)) {
      toml = toml.replace(/driver\s*=\s*"[^"]+"/, `driver = "${driver}"`);
    } else {
      toml += `\n[remote]\ndriver = "${driver}"\n`;
    }
    writeFileSync(tomlPath, toml);
  }

  test('lazy start emits offline notice when driver is gitlab', async () => {
    switchDriver('gitlab');
    expectSuccess(await ctx.lazy(['system', 'offline']));

    const taskId = await createTask(ctx, 'Offline start', 'Do work');
    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(result);

    expectOutput(result, 'lazy is in offline mode');
    expectOutput(result, 'Accepts will not create MRs');
    expectOutput(result, 'lazy system online');
  });

  test('lazy accept emits MR/PR warning when offline with github driver', async () => {
    // Start with local driver (so start succeeds without a real remote),
    // commit work, switch to github + offline, then accept.
    const taskId = await createTask(ctx, 'Offline accept', 'Do work');
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature\n');
    expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'add feature').exitCode).toBe(0);

    switchDriver('github');
    expectSuccess(await ctx.lazy(['system', 'offline']));

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'lazy is in offline mode');
    expectOutput(result, 'will NOT create a PR on GitHub');
    expectOutput(result, 'squash-merge locally');
  });
});
