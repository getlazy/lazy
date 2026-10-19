import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { seedFinal } from '../helpers/final';
import { findFullTaskId } from '../helpers/storage';
import { getProxyTokensPath } from '../../src/daemon/paths';

interface Grant { token: string; taskId: string | null; taskUuid?: string; role: string }

/**
 * INVARIANT: a task's proxy placeholders die when the task is accepted.
 *
 * Launches mint each grant with `taskId` = the task's REF (its code or short
 * id) and `taskUuid` = its UUID, while accept revokes by the UUID — and for a
 * release the two never matched, so in solo mode a placeholder that leaked out
 * of the container kept spending the human's credential after accept. The
 * grants are seeded here exactly as a launch writes them, because the module
 * mock replaces the launch that would mint them.
 * (Before the fix this test leaves both of the task's grants behind.)
 */
describe('accept revokes the task\'s proxy placeholders', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // Accept needs a real daemon: the reconciler moves the task out of working.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('grants minted under the task ref and UUID are revoked; another task\'s stay', async () => {
    const ref = await createTask(ctx, 'Revocation test', 'Some work');
    const uuid = findFullTaskId(ctx.root, ref);
    const now = new Date().toISOString();
    const grants = [
      { token: 'sk-ant-api03-lazy-' + 'a'.repeat(48), role: 'agent', taskId: ref, taskUuid: uuid, label: `lazy-${ref}`, envKey: 'ANTHROPIC_API_KEY', createdAt: now },
      { token: 'key_lazy_' + 'b'.repeat(48), role: 'agent', taskId: ref, taskUuid: uuid, label: `lazy-${ref}`, envKey: 'CURSOR_API_KEY', createdAt: now },
      { token: 'sk-ant-api03-lazy-' + 'c'.repeat(48), role: 'agent', taskId: 'someone-else', taskUuid: '00000000-0000-4000-8000-000000000000', label: 'lazy-someone-else', envKey: 'ANTHROPIC_API_KEY', createdAt: now },
    ];
    const path = getProxyTokensPath(ctx.root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, grants }), { mode: 0o600 });
    // The daemon caches the registry; restart it so it reads the seeded file,
    // as a daemon that minted these grants itself would hold them.
    await ctx.restartDaemon();

    expectSuccess(await ctx.lazyMocked(['start', ref, '--yes'], MOCK_CLAUDE_SUCCESS));
    const waited = await ctx.lazy(['wait', ref]);
    expect(waited.exitCode).toBe(0);
    const worktree = join(ctx.root, '.lazy', 'worktrees', ref);
    writeFileSync(join(worktree, 'feature.txt'), 'feature\n');
    expect(ctx.git('-C', worktree, 'add', 'feature.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktree, 'commit', '-m', 'Add feature').exitCode).toBe(0);
    await seedFinal(ctx, ref);

    expectSuccess(await ctx.lazy(['accept', ref, '--reason', 'done']));

    expect(existsSync(path)).toBe(true);
    const left = (JSON.parse(await readFile(path, 'utf-8')) as { grants: Grant[] }).grants;
    expect(left.map(g => g.taskId)).toEqual(['someone-else']);
  });
});
