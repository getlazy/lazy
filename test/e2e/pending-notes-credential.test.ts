/**
 * E2E: comments queued during a running turn can be claimed and acknowledged
 * only by that turn's supervisor, through the real daemon route and RPC.
 *
 * The positive path (a real supervisor presenting its command's secret) is
 * test/e2e/pending-notes.test.ts; the stale-command case is in
 * test/unit/turn-comments.test.ts (the secret key lives in the daemon process,
 * so a test process cannot mint one). Here: everything a holder of the task
 * token — or of the daemon's own control token — can try without the secret.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { findFullTaskId, readSessionJson, readTaskStatus } from '../helpers/storage';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';

describe('mid-turn comment hand-off needs the supervisor credential', () => {
  let ctx: TestContext;
  let holdFile: string;
  let target: string;
  let controlToken: string;

  beforeEach(async () => {
    clearMcpTokenCache();
    holdFile = join(process.env.TMPDIR ?? '/tmp', `lazy-hold-pn-${process.pid}-${Date.now()}`);
    ctx = await setupTestLazy({ withDaemon: true, daemonEnv: { LAZY_MOCK_HOLD_TURN_FILE: holdFile } });
    target = getDaemonTcpTarget(ctx.root)!;
    controlToken = readToken(ctx.root)!;
  }, 90_000);

  afterEach(async () => {
    rmSync(holdFile, { force: true });
    await ctx.cleanup();
    clearMcpTokenCache();
  }, 90_000);

  async function postNotes(fullTaskId: string, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
    const token = await mintMcpToken(ctx.root, { kind: 'task', taskId: fullTaskId }, 'e2e-agent');
    const base = target.startsWith('http') ? target : `http://${target}`;
    const resp = await fetch(`${base}/agent/pending-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root },
      body: JSON.stringify(body),
    } as any);
    return { status: resp.status, text: await resp.text() };
  }

  // INVARIANT: the task token (held by the agent and every process in its
  // container) cannot claim or acknowledge mid-turn comments; doing so would
  // mark human feedback delivered that no agent received.
  test('task token / control token without the supervisor secret get 403 and move nothing', async () => {
    const taskId = await createTask(ctx, 'Held turn', 'Do the work');
    const fullId = findFullTaskId(ctx.root, taskId);
    writeFileSync(holdFile, 'hold');
    const started = ctx.lazy(['start', taskId, '--yes']).catch((e) => e);
    try {
      const deadline = Date.now() + 30_000;
      while (readTaskStatus(ctx.root, taskId) !== 'working') {
        if (Date.now() > deadline) throw new Error('turn never went live');
        await Bun.sleep(100);
      }
      expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'must stay queued']));
      const before = readSessionJson(ctx.root, taskId)?.notes_delivered_through;

      for (const body of [{}, { command_id: 'c1' }, { command_id: 'c1', notes_secret: 'deadbeef' },
                          { ack_through: Date.now(), claim_id: 'x', command_id: 'c1', notes_secret: 'deadbeef' }]) {
        const r = await postNotes(fullId, body);
        expect(r.status, r.text).toBe(403);
        expect(r.text).toContain('Only the supervisor');
      }
      const client = DaemonClient.fromTarget(target, controlToken);
      for (const params of [{ taskId }, { taskId, command_id: 'c1', notes_secret: 'deadbeef' }]) {
        await expect(client.rpc('claimTurnNotes', ctx.root, params)).rejects.toThrow(/Only the supervisor/);
      }
      expect(readSessionJson(ctx.root, taskId)?.notes_delivered_through).toBe(before);
    } finally {
      rmSync(holdFile, { force: true });
      await started;
    }
  }, 120_000);
});
