/**
 * Stats tab — where a task's time and tokens went.
 *
 * Renders only. Every number comes from `src/task/stats.ts`, which derives them
 * from records the route already loaded; nothing is computed here that a unit
 * test would have to open a browser to check.
 *
 * CHARTS ARE SERVER-RENDERED INLINE SVG, not a charting library. The dashboard's
 * one existing chart pulls Chart.js off a CDN, which a local dashboard on a
 * plane does not get; an SVG the server emits needs no network, no canvas and
 * no script, and it is assertable in a unit test as text.
 *
 * COLOR follows the house data-viz method: four categorical slots (blue,
 * orange, aqua, yellow) in the fixed order, validated for both themes against
 * this surface's own background — worst adjacent CVD ΔE 9.1 light / 8.4 dark,
 * worst normal-vision ΔE 22.9 / 19.8. Three of the light steps sit below 3:1
 * contrast on the light surface, so the relief rule applies and is honoured:
 * every series carries a legend swatch with its value spelled out, and the
 * per-turn table under the chart is the table view. The slots are CSS custom
 * properties (`--lz-viz-1…4`) defined in stats.css with a dark-mode step, so
 * the chart follows the theme with no script and no palette duplicated here.
 *
 * Escaping comes from `./escape`, which imports nothing — so this module stays
 * out of the mermaid-heavy review-diff import graph without keeping a second
 * escaper of its own. The local copy it used to keep had already drifted: it
 * left `'` raw.
 */

import type { TaskStats, TurnTokenPoint, TokenTotals, StatsScope } from '../task/stats';
import { escapeHtml } from './escape';

// --- formatting -------------------------------------------------------------

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return '0m';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

function formatWhen(ts: number | null): string {
  if (ts === null) return 'not recorded';
  return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  const pct = (part / whole) * 100;
  return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

// --- pieces -----------------------------------------------------------------

function statTile(label: string, value: string, note?: string): string {
  return (
    `<div class="lz-stat-tile">` +
    `<div class="lz-stat-label">${escapeHtml(label)}</div>` +
    `<div class="lz-stat-value">${escapeHtml(value)}</div>` +
    (note ? `<div class="lz-stat-note">${escapeHtml(note)}</div>` : '') +
    `</div>`
  );
}

interface Slice {
  label: string;
  ms: number;
  slot: number;
}

/**
 * Time split as one horizontal meter plus a labelled legend.
 *
 * A meter rather than a pie: three parts of one whole, read by length, with the
 * value written next to every label — which is also the relief the light-mode
 * contrast warning asks for.
 */
function timeMeterHtml(slices: Slice[], total: number): string {
  const shown = slices.filter((s) => s.ms > 0);
  if (!shown.length || total <= 0) {
    return `<p class="lz-stats-note">No elapsed time to break down yet.</p>`;
  }
  // 2px surface gap between touching segments — the house spacer. Implemented
  // as a flex gap so no segment has to know its neighbours' widths.
  const bar = shown
    .map(
      (s) =>
        `<span class="lz-meter-seg" style="flex:${s.ms} 1 0;background:var(--lz-viz-${s.slot})"` +
        ` title="${escapeHtml(`${s.label}: ${formatDuration(s.ms)}`)}"></span>`,
    )
    .join('');
  const legend = slices
    .map(
      (s) =>
        `<li><span class="lz-viz-swatch" style="background:var(--lz-viz-${s.slot})" aria-hidden="true"></span>` +
        `<span class="lz-viz-key">${escapeHtml(s.label)}</span>` +
        `<span class="lz-viz-val">${escapeHtml(formatDuration(s.ms))}</span>` +
        `<span class="lz-viz-pct">${escapeHtml(percent(s.ms, total))}</span></li>`,
    )
    .join('');
  return (
    `<div class="lz-meter" role="img" aria-label="${escapeHtml(
      shown.map((s) => `${s.label} ${formatDuration(s.ms)}`).join(', '),
    )}">${bar}</div>` +
    `<ul class="lz-viz-legend">${legend}</ul>`
  );
}

/** The four token series, in the fixed categorical order. */
const TOKEN_SERIES: Array<{ key: keyof TokenTotals; label: string; slot: number }> = [
  { key: 'inputTokens', label: 'Input', slot: 1 },
  { key: 'outputTokens', label: 'Output', slot: 2 },
  { key: 'cacheReadTokens', label: 'Cache read', slot: 3 },
  { key: 'cacheCreationTokens', label: 'Cache write', slot: 4 },
];

const CHART_W = 720;
const CHART_H = 200;
const PAD_L = 52;
const PAD_B = 22;
const PAD_T = 8;

function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

/**
 * Stacked columns, one per agent turn, of that turn's four token counters.
 *
 * A turn that reported no usage renders as no column and is called out under
 * the chart — a zero-height bar would read as "this turn was free".
 */
/**
 * How a point names itself on an axis or in a tooltip.
 *
 * In a subtree view the sequence alone is ambiguous — every task has a turn 1,
 * and an axis reading "turn 2 … turn 2" is worse than no axis at all.
 */
function pointLabel(point: TurnTokenPoint): string {
  return point.taskLabel ? `${point.taskLabel} #${point.sequence}` : `turn ${point.sequence}`;
}

function perTurnChartHtml(series: TurnTokenPoint[]): string {
  const withUsage = series.filter((p) => p.usage);
  if (!withUsage.length) return '';
  const max = niceCeil(Math.max(...withUsage.map((p) => p.usage!.total)));
  const plotW = CHART_W - PAD_L - 8;
  const plotH = CHART_H - PAD_T - PAD_B;
  const band = plotW / series.length;
  const barW = Math.max(1, Math.min(24, band - 2));

  const bars = series
    .map((point, i) => {
      if (!point.usage) return '';
      const x = PAD_L + i * band + (band - barW) / 2;
      let cursor = PAD_T + plotH;
      const segments = TOKEN_SERIES.map(({ key, label, slot }) => {
        const value = point.usage![key];
        if (value <= 0) return '';
        const h = (value / max) * plotH;
        cursor -= h;
        // 2px surface gap between stacked segments; never taller than the value.
        const drawn = Math.max(0.5, h - (h > 2.5 ? 2 : 0));
        return (
          `<rect x="${x.toFixed(1)}" y="${cursor.toFixed(1)}" width="${barW.toFixed(1)}" height="${drawn.toFixed(1)}"` +
          ` fill="var(--lz-viz-${slot})"><title>${escapeHtml(
            `${pointLabel(point)} · ${label} ${formatCount(value)}`,
          )}</title></rect>`
        );
      }).join('');
      return segments;
    })
    .join('');

  const ticks = [0, 0.5, 1]
    .map((f) => {
      const y = PAD_T + plotH - f * plotH;
      return (
        `<line class="lz-viz-grid" x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${CHART_W - 8}" y2="${y.toFixed(1)}"/>` +
        `<text class="lz-viz-tick" x="${PAD_L - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${escapeHtml(
          formatTokens(Math.round(max * f)),
        )}</text>`
      );
    })
    .join('');

  const first = series[0];
  const last = series[series.length - 1];
  const axis =
    `<text class="lz-viz-tick" x="${PAD_L}" y="${CHART_H - 6}">${escapeHtml(pointLabel(first))}</text>` +
    (series.length > 1
      ? `<text class="lz-viz-tick" x="${CHART_W - 8}" y="${CHART_H - 6}" text-anchor="end">${escapeHtml(
          pointLabel(last),
        )}</text>`
      : '');

  return (
    `<svg class="lz-viz-svg" viewBox="0 0 ${CHART_W} ${CHART_H}" role="img"` +
    ` aria-label="Tokens per turn, stacked by input, output, cache read and cache write">` +
    ticks +
    bars +
    axis +
    `</svg>`
  );
}

/** Cumulative total tokens across the same turns — growth, on its own axis. */
function cumulativeChartHtml(series: TurnTokenPoint[]): string {
  const points = series.filter((p) => p.usage);
  if (points.length < 2) return '';
  const max = niceCeil(points[points.length - 1].cumulative);
  const plotW = CHART_W - PAD_L - 8;
  const plotH = CHART_H - PAD_T - PAD_B;
  const step = plotW / Math.max(1, series.length - 1);
  const coords = series.map((p, i) => ({
    x: PAD_L + i * step,
    y: PAD_T + plotH - (p.cumulative / max) * plotH,
    point: p,
  }));
  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const end = coords[coords.length - 1];

  const ticks = [0, 0.5, 1]
    .map((f) => {
      const y = PAD_T + plotH - f * plotH;
      return (
        `<line class="lz-viz-grid" x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${CHART_W - 8}" y2="${y.toFixed(1)}"/>` +
        `<text class="lz-viz-tick" x="${PAD_L - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${escapeHtml(
          formatTokens(Math.round(max * f)),
        )}</text>`
      );
    })
    .join('');

  return (
    `<svg class="lz-viz-svg" viewBox="0 0 ${CHART_W} ${CHART_H}" role="img"` +
    ` aria-label="Cumulative tokens across this task's turns">` +
    ticks +
    `<path class="lz-viz-line" d="${path}" fill="none" stroke="var(--lz-viz-1)"/>` +
    // End-dot with the house 2px surface ring, and the one direct label.
    `<circle cx="${end.x.toFixed(1)}" cy="${end.y.toFixed(1)}" r="4" fill="var(--lz-viz-1)"` +
    ` stroke="var(--color-surface)" stroke-width="2"/>` +
    `<text class="lz-viz-endlabel" x="${(end.x - 8).toFixed(1)}" y="${(end.y - 8).toFixed(1)}" text-anchor="end">` +
    `${escapeHtml(formatTokens(end.point.cumulative))}</text>` +
    `</svg>`
  );
}

function tokenLegendHtml(totals: TokenTotals): string {
  const items = TOKEN_SERIES.map(
    ({ key, label, slot }) =>
      `<li><span class="lz-viz-swatch" style="background:var(--lz-viz-${slot})" aria-hidden="true"></span>` +
      `<span class="lz-viz-key">${escapeHtml(label)}</span>` +
      `<span class="lz-viz-val">${escapeHtml(formatCount(totals[key]))}</span>` +
      `<span class="lz-viz-pct">${escapeHtml(percent(totals[key], totals.total))}</span></li>`,
  ).join('');
  return `<ul class="lz-viz-legend">${items}</ul>`;
}

function turnTableHtml(series: TurnTokenPoint[]): string {
  // In a subtree view the sequence column alone is ambiguous — every task has a
  // turn 1 — so the task each turn belongs to gets its own column.
  const labelled = series.some((p) => p.taskLabel !== null);
  const rows = [...series]
    .reverse()
    .map((p) => {
      const usage = p.usage;
      return (
        `<tr>` +
        (labelled ? `<td><code>${escapeHtml(p.taskLabel ?? '—')}</code></td>` : '') +
        `<td class="lz-num">${p.sequence}</td>` +
        `<td>${escapeHtml(formatWhen(p.timestamp))}</td>` +
        `<td>${escapeHtml(p.model ?? 'unknown')}${p.effort ? escapeHtml(` · ${p.effort}`) : ''}</td>` +
        `<td class="lz-num">${escapeHtml(p.spanMs === null ? '—' : formatDuration(p.spanMs))}</td>` +
        (usage
          ? `<td class="lz-num">${formatCount(usage.inputTokens)}</td>` +
            `<td class="lz-num">${formatCount(usage.outputTokens)}</td>` +
            `<td class="lz-num">${formatCount(usage.cacheReadTokens)}</td>` +
            `<td class="lz-num">${formatCount(usage.cacheCreationTokens)}</td>` +
            `<td class="lz-num"><strong>${formatCount(usage.total)}</strong></td>`
          : `<td class="lz-num" colspan="5">not recorded</td>`) +
        `</tr>`
      );
    })
    .join('');
  return (
    `<details class="lz-stats-table"><summary>Per-turn numbers (${series.length})</summary>` +
    `<table class="lz-table"><thead><tr>` +
    (labelled ? `<th>Task</th>` : '') +
    `<th>#</th><th>When</th><th>Model</th><th>Span</th>` +
    `<th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Total</th>` +
    `</tr></thead><tbody>${rows}</tbody></table></details>`
  );
}

function toolsSectionHtml(stats: TaskStats): string {
  const tools = stats.tools;
  const preamble =
    `<p class="lz-stats-note">The proxy folds every request it forwards into that task's own tool ` +
    `record, so these cover ${stats.scope === 'subtree' ? 'those tasks\'' : "the task's"} whole ` +
    `life and nothing here expires. ` +
    `<strong>Tokens</strong> is the size of what that tool's results put into the conversation, ` +
    `measured once per call: it is context the tool added, not a share of the model bill. A request's ` +
    `own usage is never split across the tools it carried — that would be a guess.</p>`;

  const subject = stats.scope === 'subtree' ? 'any task in this subtree' : 'this task';
  if (!tools) {
    return (
      `<h3>Tools</h3>` +
      `<p class="lz-stats-note">No tool statistics were recorded for ${subject}. Either it ran before ` +
      `lazy started keeping them, or its traffic did not go through the lazy proxy. This is not a ` +
      `claim that no tools were called.</p>`
    );
  }
  if (tools.requests === 0) {
    return (
      `<h3>Tools</h3>` +
      `<p class="lz-stats-note">No proxied requests have been recorded for ${subject} yet.</p>`
    );
  }
  if (tools.rows.length === 0) {
    return (
      `<h3>Tools</h3>` +
      preamble +
      `<p class="lz-stats-note">${escapeHtml(
        `${formatCount(tools.requests)} proxied request(s) recorded, none of which carried a tool call.`,
      )}</p>`
    );
  }

  const rows = tools.rows
    .map((row) => {
      // A row with nothing measured shows "not recorded", never a 0 that would
      // read as "this tool's output was free".
      const tokenCell =
        row.resultsMeasured > 0
          ? `<td class="lz-num">${formatCount(row.resultTokens)}</td>` +
            `<td class="lz-num">${escapeHtml(percent(row.resultTokens, tools.resultTokens))}</td>`
          : `<td class="lz-num" colspan="2">not recorded</td>`;
      // Per-call average is the number that actually ranks tools against each
      // other — one 200K result and 200 one-token results are not the same
      // problem — and it is only honest over the calls that were measured.
      const perCall =
        row.resultsMeasured > 0
          ? `<td class="lz-num">${formatCount(Math.round(row.resultTokens / row.resultsMeasured))}</td>`
          : `<td class="lz-num">—</td>`;
      return (
        `<tr><td><code>${escapeHtml(row.name)}</code></td>` +
        `<td class="lz-num">${formatCount(row.invocations)}</td>` +
        tokenCell +
        perCall +
        `<td class="lz-num">${row.errors ? formatCount(row.errors) : '—'}</td></tr>`
      );
    })
    .join('');

  const caveats: string[] = [];
  if (tools.resultsUnmeasured > 0) {
    caveats.push(
      `${formatCount(tools.resultsUnmeasured)} result(s) carry no recorded size — ` +
        `they predate this being measured, and are left out of the token column rather than counted as zero.`,
    );
  }
  if (tools.unattributedResultTokens > 0) {
    caveats.push(
      `${formatCount(tools.unattributedResultTokens)} token(s) arrived as results of calls this record never ` +
        `saw — a conversation already under way when recording started — so the tool that produced them is ` +
        `unknown and they are not in any row.`,
    );
  }

  return (
    `<h3>Tools</h3>` +
    preamble +
    `<p class="lz-stats-note">${escapeHtml(
      `${formatCount(tools.totalInvocations)} call(s) across ${formatCount(tools.requests)} proxied request(s), ` +
        `${formatWhen(tools.firstTs)} → ${formatWhen(tools.lastTs)}. ` +
        (tools.resultTokens > 0
          ? `Their results added ${formatCount(tools.resultTokens)} tokens to ${
              stats.scope === 'subtree' ? "these tasks'" : "this task's"
            } context. `
          : '') +
        `The proxy observed ${formatCount(tools.proxyTotals.total)} tokens across those requests; expect that ` +
        `to be far larger, because every request re-sends the whole conversation those results sit in.`,
    )}</p>` +
    `<table class="lz-table"><thead><tr><th>Tool</th><th>Calls</th><th>Tokens</th><th>Share</th>` +
    `<th>Per call</th><th>Errors</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>` +
    caveats.map((c) => `<p class="lz-stats-note">${escapeHtml(c)}</p>`).join('')
  );
}

function modelsSectionHtml(stats: TaskStats): string {
  const rows = stats.tokens.byModel;
  if (!rows.length) return '';
  const body = rows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.key)}</td>` +
        `<td class="lz-num">${formatCount(row.turns)}</td>` +
        `<td class="lz-num">${formatCount(row.totals.total)}</td></tr>`,
    )
    .join('');
  return (
    `<h3>By model</h3>` +
    `<p class="lz-stats-note">The model each turn was launched with, as recorded on the turn. ` +
    `<code>unknown</code> means the turn predates that field — it is never back-filled.</p>` +
    `<table class="lz-table"><thead><tr><th>Model</th><th>Turns</th><th>Tokens</th></tr></thead>` +
    `<tbody>${body}</tbody></table>`
  );
}

// --- the tab ----------------------------------------------------------------

/**
 * What the subtree's time numbers mean, spelled out where they are shown.
 *
 * The single most misreadable number on a rolled-up tab: a parent and its
 * children run at the same moment by design, so the meter is a UNION and the
 * timesheet-style sum is a different, larger, also-true number. Showing one
 * without naming the other is how a reader concludes the tab is broken.
 */
function rolledTimeNoteHtml(stats: TaskStats): string {
  const roll = stats.subtree;
  if (!roll) return '';
  const parts = [
    `Across ${formatCount(roll.tasks)} task(s), the bar is wall clock during which AT LEAST ONE of them was ` +
      `in that state — running wins over awaiting, awaiting over backlog, so the three divide one window ` +
      `instead of counting the same minute three times.`,
    `Added up per task instead, running time comes to ${formatDuration(roll.summedRunningMs)}` +
      (roll.overlappedRunningMs > 0
        ? `, of which ${formatDuration(roll.overlappedRunningMs)} is time two or more tasks were running at once.`
        : ' — no two of them ever ran at the same moment.'),
  ];
  if (roll.tasksWithHistory < roll.tasks) {
    parts.push(
      `${formatCount(roll.tasks - roll.tasksWithHistory)} of them have no recorded status history and ` +
        `contribute no time at all.`,
    );
  }
  return parts.map((p) => `<p class="lz-stats-note">${escapeHtml(p)}</p>`).join('');
}

/**
 * The Stats tab's URL for one scope.
 *
 * `?scope=` is a plain query on the tab's own path, so the toggle is two links,
 * both bookmarkable, and the in-place tab switcher carries the query the same
 * way it carries `?region=` on Changes.
 */
export function statsScopeHref(taskId: string, scope: StatsScope): string {
  // taskId is the ESCAPED path segment (taskPathSegment) — interpolate raw.
  return `/tasks/${taskId}/stats?scope=${scope}`;
}

/** What the tab needs to draw the scope toggle. */
export interface StatsTabView {
  /** The scope actually rendered. */
  scope: StatsScope;
  /** Descendants the task has, whatever scope is rendered. 0 hides the toggle. */
  descendantCount: number;
  /** URL for each scope. Plain links — no script, and both are bookmarkable. */
  taskHref: string;
  subtreeHref: string;
}

/**
 * The two-view toggle.
 *
 * Only rendered when the task actually has descendants: on a leaf task the two
 * views are the same numbers, and a control that changes nothing is noise.
 */
function scopeToggleHtml(view: StatsTabView): string {
  if (view.descendantCount <= 0) return '';
  const option = (scope: StatsScope, href: string, label: string): string => {
    const active = view.scope === scope;
    return active
      ? `<span class="lz-scope-opt lz-scope-active" aria-current="true">${escapeHtml(label)}</span>`
      : `<a class="lz-scope-opt" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  };
  const folded = `${formatCount(view.descendantCount)} nested task${view.descendantCount === 1 ? '' : 's'}`;
  return (
    `<div class="lz-stats-scope" role="group" aria-label="Which tasks these numbers cover">` +
    option('task', view.taskHref, 'This task only') +
    option('subtree', view.subtreeHref, `Including subtasks (${folded})`) +
    `</div>`
  );
}

/**
 * Full Stats tab body.
 *
 * Every section renders something honest when its data is missing: no turns, no
 * recorded usage, and no proxy history are all real states with their own copy,
 * not blank boxes.
 */
export function statsTabHtml(stats: TaskStats, view?: StatsTabView): string {
  const { time, tokens } = stats;
  const rolled = stats.scope === 'subtree';
  const covers = rolled
    ? `this task and ${formatCount(stats.descendants)} nested task(s)`
    : 'this task alone';

  const tiles =
    `<div class="lz-stat-row">` +
    statTile('Turns', formatCount(stats.turns.total), `${stats.turns.agent} agent · ${stats.turns.human} human`) +
    statTile('Elapsed', formatDuration(time.elapsedMs), time.live ? 'still running' : 'finished') +
    statTile(
      'Tokens',
      tokens.totals.total ? formatTokens(tokens.totals.total) : 'not recorded',
      tokens.agentTurns
        ? `${tokens.turnsWithUsage}/${tokens.agentTurns} turns reported usage`
        : 'no agent turns yet',
    ) +
    statTile('Commits', formatCount(stats.commits)) +
    `</div>`;

  const slices = [
    { label: rolled ? 'Some task running' : 'Agent running', ms: time.runningMs, slot: 1 },
    { label: 'Awaiting a human', ms: time.awaitingMs, slot: 2 },
    { label: 'In backlog', ms: time.backlogMs, slot: 3 },
    // Only when there IS such a stretch: one task's lifetime never has one, and
    // a permanently-zero fourth key is noise in the legend rather than honesty.
    ...(time.idleMs > 0 ? [{ label: 'No task active', ms: time.idleMs, slot: 4 }] : []),
  ];
  // THE DENOMINATOR IS THE ROOT'S OWN RUNNING CLOCK, in both scopes. The
  // sentence says "of this task's own running time", and `subtaskRunningMs` is
  // the root's own running time that overlapped a descendant's — so the only
  // whole it is a share of is the root's own. In the rolled-up view this used
  // to divide by `summedRunningMs`, which folds in every descendant's clock as
  // well: the sentence named one whole and the arithmetic used another, and it
  // understated, worst on exactly the deep trees where the question gets asked.
  const overlapWhole = rolled ? (stats.subtree?.rootRunningMs ?? time.runningMs) : time.runningMs;
  const subtaskLine =
    time.subtaskRunningMs === null
      ? `<p class="lz-stats-note">Time waiting on subtasks is derived from the children's own histories; this task has none.</p>`
      : `<p class="lz-stats-note">${escapeHtml(
          `Of ${rolled ? "this task's own" : 'the'} running time, ${formatDuration(time.subtaskRunningMs)} (${percent(
            time.subtaskRunningMs,
            overlapWhole,
          )}) overlapped a ${rolled ? 'nested' : 'direct'} subtask that was itself running — a parent waiting inside lazy_wait still counts as running.`,
        )}</p>`;

  const timeSection =
    `<h3>Where the time went</h3>` +
    (time.transitions === 0
      ? `<p class="lz-stats-note">No status history recorded${
          rolled ? ' for any task in this subtree' : ' for this task'
        }, so the elapsed time cannot be broken down.</p>`
      : timeMeterHtml(slices, time.runningMs + time.awaitingMs + time.backlogMs + time.idleMs) +
        subtaskLine +
        rolledTimeNoteHtml(stats)) +
    `<p class="lz-stats-note">Wall clock, from the recorded status history. A task left blocked overnight ` +
    `really did spend those hours blocked — that is not agent runtime, and per-turn agent runtime is not ` +
    `recorded anywhere, so it is not shown.</p>` +
    `<dl class="lz-stats-facts">` +
    `<dt>Created</dt><dd>${escapeHtml(formatWhen(time.createdAt))}</dd>` +
    `<dt>Last activity</dt><dd>${escapeHtml(formatWhen(time.lastActivityAt))}</dd>` +
    `<dt>Status changes</dt><dd>${formatCount(time.transitions)}</dd>` +
    `</dl>`;

  let tokenSection: string;
  if (tokens.agentTurns === 0) {
    tokenSection = `<h3>Tokens</h3><p class="lz-stats-note">No agent turns yet, so nothing has been spent.</p>`;
  } else if (tokens.turnsWithUsage === 0) {
    tokenSection =
      `<h3>Tokens</h3>` +
      `<p class="lz-stats-note">${escapeHtml(
        `${tokens.agentTurns} agent turn(s), none of which reported token usage. Usage is recorded when the agent reports it; absence here means it did not, not that the turns were free.`,
      )}</p>`;
  } else {
    const missing = tokens.agentTurns - tokens.turnsWithUsage;
    const bound =
      tokens.omittedTurns > 0
        ? ` The chart shows the newest ${tokens.series.length} turns; ${formatCount(
            tokens.omittedTurns,
          )} earlier turn(s) worth ${formatCount(tokens.omittedTotal)} tokens are in the totals but off the chart.`
        : '';
    const sessionLine = tokens.sessionTotal
      ? `<p class="lz-stats-note">${escapeHtml(
          rolled
            ? `The sessions' own running totals add up to ${formatCount(tokens.sessionTotal.total)} tokens.`
            : `The session's own running total is ${formatCount(tokens.sessionTotal.total)} tokens.`,
        )}</p>`
      : '';
    tokenSection =
      `<h3>Tokens</h3>` +
      tokenLegendHtml(tokens.totals) +
      `<h4>Per turn</h4>` +
      perTurnChartHtml(tokens.series) +
      `<p class="lz-stats-note">${escapeHtml(
        `${formatCount(tokens.totals.total)} tokens across ${tokens.turnsWithUsage} turn(s).` +
          (missing ? ` ${missing} agent turn(s) reported no usage and are absent from the chart.` : '') +
          bound,
      )}</p>` +
      `<h4>Cumulative</h4>` +
      (cumulativeChartHtml(tokens.series) ||
        `<p class="lz-stats-note">Growth needs at least two turns with recorded usage.</p>`) +
      sessionLine +
      turnTableHtml(tokens.series);
  }

  return (
    `<section class="lz-stats-tab" id="lz-stats">` +
    (view ? scopeToggleHtml(view) : '') +
    `<p class="lz-stats-note">${escapeHtml(`These numbers cover ${covers}.`)}</p>` +
    tiles +
    timeSection +
    tokenSection +
    toolsSectionHtml(stats) +
    modelsSectionHtml(stats) +
    `<p class="lz-stats-note">No cost figures: lazy has no price table, and hardcoding one here would ` +
    `go stale without anyone noticing.</p>` +
    `</section>`
  );
}
