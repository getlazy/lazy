/**
 * `lazy stats tokens` — token accounting from the proxy audit trail.
 *
 * The proxy records one audit record per forwarded request, attributed by the
 * `x-lazy-role` / `x-lazy-task-id` headers lazy injects, with the token usage
 * parsed out of the response. This command is the reader for that trail: overall
 * totals plus per-role, per-task and per-model breakdowns.
 *
 * Scope, stated in the readout rather than buried here: every launch lazy makes
 * is proxied, whatever its role's backend — so this trail covers all of them.
 * What it cannot cover is a process lazy did not launch.
 */
import { join } from 'path';
import { requireLazyRoot, parseFlags } from '../helpers';
import { loadConfig } from '../../config/loader';
import { readAuditRecords } from '../../proxy/audit-log';
import { theme, dim } from '../theme';
import { aggregateUsage, type TokenGroup, type TokenReport } from '../../proxy/aggregate';
import { parseSince, parsePositiveInt } from './stats-flags';

function num(n: number): string {
  return n.toLocaleString('en-US');
}

const COLUMNS: Array<{ header: string; get: (g: TokenGroup) => number }> = [
  { header: 'REQS', get: (g) => g.requests },
  { header: 'TOTAL', get: (g) => g.totalTokens },
  { header: 'INPUT', get: (g) => g.inputTokens },
  { header: 'OUTPUT', get: (g) => g.outputTokens },
  { header: 'CACHE WRITE', get: (g) => g.cacheCreationInputTokens },
  { header: 'CACHE READ', get: (g) => g.cacheReadInputTokens },
];

function renderBreakdown(title: string, groups: TokenGroup[], top: number): void {
  console.log(`\n${theme.label(title)}`);
  if (groups.length === 0) {
    console.log(dim('  (none)'));
    return;
  }
  const shown = groups.slice(0, top);
  const keyWidth = Math.max(3, ...shown.map((g) => g.key.length));
  const widths = COLUMNS.map((c, i) =>
    Math.max(c.header.length, ...shown.map((g) => num(COLUMNS[i].get(g)).length)),
  );

  const header =
    '  ' +
    'KEY'.padEnd(keyWidth) +
    COLUMNS.map((c, i) => '  ' + c.header.padStart(widths[i])).join('');
  console.log(dim(header));

  for (const g of shown) {
    console.log(
      '  ' +
        g.key.padEnd(keyWidth) +
        COLUMNS.map((c, i) => '  ' + num(c.get(g)).padStart(widths[i])).join(''),
    );
  }
  if (groups.length > shown.length) {
    console.log(dim(`  … ${groups.length - shown.length} more (raise --top to see them)`));
  }
}

function renderReport(report: TokenReport, top: number): void {
  const t = report.totals;
  const window =
    report.firstTs !== null && report.lastTs !== null
      ? dim(
          ` (${new Date(report.firstTs).toLocaleString()} → ${new Date(report.lastTs).toLocaleString()})`,
        )
      : '';
  console.log(
    theme.label(`${num(t.requests)} proxied request(s)`) +
      dim(`, ${num(t.withUsage)} with usage`) +
      window,
  );
  console.log(
    `  ${theme.label('total')} ${num(t.totalTokens)}  ` +
      dim(
        `input ${num(t.inputTokens)} · output ${num(t.outputTokens)} · ` +
          `cache write ${num(t.cacheCreationInputTokens)} · cache read ${num(t.cacheReadInputTokens)}`,
      ),
  );

  renderBreakdown('By role', report.byRole, top);
  renderBreakdown('By task', report.byTask, top);
  renderBreakdown('By model', report.byModel, top);
  console.log(
    dim('\nOnly traffic through the lazy proxy is audited — agents on the anthropic/ollama backends are not counted.'),
  );
}

export async function commandTokens(args: string[]): Promise<void> {
  const parsed = parseFlags(
    args,
    [
      { name: 'since', takesValue: true },
      { name: 'limit', takesValue: true },
      { name: 'top', takesValue: true },
      { name: 'role', takesValue: true },
      { name: 'task', takesValue: true },
      { name: 'json', takesValue: false },
    ],
    'stats tokens',
  );

  const sinceMs = parseSince(parsed.flags.get('since') as string | undefined);
  const limit = parsePositiveInt(parsed.flags.get('limit') as string | undefined, 'limit', 50000);
  const top = parsePositiveInt(parsed.flags.get('top') as string | undefined, 'top', 10);
  const role = parsed.flags.get('role') as string | undefined;
  const taskId = parsed.flags.get('task') as string | undefined;
  const json = parsed.flags.get('json') === true;

  const root = requireLazyRoot();
  const config = await loadConfig(root);
  const records = await readAuditRecords(join(root, config.data.path), { limit });
  const report = aggregateUsage(records, { sinceMs, role, taskId });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (report.totals.requests === 0) {
    console.log(
      'No proxied requests recorded yet — run a task and retry.',
    );
    return;
  }

  renderReport(report, top);
  console.log('');
}

export function tokensUsage(): void {
  console.log(`Usage: lazy stats tokens [--since <duration>] [--limit <n>] [--top <n>] [--role <role>] [--task <id>] [--json]

Token accounting from the proxy audit trail. The lazy proxy records one audit
record per forwarded request — attributed to a role (builder/agent) and a task
by headers lazy injects — with the token usage parsed out of the response. This
command rolls those records up:

  total          requests, and input / output / cache-write / cache-read tokens
  By role        which role burned the tokens (builder vs agent)
  By task        which task burned them
  By model       which wire model served them

Every launch lazy makes routes through the proxy, whatever the role's backend, so
all of it is audited here; a process lazy did not launch is not. Requests that
failed before a response carry no usage and are counted in "requests" but not in
"with usage".

Options:
  --since <duration>   Only records within this window (e.g. 30m, 2h, 1d)
  --limit <n>          Max audit records to scan, newest first (default 50000)
  --top <n>            Max rows per breakdown (default 10)
  --role <role>        Only count this role (e.g. agent, builder)
  --task <id>          Only count this task (short-id prefix match)
  --json               Emit the full rollup as JSON (ignores --top)

Examples:
  lazy stats tokens                        # everything recorded, ranked breakdowns
  lazy stats tokens --since 24h            # the last day
  lazy stats tokens --role agent --top 20  # agent traffic, 20 rows per breakdown
  lazy stats tokens --task add-proxy       # one task's spend
  lazy stats tokens --json                 # machine-readable rollup`);
}
