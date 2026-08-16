/**
 * `lazy stats timings` — readout of persisted request traces, ranked by SELF
 * TIME.
 *
 * The headline for each request is two ranked lists rather than the nested
 * tree. The tree was uninformative in practice: everything is under
 * `lazy.start` and the "slowest span" is always whichever ancestor contains
 * the slow work. Ranking by self time (see `src/tracing/analysis.ts`) surfaces
 * the operations that actually burned time and suppresses pass-through
 * wrappers. The tree is still available behind `--tree`.
 */
import { requireStorage, parseFlags } from '../helpers';
import { theme, dim } from '../theme';
import {
  buildTraceAnalyses,
  slowestLeaves,
  slowestBranches,
  type AnalyzedSpan,
  type TraceAnalysis,
} from '../../tracing/analysis';
import { parseSince, parsePositiveInt } from './stats-flags';

function fmtDur(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function pct(part: number, whole: number): string {
  return `${whole > 0 ? Math.round((part / whole) * 100) : 0}%`;
}

function statusMark(s: AnalyzedSpan): string {
  if (s.span.status === 'error') return theme.error(' ✗');
  if (s.span.status === 'unset') return dim(' ?');
  return '';
}

/**
 * One ranked row. `value` is the number being ranked on (whole duration for a
 * leaf, self time for a branch) and is shown as a share of the whole request,
 * so leaf and branch rows are directly comparable.
 */
function printRankedRow(s: AnalyzedSpan, value: number, totalMs: number, extra: string): void {
  const dur = `${fmtDur(value).padStart(8)} ${dim(pct(value, totalMs).padStart(4))}`;
  console.log(`    ${dur}  ${s.span.name} ${dim(`[${s.span.service}]`)}${statusMark(s)}${extra}`);
}

function renderRankings(t: TraceAnalysis, top: number): void {
  const leaves = slowestLeaves(t, top);
  const branches = slowestBranches(t, top);

  console.log(`  ${theme.label('slowest operations')} ${dim('(leaf spans — no children, so this is all own work)')}`);
  if (leaves.length === 0) {
    console.log(dim('    (none)'));
  } else {
    for (const s of leaves) printRankedRow(s, s.span.duration_ms, t.totalMs, '');
  }

  console.log(
    `  ${theme.label('slowest own work in nested spans')} ${dim('(self time — children excluded)')}`,
  );
  if (branches.length === 0) {
    console.log(dim('    (none — this request has no nested spans)'));
  } else {
    for (const s of branches) {
      // Show what the span cost in total next to its own share, so a wrapper
      // near the top of this list is obviously a wrapper.
      const inKids = dim(` of ${fmtDur(s.span.duration_ms)} total, ${pct(s.childMs, s.span.duration_ms)} in children`);
      printRankedRow(s, s.selfMs, t.totalMs, inKids);
    }
  }
}

function renderTree(t: TraceAnalysis): void {
  console.log(`  ${theme.label('tree')}`);
  const printSpan = (s: AnalyzedSpan, depth: number): void => {
    const indent = '  '.repeat(depth + 2);
    const dur = `${fmtDur(s.span.duration_ms).padStart(8)} ${dim(pct(s.span.duration_ms, t.totalMs).padStart(4))}`;
    const self = s.isLeaf ? '' : dim(`  self ${fmtDur(s.selfMs)}`);
    console.log(`${indent}${dur}  ${s.span.name} ${dim(`[${s.span.service}]`)}${statusMark(s)}${self}`);
    for (const child of t.childrenOf.get(s.span.span_id) ?? []) printSpan(child, depth + 1);
  };
  for (const root of t.roots) printSpan(root, 0);
}

function renderTrace(t: TraceAnalysis, top: number, tree: boolean): void {
  console.log(
    theme.label(`\nTrace ${t.traceId.slice(0, 12)}`) +
      (t.taskId ? `  ${dim(`task ${t.taskId.slice(0, 8)}`)}` : '') +
      `  ${dim('total')} ${fmtDur(t.totalMs)}  ${dim(`${t.spans.length} span(s)`)}`,
  );
  renderRankings(t, top);
  if (tree) renderTree(t);
}

export async function commandTimings(args: string[]): Promise<void> {
  const parsed = parseFlags(
    args,
    [
      { name: 'since', takesValue: true },
      { name: 'limit', takesValue: true },
      { name: 'top', takesValue: true },
      { name: 'tree', takesValue: false },
    ],
    'stats timings',
  );

  const sinceMs = parseSince(parsed.flags.get('since') as string | undefined);
  const limit = parsePositiveInt(parsed.flags.get('limit') as string | undefined, 'limit', 20);
  const top = parsePositiveInt(parsed.flags.get('top') as string | undefined, 'top', 10);
  const tree = parsed.flags.get('tree') === true;

  const storage = await requireStorage();
  try {
    const spans = await storage.readTraceSpans(sinceMs);
    if (spans.length === 0) {
      console.log('No requests traced yet — run any lazy command and retry.');
      return;
    }

    const traces = buildTraceAnalyses(spans).slice(0, limit);
    console.log(theme.label(`${traces.length} trace(s), ${spans.length} span(s)`));
    for (const t of traces) renderTrace(t, top, tree);
    console.log('');
  } finally {
    await storage.close();
  }
}

export function timingsUsage(): void {
  console.log(`Usage: lazy stats timings [--since <duration>] [--limit <n>] [--top <n>] [--tree]

Show recorded request traces ranked by SELF TIME — the time a span spent on its
own work, with its children's time removed. For each request you get:

  slowest operations                 leaf spans (no children), by duration
  slowest own work in nested spans   spans with children, by self time

Ranking this way suppresses wrappers: a span that merely awaits one slow child
has almost no self time and drops out, so what's left is where time really
went. Children that run concurrently are counted once (the union of their
intervals), never twice.

Request tracing is always on; there is nothing to enable. Traces are recorded
automatically as you use lazy, and the store is pruned to a bounded size.

Options:
  --since <duration>   Only traces started within this window (e.g. 30m, 2h, 1d)
  --limit <n>          Max traces to show, newest first (default 20)
  --top <n>            Max entries per ranked list (default 10)
  --tree               Also print the full nested span tree per trace

Examples:
  lazy stats timings                   # newest 20 traces, ranked by self time
  lazy stats timings --since 1h        # traces from the last hour
  lazy stats timings --top 5           # shorter lists
  lazy stats timings --limit 1 --tree  # newest request, rankings plus the tree`);
}
