/**
 * Teams core flow 4 — submit. Teams' Submit page and a bound clone's
 * `lazy submit` both land on the daemon's submitTaskPreflight / submitTask
 * RPCs, so this drives those with a real daemon:
 *   - a forge-backed project (fake forge, test/mocks/remote.ts) opens the PR;
 *   - a project whose repository Lazy Teams hosts (managed mode, local driver
 *     mirroring origin) has no PR to open and says, plainly, what happens.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFile, writeFile, mkdtemp, rm } from 'fs/promises';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskStatus, storageDirFor } from '../helpers/storage';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';

const PR_URL = 'https://github.com/o/r/pull/7';

describe('core flow: submit', () => {
  let ctx: TestContext;
  let controlDir: string | undefined;

  afterEach(async () => {
    await ctx.cleanup();
    if (controlDir) await rm(controlDir, { recursive: true, force: true });
  });

  async function blockedTask(): Promise<string> {
    const id = await createTask(ctx, 'Submit me', 'Do work');
    expectSuccess(await ctx.lazyMocked(['start', id, '--yes'], MOCK_CLAUDE_SUCCESS, { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } }));
    expectSuccess(await ctx.lazy(['wait', id]));
    expect(readTaskStatus(ctx.root, id)).toBe('blocked');
    return id;
  }

  // INVARIANT: submit on a forge-backed project opens the PR and records the
  // task as submitted — the same RPCs Teams' Submit page and a bound clone use.
  describe('forge-backed project', () => {
    beforeEach(async () => {
      ctx = await setupTestLazy({ withDaemon: true, daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_NEEDS_SYNC: '1' } });
    });

    test('submit opens the PR and marks the task submitted', async () => {
      const id = await blockedTask();
      writeFileSync(join(ctx.protocolBase, 'mock-review-create.json'), JSON.stringify({ url: PR_URL, id: '7' }));
      const result = await ctx.lazy(['submit', id, '--yes']);
      expectSuccess(result);
      expect(result.stdout).toContain(PR_URL);
      expect(readTaskStatus(ctx.root, id)).toBe('submitted');
    }, 120_000);
  });

  // INVARIANT: a hosted repository has no pull requests, and submit says what
  // happens instead (review in Teams; accept pushes the target to the install)
  // rather than the forge-only "Local driver has no remote" wording.
  describe('hosted project', () => {
    beforeEach(async () => {
      ctx = await setupTestLazy({ withDaemon: true });
    });

    test('preflight and submit explain what submit means for a hosted repo', async () => {
      const id = await blockedTask();
      controlDir = await mkdtemp(join(tmpdir(), 'submit-control-plane-'));
      const controlConfig = join(controlDir, 'lazy.toml');
      await writeFile(controlConfig, await readFile(join(ctx.root, 'lazy.toml'), 'utf8'));
      await ctx.restartDaemon({ LAZY_TEST_FORCE_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root), LAZY_MANAGED_CONFIG_PATH: controlConfig });
      const target = getDaemonTcpTarget(ctx.root), token = readToken(ctx.root);
      if (!target || !token) throw new Error('daemon did not publish its TCP target and control token');
      const control = DaemonClient.fromTarget(target, token);

      const pre = await control.rpc('submitTaskPreflight', ctx.root, { taskId: id }) as { canSubmit: boolean; refusal?: string };
      expect(pre.canSubmit).toBe(false);
      expect(pre.refusal).toContain('Lazy Teams hosts it');
      expect(pre.refusal).toContain('git fetch');
      expect(pre.refusal).not.toContain('Local driver');

      const minted = await control.rpc('mintActorToken', ctx.root, { kind: 'user', email: 'ada@example.com', name: 'Ada' }) as { token: string };
      const member = DaemonClient.fromTarget(target, minted.token);
      await expect(member.rpc('submitTask', ctx.root, { taskId: id }))
        .rejects.toThrow('Lazy Teams hosts it');
      expect(readTaskStatus(ctx.root, id)).toBe('blocked');
    }, 120_000);
  });
});
