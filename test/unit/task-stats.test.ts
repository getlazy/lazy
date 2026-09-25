/**
 * Where a task's time and tokens went — the derivation, and the tab that
 * renders it.
 *
 * What is pinned here is the part a reader trusts and a refactor could quietly
 * break: which status counts as which kind of time, that a missing number
 * stays missing instead of becoming zero, and that per-tool TOKENS are never
 * invented out of per-request usage.
 */

import { describe, test, expect } from 'bun:test';
import {
  buildTaskStats,
  buildTokenStats,
  buildToolStats,
  statusIntervals,
  bucketIntervals,
  overlapMs,
  timeBucketOf,
  DEFAULT_TURN_CHART_LIMIT,
} from '../../src/task/stats';
import { emptyToolStatsRecord, foldAuditRecord } from '../../src/proxy/tool-stats';
import { statsTabHtml, formatDuration, formatTokens } from '../../src/server/stats-tab';
import type { Task, Session, Turn, Commit, TokenUsage } from '../../src/types';
import type { StatusChange, ProxyAuditRecord, TaskToolStatsRecord } from '../../src/storage/types';

const T0 = new Date('2026-09-01T00:00:00Z').getTime();
const HOUR = 3_600_000;

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1111',
    code: 'demo',
    goal: 'demo',
    status: 'working',
    created_at: T0,
    completed_at: null,
    ...over,
  } as unknown as Task;
}

function change(status: string, atHours: number): StatusChange {
  return { status, timestamp: T0 + atHours * HOUR };
}

function usage(input: number, output: number, read = 0, write = 0): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: read,
    cacheCreationTokens: write,
  };
}

function turn(over: Partial<Turn> & { sequence: number }): Turn {
  return {
    id: `t-${over.sequence}`,
    session_id: 's-1',
    role: 'agent',
    content: 'x',
    timestamp: T0 + over.sequence * HOUR,
    usage: null,
    ...over,
  } as unknown as Turn;
}

function commit(atHours: number): Commit {
  return { id: 'c', session_id: 's-1', sha: 'abc', message: 'm', status: 'pending', timestamp: T0 + atHours * HOUR } as unknown as Commit;
}

function auditRecord(over: Partial<ProxyAuditRecord>): ProxyAuditRecord {
  return {
    id: 'a',
    seq: 1,
    ts: T0,
    role: 'agent',
    taskId: 'task-1111',
    backend: 'anthropic',
    upstream: 'https://api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    endpoint: 'messages',
    model: 'claude-opus-5',
    tier: 'opus',
    stream: true,
    requestShape: null,
    toolUses: [],
    toolResults: [],
    status: 200,
    usage: null,
    stopReason: 'tool_use',
    error: null,
    durationMs: 10,
    reroute: null,
    ...over,
  } as unknown as ProxyAuditRecord;
}

/**
 * A durable tool-stats record built the way the proxy builds one: by folding
 * audited requests through the real fold, never by hand-writing totals. A
 * hand-written record would let these renderer tests pass over arithmetic the
 * proxy does not actually produce.
 */
function toolRecord(audits: ProxyAuditRecord[]): TaskToolStatsRecord {
  const record = emptyToolStatsRecord('task-1111');
  for (const audit of audits) foldAuditRecord(record, audit);
  return record;
}

/** One request's worth of conversation tail: the calls just made. */
function calls(uses: Array<{ id: string; name: string }>): Partial<ProxyAuditRecord> {
  return {
    toolUses: uses.map((u) => ({
      id: u.id,
      name: u.name,
      path: null,
      command: null,
      target: null,
      connector: false,
      inputPreview: '',
      tail: true,
    })),
  };
}

/** The next request's worth: the results of those calls. */
function results(
  rows: Array<{ id: string; tokens?: number | null; isError?: boolean }>,
): Partial<ProxyAuditRecord> {
  return {
    toolResults: rows.map((r) => ({
      toolUseId: r.id,
      isError: r.isError ?? false,
      contentPreview: '',
      contentLen: 100,
      contentTokens: r.tokens ?? null,
      tail: true,
    })),
  };
}

describe('time buckets', () => {
  // INVARIANT: `interrupted` is AWAITING time, not running time. The state
  // machine's isActiveStatus() counts it as active because the worktree is
  // live and nobody may merge into it — a different question from "was the
  // clock running on an agent". Counting it as running would inflate the one
  // number this tab exists to show.
  test('interrupted and zombie are awaiting, not running', () => {
    expect(timeBucketOf('working')).toBe('running');
    expect(timeBucketOf('pairing')).toBe('running');
    expect(timeBucketOf('merging')).toBe('running');
    expect(timeBucketOf('interrupted')).toBe('awaiting');
    expect(timeBucketOf('zombie')).toBe('awaiting');
    expect(timeBucketOf('blocked')).toBe('awaiting');
    expect(timeBucketOf('backlog')).toBe('backlog');
  });

  // INVARIANT: a terminal status stops the clock. Otherwise an accepted task
  // would accrue "awaiting a human" time forever, and the oldest finished task
  // would look like the most expensive one.
  test('terminal statuses are not a bucket', () => {
    expect(timeBucketOf('complete')).toBeNull();
    expect(timeBucketOf('abandoned')).toBeNull();
  });

  test('a status holds until the next change, then until the end', () => {
    const totals = statusIntervals(T0, [change('working', 1), change('blocked', 3)], T0 + 6 * HOUR);
    expect(totals.get('backlog')).toBe(1 * HOUR); // created → first transition
    expect(totals.get('running')).toBe(2 * HOUR);
    expect(totals.get('awaiting')).toBe(3 * HOUR);
  });

  test('no recorded history is no split at all, not a guessed one', () => {
    const totals = statusIntervals(T0, [], T0 + 5 * HOUR);
    expect(totals.get('running')).toBe(0);
    expect(totals.get('awaiting')).toBe(0);
    expect(totals.get('backlog')).toBe(5 * HOUR);
  });

  test('overlap of parent running time with a child running time', () => {
    const parent = bucketIntervals([change('working', 0), change('blocked', 8)], 'running', T0 + 8 * HOUR);
    const child = bucketIntervals([change('working', 2), change('complete', 5)], 'running', T0 + 8 * HOUR);
    expect(overlapMs(parent, child)).toBe(3 * HOUR);
  });

  test('overlapping child intervals are merged, never double-counted', () => {
    const parent = [{ start: T0, end: T0 + 10 * HOUR }];
    const children = [
      { start: T0 + 1 * HOUR, end: T0 + 4 * HOUR },
      { start: T0 + 2 * HOUR, end: T0 + 5 * HOUR },
    ];
    expect(overlapMs(parent, children)).toBe(4 * HOUR);
  });
});

describe('token aggregation', () => {
  test('sums the four counters across agent turns', () => {
    const stats = buildTokenStats(
      [
        turn({ sequence: 1, role: 'human' }),
        turn({ sequence: 2, usage: usage(100, 20, 5, 3) }),
        turn({ sequence: 3, usage: usage(200, 40, 7, 1) }),
      ],
      null,
      DEFAULT_TURN_CHART_LIMIT,
    );
    expect(stats.agentTurns).toBe(2);
    expect(stats.turnsWithUsage).toBe(2);
    expect(stats.totals.inputTokens).toBe(300);
    expect(stats.totals.outputTokens).toBe(60);
    expect(stats.totals.cacheReadTokens).toBe(12);
    expect(stats.totals.cacheCreationTokens).toBe(4);
    expect(stats.totals.total).toBe(376);
    expect(stats.series.map((p) => p.cumulative)).toEqual([128, 376]);
  });

  // INVARIANT: a turn that reported no usage stays null. Coercing it to zero
  // would render as a free turn, which is a fabricated number — the whole
  // point of this rollup is that a reader can trust what it shows.
  test('a turn with no recorded usage is null, never zero', () => {
    const stats = buildTokenStats(
      [turn({ sequence: 1, usage: usage(10, 5) }), turn({ sequence: 2 })],
      null,
      DEFAULT_TURN_CHART_LIMIT,
    );
    expect(stats.agentTurns).toBe(2);
    expect(stats.turnsWithUsage).toBe(1);
    expect(stats.series[1].usage).toBeNull();
    expect(stats.totals.total).toBe(15);
  });

  test('no turns at all is an empty rollup, not a crash', () => {
    const stats = buildTokenStats([], null, DEFAULT_TURN_CHART_LIMIT);
    expect(stats.agentTurns).toBe(0);
    expect(stats.totals.total).toBe(0);
    expect(stats.series).toEqual([]);
    expect(stats.byModel).toEqual([]);
  });

  // INVARIANT: the chart bound never changes the totals. Bounding the series
  // is what keeps a several-hundred-turn task cheap to render; silently
  // dropping those turns from the totals would make the tab lie about spend.
  test('the chart bound trims the series and reports what it trimmed', () => {
    const turns = Array.from({ length: 10 }, (_, i) =>
      turn({ sequence: i + 1, usage: usage(10, 0) }),
    );
    const stats = buildTokenStats(turns, null, 4);
    expect(stats.totals.total).toBe(100);
    expect(stats.series).toHaveLength(4);
    expect(stats.omittedTurns).toBe(6);
    expect(stats.omittedTotal).toBe(60);
    expect(stats.series[0].sequence).toBe(7);
  });

  test('model grouping prefers the concrete id and never back-fills unknown', () => {
    const stats = buildTokenStats(
      [
        turn({ sequence: 1, usage: usage(10, 0), model: 'opus', model_id: 'claude-opus-5' }),
        turn({ sequence: 2, usage: usage(90, 0) }),
      ],
      null,
      DEFAULT_TURN_CHART_LIMIT,
    );
    expect(stats.byModel.map((m) => m.key)).toEqual(['unknown', 'claude-opus-5']);
    expect(stats.byModel[0].totals.total).toBe(90);
  });

  test('per-turn span is the gap to the previous turn of any role', () => {
    const stats = buildTokenStats(
      [
        turn({ sequence: 1, role: 'human', timestamp: T0 }),
        turn({ sequence: 2, timestamp: T0 + 2 * HOUR, usage: usage(1, 1) }),
      ],
      null,
      DEFAULT_TURN_CHART_LIMIT,
    );
    expect(stats.series[0].spanMs).toBe(2 * HOUR);
  });
});

describe('tool stats from the proxy audit trail', () => {
  test('counts invocations per tool for this task only', () => {
    const stats = buildToolStats(
      [
        auditRecord({
          toolUses: [
            { id: 'u1', name: 'Read', path: null, command: null, target: null, connector: false, inputPreview: '' },
            { id: 'u2', name: 'Bash', path: null, command: 'ls', target: null, connector: false, inputPreview: '' },
          ],
          usage: { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 5, cacheReadInputTokens: 2 },
        }),
        auditRecord({
          toolUses: [{ id: 'u3', name: 'Read', path: null, command: null, target: null, connector: false, inputPreview: '' }],
          toolResults: [{ toolUseId: 'u2', isError: true, contentPreview: 'boom', contentLen: 4 }],
        }),
        auditRecord({ taskId: 'other-task', toolUses: [{ id: 'x', name: 'Read', path: null, command: null, target: null, connector: false, inputPreview: '' }] }),
      ],
      'task-1111',
    );
    expect(stats.requests).toBe(2);
    expect(stats.rows).toEqual([
      { name: 'Read', invocations: 2, errors: 0, resultTokens: 0, resultsMeasured: 0, resultsUnmeasured: 0 },
      { name: 'Bash', invocations: 1, errors: 1, resultTokens: 0, resultsMeasured: 0, resultsUnmeasured: 1 },
    ]);
    expect(stats.totalInvocations).toBe(3);
    expect(stats.proxyTotals.total).toBe(117);
  });

  // INVARIANT: a request's USAGE is never split across the tools it carried.
  // Usage is per request and one response routinely asks for several tools, so
  // any such division would be invented. The token column is a different
  // number — the measured size of each tool's own results — and it comes from
  // a recording change in the proxy, not from arithmetic here.
  test('per-tool tokens come from measured results, never from request usage', () => {
    const stats = buildToolStats(
      [
        auditRecord({
          usage: { inputTokens: 1000, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          toolUses: [
            { id: 'a', name: 'Read', path: null, command: null, target: null, connector: false, inputPreview: '' },
            { id: 'b', name: 'Grep', path: null, command: null, target: null, connector: false, inputPreview: '' },
          ],
        }),
        auditRecord({
          toolResults: [
            { toolUseId: 'a', isError: false, contentPreview: '', contentLen: 4000, contentTokens: 900 },
            { toolUseId: 'b', isError: false, contentPreview: '', contentLen: 40, contentTokens: 12 },
          ],
        }),
      ],
      'task-1111',
    );
    // 1100 tokens of request usage exist and are reported at task level; not
    // one of them lands in a row.
    expect(stats.proxyTotals.total).toBe(1100);
    expect(stats.rows.map((r) => [r.name, r.resultTokens])).toEqual([
      ['Read', 900],
      ['Grep', 12],
    ]);
    expect(stats.resultTokens).toBe(912);
  });

  // INVARIANT: every audited request replays the WHOLE conversation, so the
  // same tool_use and tool_result blocks reappear in every later record.
  // Everything is deduped by tool_use id. Counting raw blocks measures how many
  // requests followed a call, which is not a tool statistic — on a real log it
  // inflated 142 calls to 3,966.
  test('a call replayed across many requests is one call, and one result', () => {
    const use = { id: 'u1', name: 'Read', path: null, command: null, target: null, connector: false, inputPreview: '' };
    const result = { toolUseId: 'u1', isError: false, contentPreview: '', contentLen: 400, contentTokens: 100 };
    const stats = buildToolStats(
      [
        auditRecord({ toolUses: [use] }),
        auditRecord({ toolUses: [use], toolResults: [result] }),
        auditRecord({ toolUses: [use], toolResults: [result] }),
        auditRecord({ toolUses: [use], toolResults: [result] }),
      ],
      'task-1111',
    );
    expect(stats.requests).toBe(4);
    expect(stats.totalInvocations).toBe(1);
    expect(stats.rows[0]).toEqual({
      name: 'Read',
      invocations: 1,
      errors: 0,
      resultTokens: 100,
      resultsMeasured: 1,
      resultsUnmeasured: 0,
    });
    expect(stats.resultTokens).toBe(100);
  });

  // INVARIANT: an unmeasured result is counted as unmeasured, never as zero
  // tokens — a zero would read as "this tool's output was free".
  test('results with no recorded size are counted, not assumed free', () => {
    const stats = buildToolStats(
      [
        auditRecord({
          toolUses: [{ id: 'u1', name: 'Bash', path: null, command: 'ls', target: null, connector: false, inputPreview: '' }],
        }),
        auditRecord({
          toolResults: [{ toolUseId: 'u1', isError: false, contentPreview: '', contentLen: 999 }],
        }),
      ],
      'task-1111',
    );
    expect(stats.rows[0].resultTokens).toBe(0);
    expect(stats.rows[0].resultsMeasured).toBe(0);
    expect(stats.rows[0].resultsUnmeasured).toBe(1);
    expect(stats.resultsUnmeasured).toBe(1);
  });

  // INVARIANT: a result whose tool_use fell outside the retained window has no
  // known tool. Its tokens are real, so they are reported separately rather
  // than dropped or filed under a guessed name.
  test('results for calls outside the window are reported as unattributed', () => {
    const stats = buildToolStats(
      [
        auditRecord({
          toolResults: [{ toolUseId: 'gone', isError: false, contentPreview: '', contentLen: 800, contentTokens: 200 }],
        }),
      ],
      'task-1111',
    );
    expect(stats.rows).toEqual([]);
    expect(stats.resultTokens).toBe(0);
    expect(stats.unattributedResultTokens).toBe(200);
  });

  test('rows lead with the tool that put the most into the context', () => {
    const uses = [
      { id: 'a', name: 'Read', path: null, command: null, target: null, connector: false, inputPreview: '' },
      { id: 'b', name: 'Read', path: null, command: null, target: null, connector: false, inputPreview: '' },
      { id: 'c', name: 'Read', path: null, command: null, target: null, connector: false, inputPreview: '' },
      { id: 'd', name: 'WebFetch', path: null, command: null, target: null, connector: false, inputPreview: '' },
    ];
    const stats = buildToolStats(
      [
        auditRecord({ toolUses: uses }),
        auditRecord({
          toolResults: [
            { toolUseId: 'a', isError: false, contentPreview: '', contentLen: 40, contentTokens: 10 },
            { toolUseId: 'b', isError: false, contentPreview: '', contentLen: 40, contentTokens: 10 },
            { toolUseId: 'c', isError: false, contentPreview: '', contentLen: 40, contentTokens: 10 },
            { toolUseId: 'd', isError: false, contentPreview: '', contentLen: 400_000, contentTokens: 90_000 },
          ],
        }),
      ],
      'task-1111',
    );
    // Three Read calls against one WebFetch: calls alone would rank Read first.
    expect(stats.rows.map((r) => r.name)).toEqual(['WebFetch', 'Read']);
  });

  test('no records for this task is zero, and says so through requests', () => {
    const stats = buildToolStats([auditRecord({ taskId: 'zzzz' })], 'task-1111');
    expect(stats.requests).toBe(0);
    expect(stats.rows).toEqual([]);
    expect(stats.firstTs).toBeNull();
  });
});

describe('buildTaskStats', () => {
  test('rolls time, tokens, tools and counts together', () => {
    const stats = buildTaskStats({
      task: task(),
      session: null,
      turns: [turn({ sequence: 1, usage: usage(10, 5) })],
      commits: [commit(2)],
      statusHistory: [change('working', 0), change('blocked', 4)],
      childHistories: new Map([['child', [change('working', 1), change('complete', 2)]]]),
      toolStatsRecord: toolRecord([]),
      now: T0 + 6 * HOUR,
    });
    expect(stats.time.runningMs).toBe(4 * HOUR);
    expect(stats.time.awaitingMs).toBe(2 * HOUR);
    expect(stats.time.subtaskRunningMs).toBe(1 * HOUR);
    expect(stats.time.elapsedMs).toBe(6 * HOUR);
    expect(stats.time.live).toBe(true);
    expect(stats.tokens.totals.total).toBe(15);
    expect(stats.tools?.requests).toBe(0);
    expect(stats.commits).toBe(1);
  });

  test('no child histories leaves subtask time underived, not zero', () => {
    const stats = buildTaskStats({
      task: task(),
      session: null,
      turns: [],
      commits: [],
      statusHistory: [change('working', 0)],
      now: T0 + HOUR,
    });
    expect(stats.time.subtaskRunningMs).toBeNull();
    expect(stats.tools).toBeNull();
  });

  test('a finished task stops its clock at completion', () => {
    const stats = buildTaskStats({
      task: task({ status: 'complete', completed_at: T0 + 3 * HOUR }),
      session: null,
      turns: [],
      commits: [],
      statusHistory: [change('working', 0), change('complete', 3)],
      now: T0 + 100 * HOUR,
    });
    expect(stats.time.elapsedMs).toBe(3 * HOUR);
    expect(stats.time.runningMs).toBe(3 * HOUR);
    expect(stats.time.awaitingMs).toBe(0);
    expect(stats.time.live).toBe(false);
  });
});

describe('the rendered tab', () => {
  function render(over: Partial<Parameters<typeof buildTaskStats>[0]> = {}): string {
    return statsTabHtml(
      buildTaskStats({
        task: task(),
        session: null,
        turns: [],
        commits: [],
        statusHistory: [],
        now: T0 + HOUR,
        ...over,
      }),
    );
  }

  test('a task with no turns renders an honest empty state', () => {
    const html = render();
    expect(html).toContain('No agent turns yet');
    expect(html).toContain('No status history recorded');
    expect(html).not.toContain('<svg');
  });

  test('agent turns with no usage say so instead of showing zero', () => {
    const html = render({ turns: [turn({ sequence: 1 }), turn({ sequence: 2 })] });
    expect(html).toContain('none of which reported token usage');
    expect(html).not.toContain('<svg');
  });

  test('recorded usage draws the stacked chart and the legend values', () => {
    const html = render({
      turns: [
        turn({ sequence: 1, usage: usage(1000, 200, 50, 10) }),
        turn({ sequence: 2, usage: usage(2000, 300, 60, 20) }),
      ],
      statusHistory: [change('working', 0)],
    });
    expect(html).toContain('<svg');
    // Every series is labelled with its value — the relief the light-mode
    // contrast warning requires, and what keeps identity off color alone.
    for (const label of ['Input', 'Output', 'Cache read', 'Cache write']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('3,000'); // input total, spelled out
    expect(html).toContain('Per-turn numbers (2)'); // the table view
  });

  // INVARIANT: a task with no durable tool record says the numbers were never
  // recorded. It must never render as "this task called no tools" — the two are
  // different facts and only one of them is known.
  test('a task with no tool record says that, not "no tools"', () => {
    const html = render({ toolStatsRecord: null });
    expect(html).toContain('No tool statistics were recorded for this task');
    expect(html).toContain('not a claim that no tools were called');
  });

  test('a task that ran under the proxy but called nothing says exactly that', () => {
    const html = render({ toolStatsRecord: toolRecord([]) });
    expect(html).toContain('No proxied requests have been recorded for this task');
  });

  test('what the token column means is stated', () => {
    const html = render({
      toolStatsRecord: toolRecord([
        auditRecord(calls([{ id: 'u', name: 'Read' }])),
        auditRecord(results([{ id: 'u', tokens: 987 }])),
      ]),
    });
    // The meaning travels with the number: context the tool added, and
    // explicitly NOT a share of the model bill.
    expect(html).toContain('context the tool added, not a share of the model bill');
    expect(html).toContain('never split across the tools it carried');
    expect(html).toContain('Read');
    expect(html).toContain('987');
  });

  // INVARIANT: a tool whose results were never measured renders "not recorded",
  // never a 0 that a reader would take for "this tool's output was free".
  test('an unmeasured tool row says not recorded rather than zero', () => {
    const html = render({
      toolStatsRecord: toolRecord([
        auditRecord(calls([{ id: 'u', name: 'Read' }])),
        auditRecord(results([{ id: 'u', tokens: null }])),
      ]),
    });
    expect(html).toContain('not recorded');
    expect(html).toContain('predate this being measured');
  });

  // INVARIANT: no cost figures without a price table. There is no source of
  // truth for prices in this repository, and a hardcoded one would rot in
  // silence — which is worse than saying nothing.
  test('cost is absent and the absence is explained', () => {
    expect(render()).toContain('no price table');
  });

  test('wall-clock is labelled as wall-clock', () => {
    const html = render({ statusHistory: [change('working', 0), change('blocked', 1)] });
    expect(html).toContain('Wall clock');
    expect(html).toContain('blocked overnight');
  });

  test('tool names are escaped, not injected', () => {
    const html = render({
      toolStatsRecord: toolRecord([
        auditRecord(calls([{ id: 'u', name: '<img src=x onerror=alert(1)>' }])),
      ]),
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});

describe('formatting', () => {
  test('durations read at the right scale', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(90_000)).toBe('2m');
    expect(formatDuration(3 * HOUR)).toBe('3.0h');
    expect(formatDuration(72 * HOUR)).toBe('3.0d');
  });

  test('token counts compact without losing the magnitude', () => {
    expect(formatTokens(942)).toBe('942');
    expect(formatTokens(1500)).toBe('1.5K');
    expect(formatTokens(250_000)).toBe('250K');
    expect(formatTokens(3_400_000)).toBe('3.4M');
    expect(formatTokens(42_000_000)).toBe('42M');
  });
});
