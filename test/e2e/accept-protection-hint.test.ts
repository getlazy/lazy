/**
 * E2E tests for the branch-protection discovery hint printed by `lazy accept`.
 *
 * WHY THIS EXISTS: protection is opt-in and therefore invisible — a user who
 * never hears of it never turns it on. The hint is the one place lazy mentions
 * it, printed AFTER a successful accept into the repo's integration branch,
 * where it costs nothing and blocks nothing (see src/protection/discovery.ts).
 *
 * INVARIANT: the hint is suppressed the moment the human has an opinion —
 * `[protection] enabled` present with EITHER value stops it for good. An
 * explicit `enabled = false` means "I know about it and said no"; nagging past
 * that is exactly the friction this reversal was meant to remove.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

const HINT = 'lazy protect main on';

/** Overwrite the [protection] section header with the given extra keys. */
async function setProtectionKeys(ctx: TestContext, extra: string): Promise<void> {
  const tomlPath = join(ctx.root, 'lazy.toml');
  const toml = await readFile(tomlPath, 'utf-8');
  await writeFile(tomlPath, toml.replace('[protection]\n', `[protection]\n${extra}`));
}

describe('lazy accept: the branch-protection discovery hint', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // `start`/`accept` need a real daemon (post-v0.11 the CLI goes through the
    // daemon for storage, and the merge runs inside it).
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Create a task, run a mocked turn, and commit a file so it can be accepted. */
  async function setupBlockedTask(name: string): Promise<string> {
    const taskId = await createTask(ctx, `Hint test ${name}`, 'Add a file');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, `${name}.txt`), 'content\n');
    ctx.git('-C', worktreePath, 'add', `${name}.txt`);
    ctx.git('-C', worktreePath, 'commit', '-m', `Add ${name}.txt`);
    return taskId;
  }

  test('a stock project gets the hint after a successful accept into main', async () => {
    const taskId = await setupBlockedTask('stock');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'accepted and merged');
    expectOutput(result, HINT);
  }, 60000);

  // The explicit opt-out means the human knows the feature and declined it.
  test('an explicit enabled = false suppresses the hint', async () => {
    await setProtectionKeys(ctx, 'enabled = false\n');
    const taskId = await setupBlockedTask('optedout');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'accepted and merged');
    expectOutputExcludes(result, 'lazy protect');
  }, 60000);

  // Nothing to advertise once protection is on — and with it on this accept
  // would be gated anyway, so the gate is lifted for the default branch here
  // and the point is purely that the tip is gone.
  test('protection already on suppresses the hint', async () => {
    await setProtectionKeys(ctx, 'enabled = true\ngate_default_branch = false\n');
    const taskId = await setupBlockedTask('alreadyon');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'accepted and merged');
    expectOutputExcludes(result, 'lazy protect');
  }, 60000);

  // A subtask merging into its parent's `lazy/*` branch is the inner loop —
  // never gate-worthy, so never advertised.
  test('no hint when the accept targets a lazy/* parent branch', async () => {
    const parentId = await setupBlockedTask('parent');
    const created = await ctx.lazy(['create', '--goal', 'Hint test child', '--prompt', 'Add a file', '--parent', parentId]);
    expectSuccess(created);
    const childId = extractTaskId(created.stdout);
    expectSuccess(await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expect((await ctx.lazy(['wait', childId])).exitCode).toBe(0);

    const worktreePath = join(ctx.root, '.lazy', 'worktrees', childId);
    writeFileSync(join(worktreePath, 'child.txt'), 'content\n');
    ctx.git('-C', worktreePath, 'add', 'child.txt');
    ctx.git('-C', worktreePath, 'commit', '-m', 'Add child.txt');

    const result = await ctx.lazy(['accept', childId, '--yes']);
    expectSuccess(result);
    expectOutputExcludes(result, 'lazy protect');
  }, 90000);
});
