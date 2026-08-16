/**
 * `lazy stats tokens` — the reader surface over the proxy audit trail.
 *
 * Seeds proxy-audit.jsonl directly (a real proxied turn needs an upstream and a
 * live agent) and asserts the rendered rollup: totals, the role/task/model
 * breakdowns, filters, and the empty state. The capture side — that these
 * records get a non-null `usage` in the first place — is covered by
 * test/unit/proxy-usage.test.ts and test/unit/proxy-server.test.ts.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { storageDirFor } from '../helpers/storage';

interface SeedRecord {
  role: string | null;
  taskId: string | null;
  model: string | null;
  ts: number;
  input: number;
  output: number;
  usage?: boolean;
}

function seedLine(i: number, r: SeedRecord): string {
  return JSON.stringify({
    id: `rec-${i}`,
    seq: i,
    ts: r.ts,
    role: r.role,
    taskId: r.taskId,
    backend: 'proxy',
    upstream: 'https://api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    endpoint: 'messages',
    model: r.model,
    tier: null,
    stream: true,
    requestShape: null,
    toolUses: [],
    toolResults: [],
    status: 200,
    usage:
      r.usage === false
        ? null
        : {
            inputTokens: r.input,
            outputTokens: r.output,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
    stopReason: 'end_turn',
    error: null,
    durationMs: 100,
    reroute: null,
  });
}

async function seedAudit(root: string, records: SeedRecord[]): Promise<void> {
  const dir = storageDirFor(root);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'proxy-audit.jsonl'),
    records.map((r, i) => seedLine(i + 1, r)).join('\n') + '\n',
    'utf-8',
  );
}

const NOW = Date.now();

function sampleRecords(): SeedRecord[] {
  return [
    { role: 'agent', taskId: 'task-alpha', model: 'claude-opus-5', ts: NOW - 60_000, input: 1000, output: 100 },
    { role: 'agent', taskId: 'task-alpha', model: 'claude-opus-5', ts: NOW - 30_000, input: 2000, output: 200 },
    { role: 'builder', taskId: null, model: 'claude-sonnet-5', ts: NOW - 20_000, input: 10, output: 5 },
    // A failed request: counted as a request, but contributes no tokens.
    { role: 'agent', taskId: 'task-beta', model: null, ts: NOW - 10_000, input: 0, output: 0, usage: false },
    { role: 'agent', taskId: 'task-beta', model: 'claude-opus-5', ts: NOW - 5_000, input: 40, output: 4 },
  ];
}

describe('lazy stats tokens', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('reports an actionable empty state when nothing was proxied', async () => {
    const result = await ctx.lazy(['stats', 'tokens']);
    expectSuccess(result);
    expectOutput(result, 'No proxied requests recorded yet');
  });

  test('rolls up totals and breaks down by role, task and model', async () => {
    await seedAudit(ctx.root, sampleRecords());
    const result = await ctx.lazy(['stats', 'tokens']);
    expectSuccess(result);

    // 5 requests, 4 of which carried usage — the failed one is visible in the
    // request count but must not silently inflate the token totals.
    expectOutput(result, '5 proxied request(s)');
    expectOutput(result, '4 with usage');
    expectOutput(result, '3,359'); // 3050 input + 309 output

    expectOutput(result, 'By role');
    expectOutput(result, 'By task');
    expectOutput(result, 'By model');

    const out = result.stdout;
    const roleSection = out.slice(out.indexOf('By role'), out.indexOf('By task'));
    // agent (3,344) outranks builder (15).
    expect(roleSection.indexOf('agent')).toBeLessThan(roleSection.indexOf('builder'));

    const taskSection = out.slice(out.indexOf('By task'), out.indexOf('By model'));
    expect(taskSection.indexOf('task-alpha')).toBeLessThan(taskSection.indexOf('task-beta'));
    // INVARIANT: traffic with no task header is surfaced, not dropped — the
    // builder's requests cost real tokens and must appear somewhere.
    expect(taskSection).toContain('(unattributed)');

    // The scope caveat is always printed: this counts proxied traffic only.
    expectOutput(result, 'Only traffic through the lazy proxy is audited');
  });

  test('--role and --task narrow the rollup', async () => {
    await seedAudit(ctx.root, sampleRecords());

    const builder = await ctx.lazy(['stats', 'tokens', '--role', 'builder']);
    expectSuccess(builder);
    expectOutput(builder, '1 proxied request(s)');
    expect(builder.stdout).not.toContain('task-alpha');

    // --task is a prefix match, matching how task ids are used everywhere else.
    const alpha = await ctx.lazy(['stats', 'tokens', '--task', 'task-al']);
    expectSuccess(alpha);
    expectOutput(alpha, '2 proxied request(s)');
    expect(alpha.stdout).not.toContain('task-beta');
  });

  test('--since bounds the window', async () => {
    await seedAudit(ctx.root, sampleRecords());
    const recent = await ctx.lazy(['stats', 'tokens', '--since', '15s']);
    expectSuccess(recent);
    expectOutput(recent, '2 proxied request(s)');
  });

  test('--json emits the machine-readable rollup', async () => {
    await seedAudit(ctx.root, sampleRecords());
    const result = await ctx.lazy(['stats', 'tokens', '--json']);
    expectSuccess(result);
    const report = JSON.parse(result.stdout);
    expect(report.totals.requests).toBe(5);
    expect(report.totals.withUsage).toBe(4);
    expect(report.totals.totalTokens).toBe(3359);
    expect(report.byRole.map((g: { key: string }) => g.key)).toEqual(['agent', 'builder']);
  });

  test('--top caps each breakdown', async () => {
    await seedAudit(ctx.root, sampleRecords());
    const result = await ctx.lazy(['stats', 'tokens', '--top', '1']);
    expectSuccess(result);
    const out = result.stdout;
    const roleSection = out.slice(out.indexOf('By role'), out.indexOf('By task'));
    expect(roleSection).toContain('agent');
    expect(roleSection).not.toContain('builder');
    expect(roleSection).toContain('1 more');
  });

  test('rejects invalid --since and --top values', async () => {
    const badSince = await ctx.lazy(['stats', 'tokens', '--since', 'yesterday']);
    expectFailure(badSince);
    expectError(badSince, "Invalid --since 'yesterday'");

    const badTop = await ctx.lazy(['stats', 'tokens', '--top', '0']);
    expectFailure(badTop);
    expectError(badTop, "Invalid --top '0'");
  });

  // INVARIANT: `tokens` is a `stats` subcommand, not a top-level verb. Top
  // level is for task-lifecycle operations; read-only analytics live under
  // `stats` so that surface can accumulate more rollups without crowding the
  // root command list.
  test('is reachable only under `stats`, not as a top-level command', async () => {
    await seedAudit(ctx.root, sampleRecords());
    const topLevel = await ctx.lazy(['tokens']);
    expectFailure(topLevel);
    expectError(topLevel, 'Unknown command: tokens');
  });

  test('bare `lazy stats` prints the multiplexer usage and fails', async () => {
    const result = await ctx.lazy(['stats']);
    expectFailure(result);
    expectOutput(result, 'Usage: lazy stats <subcommand>');
    expectOutput(result, 'tokens');
  });

  test('an unknown stats subcommand fails loudly', async () => {
    const result = await ctx.lazy(['stats', 'replay']);
    expectFailure(result);
    expectError(result, 'Unknown subcommand: stats replay');
  });

  // The multiplexer invariant from CLAUDE.md: a subcommand with dedicated
  // usage text must be in the parent's usage map, or -h silently prints the
  // PARENT's help with no error anywhere.
  test('`lazy stats tokens -h` prints the subcommand help, not the parent help', async () => {
    const result = await ctx.lazy(['stats', 'tokens', '-h']);
    expectSuccess(result);
    expectOutput(result, 'Usage: lazy stats tokens');
    expectOutput(result, '--since <duration>');
    expect(result.stdout).not.toContain('Usage: lazy stats <subcommand>');
  });

  test('a corrupt audit line does not make the trail unreadable', async () => {
    const dir = storageDirFor(ctx.root);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'proxy-audit.jsonl'),
      seedLine(1, sampleRecords()[0]) + '\n{partial write interrupted by a cra\n',
      'utf-8',
    );
    const result = await ctx.lazy(['stats', 'tokens']);
    expectSuccess(result);
    expectOutput(result, '1 proxied request(s)');
  });
});
