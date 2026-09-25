/**
 * `lazy stats tokens` and `lazy stats tools` — the reader surfaces over the
 * proxy audit trail.
 *
 * Seeds proxy-audit.jsonl directly (a real proxied turn needs an upstream and a
 * live agent) and asserts the rendered rollup: totals, the role/task/model
 * breakdowns, filters, and the empty state. The capture side — that these
 * records get a non-null `usage` in the first place — is covered by
 * test/unit/proxy-usage.test.ts and test/unit/proxy-server.test.ts.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { findFullTaskId, taskFilePath } from '../helpers/storage';
import { auditLogPath, ProxyAuditLog } from '../../src/proxy/audit-log';
import { emptyToolStatsRecord, foldAuditRecord } from '../../src/proxy/tool-stats';
import type { ProxyAuditRecord } from '../../src/storage/types';

interface SeedToolUse {
  id: string | null;
  name: string;
}

interface SeedToolResult {
  toolUseId: string | null;
  tokens?: number | null;
  isError?: boolean;
}

interface SeedRecord {
  role: string | null;
  taskId: string | null;
  model: string | null;
  ts: number;
  input: number;
  output: number;
  usage?: boolean;
  toolUses?: SeedToolUse[];
  toolResults?: SeedToolResult[];
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
      isError: t.isError ?? false,
      contentPreview: '',
      contentLen: 0,
      // `undefined` here means the field is absent from the JSON line, which is
      // how a record written before results were sized reads back.
      contentTokens: t.tokens,
    })),
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

/**
 * Seed the live audit segment where the reader actually looks.
 *
 * `auditLogPath` rather than a hand-composed path: the log lives in the
 * PROJECT-LOCAL data dir under `logs/`, not in the (possibly external) store
 * root. This suite seeded the store root, which the reader stopped reading when
 * the log moved — so every assertion below ran against an empty trail. The same
 * trap, and the same fix, as test/e2e/audit.test.ts.
 */
async function seedAudit(root: string, records: SeedRecord[]): Promise<void> {
  const path = auditLogPath(join(root, '.lazy'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((r, i) => seedLine(i + 1, r)).join('\n') + '\n', 'utf-8');
}

/**
 * Collapse whitespace so a prose assertion survives line wrapping.
 *
 * `lazy stats tools` wraps its caveats to the terminal width, so where a
 * sentence breaks is a rendering detail. Asserting on a raw substring pins that
 * detail and goes red the next time a word is added — what these tests are
 * actually about is that the SENTENCE is printed.
 */
function flat(stdout: string): string {
  return stdout.replace(/\s+/g, ' ');
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
    const path = auditLogPath(join(ctx.root, '.lazy'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      seedLine(1, sampleRecords()[0]) + '\n{partial write interrupted by a cra\n',
      'utf-8',
    );
    const result = await ctx.lazy(['stats', 'tokens']);
    expectSuccess(result);
    expectOutput(result, '1 proxied request(s)');
  });
});

/**
 * `lazy stats tools <task> --since …` — the WINDOWED reading, over the bounded
 * audit trail (`buildToolStats`). Passing `--since` or `--limit` asks what a
 * task's tools cost over a stretch of time, which only the trail can answer;
 * without them the command reads the task's durable record instead (the
 * describe below). The arithmetic is unit-tested in
 * test/unit/task-stats.test.ts; what is asserted here is the CLI surface — that
 * a real task resolves, that the table ranks and formats, and that the honesty
 * rules survive the trip into a terminal.
 */
describe('lazy stats tools', () => {
  let ctx: TestContext;
  let taskShortId: string;
  let taskId: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    taskShortId = await createTask(ctx, 'Tune token spend');
    taskId = findFullTaskId(ctx.root, taskShortId);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * One task's window, built to exercise every honesty rule at once:
   *  - `tu-1`/`tu-2` are replayed by later requests, so they must be counted ONCE
   *  - `tu-0`'s result arrives with its call outside the window → unattributed
   *  - `tu-3`'s result carries no size → not recorded, never a zero
   */
  function toolRecords(): SeedRecord[] {
    // Timestamps are taken at seed time, not from a module-level constant: this
    // suite's `--since` case asserts a 15-SECOND window, and a constant captured
    // at import time is already tens of seconds stale by the time the last test
    // in the file runs.
    const now = Date.now();
    return [
      {
        role: 'agent', taskId, model: 'claude-opus-5', ts: now - 60_000, input: 100, output: 10,
        toolUses: [{ id: 'tu-1', name: 'Read' }, { id: 'tu-2', name: 'Bash' }],
        toolResults: [{ toolUseId: 'tu-0', tokens: 500 }],
      },
      {
        role: 'agent', taskId, model: 'claude-opus-5', ts: now - 30_000, input: 200, output: 20,
        // The first two are the SAME calls replayed in this request's history.
        toolUses: [{ id: 'tu-1', name: 'Read' }, { id: 'tu-2', name: 'Bash' }, { id: 'tu-3', name: 'Read' }],
        toolResults: [{ toolUseId: 'tu-1', tokens: 9000 }, { toolUseId: 'tu-2', tokens: 100, isError: true }],
      },
      {
        role: 'agent', taskId, model: 'claude-opus-5', ts: now - 5_000, input: 300, output: 30,
        toolUses: [{ id: 'tu-1', name: 'Read' }, { id: 'tu-3', name: 'Read' }],
        toolResults: [{ toolUseId: 'tu-1', tokens: 9000 }, { toolUseId: 'tu-3' }],
      },
      // Another task's traffic in the same trail, which must not leak in.
      {
        role: 'agent', taskId: 'task-other', model: 'claude-opus-5', ts: now - 1_000, input: 1, output: 1,
        toolUses: [{ id: 'other-1', name: 'WebFetch' }],
        toolResults: [{ toolUseId: 'other-1', tokens: 77_000 }],
      },
    ];
  }

  test('ranks the task\'s tools by the context their results added', async () => {
    await seedAudit(ctx.root, toolRecords());
    const result = await ctx.lazy(['stats', 'tools', taskShortId, '--since', '1d']);
    expectSuccess(result);

    expectOutput(result, '3 proxied request(s)');
    expectOutput(result, '3 call(s)');
    expectOutput(result, '9,100');

    const out = result.stdout;
    expect(out).toContain('TOOL');
    expect(out).toContain('PER CALL');
    // Read (9,000) outranks Bash (100): the reader came for the heaviest tool.
    expect(out.indexOf('Read')).toBeLessThan(out.indexOf('Bash'));
    expect(out).toContain('98.9%');

    // Another task's 77,000-token WebFetch is in the same trail and must not
    // appear: `buildToolStats` is per task, and so is this readout.
    expect(out).not.toContain('WebFetch');
    expect(out).not.toContain('77,000');
  });

  // INVARIANT: every request replays the whole conversation, so tool calls are
  // deduped by `tool_use` id. Counting raw blocks would answer "how many
  // requests happened after this call", which is not a tool statistic — a real
  // log showed a 28x inflation.
  test('counts a replayed call once, not once per request that carried it', async () => {
    await seedAudit(ctx.root, toolRecords());
    const result = await ctx.lazy(['stats', 'tools', taskShortId, '--since', '1d', '--json']);
    expectSuccess(result);
    const stats = JSON.parse(result.stdout);

    // tu-1 appears in three requests and tu-2 in two; there are three calls.
    expect(stats.totalInvocations).toBe(3);
    const read = stats.rows.find((r: { name: string }) => r.name === 'Read');
    expect(read.invocations).toBe(2);
    // tu-1's 9,000-token result is carried by two requests and counted once.
    expect(read.resultTokens).toBe(9000);
    expect(stats.resultTokens).toBe(9100);
  });

  // INVARIANT: a result with no recorded size prints "not recorded", never 0.
  // A zero reads as "this tool's output was free", which is a different and
  // false claim about an unmeasured value.
  test('shows an unmeasured result as not-recorded rather than zero', async () => {
    await seedAudit(ctx.root, toolRecords());
    const result = await ctx.lazy(['stats', 'tools', taskShortId, '--since', '1d']);
    expectSuccess(result);
    expect(flat(result.stdout)).toContain(
      'result(s) carry no recorded size — they predate this being measured, ' +
        'and are left out of the token column rather than counted as zero.',
    );
  });

  // INVARIANT: a result whose `tool_use` predates the window is reported as
  // unattributed, never filed under a guessed tool name. Guessing would put
  // real tokens in a row that did not earn them.
  test('reports tokens from calls older than the window as unattributed', async () => {
    await seedAudit(ctx.root, toolRecords());
    const result = await ctx.lazy(['stats', 'tools', taskShortId, '--since', '1d']);
    expectSuccess(result);
    expect(flat(result.stdout)).toContain(
      '500 token(s) arrived as results of calls that were never observed, so the tool ' +
        'that produced them is unknown and they are in no row.',
    );

    const json = await ctx.lazy(['stats', 'tools', taskShortId, '--since', '1d', '--json']);
    const stats = JSON.parse(json.stdout);
    expect(stats.unattributedResultTokens).toBe(500);
  });

  // INVARIANT: the number is context a tool added, not a share of the model
  // bill. A request's usage is one number for the whole request and a response
  // routinely asks for several tools, so splitting it would be an invention.
  test('always says the token column is context added, not a share of the bill', async () => {
    await seedAudit(ctx.root, toolRecords());
    const result = await ctx.lazy(['stats', 'tools', taskShortId, '--since', '1d']);
    expectSuccess(result);
    expect(flat(result.stdout)).toContain('context the tool added, not a share of the model bill');
    // And that a --since reading is a recent window, not the task's whole life.
    expect(flat(result.stdout)).toContain(
      'A recent window: this reading comes from the proxy audit trail, which is bounded and ' +
        'disposable, so it is not the task\'s whole life.',
    );
  });

  test('counts errored results per tool', async () => {
    await seedAudit(ctx.root, toolRecords());
    const result = await ctx.lazy(['stats', 'tools', taskShortId, '--since', '1d', '--json']);
    expectSuccess(result);
    const stats = JSON.parse(result.stdout);
    const bash = stats.rows.find((r: { name: string }) => r.name === 'Bash');
    expect(bash.errors).toBe(1);
  });

  test('--top caps the table and says how many were hidden', async () => {
    await seedAudit(ctx.root, toolRecords());
    const result = await ctx.lazy(['stats', 'tools', taskShortId, '--since', '1d', '--top', '1']);
    expectSuccess(result);
    expect(result.stdout).toContain('Read');
    expect(result.stdout).not.toContain('Bash');
    expectOutput(result, '1 more');
  });

  test('--since bounds the window', async () => {
    await seedAudit(ctx.root, toolRecords());
    const result = await ctx.lazy(['stats', 'tools', taskShortId, '--since', '15s']);
    expectSuccess(result);
    expectOutput(result, '1 proxied request(s)');
  });

  // INVARIANT: nothing recorded is not the same fact as nothing called, and the
  // command must not print the second when it only knows the first.
  test('explains a missing record instead of printing an empty table', async () => {
    const result = await ctx.lazy(['stats', 'tools', taskShortId]);
    expectSuccess(result);
    expectOutput(result, 'No tool statistics recorded for');
    expectOutput(result, 'not a claim that it called no tools');
  });

  test('says so when the window holds requests but no tool calls', async () => {
    await seedAudit(ctx.root, [
      { role: 'agent', taskId, model: 'claude-opus-5', ts: NOW - 1_000, input: 10, output: 1 },
    ]);
    const result = await ctx.lazy(['stats', 'tools', taskShortId, '--since', '1d']);
    expectSuccess(result);
    expectOutput(result, 'none of which carried a tool call');
  });

  test('resolves a task by code, not only by id', async () => {
    await ctx.lazy(['edit', taskShortId, '--code', 'tune-spend']);
    await seedAudit(ctx.root, toolRecords());
    const result = await ctx.lazy(['stats', 'tools', 'tune-spend', '--since', '1d']);
    expectSuccess(result);
    expectOutput(result, 'Tools for tune-spend');
  });

  test('fails with usage when no task is given', async () => {
    const result = await ctx.lazy(['stats', 'tools']);
    expectFailure(result);
    expectOutput(result, 'Usage: lazy stats tools <task>');
  });

  test('fails loudly on an unknown task', async () => {
    const result = await ctx.lazy(['stats', 'tools', 'no-such-task']);
    expectFailure(result);
  });

  test('rejects invalid --since and --top values', async () => {
    const badSince = await ctx.lazy(['stats', 'tools', taskShortId, '--since', 'yesterday']);
    expectFailure(badSince);
    expectError(badSince, "Invalid --since 'yesterday'");

    const badTop = await ctx.lazy(['stats', 'tools', taskShortId, '--top', '0']);
    expectFailure(badTop);
    expectError(badTop, "Invalid --top '0'");
  });

  // The multiplexer invariant from CLAUDE.md: a subcommand with its own usage
  // text must be in the parent's usage map, or -h silently prints the PARENT's
  // help with no error anywhere.
  test('`lazy stats tools -h` prints the subcommand help, not the parent help', async () => {
    const result = await ctx.lazy(['stats', 'tools', '-h']);
    expectSuccess(result);
    expectOutput(result, 'Usage: lazy stats tools');
    expect(result.stdout).not.toContain('Usage: lazy stats <subcommand>');
  });

  test('is listed in the `lazy stats` multiplexer usage', async () => {
    const result = await ctx.lazy(['stats']);
    expectFailure(result);
    expectOutput(result, 'tools');
  });
});

/**
 * The durable record — the default reading, and the reason it exists.
 *
 * The proxy folds each forwarded request into a small per-task record as it
 * goes, so the per-tool table no longer depends on the audit trail still
 * holding those requests. What is asserted here is exactly that independence:
 * the trail is rotated away underneath a task and its tools are still there.
 */
describe('lazy stats tools over the durable record', () => {
  let ctx: TestContext;
  let taskShortId: string;
  let taskId: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    taskShortId = await createTask(ctx, 'Tune token spend');
    taskId = findFullTaskId(ctx.root, taskShortId);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** One `tool_use` block as the extractor marks a NEW call (the tail). */
  function tailUse(id: string, name: string) {
    return { id, name, path: null, command: null, target: null, connector: false, inputPreview: '{}', tail: true };
  }

  function tailResult(id: string, tokens: number | null) {
    return { toolUseId: id, isError: false, contentPreview: '', contentLen: 0, contentTokens: tokens, tail: true };
  }

  /** A bare audited request for this task, in the shape the log really holds. */
  function auditFor(): ProxyAuditRecord {
    return JSON.parse(
      seedLine(1, { role: 'agent', taskId, model: 'claude-opus-5', ts: Date.now(), input: 10, output: 1 }),
    ) as ProxyAuditRecord;
  }

  /**
   * Two requests of a real tool loop — the call, then its result — folded
   * through the PRODUCTION fold and written where the daemon writes it.
   * Hand-writing totals here would let the test pass over arithmetic the proxy
   * does not actually produce.
   */
  async function seedRecord(): Promise<void> {
    const record = emptyToolStatsRecord(taskId);
    foldAuditRecord(record, { ...auditFor(), toolUses: [tailUse('tu-1', 'Read')] });
    foldAuditRecord(record, { ...auditFor(), toolResults: [tailResult('tu-1', 9000)] });
    foldAuditRecord(record, { ...auditFor(), toolUses: [tailUse('tu-2', 'Bash')] });
    foldAuditRecord(record, { ...auditFor(), toolResults: [tailResult('tu-2', 100)] });
    await writeFile(taskFilePath(ctx.root, taskShortId, 'tool-stats.json'), JSON.stringify(record, null, 2), 'utf-8');
  }

  test('renders the task\'s tools without reading the audit trail at all', async () => {
    await seedRecord();
    const result = await ctx.lazy(['stats', 'tools', taskShortId]);
    expectSuccess(result);
    expectOutput(result, '2 call(s)');
    expectOutput(result, '9,100');
    expect(result.stdout.indexOf('Read')).toBeLessThan(result.stdout.indexOf('Bash'));
    // No window caveat: these numbers do not expire, and the copy must not
    // suggest they might.
    expect(flat(result.stdout)).toContain('The task\'s whole life');
    expect(result.stdout).not.toContain('A recent window');
  });

  // INVARIANT: the per-tool table outlives the proxy audit trail. The trail is
  // bounded and disposable by design (src/proxy/audit-log.ts) and stays that
  // way; the numbers are kept in the task's own record instead. Before this,
  // a rotation replaced the table with "outside the retained window".
  test('survives the audit window rolling the task\'s requests away', async () => {
    await seedRecord();

    // A real rotation, not a deleted file: a log configured to retain nothing
    // drops the live segment the moment it passes its cap.
    const log = new ProxyAuditLog(join(ctx.root, '.lazy'), { maxBytes: 512, retainedSegments: 0 });
    for (let i = 0; i < 20; i++) {
      await log.append(
        JSON.parse(
          seedLine(i, { role: 'agent', taskId, model: 'claude-opus-5', ts: Date.now(), input: 1, output: 1 }),
        ) as ProxyAuditRecord,
      );
    }

    // The window really is empty for this task now…
    const windowed = await ctx.lazy(['stats', 'tools', taskShortId, '--since', '1d']);
    expectSuccess(windowed);
    expectOutput(windowed, 'No proxied requests for');

    // …and the table is unchanged.
    const result = await ctx.lazy(['stats', 'tools', taskShortId]);
    expectSuccess(result);
    expectOutput(result, '2 call(s)');
    expectOutput(result, '9,100');
    expect(result.stdout).toContain('Read');
    expect(result.stdout).toContain('Bash');
  });
});
