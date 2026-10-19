/**
 * `lazy stats latency` and the per-request timings in `lazy stats audit`.
 * Daemonless: runs the in-process fallback of the `tokenStats` RPC over a
 * seeded audit trail.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { auditLogPath } from '../../src/proxy/audit-log';
import { emptyRollup, foldAudit } from '../../src/task/turn-latency';
import { taskDirFor } from '../helpers/storage';

function record(i: number, extra: Record<string, unknown>): string {
  return JSON.stringify({
    id: `latency-${i}`, seq: i, ts: Date.now() - 1000 * i, role: 'agent', taskId: null, backend: 'proxy',
    upstream: 'https://slow.example.com', method: 'POST', path: '/v1/messages', endpoint: 'messages',
    model: 'slow-model', tier: 'other', stream: true, requestShape: null, toolUses: [], toolResults: [],
    status: 200, stopReason: null, error: null, durationMs: 100, reroute: null, enforcement: null,
    usage: { inputTokens: 10, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...extra,
  });
}

describe('lazy stats latency', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await setupTestLazy(); });
  afterEach(async () => { await ctx.cleanup(); });

  async function seed(lines: string[]): Promise<void> {
    const path = auditLogPath(join(ctx.root, '.lazy'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, lines.join('\n') + '\n', 'utf-8');
  }

  test('an empty trail says so', async () => {
    const result = await ctx.lazy(['stats', 'latency', '--recent']);
    expectSuccess(result);
    expect(result.stdout).toContain('No timed requests recorded yet');
  });

  // INVARIANT: a slow-to-finish provider is visible — TTFT, TTLT and tokens/s are separate columns, and a record from before timings existed adds nothing to them.
  test('shows p50/p90 of each timing by model and ignores legacy records', async () => {
    await seed([
      record(1, { ttftMs: 500, ttltMs: 10_500 }), // 100 tokens over 10.5s → 9.52 tok/s
      record(2, { ttftMs: 700, ttltMs: 20_700 }), // 4.83 tok/s
      record(3, {}), // legacy
    ]);
    const json = await ctx.lazy(['stats', 'latency', '--recent', '--json']);
    expectSuccess(json);
    const report = JSON.parse(json.stdout);
    const g = report.byModel[0];
    expect(g.key).toBe('slow-model');
    expect(g.requests).toBe(3);
    expect(g.ttft).toEqual({ n: 2, p50: 500, p90: 700 });
    expect(g.ttlt).toEqual({ n: 2, p50: 10_500, p90: 20_700 });
    expect(g.tokensPerSecond!.n).toBe(2);
    expect(g.tokensPerSecond!.p50).toBeCloseTo(4.83, 2);
    expect(g.tokensPerSecond!.p90).toBeCloseTo(9.52, 2);
    expect(report.byEndpoint[0].key).toBe('https://slow.example.com');

    const table = await ctx.lazy(['stats', 'latency', '--recent']);
    expectSuccess(table);
    expect(table.stdout).toContain('TTFT p50/p90');
    expect(table.stdout).toContain('500ms / 700ms (n=2)');
  });

  test('audit lists first-byte, first-token and last-token per request', async () => {
    await seed([record(1, { ttftMs: 500, ttltMs: 10_500 })]);
    const result = await ctx.lazy(['stats', 'audit']);
    expectSuccess(result);
    for (const h of ['TTFB', 'TTFT', 'TTLT']) expect(result.stdout).toContain(h);
    expect(result.stdout).toContain('10.5s');
  });

  // INVARIANT: the same model on two endpoints is two rows, so endpoints can be compared; failures are counted and classified, never dropped.
  test('audit --summary rolls up per endpoint × model with an error breakdown', async () => {
    await seed([
      record(1, { servedByEndpoint: 'fast', ttftMs: 100, ttltMs: 1100 }),
      record(2, { servedByEndpoint: 'fast', ttftMs: 300, ttltMs: 1300 }),
      record(3, { servedByEndpoint: 'slow', ttftMs: 900, ttltMs: 9900 }),
      record(4, { servedByEndpoint: 'slow', status: 429, usage: null }),
      record(5, { servedByEndpoint: 'slow', status: null, error: 'request timed out', usage: null }),
    ]);
    const json = await ctx.lazy(['stats', 'audit', '--summary', '--json']);
    expectSuccess(json);
    const rows = JSON.parse(json.stdout);
    expect(rows.map((r: { endpoint: string }) => r.endpoint).sort()).toEqual(['fast', 'slow']);
    const slow = rows.find((r: { endpoint: string }) => r.endpoint === 'slow');
    expect(slow.model).toBe('slow-model');
    expect(slow.requests).toBe(3);
    expect(slow.errors).toMatchObject({ total: 2, rateLimited: 1, timeout: 1 });
    const fast = rows.find((r: { endpoint: string }) => r.endpoint === 'fast');
    expect(fast.ttft).toEqual({ n: 2, p50: 100, p90: 300 });
    expect(fast.outputTokens).toBe(200);

    const table = await ctx.lazy(['stats', 'audit', '--summary']);
    expectSuccess(table);
    expect(table.stdout).toContain('ENDPOINT');
    expect(table.stdout).toContain('429×1');

    const latency = JSON.parse((await ctx.lazy(['stats', 'latency', '--recent', '--json'])).stdout);
    expect(latency.byEndpointModel.length).toBe(2);
  });

  test('audit names the endpoint, falling back to the upstream origin', async () => {
    await seed([record(1, { servedByEndpoint: 'fast' }), record(2, {})]);
    const result = await ctx.lazy(['stats', 'audit']);
    expectSuccess(result);
    expect(result.stdout).toContain('ENDPOINT');
    expect(result.stdout).toContain('fast');
    expect(result.stdout).toContain('https://slow.example.com');
    const detail = await ctx.lazy(['stats', 'audit', 'latency-1']);
    expectSuccess(detail);
    expect(detail.stdout).toMatch(/endpoint\s+fast/);
  });
});

describe('lazy stats latency — history from the store', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await setupTestLazy(); });
  afterEach(async () => { await ctx.cleanup(); });

  // INVARIANT: `lazy stats latency` reads the per-turn rollups kept in the
  // STORE, so it reaches turns long gone from the audit trail — and --since
  // still narrows the period.
  test('reaches past the audit window, groups by endpoint × model, and honours --since', async () => {
    const created = await ctx.lazy(['create', '--goal', 'Latency history', '--prompt', 'p']);
    expectSuccess(created);
    const id = created.stdout.match(/\b([0-9a-f]{8})\b/)![1];
    const old = Date.now() - 60 * 86_400_000;
    const rollup = emptyRollup();
    for (const ttltMs of [2000, 4000]) {
      foldAudit(rollup, JSON.parse(record(0, { ts: old, taskId: id, ttftMs: 400, ttltMs, servedByEndpoint: 'lunaroute', tierIndex: 1 })));
    }
    foldAudit(rollup, JSON.parse(record(0, { ts: old, taskId: id, status: 429 })));
    await writeFile(
      join(taskDirFor(ctx.root, id), 'turn-latency.json'),
      JSON.stringify({ turns: [{ ...rollup, turn_sequence: 2, ended_at: old, wall_ms: 12_000 }] }),
    );

    const json = await ctx.lazy(['stats', 'latency', '--since', '90d', '--json']);
    expectSuccess(json);
    const history = JSON.parse(json.stdout);
    expect(history.turns).toBe(1);
    const tiered = history.rows.find((r: { endpoint: string }) => r.endpoint === 'lunaroute');
    expect(tiered).toMatchObject({ model: 'slow-model', tier: 1, requests: 2 });
    expect(tiered.ttlt.p50).toBeGreaterThan(1700);
    expect(tiered.ttlt.p50).toBeLessThan(2400);
    const direct = history.rows.find((r: { endpoint: string }) => r.endpoint === 'https://slow.example.com');
    expect(direct.errors.rate_limited).toBe(1);
    expect(history.model_wait_share).toBeCloseTo(0.5, 6);

    const table = await ctx.lazy(['stats', 'latency', '--since', '90d']);
    expectSuccess(table);
    expect(table.stdout).toContain('lunaroute · slow-model · tier 2');
    expect(table.stdout).toContain('Waiting on the model: 50%');

    const recent = await ctx.lazy(['stats', 'latency', '--since', '1d']);
    expectSuccess(recent);
    expect(recent.stdout).toContain('No latency rollups recorded in that period');
  });
});
