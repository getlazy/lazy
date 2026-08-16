/**
 * Self-time analysis for `lazy timings`.
 *
 * These tests encode the ranking invariants that make the readout useful:
 * self time is duration minus the UNION of direct children (never the sum),
 * cross-process clock skew can never produce a negative self time, and
 * pass-through wrappers rank below spans with real own work.
 */
import { describe, test, expect } from 'bun:test';
import {
  unionLength,
  selfTimeMs,
  buildTraceAnalyses,
  slowestLeaves,
  slowestBranches,
  slowestBySelfTime,
} from '../../src/tracing/analysis';
import type { SpanRecord } from '../../src/tracing/types';

let nextId = 0;

function span(
  name: string,
  start: number,
  end: number,
  parent: string | null = null,
  opts: Partial<SpanRecord> = {},
): SpanRecord {
  return {
    trace_id: 't1',
    span_id: opts.span_id ?? `s${++nextId}`,
    parent_span_id: parent,
    name,
    start_ms: start,
    end_ms: end,
    duration_ms: end - start,
    status: 'ok',
    service: 'daemon',
    attributes: {},
    ...opts,
  };
}

describe('unionLength', () => {
  test('sums disjoint intervals', () => {
    expect(unionLength([[0, 10], [20, 25]])).toBe(15);
  });

  test('counts overlap once', () => {
    expect(unionLength([[0, 10], [5, 15]])).toBe(15);
  });

  test('absorbs fully nested intervals', () => {
    expect(unionLength([[0, 100], [10, 20], [30, 40]])).toBe(100);
  });

  test('treats touching intervals as one run', () => {
    expect(unionLength([[0, 10], [10, 20]])).toBe(20);
  });

  test('ignores empty and inverted intervals', () => {
    expect(unionLength([[5, 5], [10, 8], [0, 3]])).toBe(3);
    expect(unionLength([])).toBe(0);
  });

  test('is order-independent', () => {
    expect(unionLength([[20, 25], [0, 10], [5, 15]])).toBe(20);
  });
});

describe('selfTimeMs', () => {
  test('a leaf owns its whole duration', () => {
    expect(selfTimeMs(span('git.push', 0, 500), []).selfMs).toBe(500);
  });

  test('subtracts sequential children', () => {
    const parent = span('wrap', 0, 1000);
    const kids = [span('a', 0, 300, parent.span_id), span('b', 400, 900, parent.span_id)];
    // 1000 - (300 + 500) = 200ms of own work, including the 100ms gap.
    expect(selfTimeMs(parent, kids).selfMs).toBe(200);
  });

  // INVARIANT: concurrent children are subtracted as a UNION, not a sum.
  // Summing would double-count the overlap and drive self time negative,
  // which is exactly the bug this ranking would die of.
  test('overlapping children are subtracted once, not twice', () => {
    const parent = span('fanout', 0, 1200);
    const kids = [span('a', 0, 1000, parent.span_id), span('b', 0, 1000, parent.span_id)];
    const { selfMs, childMs } = selfTimeMs(parent, kids);
    expect(childMs).toBe(1000); // union, not 2000
    expect(selfMs).toBe(200);
  });

  test('partially overlapping children subtract their union', () => {
    const parent = span('fanout', 0, 1000);
    const kids = [span('a', 0, 600, parent.span_id), span('b', 400, 900, parent.span_id)];
    const { selfMs, childMs } = selfTimeMs(parent, kids);
    expect(childMs).toBe(900);
    expect(selfMs).toBe(100);
  });

  // INVARIANT: spans in one trace come from different processes (cli, daemon)
  // whose clocks are only loosely aligned. A child that appears to start before
  // its parent or end after it must not steal time the parent never had.
  test('clips children to the parent interval under clock skew', () => {
    const parent = span('parent', 100, 200);
    const kids = [span('skewed', 50, 150, parent.span_id)];
    const { selfMs, childMs } = selfTimeMs(parent, kids);
    expect(childMs).toBe(50); // only [100,150] counts
    expect(selfMs).toBe(50);
  });

  test('self time never goes negative', () => {
    const parent = span('parent', 100, 200);
    const kids = [span('longer', 0, 5000, parent.span_id)];
    expect(selfTimeMs(parent, kids).selfMs).toBe(0);
  });

  test('a child entirely outside the parent subtracts nothing', () => {
    const parent = span('parent', 100, 200);
    const kids = [span('elsewhere', 900, 1000, parent.span_id)];
    expect(selfTimeMs(parent, kids).selfMs).toBe(100);
  });
});

describe('buildTraceAnalyses', () => {
  test('groups by trace, newest request first', () => {
    const a = { ...span('old', 0, 10), trace_id: 'old-trace' };
    const b = { ...span('new', 5000, 5010), trace_id: 'new-trace' };
    const traces = buildTraceAnalyses([a, b]);
    expect(traces.map((t) => t.traceId)).toEqual(['new-trace', 'old-trace']);
  });

  test('a span whose parent is absent is treated as a root', () => {
    const orphan = span('orphan', 0, 10, 'missing-parent');
    const [t] = buildTraceAnalyses([orphan]);
    expect(t.roots).toHaveLength(1);
    expect(t.roots[0].span.name).toBe('orphan');
  });

  test('only DIRECT children are subtracted (grandchildren are already nested)', () => {
    const root = span('root', 0, 1000, null, { span_id: 'r' });
    const mid = span('mid', 0, 800, 'r', { span_id: 'm' });
    const leaf = span('leaf', 0, 700, 'm', { span_id: 'l' });
    const [t] = buildTraceAnalyses([root, mid, leaf]);
    const byName = new Map(t.spans.map((s) => [s.span.name, s]));
    expect(byName.get('root')!.selfMs).toBe(200);
    expect(byName.get('mid')!.selfMs).toBe(100);
    expect(byName.get('leaf')!.selfMs).toBe(700);
  });

  test('picks up the task id attribute', () => {
    const s = span('lazy.start', 0, 10, null, { attributes: { 'lazy.task_id': 'abcd1234' } });
    expect(buildTraceAnalyses([s])[0].taskId).toBe('abcd1234');
  });

  test('total spans the whole request, roots included', () => {
    const root = span('root', 100, 900, null, { span_id: 'r' });
    const kid = span('kid', 200, 400, 'r');
    const [t] = buildTraceAnalyses([root, kid]);
    expect(t.totalMs).toBe(800);
  });
});

describe('rankings', () => {
  // The live trace that motivated this change: lazy.start 8.50s ->
  // remote.publish_branch 3.15s was flagged "slowest", but publish_branch was a
  // wrapper around the actual git push. The tree told the engineer nothing.
  function liveShapedTrace() {
    const root = span('lazy.start', 0, 8500, null, { span_id: 'root', service: 'cli' });
    const daemon = span('daemon.start', 100, 8400, 'root', { span_id: 'd' });
    const publish = span('remote.publish_branch', 200, 3350, 'd', { span_id: 'pub' });
    const push = span('git.push', 210, 3340, 'pub'); // 3.13s — the real cost
    const worktree = span('git.worktree.create', 3400, 4600, 'd'); // 1.2s
    const docker = span('docker.launch_supervisor', 4700, 8300, 'd'); // 3.6s
    return buildTraceAnalyses([root, daemon, publish, push, worktree, docker])[0];
  }

  test('leaf ranking surfaces the real operations, not the wrappers', () => {
    const t = liveShapedTrace();
    expect(slowestLeaves(t, 10).map((s) => s.span.name)).toEqual([
      'docker.launch_supervisor',
      'git.push',
      'git.worktree.create',
    ]);
  });

  test('a pass-through wrapper ranks last among branches', () => {
    const t = liveShapedTrace();
    const branches = slowestBranches(t, 10);
    const byName = new Map(branches.map((s) => [s.span.name, s]));
    // remote.publish_branch is 3.15s of duration but only 20ms of own work.
    expect(byName.get('remote.publish_branch')!.selfMs).toBe(20);
    expect(branches[branches.length - 1].span.name).toBe('remote.publish_branch');
    // daemon.start wins on self time: the gaps between its three children.
    expect(branches[0].span.name).toBe('daemon.start');
  });

  test('leaves and branches partition the full self-time ranking', () => {
    const t = liveShapedTrace();
    const all = slowestBySelfTime(t, 100).map((s) => s.span.span_id).sort();
    const split = [...slowestLeaves(t, 100), ...slowestBranches(t, 100)]
      .map((s) => s.span.span_id)
      .sort();
    expect(split).toEqual(all);
  });

  test('honors the top-n cap', () => {
    const t = liveShapedTrace();
    expect(slowestLeaves(t, 2)).toHaveLength(2);
    expect(slowestBranches(t, 1)).toHaveLength(1);
  });

  test('a trace with no nested spans yields an empty branch list', () => {
    const [t] = buildTraceAnalyses([span('solo', 0, 100)]);
    expect(slowestBranches(t, 10)).toEqual([]);
    expect(slowestLeaves(t, 10).map((s) => s.span.name)).toEqual(['solo']);
  });

  test('ranking is deterministic for equal self times', () => {
    const a = span('bbb', 0, 100);
    const b = span('aaa', 0, 100);
    const [t] = buildTraceAnalyses([a, b]);
    expect(slowestLeaves(t, 10).map((s) => s.span.name)).toEqual(['aaa', 'bbb']);
  });
});
