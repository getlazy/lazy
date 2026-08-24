/**
 * `lazy stats audit` — the record-level reader for the proxy audit trail.
 *
 * `lazy stats tokens` rolls the same trail up into totals; this is the other
 * half — one row per proxied request, filterable, plus a detail view for a
 * single record. Before it existed the only way to answer "what did the policy
 * engine deny on that turn?" was to hand-read `.lazy/proxy-audit.jsonl`.
 *
 * Naming: this is a `stats` subcommand rather than a top-level `lazy audit`.
 * Top-level verbs are task-lifecycle operations, and `audit` is a task TYPE —
 * `lazy fix`, `lazy refactor`, `lazy document` and `lazy rework` all CREATE a
 * task of their name, so a top-level `lazy audit "<goal>"` reads as "create an
 * audit task" to anyone who has used the rest of the CLI. Putting the reader
 * under `stats`, next to the `tokens` rollup over the very same records, keeps
 * that word free and matches the invariant `stats` already documents.
 *
 * Everything here is read-only, like every other `stats` subcommand.
 */
import { join } from 'path';
import { requireLazyRoot, parseFlags } from '../helpers';
import { loadConfig } from '../../config/loader';
import { readAuditRecords } from '../../proxy/audit-log';
import { theme, dim } from '../theme';
import { parseSince, parsePositiveInt } from './stats-flags';
import {
  filterAuditRecords,
  resolveAuditRecord,
  toAuditRow,
  denialsOf,
  type AuditFilters,
  type AuditRow,
} from '../../proxy/audit-query';
import type { ProxyAuditRecord } from '../../storage/types';

/** How much of the record UUID identifies a record in the listing. */
const ID_WIDTH = 8;

/** Scan cap: how many records are read from the trail before filtering. */
const DEFAULT_SCAN = 50_000;

/** How many matching records the table shows by default. */
const DEFAULT_LIMIT = 20;

const SCOPE_NOTE =
  'Only traffic through the lazy proxy is audited — agents on the anthropic/ollama backends never appear here.';

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

function fmtDur(ms: number | null): string {
  if (ms === null) return '-';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function num(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Markers are the reason to scan this table at all: a denial, a reroute or a
 * failure is the thing you came looking for. Letters, not glyphs alone, so the
 * signal survives a pipe through `grep` and a terminal without color.
 */
function markers(row: AuditRow): string {
  const out: string[] = [];
  if (row.denials > 0) out.push(theme.error(`DENY(${row.denials})`));
  if (row.rerouted) out.push(theme.warning('REROUTE'));
  if (row.failed) out.push(theme.error(`FAIL(${row.status ?? 'no-response'})`));
  return out.join(' ');
}

interface Column {
  header: string;
  get: (row: AuditRow) => string;
  /** Right-align numeric columns so magnitudes line up. */
  right?: boolean;
}

const COLUMNS: Column[] = [
  { header: 'TIME', get: (r) => fmtTime(r.ts) },
  { header: 'ID', get: (r) => r.id.slice(0, ID_WIDTH) },
  { header: 'ROLE', get: (r) => r.role ?? '-' },
  { header: 'TASK', get: (r) => r.taskId ?? '-' },
  { header: 'MODEL', get: (r) => r.model ?? '-' },
  { header: 'TOOLS', get: (r) => `${r.toolUses}/${r.toolResults}`, right: true },
  { header: 'TOKENS', get: (r) => (r.totalTokens === null ? '-' : num(r.totalTokens)), right: true },
  { header: 'TOOK', get: (r) => fmtDur(r.durationMs), right: true },
];

function renderTable(rows: AuditRow[]): void {
  const widths = COLUMNS.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => c.get(r).length)),
  );

  console.log(
    dim(
      COLUMNS.map((c, i) => (c.right ? c.header.padStart(widths[i]) : c.header.padEnd(widths[i])))
        .join('  ') + '  NOTES',
    ),
  );

  for (const row of rows) {
    const cells = COLUMNS.map((c, i) => {
      const v = c.get(row);
      return c.right ? v.padStart(widths[i]) : v.padEnd(widths[i]);
    });
    console.log(`${cells.join('  ')}  ${markers(row)}`.trimEnd());
  }
}

/** Multi-line blocks in the detail view all indent the same way. */
function field(label: string, value: string): void {
  console.log(`  ${theme.label(label.padEnd(12))} ${value}`);
}

function renderDetail(record: ProxyAuditRecord): void {
  const row = toAuditRow(record);
  console.log(
    `\n${theme.label(`Audit record ${record.id.slice(0, ID_WIDTH)}`)} ` +
      `${dim(record.id)}  ${dim(fmtTime(record.ts))}`,
  );
  const mark = markers(row);
  if (mark) console.log(`  ${mark}`);

  console.log('');
  field('role', record.role ?? dim('(unattributed)'));
  field('task', record.taskId ?? dim('(unattributed)'));
  field('model', record.model ?? '-');
  field('tier', record.tier ?? '-');
  field('backend', `${record.backend} ${dim(record.upstream)}`);
  field('request', `${record.method} ${record.path} ${dim(`(${record.endpoint})`)}`);
  field(
    'response',
    `${record.status ?? dim('no response')}` +
      (record.stopReason ? ` ${dim(record.stopReason)}` : '') +
      `  ${dim(fmtDur(record.durationMs))}` +
      (record.stream ? ` ${dim('streamed')}` : ''),
  );

  const u = record.usage;
  field(
    'usage',
    u
      ? `${num(row.totalTokens ?? 0)} total ` +
        dim(
          `(input ${num(u.inputTokens ?? 0)} · output ${num(u.outputTokens ?? 0)} · ` +
            `cache write ${num(u.cacheCreationInputTokens ?? 0)} · cache read ${num(u.cacheReadInputTokens ?? 0)})`,
        )
      : dim('not captured (no response body, or a non-messages endpoint)'),
  );

  if (record.error) field('error', theme.error(record.error));

  const shape = record.requestShape;
  if (shape) {
    field(
      'shape',
      `${shape.numMessages} message(s), ${shape.numTools} tool(s) declared, ` +
        `${num(shape.bodyBytes)} bytes` +
        (shape.hasSystem ? dim(`, system ${num(shape.systemLen)} chars`) : ''),
    );
    if (shape.toolNames.length > 0) field('declared', dim(shape.toolNames.join(', ')));
  }

  const rr = record.reroute;
  if (rr) {
    console.log(`\n  ${theme.warning('Rerouted')} ${dim(`(trigger ${rr.trigger}, ${rr.attempts} target(s) tried)`)}`);
    console.log(`    from ${rr.fromUpstream} ${dim(rr.fromModel ?? '-')}`);
    console.log(`    to   ${rr.toUpstream} ${dim(rr.toModel ?? '-')}`);
  }

  const denials = denialsOf(record);
  if (denials.length > 0) {
    console.log(`\n  ${theme.error(`Denied ${denials.length} tool_use(s)`)}`);
    for (const d of denials) {
      console.log(`    ${d.name} ${dim(`[${d.rule}]`)}${d.toolUseId ? dim(` ${d.toolUseId}`) : ''}`);
      console.log(`      ${dim(d.reason)}`);
    }
  }

  if (record.toolUses.length > 0) {
    console.log(`\n  ${theme.label(`tool_use (${record.toolUses.length})`)} ${dim('— actions the agent intended')}`);
    for (const t of record.toolUses) {
      const detail = t.path ?? t.command ?? t.target ?? t.inputPreview;
      console.log(
        `    ${t.name}${t.connector ? theme.warning(' [connector]') : ''}  ${dim(detail)}`,
      );
    }
  }

  if (record.toolResults.length > 0) {
    console.log(
      `\n  ${theme.label(`tool_result (${record.toolResults.length})`)} ${dim('— results of prior actions')}`,
    );
    for (const t of record.toolResults) {
      const flag = t.isError ? theme.error('error ') : '';
      console.log(`    ${flag}${dim(`${num(t.contentLen)} chars`)}  ${dim(t.contentPreview)}`);
    }
  }

  console.log('');
}

export async function commandAudit(args: string[]): Promise<void> {
  const parsed = parseFlags(
    args,
    [
      { name: 'task', takesValue: true },
      { name: 'role', takesValue: true },
      { name: 'model', takesValue: true },
      // --last is a synonym for --since. parseFlags aliases are single-dash
      // only, so the synonym has to be its own flag.
      { name: 'since', takesValue: true },
      { name: 'last', takesValue: true },
      { name: 'denied', takesValue: false },
      { name: 'reroutes', takesValue: false },
      { name: 'errors', takesValue: false },
      { name: 'limit', takesValue: true },
      { name: 'scan', takesValue: true },
      { name: 'json', takesValue: false },
    ],
    'stats audit',
  );

  const sinceRaw = parsed.flags.get('since') as string | undefined;
  const lastRaw = parsed.flags.get('last') as string | undefined;
  if (sinceRaw !== undefined && lastRaw !== undefined) {
    console.error('Use --since or --last, not both — they mean the same thing.');
    process.exit(1);
  }
  const sinceMs =
    sinceRaw !== undefined ? parseSince(sinceRaw, 'since') : parseSince(lastRaw, 'last');

  const limit = parsePositiveInt(parsed.flags.get('limit') as string | undefined, 'limit', DEFAULT_LIMIT);
  const scan = parsePositiveInt(parsed.flags.get('scan') as string | undefined, 'scan', DEFAULT_SCAN);
  const json = parsed.flags.get('json') === true;

  const filters: AuditFilters = {
    sinceMs,
    role: parsed.flags.get('role') as string | undefined,
    taskId: parsed.flags.get('task') as string | undefined,
    model: parsed.flags.get('model') as string | undefined,
    denied: parsed.flags.get('denied') === true,
    reroutes: parsed.flags.get('reroutes') === true,
    errors: parsed.flags.get('errors') === true,
  };

  const recordId = parsed.positional[0];
  if (parsed.positional.length > 1) {
    console.error(
      `Expected at most one record id, got ${parsed.positional.length}: ${parsed.positional.join(' ')}`,
    );
    process.exit(1);
  }

  const root = requireLazyRoot();
  const config = await loadConfig(root);
  const all = await readAuditRecords(join(root, config.data.path), { limit: scan });

  // --- Detail view: one record, resolved by id prefix ---
  if (recordId !== undefined) {
    const { record, matches } = resolveAuditRecord(all, recordId);
    if (matches === 0) {
      console.error(
        `No audit record matches '${recordId}'. Run \`lazy stats audit\` to list recent records.`,
      );
      process.exit(1);
    }
    if (matches > 1) {
      console.error(
        `'${recordId}' matches ${matches} audit records — use more characters of the id.`,
      );
      process.exit(1);
    }
    if (json) {
      console.log(JSON.stringify(record, null, 2));
      return;
    }
    renderDetail(record!);
    return;
  }

  // --- List view ---
  const matched = filterAuditRecords(all, filters);
  // Newest last: the trail reads like a log, so the most recent request ends
  // up next to the prompt. `--limit` therefore keeps the TAIL, not the head.
  const shown = matched.slice(Math.max(0, matched.length - limit));
  const rows = shown.map(toAuditRow);

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (all.length === 0) {
    console.log(
      'No proxied requests recorded yet — run a task and retry.',
    );
    console.log(dim(SCOPE_NOTE));
    return;
  }
  if (matched.length === 0) {
    console.log(`No audit records match those filters ${dim(`(${num(all.length)} scanned)`)}.`);
    return;
  }

  renderTable(rows);
  const hidden = matched.length - shown.length;
  console.log(
    dim(
      `\n${num(shown.length)} of ${num(matched.length)} matching record(s)` +
        (hidden > 0 ? `, ${num(hidden)} older hidden (raise --limit)` : '') +
        ` · ${num(all.length)} scanned`,
    ),
  );
  console.log(dim(`Detail: lazy stats audit ${rows[rows.length - 1].id.slice(0, ID_WIDTH)}`));
  console.log(dim(SCOPE_NOTE));
}

export function auditUsage(): void {
  console.log(`Usage: lazy stats audit [<record-id>] [filters] [--limit <n>] [--json]

Browse the proxy audit trail one record per proxied request — the record-level
view of the same trail \`lazy stats tokens\` rolls up. Every request through the
lazy proxy is recorded with its role, task, model, the tool_use/tool_result
blocks it carried, any policy denials applied to the response, and any failover
reroute.

With no record id you get the newest matching records as a table; NOTES flags
the rows worth looking at (DENY, REROUTE, FAIL). Pass a record id — the short
form from the ID column is enough — for the full detail view of one request,
including denied tool calls with the rule that fired and the reason given.

Every launch lazy makes routes through the proxy, whatever the role's backend, so
all of it is audited here; a process lazy did not launch is not.

Filters (all combine):
  --task <id>          Only this task (short-id prefix match)
  --role <role>        Only this role (agent, builder)
  --model <substr>     Only models whose name contains this
  --since <duration>   Only records within this window (e.g. 30m, 2h, 1d)
  --last <duration>    Synonym for --since
  --denied             Only requests where the policy engine denied a tool_use
  --reroutes           Only requests that failed over to a fallback target
  --errors             Only failed requests (proxy error, or non-2xx upstream)

Options:
  --limit <n>          Max records to show, newest kept (default ${DEFAULT_LIMIT})
  --scan <n>           Max records to read from the trail (default ${num(DEFAULT_SCAN)})
  --json               Emit matching rows as JSON; with a record id, the raw record

Examples:
  lazy stats audit                          # the newest ${DEFAULT_LIMIT} proxied requests
  lazy stats audit --denied                 # every policy denial recorded
  lazy stats audit --task add-audit --last 2h
  lazy stats audit --errors --limit 50      # recent failures, e.g. 401s
  lazy stats audit 3f9a1c2b                 # full detail for one record
  lazy stats audit --reroutes --json        # failovers, machine-readable`);
}
