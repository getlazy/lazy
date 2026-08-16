/**
 * `lazy stats audit` — the record-level reader over the proxy audit trail.
 *
 * Seeds proxy-audit.jsonl directly (a real proxied turn needs an upstream and a
 * live agent) and asserts the rendered listing, the filters, the detail view and
 * the JSON forms. The capture side — that the proxy writes these records at all,
 * with denials and reroutes on them — is covered by test/unit/proxy-server.test.ts
 * and test/unit/proxy-usage.test.ts.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { storageDirFor } from '../helpers/storage';

interface SeedRecord {
  id: string;
  ts: number;
  role?: string | null;
  taskId?: string | null;
  model?: string | null;
  status?: number | null;
  error?: string | null;
  usage?: { input: number; output: number } | null;
  denials?: Array<{ name: string; rule: string; reason: string }>;
  reroute?: { trigger: string; toUpstream: string; toModel: string } | null;
  toolUses?: Array<{ name: string; path?: string; command?: string; connector?: boolean }>;
  toolResults?: Array<{ len: number; preview: string; isError?: boolean }>;
}

function seedLine(seq: number, r: SeedRecord): string {
  return JSON.stringify({
    id: r.id,
    seq,
    ts: r.ts,
    role: r.role ?? 'agent',
    taskId: r.taskId ?? null,
    backend: 'proxy',
    upstream: 'https://api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    endpoint: 'messages',
    model: r.model ?? 'claude-opus-5',
    tier: 'opus',
    stream: true,
    requestShape: {
      hasSystem: true,
      systemLen: 2048,
      numMessages: 4,
      messageRoles: ['user', 'assistant', 'user', 'assistant'],
      numTools: 2,
      toolNames: ['Read', 'Bash'],
      maxTokens: 8192,
      bodyBytes: 4096,
    },
    toolUses: (r.toolUses ?? []).map((t, i) => ({
      id: `tu_${i}`,
      name: t.name,
      path: t.path ?? null,
      command: t.command ?? null,
      target: null,
      connector: t.connector ?? false,
      inputPreview: '{"…":"…"}',
    })),
    toolResults: (r.toolResults ?? []).map((t, i) => ({
      toolUseId: `tu_${i}`,
      isError: t.isError ?? false,
      contentPreview: t.preview,
      contentLen: t.len,
    })),
    status: r.status === undefined ? 200 : r.status,
    usage: r.usage
      ? {
          inputTokens: r.usage.input,
          outputTokens: r.usage.output,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        }
      : null,
    stopReason: 'end_turn',
    error: r.error ?? null,
    durationMs: 1500,
    reroute: r.reroute
      ? {
          fromUpstream: 'https://api.anthropic.com',
          fromModel: 'claude-opus-5',
          toUpstream: r.reroute.toUpstream,
          toModel: r.reroute.toModel,
          trigger: r.reroute.trigger,
          attempts: 2,
        }
      : null,
    enforcement: r.denials
      ? r.denials.map((d, i) => ({ toolUseId: `tu_${i}`, name: d.name, rule: d.rule, reason: d.reason }))
      : null,
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
    {
      id: 'aaaa1111-1111-1111-1111-111111111111',
      ts: NOW - 3_600_000,
      taskId: 'task-alpha',
      usage: { input: 1000, output: 100 },
      toolUses: [{ name: 'Read', path: '/repo/src/index.ts' }],
      toolResults: [{ len: 4096, preview: 'file contents…' }],
    },
    {
      id: 'bbbb2222-2222-2222-2222-222222222222',
      ts: NOW - 60_000,
      taskId: 'task-alpha',
      denials: [
        {
          name: 'mcp__claude_ai_gmail_search',
          rule: 'connector-deny-default',
          reason: 'inherited claude.ai connectors are denied by default',
        },
      ],
      toolUses: [{ name: 'mcp__claude_ai_gmail_search', connector: true }],
      usage: { input: 20, output: 2 },
    },
    {
      id: 'cccc3333-3333-3333-3333-333333333333',
      ts: NOW - 40_000,
      role: 'builder',
      model: 'claude-sonnet-5',
      reroute: { trigger: '429', toUpstream: 'https://fallback.example', toModel: 'claude-sonnet-5' },
      usage: { input: 30, output: 3 },
    },
    {
      id: 'dddd4444-4444-4444-4444-444444444444',
      ts: NOW - 20_000,
      taskId: 'task-beta',
      status: 401,
      usage: null,
    },
    {
      id: 'eeee5555-5555-5555-5555-555555555555',
      ts: NOW - 10_000,
      taskId: 'task-beta',
      status: null,
      error: 'upstream unreachable',
      usage: null,
    },
  ];
}

describe('lazy stats audit', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('reports an actionable empty state when nothing was proxied', async () => {
    const result = await ctx.lazy(['stats', 'audit']);
    expectSuccess(result);
    expectOutput(result, 'No proxied requests recorded yet');
    // The scope caveat matters most when the trail is empty: "nothing here" and
    // "your agent is on a backend that bypasses the proxy" look identical.
    expectOutput(result, 'Only traffic through the lazy proxy is audited');
  });

  test('lists records one per row with role, task, model and tool counts', async () => {
    await seedAudit(ctx.root, sampleRecords());
    const result = await ctx.lazy(['stats', 'audit']);
    expectSuccess(result);

    expectOutput(result, 'ROLE');
    expectOutput(result, 'TASK');
    expectOutput(result, 'MODEL');
    expectOutput(result, 'task-alpha');
    expectOutput(result, 'task-beta');
    expectOutput(result, 'claude-opus-5');
    expectOutput(result, 'builder');
    // Short id from the record UUID is what the detail view takes.
    expectOutput(result, 'aaaa1111');
    expectOutput(result, '5 of 5 matching record(s)');
  });

  test('flags denials, reroutes and failures in the NOTES column', async () => {
    await seedAudit(ctx.root, sampleRecords());
    const result = await ctx.lazy(['stats', 'audit']);
    expectSuccess(result);
    expectOutput(result, 'DENY(1)');
    expectOutput(result, 'REROUTE');
    expectOutput(result, 'FAIL(401)');
    // A request that never got a response is still a failure, and says so
    // rather than showing a blank status.
    expectOutput(result, 'FAIL(no-response)');
  });

  test('--denied, --reroutes and --errors narrow to the interesting records', async () => {
    await seedAudit(ctx.root, sampleRecords());

    const denied = await ctx.lazy(['stats', 'audit', '--denied']);
    expectSuccess(denied);
    expectOutput(denied, '1 of 1 matching record(s)');
    expectOutput(denied, 'bbbb2222');

    const reroutes = await ctx.lazy(['stats', 'audit', '--reroutes']);
    expectSuccess(reroutes);
    expectOutput(reroutes, 'cccc3333');
    expect(reroutes.stdout).not.toContain('aaaa1111');

    // Both failure shapes — a 401 and a request that never got a response.
    const errors = await ctx.lazy(['stats', 'audit', '--errors']);
    expectSuccess(errors);
    expectOutput(errors, '2 of 2 matching record(s)');
    expectOutput(errors, 'dddd4444');
    expectOutput(errors, 'eeee5555');
  });

  test('--task, --role and --model narrow the listing', async () => {
    await seedAudit(ctx.root, sampleRecords());

    // Prefix match, matching how task ids work everywhere else in the CLI.
    const alpha = await ctx.lazy(['stats', 'audit', '--task', 'task-al']);
    expectSuccess(alpha);
    expectOutput(alpha, '2 of 2 matching record(s)');
    expect(alpha.stdout).not.toContain('task-beta');

    const builder = await ctx.lazy(['stats', 'audit', '--role', 'builder']);
    expectSuccess(builder);
    expectOutput(builder, '1 of 1 matching record(s)');

    const sonnet = await ctx.lazy(['stats', 'audit', '--model', 'sonnet']);
    expectSuccess(sonnet);
    expectOutput(sonnet, 'cccc3333');
  });

  test('--since and --last bound the window identically', async () => {
    await seedAudit(ctx.root, sampleRecords());

    const since = await ctx.lazy(['stats', 'audit', '--since', '15s']);
    expectSuccess(since);
    expectOutput(since, '1 of 1 matching record(s)');
    expectOutput(since, 'eeee5555');

    const last = await ctx.lazy(['stats', 'audit', '--last', '15s']);
    expectSuccess(last);
    expectOutput(last, '1 of 1 matching record(s)');
    expectOutput(last, 'eeee5555');
  });

  test('--since and --last together fail rather than silently picking one', async () => {
    await seedAudit(ctx.root, sampleRecords());
    const result = await ctx.lazy(['stats', 'audit', '--since', '1h', '--last', '5m']);
    expectFailure(result);
    expectError(result, 'Use --since or --last, not both');
  });

  test('--limit keeps the newest records and says how many are hidden', async () => {
    await seedAudit(ctx.root, sampleRecords());
    const result = await ctx.lazy(['stats', 'audit', '--limit', '2']);
    expectSuccess(result);
    expectOutput(result, '2 of 5 matching record(s)');
    expectOutput(result, '3 older hidden');
    // INVARIANT: --limit keeps the TAIL. The trail reads like a log, so the
    // newest records are the ones worth keeping when the listing is capped.
    expectOutput(result, 'eeee5555');
    expect(result.stdout).not.toContain('aaaa1111');
  });

  test('a record id opens the detail view, including denials with rule and reason', async () => {
    await seedAudit(ctx.root, sampleRecords());
    const result = await ctx.lazy(['stats', 'audit', 'bbbb2222']);
    expectSuccess(result);
    expectOutput(result, 'Audit record bbbb2222');
    expectOutput(result, 'Denied 1 tool_use(s)');
    expectOutput(result, 'mcp__claude_ai_gmail_search');
    expectOutput(result, 'connector-deny-default');
    expectOutput(result, 'inherited claude.ai connectors are denied by default');
    // The intended action is shown next to the denial that blocked it.
    expectOutput(result, '[connector]');
  });

  test('the detail view shows tool_use paths, tool_result previews and usage', async () => {
    await seedAudit(ctx.root, sampleRecords());
    const result = await ctx.lazy(['stats', 'audit', 'aaaa1111']);
    expectSuccess(result);
    expectOutput(result, '/repo/src/index.ts');
    expectOutput(result, 'file contents');
    expectOutput(result, '1,100 total');
    expectOutput(result, '4 message(s), 2 tool(s) declared');
  });

  test('the detail view shows reroute source and target', async () => {
    await seedAudit(ctx.root, sampleRecords());
    const result = await ctx.lazy(['stats', 'audit', 'cccc3333']);
    expectSuccess(result);
    expectOutput(result, 'Rerouted');
    expectOutput(result, 'trigger 429');
    expectOutput(result, 'https://fallback.example');
  });

  test('a missing or ambiguous record id fails loudly', async () => {
    await seedAudit(ctx.root, [
      { id: 'abc11111-0000-0000-0000-000000000000', ts: NOW },
      { id: 'abc22222-0000-0000-0000-000000000000', ts: NOW },
    ]);

    const missing = await ctx.lazy(['stats', 'audit', 'zzzz']);
    expectFailure(missing);
    expectError(missing, "No audit record matches 'zzzz'");

    // INVARIANT: an ambiguous prefix is reported, never resolved to the first
    // match — showing the wrong request's denials would be worse than an error.
    const ambiguous = await ctx.lazy(['stats', 'audit', 'abc']);
    expectFailure(ambiguous);
    expectError(ambiguous, "'abc' matches 2 audit records");
  });

  test('--json emits rows for a listing and the raw record for a detail view', async () => {
    await seedAudit(ctx.root, sampleRecords());

    const list = await ctx.lazy(['stats', 'audit', '--json']);
    expectSuccess(list);
    const rows = JSON.parse(list.stdout);
    expect(rows).toHaveLength(5);
    expect(rows[0].id).toBe('aaaa1111-1111-1111-1111-111111111111');
    expect(rows[0].totalTokens).toBe(1100);
    expect(rows[1].denials).toBe(1);
    expect(rows[2].rerouted).toBe(true);
    expect(rows[3].failed).toBe(true);

    const detail = await ctx.lazy(['stats', 'audit', 'bbbb2222', '--json']);
    expectSuccess(detail);
    const record = JSON.parse(detail.stdout);
    expect(record.id).toBe('bbbb2222-2222-2222-2222-222222222222');
    expect(record.enforcement[0].rule).toBe('connector-deny-default');
  });

  test('a filter that matches nothing says so instead of printing an empty table', async () => {
    await seedAudit(ctx.root, sampleRecords());
    const result = await ctx.lazy(['stats', 'audit', '--role', 'nobody']);
    expectSuccess(result);
    expectOutput(result, 'No audit records match those filters');
    expectOutput(result, '5 scanned');
  });

  test('rejects invalid --since and --limit values', async () => {
    const badSince = await ctx.lazy(['stats', 'audit', '--since', 'yesterday']);
    expectFailure(badSince);
    expectError(badSince, "Invalid --since 'yesterday'");

    // The synonym reports itself, not --since, or the fix is a guess.
    const badLast = await ctx.lazy(['stats', 'audit', '--last', 'yesterday']);
    expectFailure(badLast);
    expectError(badLast, "Invalid --last 'yesterday'");

    const badLimit = await ctx.lazy(['stats', 'audit', '--limit', '0']);
    expectFailure(badLimit);
    expectError(badLimit, "Invalid --limit '0'");
  });

  // INVARIANT: `audit` is a `stats` subcommand, not a top-level verb. Top level
  // is for task-lifecycle operations, and `audit` is a task TYPE — `lazy fix`,
  // `lazy refactor` and `lazy document` all CREATE a task of their name, so a
  // top-level `lazy audit` would read as "create an audit task". The reader
  // lives under `stats`, next to the `tokens` rollup over the same records.
  test('is reachable only under `stats`, not as a top-level command', async () => {
    await seedAudit(ctx.root, sampleRecords());
    const topLevel = await ctx.lazy(['audit']);
    expectFailure(topLevel);
    expectError(topLevel, 'Unknown command: audit');
  });

  // The multiplexer invariant from CLAUDE.md: a subcommand with dedicated usage
  // text must be in the parent's usage map, or -h silently prints the PARENT's
  // help with no error anywhere.
  test('`lazy stats audit -h` prints the subcommand help, not the parent help', async () => {
    const result = await ctx.lazy(['stats', 'audit', '-h']);
    expectSuccess(result);
    expectOutput(result, 'Usage: lazy stats audit');
    expectOutput(result, '--denied');
    expect(result.stdout).not.toContain('Usage: lazy stats <subcommand>');
  });

  test('bare `lazy stats` advertises audit', async () => {
    const result = await ctx.lazy(['stats']);
    expectFailure(result);
    expectOutput(result, 'audit');
  });

  test('a corrupt audit line does not make the trail unreadable', async () => {
    const dir = storageDirFor(ctx.root);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'proxy-audit.jsonl'),
      seedLine(1, sampleRecords()[0]) + '\n{partial write interrupted by a cra\n',
      'utf-8',
    );
    const result = await ctx.lazy(['stats', 'audit']);
    expectSuccess(result);
    expectOutput(result, '1 of 1 matching record(s)');
  });
});
