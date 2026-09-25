/**
 * Stats rolled up over a task's whole subtree.
 *
 * What is pinned here is the part a hub's reader trusts: that counts and
 * tokens are sums over EVERY level, that the per-tool table merges by name,
 * and above all that TIME IS NOT SUMMED — a parent and its children run at the
 * same moment by design, so a union is the only honest combination and the
 * timesheet-style sum is reported as its own, separately named number.
 */

import { describe, test, expect } from 'bun:test';
import {
  buildSubtreeStats,
  buildTokenStatsAcross,
  buildToolStats,
  mergeToolStats,
  partitionAuditRecordsByTask,
  subtractIntervals,
  intervalsLength,
  parseStatsScope,
  type TaskStatsPart,
} from '../../src/task/stats';
import { statsTabHtml } from '../../src/server/stats-tab';
import type { Task, Session, Turn, Commit, TokenUsage } from '../../src/types';
import type { StatusChange, ProxyAuditRecord } from '../../src/storage/types';

const T0 = new Date('2026-09-01T00:00:00Z').getTime();
const HOUR = 3_600_000;

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    code: id,
    goal: id,
    status: 'working',
    created_at: T0,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    ...over,
  } as unknown as Task;
}

function child(id: string, parentId: string, over: Partial<Task> = {}): Task {
  return task(id, { target: { kind: 'task', parentTaskId: parentId }, ...over } as Partial<Task>);
}

function change(status: string, atHours: number): StatusChange {
  return { status, timestamp: T0 + atHours * HOUR };
}

function usage(input: number, output: number): TokenUsage {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function turn(sessionId: string, sequence: number, atHours: number, u: TokenUsage | null): Turn {
  return {
    id: `${sessionId}-${sequence}`,
    session_id: sessionId,
    role: 'agent',
    content: 'x',
    sequence,
    timestamp: T0 + atHours * HOUR,
    usage: u,
    model: 'claude-opus-5',
  } as unknown as Turn;
}

function commit(atHours: number): Commit {
  return {
    id: 'c',
    session_id: 's',
    sha: 'abc',
    message: 'm',
    status: 'pending',
    timestamp: T0 + atHours * HOUR,
  } as unknown as Commit;
}

function session(id: string, total: TokenUsage | null = null): Session {
  return { id, total_usage: total } as unknown as Session;
}

function part(t: Task, over: Partial<TaskStatsPart> = {}): TaskStatsPart {
  return { task: t, session: null, turns: [], commits: [], statusHistory: [], ...over };
}

function auditRecord(over: Partial<ProxyAuditRecord>): ProxyAuditRecord {
  return {
    id: 'a',
    seq: 1,
    ts: T0,
    role: 'agent',
    taskId: 'hub',
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

function use(id: string, name: string) {
  return { id, name, path: null, command: null, target: null, connector: false, inputPreview: '' };
}

function result(toolUseId: string, tokens: number | null) {
  return { toolUseId, isError: false, contentPreview: '', contentLen: 10, contentTokens: tokens };
}

describe('interval arithmetic', () => {
  test('subtracting carves the covered parts out', () => {
    const out = subtractIntervals([{ start: 0, end: 10 }], [{ start: 2, end: 4 }, { start: 8, end: 20 }]);
    expect(out).toEqual([{ start: 0, end: 2 }, { start: 4, end: 8 }]);
    expect(intervalsLength(out)).toBe(6);
  });

  test('a fully covered interval disappears', () => {
    expect(subtractIntervals([{ start: 3, end: 5 }], [{ start: 0, end: 9 }])).toEqual([]);
  });

  test('overlapping inputs are counted once', () => {
    expect(intervalsLength([{ start: 0, end: 5 }, { start: 2, end: 8 }])).toBe(8);
  });
});

describe('buildSubtreeStats', () => {
  // A hub whose own turns are nothing, a child that did the work, and a
  // grandchild under that child — the shape a release task actually has.
  function deepTree(): { root: TaskStatsPart; descendants: TaskStatsPart[] } {
    const hub = part(task('hub'), {
      session: session('s-hub'),
      turns: [turn('s-hub', 1, 0.5, usage(10, 5))],
      statusHistory: [change('working', 0), change('blocked', 6)],
    });
    const kid = part(child('kid', 'hub'), {
      session: session('s-kid'),
      turns: [turn('s-kid', 1, 1.5, usage(100, 50))],
      commits: [commit(2)],
      statusHistory: [change('working', 1), change('complete', 3)],
    });
    const grandkid = part(child('grandkid', 'kid'), {
      session: session('s-gk'),
      turns: [turn('s-gk', 1, 2.5, usage(1000, 500))],
      commits: [commit(2.5), commit(2.8)],
      statusHistory: [change('working', 2), change('complete', 3)],
    });
    return { root: hub, descendants: [kid, grandkid] };
  }

  test('counts, tokens and commits are summed over every level', () => {
    const stats = buildSubtreeStats({ ...deepTree(), now: T0 + 6 * HOUR });
    expect(stats.scope).toBe('subtree');
    expect(stats.descendants).toBe(2);
    // Direct children only — the grandchild is nested under the child.
    expect(stats.children).toBe(1);
    expect(stats.turns.total).toBe(3);
    expect(stats.tokens.totals.total).toBe(15 + 150 + 1500);
    expect(stats.commits).toBe(3);
    expect(stats.subtree?.tasks).toBe(3);
  });

  // INVARIANT: subtree time is a UNION, never a sum. A loop parent sits in
  // `working` for exactly as long as its children run, so adding the wall
  // clocks would bill the same minute two or three times — the exact complaint
  // ("wildly inaccurate") this view exists to answer.
  test('running time is the union, and the summed figure is reported separately', () => {
    const stats = buildSubtreeStats({ ...deepTree(), now: T0 + 6 * HOUR });
    // Hub runs 0→6, kid 1→3, grandkid 2→3. Union of running is 0→6.
    expect(stats.time.runningMs).toBe(6 * HOUR);
    // Summed: 6 + 2 + 1.
    expect(stats.subtree?.summedRunningMs).toBe(9 * HOUR);
    expect(stats.subtree?.overlappedRunningMs).toBe(3 * HOUR);
  });

  // INVARIANT: the three buckets divide ONE window. Awaiting and backlog have
  // the higher-priority unions cut out of them, so a parent blocked while a
  // child still runs does not add a second copy of that minute.
  test('awaiting does not double-count a minute some task was running', () => {
    const root = part(task('hub'), { statusHistory: [change('blocked', 0)] });
    const kid = part(child('kid', 'hub'), { statusHistory: [change('working', 0)] });
    const stats = buildSubtreeStats({ root, descendants: [kid], now: T0 + 4 * HOUR });
    expect(stats.time.runningMs).toBe(4 * HOUR);
    expect(stats.time.awaitingMs).toBe(0);
    expect(stats.subtree?.summedAwaitingMs).toBe(4 * HOUR);
    expect(stats.time.elapsedMs).toBe(4 * HOUR);
  });

  // A stretch during which every task was finished and the next one not yet
  // created belongs to no bucket. Stretching one of them to cover it would be
  // a fabricated number; it is named instead.
  test('a gap with no task alive is idle, not silently absorbed', () => {
    const root = part(task('hub', { status: 'complete', completed_at: T0 + HOUR }), {
      statusHistory: [change('working', 0), change('complete', 1)],
    });
    const later = part(child('kid', 'hub', { created_at: T0 + 3 * HOUR }), {
      statusHistory: [change('working', 3)],
    });
    const stats = buildSubtreeStats({ root, descendants: [later], now: T0 + 4 * HOUR });
    expect(stats.time.runningMs).toBe(2 * HOUR);
    expect(stats.time.idleMs).toBe(2 * HOUR);
    expect(stats.time.elapsedMs).toBe(4 * HOUR);
  });

  // A child accepted into its parent is terminal: its clock stopped at
  // completion, but every token and commit it made is still the hub's spend.
  test('an accepted child stops its clock but keeps its spend', () => {
    const root = part(task('hub'), { statusHistory: [change('working', 0)] });
    const accepted = part(
      child('kid', 'hub', { status: 'complete', completed_at: T0 + 2 * HOUR }),
      {
        session: session('s-kid'),
        turns: [turn('s-kid', 1, 1, usage(100, 0))],
        commits: [commit(1.5)],
        statusHistory: [change('working', 0), change('complete', 2)],
      },
    );
    const stats = buildSubtreeStats({ root, descendants: [accepted], now: T0 + 10 * HOUR });
    expect(stats.tokens.totals.total).toBe(100);
    expect(stats.commits).toBe(1);
    // The child contributed two hours of running time, not ten.
    expect(stats.subtree?.summedRunningMs).toBe(12 * HOUR);
    expect(stats.time.runningMs).toBe(10 * HOUR);
    expect(stats.time.live).toBe(true);
  });

  test('a subtree where everything is terminal is not live', () => {
    const root = part(task('hub', { status: 'complete', completed_at: T0 + HOUR }), {
      statusHistory: [change('working', 0), change('complete', 1)],
    });
    const kid = part(child('kid', 'hub', { status: 'abandoned', completed_at: T0 + HOUR }), {
      statusHistory: [change('working', 0), change('abandoned', 1)],
    });
    const stats = buildSubtreeStats({ root, descendants: [kid], now: T0 + 50 * HOUR });
    expect(stats.time.live).toBe(false);
    expect(stats.time.elapsedMs).toBe(HOUR);
  });

  test('waiting-on-subtasks widens from direct children to the whole subtree', () => {
    const stats = buildSubtreeStats({ ...deepTree(), now: T0 + 6 * HOUR });
    // Hub running 0→6 overlapped kid 1→3 and grandkid 2→3: union 1→3.
    expect(stats.time.subtaskRunningMs).toBe(2 * HOUR);
  });

  // INVARIANT: `rootRunningMs` is the ROOT task's own running wall clock, and it
  // is the only honest denominator for `subtaskRunningMs` — which is the root's
  // own running time that overlapped a descendant's. Both renderers divide by
  // this field; neither may reach for `summedRunningMs`, which folds in every
  // descendant's clock too. That is not a rounding difference: here the root ran
  // 6h of a 9h sum, so the same overlap is 33% of the whole it is named against
  // and 22% of the one it is not, and the error always understates — worst on
  // the deep trees where somebody is actually asking.
  test('the overlap denominator is the root task alone, not the per-task sum', () => {
    const stats = buildSubtreeStats({ ...deepTree(), now: T0 + 6 * HOUR });

    expect(stats.subtree?.rootRunningMs).toBe(6 * HOUR);
    expect(stats.subtree?.summedRunningMs).toBe(9 * HOUR);
    // The two denominators genuinely differ, so a renderer using the wrong one
    // cannot pass this by coincidence.
    expect(stats.subtree!.rootRunningMs).not.toBe(stats.subtree!.summedRunningMs);
    expect(stats.time.subtaskRunningMs! / stats.subtree!.rootRunningMs).toBeCloseTo(1 / 3, 5);
  });

  // A root that never ran at all leaves the denominator at zero. There is no
  // share to state then — the renderers' percent helper answers 0%, and nothing
  // divides by zero.
  test('a root that never ran reports no running clock of its own', () => {
    const root = part(task('hub'), { statusHistory: [change('backlog', 0)] });
    const kid = part(child('kid', 'hub'), {
      statusHistory: [change('working', 1), change('complete', 3)],
    });
    const stats = buildSubtreeStats({ root, descendants: [kid], now: T0 + 6 * HOUR });

    expect(stats.subtree?.rootRunningMs).toBe(0);
    expect(stats.time.subtaskRunningMs).toBe(0);
  });

  test('a task with no recorded history contributes no time, and is counted', () => {
    const root = part(task('hub'), { statusHistory: [change('working', 0)] });
    const silent = part(child('kid', 'hub'));
    const stats = buildSubtreeStats({ root, descendants: [silent], now: T0 + 2 * HOUR });
    expect(stats.subtree?.tasksWithHistory).toBe(1);
    expect(stats.subtree?.tasks).toBe(2);
    expect(stats.time.runningMs).toBe(2 * HOUR);
  });
});

describe('the merged token series', () => {
  // INVARIANT: turn SEQUENCES are per task — every task has a turn 1 — so a
  // merged series is ordered by TIMESTAMP and its cumulative total recomputed
  // in that order. Ordering by sequence would interleave unrelated
  // conversations into a growth curve that never happened.
  test('orders by timestamp across tasks and recomputes the running total', () => {
    const stats = buildTokenStatsAcross(
      [
        { label: 'hub', session: null, turns: [turn('a', 1, 3, usage(30, 0))] },
        {
          label: 'kid',
          session: null,
          turns: [turn('b', 1, 1, usage(10, 0)), turn('b', 2, 2, usage(20, 0))],
        },
      ],
      10,
    );
    expect(stats.series.map((p) => p.taskLabel)).toEqual(['kid', 'kid', 'hub']);
    expect(stats.series.map((p) => p.cumulative)).toEqual([10, 30, 60]);
    expect(stats.totals.total).toBe(60);
    expect(stats.agentTurns).toBe(3);
  });

  // A span is the gap from a task's PREVIOUS turn. Across two tasks it would
  // be the gap between unrelated conversations, which is a span of nothing.
  test('spans stay within a task', () => {
    const stats = buildTokenStatsAcross(
      [
        { label: 'hub', session: null, turns: [turn('a', 1, 5, usage(1, 0))] },
        { label: 'kid', session: null, turns: [turn('b', 1, 4, usage(1, 0))] },
      ],
      10,
    );
    expect(stats.series.every((p) => p.spanMs === null)).toBe(true);
  });

  test('session totals are summed, and stay absent when nobody recorded one', () => {
    const withTotals = buildTokenStatsAcross(
      [
        { label: 'hub', session: session('a', usage(5, 5)), turns: [] },
        { label: 'kid', session: session('b', usage(1, 1)), turns: [] },
      ],
      10,
    );
    expect(withTotals.sessionTotal?.total).toBe(12);
    const without = buildTokenStatsAcross([{ label: 'hub', session: session('a'), turns: [] }], 10);
    expect(without.sessionTotal).toBeNull();
  });

  test('a single unlabelled group is the old single-task series', () => {
    const stats = buildTokenStatsAcross(
      [{ label: null, session: null, turns: [turn('a', 1, 1, usage(2, 0))] }],
      10,
    );
    expect(stats.series[0].taskLabel).toBeNull();
  });
});

describe('merging per-tool tables', () => {
  test('rows merge by tool name and the totals add up', () => {
    const a = buildToolStats(
      [
        auditRecord({ taskId: 'hub', toolUses: [use('u1', 'Read')] }),
        auditRecord({ taskId: 'hub', toolResults: [result('u1', 100)] }),
      ],
      'hub',
    );
    const b = buildToolStats(
      [
        auditRecord({ taskId: 'kid', toolUses: [use('u2', 'Read'), use('u3', 'Bash')] }),
        auditRecord({ taskId: 'kid', toolResults: [result('u2', 50), result('u3', 400)] }),
      ],
      'kid',
    );
    const merged = mergeToolStats([a, b]);
    expect(merged.requests).toBe(4);
    expect(merged.rows.map((r) => r.name)).toEqual(['Bash', 'Read']);
    const read = merged.rows.find((r) => r.name === 'Read')!;
    expect(read.invocations).toBe(2);
    expect(read.resultTokens).toBe(150);
    expect(read.resultsMeasured).toBe(2);
    expect(merged.totalInvocations).toBe(3);
    expect(merged.resultTokens).toBe(550);
  });

  // INVARIANT: an unmeasured result stays unmeasured through the merge. Rolling
  // it into the token column as a zero would read as "that tool's output was
  // free" on the one view most likely to be quoted.
  test('unmeasured and unattributed carry through rather than becoming zero', () => {
    const a = buildToolStats(
      [
        auditRecord({ taskId: 'hub', toolUses: [use('u1', 'Read')] }),
        auditRecord({ taskId: 'hub', toolResults: [result('u1', null)] }),
      ],
      'hub',
    );
    const b = buildToolStats(
      [auditRecord({ taskId: 'kid', toolResults: [result('gone', 200)] })],
      'kid',
    );
    const merged = mergeToolStats([a, b]);
    expect(merged.resultsUnmeasured).toBe(1);
    expect(merged.unattributedResultTokens).toBe(200);
    expect(merged.rows[0].resultTokens).toBe(0);
    expect(merged.rows[0].resultsUnmeasured).toBe(1);
  });

  test('the window spans the earliest and latest record of any task', () => {
    const a = buildToolStats([auditRecord({ taskId: 'hub', ts: T0 + 5 * HOUR })], 'hub');
    const b = buildToolStats([auditRecord({ taskId: 'kid', ts: T0 })], 'kid');
    const merged = mergeToolStats([a, b]);
    expect(merged.firstTs).toBe(T0);
    expect(merged.lastTs).toBe(T0 + 5 * HOUR);
  });

  test('merging nothing is an empty table, not a crash', () => {
    const merged = mergeToolStats([]);
    expect(merged.requests).toBe(0);
    expect(merged.rows).toEqual([]);
    expect(merged.firstTs).toBeNull();
  });
});

describe('partitioning the audit trail', () => {
  test('each record goes to the task that owns it, prefix match either way', () => {
    const records = [
      auditRecord({ taskId: 'hub' }),
      // The header carries whatever id the launch had — often a short prefix.
      auditRecord({ taskId: 'kid' }),
      auditRecord({ taskId: 'someone-else' }),
      auditRecord({ taskId: null }),
    ];
    const byTask = partitionAuditRecordsByTask(records, ['hub-full-id', 'kid-full-id']);
    expect(byTask.get('hub-full-id')!.length).toBe(1);
    expect(byTask.get('kid-full-id')!.length).toBe(1);
  });

  test('every task in the set gets an entry, even an empty one', () => {
    const byTask = partitionAuditRecordsByTask([], ['a', 'b']);
    expect([...byTask.keys()]).toEqual(['a', 'b']);
    expect(byTask.get('a')).toEqual([]);
  });
});

describe('the rendered subtree tab', () => {
  function subtreeHtml(over: Partial<Parameters<typeof buildSubtreeStats>[0]> = {}): string {
    const root = part(task('hub'), { statusHistory: [change('working', 0)] });
    const kid = part(child('kid', 'hub'), { statusHistory: [change('working', 0)] });
    return statsTabHtml(
      buildSubtreeStats({ root, descendants: [kid], now: T0 + 2 * HOUR, ...over }),
      { scope: 'subtree', descendantCount: 1, taskHref: '/t?scope=task', subtreeHref: '/t?scope=subtree' },
    );
  }

  test('says what it folded in and offers the other view', () => {
    const html = subtreeHtml();
    expect(html).toContain('These numbers cover this task and 1 nested task(s).');
    expect(html).toContain('/t?scope=task');
    expect(html).toContain('This task only');
    expect(html).toContain('Including subtasks (1 nested task)');
  });

  // The single most misreadable number on the tab: showing a union without
  // naming the sum is how a reader concludes the numbers are broken.
  test('names the summed running time next to the union', () => {
    const html = subtreeHtml();
    expect(html).toContain('AT LEAST ONE');
    expect(html).toContain('Added up per task instead');
  });

  // INVARIANT: the overlap percentage is against the ROOT'S OWN running clock.
  // The sentence says "of this task's own running time", so that is the only
  // whole it may be a share of. It used to divide by `summedRunningMs` — every
  // folded-in task's clock — which named one whole and used another, and always
  // understated. Pinned on the RENDERED string because the wrong denominator is
  // invisible in a percentage: both readings are plausible-looking numbers.
  test("the overlap share is against the root's own running time, not the sum", () => {
    // Hub runs 0→6; kid runs 1→3 inside it. Overlap 2h, hub's own clock 6h, the
    // per-task sum 8h. Correct: 33%. Against the sum it would read 25%.
    const root = part(task('hub'), {
      statusHistory: [change('working', 0), change('blocked', 6)],
    });
    const kid = part(child('kid', 'hub'), {
      statusHistory: [change('working', 1), change('complete', 3)],
    });
    const stats = buildSubtreeStats({ root, descendants: [kid], now: T0 + 6 * HOUR });

    expect(stats.subtree?.rootRunningMs).toBe(6 * HOUR);
    expect(stats.subtree?.summedRunningMs).toBe(8 * HOUR);
    expect(stats.time.subtaskRunningMs).toBe(2 * HOUR);

    const html = statsTabHtml(stats);
    // `&#39;` and not `'`: this tab now escapes through src/server/escape.ts
    // like every other renderer, and that escaper covers the apostrophe. The
    // sentence and the percentage it pins are unchanged — only the encoding of
    // one character is.
    expect(html).toContain("Of this task&#39;s own running time, 2.0h (33%)");
    expect(html).not.toContain('(25%)');
  });

  test('the toggle is absent on a task with no descendants', () => {
    const html = statsTabHtml(
      buildSubtreeStats({
        root: part(task('hub'), { statusHistory: [change('working', 0)] }),
        descendants: [],
        now: T0 + HOUR,
      }),
      { scope: 'task', descendantCount: 0, taskHref: '/t?scope=task', subtreeHref: '/t?scope=subtree' },
    );
    expect(html).not.toContain('lz-stats-scope');
  });

  // An axis reading "turn 2 … turn 2" is worse than no axis: the two ends are
  // different tasks' second turns, and nothing on the chart says so.
  test('the chart axis names the task, not just a colliding sequence number', () => {
    const root = part(task('hub'), {
      session: session('s-hub'),
      turns: [turn('s-hub', 2, 0.5, usage(10, 5))],
      statusHistory: [change('working', 0)],
    });
    const kid = part(child('kid', 'hub'), {
      session: session('s-kid'),
      turns: [turn('s-kid', 2, 1, usage(20, 5))],
      statusHistory: [change('working', 0)],
    });
    const html = statsTabHtml(buildSubtreeStats({ root, descendants: [kid], now: T0 + 2 * HOUR }));
    expect(html).toContain('hub #2');
    expect(html).toContain('kid #2');
    expect(html).not.toContain('>turn 2<');
  });

  test('the per-turn table names the task each turn came from', () => {
    const root = part(task('hub'), {
      session: session('s-hub'),
      turns: [turn('s-hub', 1, 0.5, usage(10, 5))],
      statusHistory: [change('working', 0)],
    });
    const kid = part(child('kid', 'hub'), {
      session: session('s-kid'),
      turns: [turn('s-kid', 1, 1, usage(20, 5))],
      statusHistory: [change('working', 0)],
    });
    const html = statsTabHtml(buildSubtreeStats({ root, descendants: [kid], now: T0 + 2 * HOUR }));
    expect(html).toContain('<th>Task</th>');
    expect(html).toContain('<code>kid</code>');
  });
});

describe('scope parsing', () => {
  test('only the two real scopes are accepted', () => {
    expect(parseStatsScope('task')).toBe('task');
    expect(parseStatsScope('subtree')).toBe('subtree');
    expect(parseStatsScope('everything')).toBeNull();
    expect(parseStatsScope(null)).toBeNull();
  });
});
