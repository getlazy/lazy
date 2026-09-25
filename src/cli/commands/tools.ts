/**
 * `lazy stats tools <task>` — which tool filled a task's context, on the CLI.
 *
 * WHY A SIBLING RATHER THAN A TABLE UNDER `stats tokens`.
 *
 * `stats tokens` is a rollup over the WHOLE trail whose filters (`--role`,
 * `--task`, `--since`) are all optional narrowings of one global readout. The
 * per-tool breakdown is not that shape: it only exists per task, because the
 * dedup that makes it honest is keyed on `tool_use` ids within one
 * conversation, and a task is required rather than optional. Hanging a
 * mandatory-argument table off an all-optional command would make `--task` mean
 * two different things depending on whether another flag was passed. So it is
 * its own subcommand, named for what it answers, next to the two readers over
 * the same trail.
 *
 * The arithmetic is NOT re-implemented here: `toolStatsFromRecord`
 * (src/task/stats.ts) is the derivation, already rendered by the web Stats tab,
 * and this is a second renderer over it. The honesty rules it encodes are
 * carried into the terminal copy verbatim — "not recorded" instead of zero,
 * unattributed instead of a guessed tool name, and context added rather than a
 * share of the model bill.
 *
 * Default numbers come from the task's DURABLE record, which the proxy folds
 * each forwarded request into and which never expires. `--since` / `--limit`
 * ask a different question — what did this task's tools cost in that stretch of
 * time — and only the bounded audit trail can answer it, so those flags switch
 * to `buildToolStats` over the log and the report says it is a window.
 *
 * `--subtree` is orthogonal to that choice and means one thing under both: walk
 * the descendants through `collectDescendantTasks` — the same walk the web tab
 * and the RPC use — and `mergeToolStats` what each of them contributes.
 */
import { join } from 'path';
import { requireLazyRoot, requireStorage, resolveTaskOrExit, parseFlags } from '../helpers';
import { loadConfig } from '../../config/loader';
import { readAuditRecords } from '../../proxy/audit-log';
import { theme, dim } from '../../render/theme';
import {
  buildToolStats,
  toolStatsFromRecord,
  mergeToolStats,
  partitionAuditRecordsByTask,
  type TaskToolStats,
  type ToolRow,
} from '../../task/stats';
import { collectDescendantTasks, loadToolStatsRecords } from '../../task/stats-data';
import { displayId } from '../../task/identity';
import { writeStdout } from '../../utils/stdio';
import { parseSince, parsePositiveInt } from './stats-flags';

/** Scan cap: how many records are read from the trail before filtering. */
const DEFAULT_SCAN = 50_000;

/** How many tool rows the table shows by default. */
const DEFAULT_TOP = 20;

function num(n: number): string {
  return n.toLocaleString('en-US');
}

function when(ts: number | null): string {
  return ts === null ? 'unknown' : new Date(ts).toLocaleString();
}

function share(part: number, whole: number): string {
  if (whole <= 0) return '-';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/**
 * Wrap one paragraph of prose to the terminal, indented two spaces like every
 * other body line here.
 *
 * Hand-broken strings were the alternative and they are wrong twice: they
 * overflow a narrow terminal anyway, and they leave a ragged short line on a
 * wide one. Wrapping happens BEFORE `dim()`, so each emitted line carries its
 * own complete escape pair and a pipe or a `grep` never sees a dangling one.
 * The width is clamped so the caveats stay readable in a 60-column window and
 * do not sprawl across a maximized one.
 */
function prose(text: string): string[] {
  const width = Math.max(60, Math.min(100, process.stdout.columns || 100)) - 2;
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(dim('  ' + line));
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(dim('  ' + line));
  return out;
}

interface Column {
  header: string;
  get: (row: ToolRow, stats: TaskToolStats) => string;
  right?: boolean;
}

/**
 * A row with nothing measured prints "not recorded" in the token columns rather
 * than a 0, which a reader would take for "this tool's output was free".
 */
const COLUMNS: Column[] = [
  { header: 'TOOL', get: (r) => r.name },
  { header: 'CALLS', get: (r) => num(r.invocations), right: true },
  {
    header: 'TOKENS',
    get: (r) => (r.resultsMeasured > 0 ? num(r.resultTokens) : 'not recorded'),
    right: true,
  },
  {
    header: 'SHARE',
    get: (r, s) => (r.resultsMeasured > 0 ? share(r.resultTokens, s.resultTokens) : '-'),
    right: true,
  },
  {
    // Per-call average is what actually ranks tools against each other — one
    // 200K result and 200 one-token results are not the same problem — and it
    // is only honest over the calls that were measured.
    header: 'PER CALL',
    get: (r) => (r.resultsMeasured > 0 ? num(Math.round(r.resultTokens / r.resultsMeasured)) : '-'),
    right: true,
  },
  { header: 'ERRORS', get: (r) => (r.errors ? num(r.errors) : '-'), right: true },
];

function renderTable(stats: TaskToolStats, top: number): string[] {
  const shown = stats.rows.slice(0, top);
  const widths = COLUMNS.map((c, i) =>
    Math.max(c.header.length, ...shown.map((r) => COLUMNS[i].get(r, stats).length)),
  );
  const pad = (text: string, i: number): string =>
    COLUMNS[i].right ? text.padStart(widths[i]) : text.padEnd(widths[i]);

  const lines: string[] = [];
  lines.push(dim('  ' + COLUMNS.map((c, i) => pad(c.header, i)).join('  ')));
  for (const row of shown) {
    lines.push('  ' + COLUMNS.map((c, i) => pad(c.get(row, stats), i)).join('  '));
  }
  if (stats.rows.length > shown.length) {
    lines.push(dim(`  … ${stats.rows.length - shown.length} more (raise --top to see them)`));
  }
  return lines;
}

/**
 * The caveats, spelled out whenever they apply. Each one exists because the
 * alternative would be a number that silently lies: a zero for a result nobody
 * sized, or a tool name guessed for a call the window never saw.
 */
function renderCaveats(stats: TaskToolStats): string[] {
  const lines: string[] = [];
  if (stats.resultsUnmeasured > 0) {
    lines.push(
      ...prose(
        `${num(stats.resultsUnmeasured)} result(s) carry no recorded size — they predate ` +
          `this being measured, and are left out of the token column rather than counted as zero.`,
      ),
    );
  }
  if (stats.unattributedResultTokens > 0) {
    lines.push(
      ...prose(
        `${num(stats.unattributedResultTokens)} token(s) arrived as results of calls that were never ` +
          `observed, so the tool that produced them is unknown and they are in no row.`,
      ),
    );
  }
  return lines;
}

function renderReport(label: string, stats: TaskToolStats, top: number): string {
  const lines: string[] = [];
  lines.push(
    theme.label(`Tools for ${label}`) +
      dim(` — ${num(stats.requests)} proxied request(s), ${when(stats.firstTs)} → ${when(stats.lastTs)}`),
  );
  lines.push(
    ...prose(
      stats.source === 'window'
        ? 'A recent window: this reading comes from the proxy audit trail, which is bounded and ' +
            'disposable, so it is not the task\'s whole life. Drop --since and --limit for the ' +
            'task\'s full record.'
        : 'The task\'s whole life: the proxy folds every request it forwards into this record, and ' +
            'nothing in it expires.',
    ),
  );
  lines.push('');

  if (stats.rows.length === 0) {
    lines.push(`  ${num(stats.requests)} proxied request(s), none of which carried a tool call.`);
    return lines.join('\n') + '\n';
  }

  lines.push(
    `  ${theme.label(num(stats.totalInvocations) + ' call(s)')}` +
      (stats.resultTokens > 0
        ? `, whose results added ${theme.label(num(stats.resultTokens))} tokens to this task's context`
        : ''),
  );
  lines.push(
    ...prose(
      `The proxy observed ${num(stats.proxyTotals.total)} tokens across those requests; expect that to be far ` +
        `larger, because every request re-sends the whole conversation those results sit in.`,
    ),
  );
  lines.push('');
  lines.push(...renderTable(stats, top));
  const caveats = renderCaveats(stats);
  if (caveats.length) {
    lines.push('');
    lines.push(...caveats);
  }
  lines.push('');
  lines.push(
    ...prose(
      'TOKENS is the size of what each tool\'s results put into the conversation, counted once per call: it is ' +
        'context the tool added, not a share of the model bill. A request\'s own usage is never split across the ' +
        'tools it carried — that would be a guess.',
    ),
  );
  return lines.join('\n') + '\n';
}

export async function commandTools(args: string[]): Promise<void> {
  const parsed = parseFlags(
    args,
    [
      { name: 'since', takesValue: true },
      { name: 'limit', takesValue: true },
      { name: 'top', takesValue: true },
      { name: 'subtree', takesValue: false },
      { name: 'json', takesValue: false },
    ],
    'stats tools',
  );

  const taskRef = parsed.positional[0];
  if (!taskRef) {
    toolsUsage();
    process.exit(1);
  }

  const sinceMs = parseSince(parsed.flags.get('since') as string | undefined);
  const limit = parsePositiveInt(parsed.flags.get('limit') as string | undefined, 'limit', DEFAULT_SCAN);
  const top = parsePositiveInt(parsed.flags.get('top') as string | undefined, 'top', DEFAULT_TOP);
  const subtree = parsed.flags.get('subtree') === true;
  const json = parsed.flags.get('json') === true;

  // A time slice is a question only the audit trail can answer, so asking for
  // one switches to the window derivation — and the report says so. Without it
  // the answer comes from the task's durable record and covers its whole life.
  const windowed = sinceMs !== undefined || parsed.flags.get('limit') !== undefined;

  const root = requireLazyRoot();
  const storage = await requireStorage();
  let label: string;
  let stats: TaskToolStats | null;
  let folded = 0;
  try {
    const task = await resolveTaskOrExit(storage, taskRef);
    label = displayId(task);
    // Same walk the web tab and the RPC use — a hub's own tool calls are not
    // its tool calls. Done for both readings, so `--subtree` means one thing.
    const ids = [task.id];
    if (subtree) {
      const descendants = await collectDescendantTasks(storage, task.id);
      folded = descendants.length;
      ids.push(...descendants.map((d) => d.id));
    }

    if (windowed) {
      const config = await loadConfig(root);
      const all = await readAuditRecords(join(root, config.data.path), { limit });
      const records = sinceMs === undefined ? all : all.filter((r) => r.ts >= sinceMs);
      const byTask = partitionAuditRecordsByTask(records, ids);
      stats = mergeToolStats(ids.map((id) => buildToolStats(byTask.get(id) ?? [], id)));
    } else {
      // Only the tasks that HAVE a record are folded in; none at all is "never
      // recorded", which is a different fact from "called no tools".
      const byTask = await loadToolStatsRecords(storage, ids);
      const present = ids.map((id) => byTask.get(id) ?? null).filter((r) => r !== null);
      stats = present.length > 0 ? mergeToolStats(present.map((r) => toolStatsFromRecord(r!))) : null;
    }
  } finally {
    await storage.close();
  }
  const scopeLabel = subtree
    ? `${label} + ${folded} nested task(s)`
    : label;

  if (json) {
    await writeStdout(JSON.stringify(stats, null, 2) + '\n');
    return;
  }

  if (!stats) {
    await writeStdout(
      `No tool statistics recorded for ${label}. Either it ran before lazy started keeping them, or its ` +
        `traffic did not go through the lazy proxy. This is not a claim that it called no tools — try ` +
        `--since to look for it in the proxy's recent audit window.\n`,
    );
    return;
  }

  if (stats.requests === 0) {
    await writeStdout(
      windowed
        ? `No proxied requests for ${scopeLabel} in that window.\n`
        : `No proxied requests recorded for ${scopeLabel} yet.\n`,
    );
    return;
  }

  await writeStdout('\n' + renderReport(scopeLabel, stats, top) + '\n');
}

export function toolsUsage(): void {
  console.log(`Usage: lazy stats tools <task> [--subtree] [--since <duration>] [--limit <n>] [--top <n>] [--json]

Which tool filled a task's context. The lazy proxy folds each forwarded
request's tool calls and their results into the task's own record, so these
cover the task's whole life and nothing expires — the same numbers the task
page's Stats tab shows.

  CALLS      distinct calls to that tool (a call replayed in later requests is
             still one call)
  TOKENS     the size of what that tool's results put into the conversation,
             counted once per call
  SHARE      that tool's share of all attributed result tokens
  PER CALL   average result size over the calls whose size was recorded
  ERRORS     results that came back flagged as errors

TOKENS is context the tool added, NOT a share of the model bill: a request's
usage is one number for the whole request, and a response routinely asks for
several tools at once, so splitting it would be an invention. Results with no
recorded size are reported as not-recorded rather than zero, and results whose
call was never observed are reported as unattributed rather than filed under a
guessed tool name.

--since and --limit ask a different question — what a task's tools cost over a
stretch of time — which only the proxy's bounded, disposable audit trail can
answer. Either flag reads that recent window instead of the task's record, and
the report says so.

Options:
  --subtree            Include every descendant task, at every depth, merging
                       the rows by tool name — what a hub (a release task, a
                       loop) actually spent, rather than its own few turns
  --since <duration>   Read the proxy's recent audit window instead, limited to
                       records within it (e.g. 30m, 2h, 1d)
  --limit <n>          Max audit records to scan, newest first (default 50000);
                       implies the audit-window reading
  --top <n>            Max tool rows to show (default 20)
  --json               Emit the full rollup as JSON (ignores --top)

Examples:
  lazy stats tools add-proxy           # one task's tools, ranked by tokens added
  lazy stats tools release-v022 --subtree   # the release and everything under it
  lazy stats tools add-proxy --since 2h # the recent audit window instead
  lazy stats tools add-proxy --top 5   # the five heaviest tools
  lazy stats tools add-proxy --json    # machine-readable rollup`);
}
