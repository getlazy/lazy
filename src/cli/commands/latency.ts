/**
 * `lazy stats latency` — how fast the models answer.
 *
 * By default from the per-turn rollups kept in the store (src/task/turn-latency.ts),
 * per endpoint × model × tier, p5/p50/p95, any period. `--recent` reads the
 * proxy audit trail instead: per model, endpoint, endpoint × model and tier, p50/p90 of time to first byte (response headers), time to first token
 * (TTFT), time to last token (TTLT) and output tokens per second over the whole request.
 * All times run from the moment the proxy received the request.
 */
import { parseFlags } from '../helpers';
import { theme, dim } from '../../render/theme';
import { formatErrors, type EndpointModelSummary, type LatencyGroup, type LatencyReport, type Percentiles } from '../../proxy/latency';
import { formatErrorBreakdown, formatPercentiles, latencyRowLabel, type LatencyHistoryReport, type LatencyHistoryRow } from '../../task/turn-latency';
import { queryTokenStats } from '../../daemon/rpc-fallback';
import { parseSince, parsePositiveInt } from './stats-flags';

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function cell(p: Percentiles | null, fmt: (n: number) => string): string {
  return p ? `${fmt(p.p50)} / ${fmt(p.p90)} (n=${p.n})` : '-';
}

const COLUMNS: Array<{ header: string; get: (g: LatencyGroup) => string }> = [
  { header: 'REQS', get: (g) => String(g.requests) },
  { header: 'ERRORS', get: (g) => ('errors' in g ? formatErrors((g as EndpointModelSummary).errors) : '-') },
  { header: 'TTFB p50/p90', get: (g) => cell(g.ttfb, fmtMs) },
  { header: 'TTFT p50/p90', get: (g) => cell(g.ttft, fmtMs) },
  { header: 'TTLT p50/p90', get: (g) => cell(g.ttlt, fmtMs) },
  { header: 'TOK/S p50/p90', get: (g) => cell(g.tokensPerSecond, (n) => n.toFixed(1)) },
];

function renderBreakdown(title: string, groups: LatencyGroup[], top: number): void {
  console.log(`\n${theme.label(title)}`);
  if (groups.length === 0) {
    console.log(dim('  (none)'));
    return;
  }
  const shown = groups.slice(0, top);
  const keyWidth = Math.max(3, ...shown.map((g) => g.key.length));
  const widths = COLUMNS.map((c) => Math.max(c.header.length, ...shown.map((g) => c.get(g).length)));
  console.log(
    dim('  ' + 'KEY'.padEnd(keyWidth) + COLUMNS.map((c, i) => '  ' + c.header.padStart(widths[i])).join('')),
  );
  for (const g of shown) {
    console.log('  ' + g.key.padEnd(keyWidth) + COLUMNS.map((c, i) => '  ' + c.get(g).padStart(widths[i])).join(''));
  }
  if (groups.length > shown.length) {
    console.log(dim(`  … ${groups.length - shown.length} more (raise --top to see them)`));
  }
}

function renderHistory(history: LatencyHistoryReport, top: number): void {
  if (history.turns === 0) {
    console.log('No latency rollups recorded in that period — run a task and retry.');
    return;
  }
  const cols: Array<{ header: string; get: (r: LatencyHistoryRow) => string }> = [
    { header: 'REQS', get: (r) => String(r.requests) },
    { header: 'ERRORS', get: (r) => formatErrorBreakdown(r.errors) },
    { header: 'TTFB p5/p50/p95', get: (r) => formatPercentiles(r.ttfb, 'ms') },
    { header: 'TTFT p5/p50/p95', get: (r) => formatPercentiles(r.ttft, 'ms') },
    { header: 'TTLT p5/p50/p95', get: (r) => formatPercentiles(r.ttlt, 'ms') },
    { header: 'TOK/S p5/p50/p95', get: (r) => formatPercentiles(r.tps, 'tps') },
    { header: 'OUT TOK', get: (r) => String(r.tokens.output) },
  ];
  const shown = history.rows.slice(0, top);
  const keyWidth = Math.max(18, ...shown.map((r) => latencyRowLabel(r).length));
  const widths = cols.map((c) => Math.max(c.header.length, ...shown.map((r) => c.get(r).length)));
  console.log(theme.label(`By endpoint × model — ${history.turns} turn(s)`));
  console.log(dim('  ' + 'ENDPOINT · MODEL'.padEnd(keyWidth) + cols.map((c, i) => '  ' + c.header.padStart(widths[i])).join('')));
  for (const r of shown) {
    console.log('  ' + latencyRowLabel(r).padEnd(keyWidth) + cols.map((c, i) => '  ' + c.get(r).padStart(widths[i])).join(''));
  }
  if (history.rows.length > shown.length) {
    console.log(dim(`  … ${history.rows.length - shown.length} more (raise --top to see them)`));
  }
  if (history.model_wait_share !== null) {
    console.log(`\nWaiting on the model: ${Math.round(history.model_wait_share * 100)}% of agent turn time (the rest is tools and the agent).`);
  }
  console.log(
    dim(
      '\nFrom the per-turn rollups kept in the store, so any period works. Times run from request start;\n' +
        'percentiles are within about ±16%. TOK/S is output tokens over the whole request.\n' +
        '(n=…) is the number of requests behind a cell; REQS includes errors, so TTFT and TTLT can have fewer.\n' +
        'For recent per-request detail from the audit trail: lazy stats latency --recent, lazy stats audit.',
    ),
  );
}

export async function commandLatency(args: string[]): Promise<void> {
  const parsed = parseFlags(
    args,
    [
      { name: 'since', takesValue: true },
      { name: 'limit', takesValue: true },
      { name: 'top', takesValue: true },
      { name: 'role', takesValue: true },
      { name: 'task', takesValue: true },
      { name: 'subtree', takesValue: false },
      { name: 'recent', takesValue: false },
      { name: 'json', takesValue: false },
    ],
    'stats latency',
  );
  const sinceMs = parseSince(parsed.flags.get('since') as string | undefined);
  const limit = parsePositiveInt(parsed.flags.get('limit') as string | undefined, 'limit', 50000);
  const top = parsePositiveInt(parsed.flags.get('top') as string | undefined, 'top', 10);
  const role = parsed.flags.get('role') as string | undefined;
  const taskId = parsed.flags.get('task') as string | undefined;
  const subtree = parsed.flags.get('subtree') === true;
  const json = parsed.flags.get('json') === true;
  if (subtree && !taskId) {
    console.error('--subtree needs a task to descend from. Pass --task <id>.');
    process.exit(1);
  }

  if (parsed.flags.get('recent') !== true) {
    if (role !== undefined || parsed.flags.get('limit') !== undefined) {
      console.error('--role and --limit apply to the audit trail; pass --recent with them.');
      process.exit(1);
    }
    const result = await queryTokenStats({ mode: 'latency-history', sinceMs, task: taskId, subtree });
    const history = result.history as LatencyHistoryReport;
    if (json) {
      console.log(JSON.stringify(history, null, 2));
      return;
    }
    renderHistory(history, top);
    return;
  }

  const result = await queryTokenStats({ mode: 'latency-cli', sinceMs, limit, role, task: taskId, subtree });
  const report = result.latency as LatencyReport;
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (report.byModel.length === 0) {
    console.log('No timed requests recorded yet — run a task and retry.');
    return;
  }
  renderBreakdown('By model', report.byModel, top);
  renderBreakdown('By endpoint × model', report.byEndpointModel ?? [], top);
  renderBreakdown('By endpoint', report.byEndpoint, top);
  renderBreakdown('By tier', report.byTier, top);
  console.log(
    dim(
      '\nTTFB = response headers, TTFT = first content token, TTLT = last token; all from request start,\n' +
        'so they include connection setup. TOK/S is output tokens over the whole request.\n' +
        '(n=…) is the number of requests behind a cell; TTFT and TTLT can have fewer than TTFB.\n' +
        'Requests recorded before latency tracking show "-". Only the endpoint × model table counts failed\n' +
        'requests (REQS includes them; ERRORS breaks them down); other tables count successful ones.',
    ),
  );
}

export function latencyUsage(): void {
  console.log(`Usage: lazy stats latency [--since <duration>] [--top <n>] [--task <id>] [--subtree] [--json]
       lazy stats latency --recent [--since <duration>] [--limit <n>] [--top <n>] [--role <role>] [--task <id>] [--subtree] [--json]

How fast the models answered, per endpoint × model (× tier).

By default this reads the per-turn latency rollups lazy keeps in the store, so
--since can reach back as far as you like. Each row has requests, errors
(429 / 4xx / 5xx / network / cancelled) and p5 / p50 / p95 of:

  TTFB    request start → upstream response headers
  TTFT    request start → first content token (a non-streamed reply: its end)
  TTLT    request start → last token (the stream's end)
  TOK/S   output tokens ÷ TTLT, over the whole request

plus the share of agent turn time spent waiting on the model. Percentiles come
from merged histograms and are within about ±16%.

--recent reads the proxy audit trail instead: p50 / p90 by model, endpoint,
endpoint × model (with an errors column) and tier,
but only as far back as the trail is kept ([proxy] audit_retention_days).
For individual requests see \`lazy stats audit\`.

Options:
  --since <duration>   Only turns (or, with --recent, records) within this window (e.g. 30m, 2h, 30d)
  --top <n>            Max rows per table (default 10)
  --task <id>          Only this task (short-id prefix match)
  --subtree            With --task, also every descendant
  --recent             Read the audit trail (recent, per request) instead of the store
  --limit <n>          With --recent: max audit records to scan, newest first (default 50000)
  --role <role>        With --recent: only this role (e.g. agent, builder)
  --json               Emit the full rollup as JSON (ignores --top)

Examples:
  lazy stats latency --since 30d
  lazy stats latency --task release-v091 --subtree
  lazy stats latency --recent --since 24h`);
}
