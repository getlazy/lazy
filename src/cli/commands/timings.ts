/**
 * `lazy timings` — rudimentary readout of persisted request traces.
 *
 * Reads the span JSONL through Storage and renders each trace as an indented
 * tree with per-span durations, flagging the slowest span. This is the "prove
 * the data answers what was slow" half of the timings spike — deliberately
 * simple; a richer report (percentiles, per-operation rollups) is future work.
 */
import { requireStorage, parseFlags } from '../helpers';
import { theme, dim } from '../theme';
import type { SpanRecord } from '../../tracing/types';

function parseSince(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = value.match(/^(\d+)([smhd])$/);
  if (!m) {
    console.error(`Invalid --since '${value}'. Use forms like 30m, 2h, 1d.`);
    process.exit(1);
  }
  const n = parseInt(m[1], 10);
  const unit = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2]]!;
  return Date.now() - n * unit;
}

function fmtDur(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

interface TraceTree {
  traceId: string;
  roots: SpanRecord[];
  childrenOf: Map<string, SpanRecord[]>;
  byId: Map<string, SpanRecord>;
  start: number;
  end: number;
}

function buildTraces(spans: SpanRecord[]): TraceTree[] {
  const byTrace = new Map<string, SpanRecord[]>();
  for (const s of spans) {
    if (!byTrace.has(s.trace_id)) byTrace.set(s.trace_id, []);
    byTrace.get(s.trace_id)!.push(s);
  }

  const traces: TraceTree[] = [];
  for (const [traceId, group] of byTrace) {
    const byId = new Map(group.map((s) => [s.span_id, s]));
    const childrenOf = new Map<string, SpanRecord[]>();
    const roots: SpanRecord[] = [];
    for (const s of group) {
      // A span is a root if it has no parent, or its parent isn't in this file
      // (e.g. the parent process didn't persist its span).
      if (!s.parent_span_id || !byId.has(s.parent_span_id)) {
        roots.push(s);
      } else {
        if (!childrenOf.has(s.parent_span_id)) childrenOf.set(s.parent_span_id, []);
        childrenOf.get(s.parent_span_id)!.push(s);
      }
    }
    for (const list of childrenOf.values()) list.sort((a, b) => a.start_ms - b.start_ms);
    roots.sort((a, b) => a.start_ms - b.start_ms);
    traces.push({
      traceId,
      roots,
      childrenOf,
      byId,
      start: Math.min(...group.map((s) => s.start_ms)),
      end: Math.max(...group.map((s) => s.end_ms)),
    });
  }
  // Newest trace last isn't useful for a tail view — show newest first.
  traces.sort((a, b) => b.start - a.start);
  return traces;
}

function renderTrace(t: TraceTree): void {
  const total = t.end - t.start;
  // The slowest LEAF span — the headline "what was slow" answer. Ancestor spans
  // (roots, the daemon wrapper) trivially dominate by duration because they
  // contain their children, so they'd always win; the actual time is spent in
  // the leaves (a git call, a docker launch), which is what we want to surface.
  const all = [...t.byId.values()];
  const leaves = all.filter((s) => !(t.childrenOf.get(s.span_id)?.length));
  const slowest = (leaves.length ? leaves : all).reduce((a, b) => (b.duration_ms > a.duration_ms ? b : a));

  const label = all.find((s) => s.attributes['lazy.task_id'])?.attributes['lazy.task_id'];
  console.log(
    theme.label(`\nTrace ${t.traceId.slice(0, 12)}`) +
      (label ? `  ${dim(`task ${String(label).slice(0, 8)}`)}` : '') +
      `  ${dim('total')} ${fmtDur(total)}`,
  );

  const printSpan = (s: SpanRecord, depth: number): void => {
    const indent = '  '.repeat(depth + 1);
    const pct = total > 0 ? Math.round((s.duration_ms / total) * 100) : 0;
    const statusMark =
      s.status === 'error' ? theme.error(' ✗') : s.status === 'ok' ? '' : dim(' ?');
    const marker = s.span_id === slowest.span_id ? theme.warning('  ← slowest') : '';
    const dur = `${fmtDur(s.duration_ms).padStart(7)} ${dim(`${pct}%`.padStart(4))}`;
    const svc = dim(`[${s.service}]`);
    console.log(`${indent}${dur}  ${s.name} ${svc}${statusMark}${marker}`);
    for (const child of t.childrenOf.get(s.span_id) ?? []) printSpan(child, depth + 1);
  };
  for (const root of t.roots) printSpan(root, 0);

  console.log(
    `  ${dim('▸ slowest:')} ${slowest.name} ${fmtDur(slowest.duration_ms)}` +
      (total > 0 ? ` (${Math.round((slowest.duration_ms / total) * 100)}% of request)` : ''),
  );
}

export async function commandTimings(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'since', takesValue: true },
    { name: 'limit', takesValue: true },
  ], 'timings');

  const sinceMs = parseSince(parsed.flags.get('since') as string | undefined);
  const limit = parsed.flags.get('limit') ? parseInt(parsed.flags.get('limit') as string, 10) : 20;

  const storage = await requireStorage();
  try {
    const spans = await storage.readTraceSpans(sinceMs);
    if (spans.length === 0) {
      console.log('No requests traced yet — run any lazy command and retry.');
      return;
    }

    const traces = buildTraces(spans).slice(0, limit);
    console.log(theme.label(`${traces.length} trace(s), ${spans.length} span(s)`));
    for (const t of traces) renderTrace(t);
    console.log('');
  } finally {
    await storage.close();
  }
}

export function timingsUsage(): void {
  console.log(`Usage: lazy timings [--since <duration>] [--limit <n>]

Show recorded request traces as a per-request tree with durations, flagging the
slowest span — use it to see where a slow command actually spent its time.

Request tracing is always on; there is nothing to enable. Traces are recorded
automatically as you use lazy, and the store is pruned to a bounded size.

Options:
  --since <duration>   Only traces started within this window (e.g. 30m, 2h, 1d)
  --limit <n>          Max traces to show, newest first (default 20)

Examples:
  lazy timings                 # newest 20 traces
  lazy timings --since 1h      # traces from the last hour
  lazy timings --limit 5`);
}
