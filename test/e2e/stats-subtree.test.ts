/**
 * `--subtree` on `lazy stats tokens` and `lazy stats tools`.
 *
 * A hub — a release task, a loop — does almost none of its own work, so its own
 * turns are not its spend. These assert the CLI half of the rollup: that a
 * descendant at every depth is folded in, that a task outside the subtree is
 * not, and that the flag refuses rather than guesses when it has nothing to
 * descend from. The merge arithmetic is unit-tested in
 * test/unit/task-stats-subtree.test.ts.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { findFullTaskId, taskFilePath } from '../helpers/storage';
import { auditLogPath } from '../../src/proxy/audit-log';
import { emptyToolStatsRecord, foldAuditRecord } from '../../src/proxy/tool-stats';
import type { ProxyAuditRecord } from '../../src/storage/types';

interface SeedRecord {
  taskId: string | null;
  ts: number;
  input: number;
  output: number;
  toolUses?: Array<{ id: string; name: string }>;
  toolResults?: Array<{ toolUseId: string; tokens?: number | null }>;
}

function seedLine(i: number, r: SeedRecord): string {
  return JSON.stringify({
    id: `rec-${i}`,
    seq: i,
    ts: r.ts,
    role: 'agent',
    taskId: r.taskId,
    backend: 'proxy',
    upstream: 'https://api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    endpoint: 'messages',
    model: 'claude-opus-5',
    tier: null,
    stream: true,
    requestShape: null,
    toolUses: (r.toolUses ?? []).map((u) => ({
      id: u.id,
      name: u.name,
      path: null,
      command: null,
      target: null,
      connector: false,
      inputPreview: '{}',
    })),
    toolResults: (r.toolResults ?? []).map((t) => ({
      toolUseId: t.toolUseId,
      isError: false,
      contentPreview: '',
      contentLen: 0,
      contentTokens: t.tokens,
    })),
    status: 200,
    usage: {
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
  const path = auditLogPath(join(root, '.lazy'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((r, i) => seedLine(i + 1, r)).join('\n') + '\n', 'utf-8');
}

describe('lazy stats --subtree', () => {
  let ctx: TestContext;
  let hubShort: string;
  let hubId: string;
  let childId: string;
  let grandchildId: string;
  let outsiderId: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    hubShort = await createTask(ctx, 'Release hub');
    hubId = findFullTaskId(ctx.root, hubShort);

    const childShort = await mkChild('Child task', hubId);
    childId = findFullTaskId(ctx.root, childShort);
    // A grandchild: the walk must go every level, not just one.
    const grandchildShort = await mkChild('Grandchild task', childId);
    grandchildId = findFullTaskId(ctx.root, grandchildShort);

    const outsiderShort = await createTask(ctx, 'Unrelated task');
    outsiderId = findFullTaskId(ctx.root, outsiderShort);
  });

  async function mkChild(goal: string, parentId: string): Promise<string> {
    const result = await ctx.lazy(['create', '--goal', goal, '--parent', parentId]);
    expectSuccess(result);
    return extractTaskId(result.stdout);
  }

  afterEach(async () => {
    await ctx.cleanup();
  });

  function records(): SeedRecord[] {
    const now = Date.now();
    return [
      { taskId: hubId, ts: now - 50_000, input: 10, output: 1 },
      { taskId: childId, ts: now - 40_000, input: 100, output: 10,
        toolUses: [{ id: 'c-1', name: 'Read' }],
        toolResults: [{ toolUseId: 'c-1', tokens: 900 }] },
      { taskId: grandchildId, ts: now - 30_000, input: 1000, output: 100,
        toolUses: [{ id: 'g-1', name: 'Read' }, { id: 'g-2', name: 'Bash' }],
        toolResults: [{ toolUseId: 'g-1', tokens: 100 }, { toolUseId: 'g-2', tokens: 7 }] },
      // Outside the subtree entirely — must never be folded in.
      { taskId: outsiderId, ts: now - 20_000, input: 50_000, output: 5_000,
        toolUses: [{ id: 'o-1', name: 'WebFetch' }],
        toolResults: [{ toolUseId: 'o-1', tokens: 77_000 }] },
    ];
  }

  test('tokens --subtree folds in every level and leaves outsiders out', async () => {
    await seedAudit(ctx.root, records());

    const own = await ctx.lazy(['stats', 'tokens', '--task', hubId, '--json']);
    expectSuccess(own);
    expect(JSON.parse(own.stdout).totals.requests).toBe(1);

    const rolled = await ctx.lazy(['stats', 'tokens', '--task', hubId, '--subtree', '--json']);
    expectSuccess(rolled);
    const report = JSON.parse(rolled.stdout);
    expect(report.totals.requests).toBe(3);
    expect(report.totals.totalTokens).toBe(11 + 110 + 1100);
    // One row per task in the subtree, and nothing from outside it.
    expect(report.byTask.map((g: { key: string }) => g.key).sort()).toEqual(
      [hubId, childId, grandchildId].sort(),
    );
  });

  test('tokens --subtree names what it folded in', async () => {
    await seedAudit(ctx.root, records());
    const result = await ctx.lazy(['stats', 'tokens', '--task', hubId, '--subtree']);
    expectSuccess(result);
    expectOutput(result, '2 nested task(s)');
    expectOutput(result, '3 proxied request(s)');
  });

  test('tokens --subtree without --task refuses rather than guessing', async () => {
    const result = await ctx.lazy(['stats', 'tokens', '--subtree']);
    expectFailure(result);
    expectError(result, '--subtree needs a task to descend from');
  });

  /**
   * The same conversations as `records()`, folded into each task's DURABLE
   * tool-stats record the way the proxy folds them — through the production
   * fold, never hand-written totals.
   *
   * `--since`/`--limit` read the bounded audit trail; without them the command
   * reads these, which do not expire. Both readings must fold a subtree the
   * same way, so the merge is asserted over each.
   */
  async function seedToolRecords(): Promise<void> {
    const tail = <T,>(block: T): T & { tail: true } => ({ ...block, tail: true });
    for (const seed of records()) {
      if (!seed.toolUses?.length && !seed.toolResults?.length) continue;
      const parsed = JSON.parse(seedLine(1, seed)) as ProxyAuditRecord;
      const record = emptyToolStatsRecord(seed.taskId!);
      // One request makes the calls, the next carries their results — the shape
      // the fold's dedupe rules are written against.
      foldAuditRecord(record, { ...parsed, toolUses: parsed.toolUses.map(tail), toolResults: [] });
      foldAuditRecord(record, { ...parsed, toolUses: [], toolResults: parsed.toolResults.map(tail) });
      await writeFile(
        taskFilePath(ctx.root, seed.taskId!, 'tool-stats.json'),
        JSON.stringify(record, null, 2),
        'utf-8',
      );
    }
  }

  test('tools --subtree merges the rows by tool name, from the durable records', async () => {
    await seedToolRecords();

    const own = await ctx.lazy(['stats', 'tools', hubShort, '--json']);
    expectSuccess(own);
    // The hub made no tool calls of its own, so it has no record at all — which
    // is "never recorded", not a zeroed table.
    expect(JSON.parse(own.stdout)).toBeNull();

    const rolled = await ctx.lazy(['stats', 'tools', hubShort, '--subtree', '--json']);
    expectSuccess(rolled);
    const stats = JSON.parse(rolled.stdout);
    // Two Read calls, one in the child and one in the grandchild, merged.
    const read = stats.rows.find((r: { name: string }) => r.name === 'Read');
    expect(read.invocations).toBe(2);
    expect(read.resultTokens).toBe(1000);
    expect(stats.totalInvocations).toBe(3);
    // These cover the tasks' whole lives — nothing here came from the window.
    expect(stats.source).toBe('record');
    // The outsider's WebFetch has a record too, and must not leak in.
    expect(stats.rows.map((r: { name: string }) => r.name)).not.toContain('WebFetch');
  });

  test('tools --subtree merges the rows by tool name', async () => {
    await seedAudit(ctx.root, records());

    const own = await ctx.lazy(['stats', 'tools', hubShort, '--since', '1d', '--json']);
    expectSuccess(own);
    expect(JSON.parse(own.stdout).totalInvocations).toBe(0);

    const rolled = await ctx.lazy(['stats', 'tools', hubShort, '--subtree', '--since', '1d', '--json']);
    expectSuccess(rolled);
    const stats = JSON.parse(rolled.stdout);
    expect(stats.requests).toBe(3);
    // Two Read calls, one in the child and one in the grandchild, merged.
    const read = stats.rows.find((r: { name: string }) => r.name === 'Read');
    expect(read.invocations).toBe(2);
    expect(read.resultTokens).toBe(1000);
    expect(stats.totalInvocations).toBe(3);
    // The outsider's WebFetch is in the same trail and must not leak in.
    expect(stats.rows.map((r: { name: string }) => r.name)).not.toContain('WebFetch');
  });

  test('tools --subtree labels the readout with what it covers', async () => {
    await seedAudit(ctx.root, records());
    const result = await ctx.lazy(['stats', 'tools', hubShort, '--subtree', '--since', '1d']);
    expectSuccess(result);
    expectOutput(result, '+ 2 nested task(s)');
  });

  test('--subtree on a leaf task is the task itself', async () => {
    await seedAudit(ctx.root, records());
    const result = await ctx.lazy(['stats', 'tools', grandchildId, '--subtree', '--since', '1d', '--json']);
    expectSuccess(result);
    expect(JSON.parse(result.stdout).totalInvocations).toBe(2);
  });

  test('both usage texts document the flag', async () => {
    const tokens = await ctx.lazy(['stats', 'tokens', '-h']);
    expectSuccess(tokens);
    expectOutput(tokens, '--subtree');

    const tools = await ctx.lazy(['stats', 'tools', '-h']);
    expectSuccess(tools);
    expectOutput(tools, '--subtree');
  });
});
