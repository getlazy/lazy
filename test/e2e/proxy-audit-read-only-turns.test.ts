/**
 * Read-only turns — `lazy ask` and `lazy review` — ride the proxy and land in
 * the audit trail, attributed to their task.
 *
 * Fake-binary seam: a real daemon launches a real `lazy supervise`, whose fake
 * agent makes a real request to whatever ANTHROPIC_BASE_URL the launch handed
 * it. The stub stands in for the upstream the proxy forwards to. Nothing here
 * seeds the audit log by hand, so a read-only launch path that stopped pointing
 * its agent at the proxy would leave the trail short of a record.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { sessionStartEvent, resultEvent } from '../helpers/fake-claude';
import { readAuditRecords } from '../../src/proxy/audit-log';

describe('read-only turns through the proxy', () => {
  let ctx: TestContext;
  let upstream: ReturnType<typeof Bun.serve>;
  let upstreamHits = 0;

  async function taskRecords(taskId: string) {
    const records = await readAuditRecords(join(ctx.root, '.lazy'), { limit: 200 });
    return records.filter(r =>
      r.role === 'agent' && r.taskId !== null &&
      (taskId.startsWith(String(r.taskId)) || String(r.taskId).startsWith(taskId)));
  }

  /** Wait until the task has more than `n` audit records; returns the count. */
  async function moreThan(taskId: string, n: number): Promise<number> {
    let count = (await taskRecords(taskId)).length;
    for (let i = 0; i < 50 && count <= n; i++) {
      await Bun.sleep(100);
      count = (await taskRecords(taskId)).length;
    }
    return count;
  }

  beforeEach(async () => {
    upstreamHits = 0;
    upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        await req.text().catch(() => '');
        upstreamHits++;
        return Response.json({ type: 'message', model: 'claude-sonnet-4-6', usage: { input_tokens: 5, output_tokens: 2 } });
      },
    });
    ctx = await setupTestLazy({ fakeClaude: true });
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    expect(before).not.toMatch(/^\s*\[proxy\]/m);
    await writeFile(configPath, `${before}\n[proxy]\nupstream = "http://127.0.0.1:${upstream.port}"\n`);
    // The proxy's upstream is read at daemon start.
    await ctx.restartDaemon();
    // Every invocation — work turn, wrap-up, ask, reviewer — makes one request.
    await ctx.setClaudeScenario({
      steps: [
        { kind: 'emit', event: sessionStartEvent('sess-ro') },
        { kind: 'http', expectStatus: 200 },
        { kind: 'emit', event: resultEvent({ result: 'Answered.', sessionId: 'sess-ro' }) },
      ],
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
    upstream.stop(true);
  });

  // INVARIANT: an ask and a review are agent launches like any other — their
  // model traffic goes through lazy's proxy and is audited against the task.
  test('an ask turn and a review turn each add audited requests for their task', async () => {
    const taskId = await createTask(ctx, 'Read-only audit', 'Do a little work');
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const afterWork = await moreThan(taskId, 0);
    expect(afterWork, 'the work turn left no audit record').toBeGreaterThan(0);
    const hitsAfterWork = upstreamHits;

    expectSuccess(await ctx.lazy(['ask', taskId, '-m', 'why this way?']));
    const afterAsk = await moreThan(taskId, afterWork);
    expect(afterAsk, 'the ask turn left no audit record').toBeGreaterThan(afterWork);
    expect(upstreamHits).toBeGreaterThan(hitsAfterWork);

    // The reviewer's verdict is beside the point here (the fake answers prose);
    // what matters is that its request was proxied and attributed.
    await ctx.lazy(['review', taskId, '--yes']);
    const afterReview = await moreThan(taskId, afterAsk);
    expect(afterReview, 'the review turn left no audit record').toBeGreaterThan(afterAsk);
  }, 180_000);
});
