/**
 * Trace analysis: turn a flat list of persisted spans into per-request trees
 * ranked by SELF TIME.
 *
 * Why self time rather than duration: in a nested trace the ancestors always
 * win on duration because they *contain* their children. A tree rooted at
 * `lazy.start 8.50s` whose slowest span is `remote.publish_branch 3.15s` tells
 * you nothing you didn't already know — the wrapper hierarchy is noise. Self
 * time (a span's own work, with its children's time removed) collapses
 * pass-through wrappers to ~0 and leaves only spans that actually burned time
 * themselves.
 *
 * ## Self time and parallel children
 *
 * Self time is NOT `duration - sum(children)`. Children can run concurrently
 * (the daemon fans work out), and subtracting the sum would double-count the
 * overlap and drive self time negative. We subtract the **union of the child
 * intervals** instead: the wall-clock time during which *at least one* child
 * was running. Two 1s children running side by side inside a 1.2s parent
 * consume 1s of the parent's wall clock, not 2s, leaving 0.2s of self time.
 *
 * Two clamps guard against cross-process clock skew. Spans in one trace are
 * emitted by different processes (`cli`, `daemon`, …) whose clocks are only
 * loosely aligned, so a child can *appear* to start before its parent or end
 * after it:
 *   1. Child intervals are clipped to the parent's own interval before the
 *      union, so time attributed outside the parent cannot be subtracted.
 *   2. The result is clamped to >= 0, so skew can never produce a negative
 *      self time.
 * Both are lossy in the same direction — they can only *overstate* self time,
 * never invent a hotspot that isn't there.
 *
 * A branch's self time also absorbs the *gaps* between its children (setup,
 * teardown, un-instrumented work between two calls). That is deliberate: gap
 * time is real time the branch spent and nobody else claimed, and surfacing it
 * is exactly how you find missing instrumentation.
 */
import type { SpanRecord } from './types';

/** A span plus its computed self time and its position in the tree. */
export interface AnalyzedSpan {
  span: SpanRecord;
  /** Own work: duration minus the union of direct children, clamped to >= 0. */
  selfMs: number;
  /** Union of direct-child intervals, clipped to this span's interval. */
  childMs: number;
  /** True when the span has no children in this trace. */
  isLeaf: boolean;
}

/** One request: its spans, their tree links, and the derived self times. */
export interface TraceAnalysis {
  traceId: string;
  /** Spans with no parent present in this trace, oldest first. */
  roots: AnalyzedSpan[];
  /** Direct children by parent span id, oldest first. */
  childrenOf: Map<string, AnalyzedSpan[]>;
  /** Every span in the trace, oldest first. */
  spans: AnalyzedSpan[];
  /** Wall-clock span of the whole request. */
  start: number;
  end: number;
  totalMs: number;
  /** `lazy.task_id` attribute if any span carries one. */
  taskId?: string;
}

/**
 * Total length covered by a set of intervals, counting overlap once.
 * `[0,10] + [5,15]` is 15, not 20.
 */
export function unionLength(intervals: Array<[number, number]>): number {
  const valid = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = 0;
  let curEnd = -Infinity;
  for (const [s, e] of valid) {
    if (s > curEnd) {
      if (curEnd > -Infinity) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (curEnd > -Infinity) total += curEnd - curStart;
  return total;
}

/**
 * Self time of `span` given its DIRECT children. Grandchildren are already
 * inside their parent's interval, so including them would change nothing but
 * cost work.
 *
 * See the module doc for the clipping and clamping rules.
 */
export function selfTimeMs(span: SpanRecord, children: SpanRecord[]): { selfMs: number; childMs: number } {
  const clipped: Array<[number, number]> = [];
  for (const c of children) {
    const s = Math.max(c.start_ms, span.start_ms);
    const e = Math.min(c.end_ms, span.end_ms);
    if (e > s) clipped.push([s, e]);
  }
  const childMs = unionLength(clipped);
  return { selfMs: Math.max(0, span.duration_ms - childMs), childMs };
}

/** Group spans into per-request trees, newest request first. */
export function buildTraceAnalyses(spans: SpanRecord[]): TraceAnalysis[] {
  const byTrace = new Map<string, SpanRecord[]>();
  for (const s of spans) {
    let g = byTrace.get(s.trace_id);
    if (!g) {
      g = [];
      byTrace.set(s.trace_id, g);
    }
    g.push(s);
  }

  const traces: TraceAnalysis[] = [];
  for (const [traceId, group] of byTrace) {
    const present = new Set(group.map((s) => s.span_id));
    const rawChildren = new Map<string, SpanRecord[]>();
    const rawRoots: SpanRecord[] = [];
    for (const s of group) {
      // A span is a root if it has no parent, or its parent isn't in this file
      // (e.g. the parent process didn't persist its span).
      if (!s.parent_span_id || !present.has(s.parent_span_id)) {
        rawRoots.push(s);
      } else {
        let list = rawChildren.get(s.parent_span_id);
        if (!list) {
          list = [];
          rawChildren.set(s.parent_span_id, list);
        }
        list.push(s);
      }
    }

    const byId = new Map<string, AnalyzedSpan>();
    for (const s of group) {
      const kids = rawChildren.get(s.span_id) ?? [];
      const { selfMs, childMs } = selfTimeMs(s, kids);
      byId.set(s.span_id, { span: s, selfMs, childMs, isLeaf: kids.length === 0 });
    }

    const childrenOf = new Map<string, AnalyzedSpan[]>();
    for (const [parentId, kids] of rawChildren) {
      childrenOf.set(
        parentId,
        kids
          .slice()
          .sort((a, b) => a.start_ms - b.start_ms)
          .map((k) => byId.get(k.span_id)!),
      );
    }

    const analyzed = [...byId.values()].sort((a, b) => a.span.start_ms - b.span.start_ms);
    const start = Math.min(...group.map((s) => s.start_ms));
    const end = Math.max(...group.map((s) => s.end_ms));
    traces.push({
      traceId,
      roots: rawRoots.sort((a, b) => a.start_ms - b.start_ms).map((r) => byId.get(r.span_id)!),
      childrenOf,
      spans: analyzed,
      start,
      end,
      totalMs: end - start,
      taskId: group.find((s) => s.attributes['lazy.task_id']) &&
        String(group.find((s) => s.attributes['lazy.task_id'])!.attributes['lazy.task_id']),
    });
  }

  // Newest request first — a tail view is what you want after a slow command.
  traces.sort((a, b) => b.start - a.start);
  return traces;
}

/**
 * Deterministic ranking: self time desc, then total duration desc, then name.
 * The tie-breaks matter — without them equal-duration spans reorder between
 * runs and the output is untestable.
 */
function bySelfTime(a: AnalyzedSpan, b: AnalyzedSpan): number {
  return (
    b.selfMs - a.selfMs ||
    b.span.duration_ms - a.span.duration_ms ||
    a.span.name.localeCompare(b.span.name)
  );
}

/**
 * Slowest LEAF spans. A leaf has no children, so its self time is its whole
 * duration — this is "which single operation took the longest", the fact the
 * tree buries.
 */
export function slowestLeaves(t: TraceAnalysis, n: number): AnalyzedSpan[] {
  return t.spans.filter((s) => s.isLeaf).sort(bySelfTime).slice(0, n);
}

/**
 * Slowest BRANCH spans by self time — spans that have children but still burned
 * time of their own (gaps between children, un-instrumented setup/teardown).
 * A wrapper that merely awaits one slow child has ~0 self time and drops out,
 * which is the whole point.
 */
export function slowestBranches(t: TraceAnalysis, n: number): AnalyzedSpan[] {
  return t.spans.filter((s) => !s.isLeaf).sort(bySelfTime).slice(0, n);
}

/**
 * Every span ranked by self time, leaves and branches together. The two lists
 * above are exactly this list partitioned by `isLeaf`, so nothing is lost by
 * splitting them — but the split is what makes the branch list readable in a
 * leaf-dominated trace.
 */
export function slowestBySelfTime(t: TraceAnalysis, n: number): AnalyzedSpan[] {
  return t.spans.slice().sort(bySelfTime).slice(0, n);
}
