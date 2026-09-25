/**
 * Where a task's time and tokens went — derived, never stored.
 *
 * Pure functions over records the caller has already loaded: no storage, no
 * I/O, no HTML. The web layer renders what this returns, the same way cluster
 * progress is derived in `cluster-progress.ts` rather than in a renderer, so the
 * arithmetic is unit-testable without a browser and a second surface (CLI,
 * MCP) can read the same numbers.
 *
 * WHAT IS AND IS NOT RECORDED — the whole design follows from this, and every
 * field below is either sourced or explicitly absent. A stat that is silently
 * wrong is worse than one that says "not recorded", because the point of this
 * rollup is to inform an optimization decision.
 *
 *  - Time in status: the ONLY source is the status changelog
 *    (`storage.getStatusHistory`). It is wall clock. A task that sat blocked
 *    overnight really did sit blocked overnight; that is not agent runtime and
 *    the renderer must say so.
 *  - Per-turn agent runtime: NOT recorded. `agent_duration_ms` exists only on
 *    the transient command settlement (src/protocol/types.ts) and never lands
 *    on the Turn. What can be derived is the SPAN between consecutive turn
 *    timestamps, which is a different thing and is named as one.
 *  - Per-turn tokens: `Turn.usage`, present when the agent reported usage for
 *    that turn. Null (human turns, agents that report none, old turns) is
 *    carried through as null — never zero, which would read as "free".
 *  - Per-tool tokens: the size of each tool's RESULTS, which the proxy measures
 *    per `tool_use` id as it forwards the request. That is what a tool added to
 *    the context, not a share of the model bill — a request's usage is still
 *    never split across the tools it carried. The default reading is the
 *    task's DURABLE record, which the proxy folds each request into and which
 *    never expires ({@link toolStatsFromRecord}); {@link buildToolStats}
 *    computes the same shape over a time slice of the bounded audit log, for
 *    the one surface that asks a windowed question.
 *  - Cost: no price table exists in this repository, so no cost is computed.
 *    Hardcoding one here would rot silently.
 *
 * TWO SCOPES. Every derivation here answers for ONE task or for a task AND ALL
 * ITS DESCENDANTS ({@link buildSubtreeStats}). A hub — a release task, a cluster —
 * does almost none of its own work, so its own turns are not its spend; the
 * subtree view is what a reader of such a task actually came for. Counts,
 * tokens, commits and the per-tool table are sums. TIME IS NOT SUMMED: a parent
 * and its children run at the same moment, so wall clocks would be added twice
 * over. See {@link SubtreeRollup}.
 */

import type { Task, Session, Turn, Commit, TokenUsage, TaskStatus } from '../types';
import type { StatusChange, ProxyAuditRecord, TaskToolStatsRecord } from '../storage/types';
import { isTerminalStatus } from '../types';
import { displayId } from './identity';
import { parentTaskIdOf } from '../task-target';

/** Whether a readout covers one task, or that task plus every descendant. */
export type StatsScope = 'task' | 'subtree';

export function parseStatsScope(value: string | null | undefined): StatsScope | null {
  return value === 'task' || value === 'subtree' ? value : null;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * The bucket a status puts the clock in.
 *
 * Deliberately NOT `isActiveStatus()` from the state machine: that predicate
 * answers "does this task have a live worktree nobody may merge into", which
 * is why it counts `interrupted`. For a time budget, `interrupted` is time the
 * task was making no progress and waiting to be picked back up — the same
 * thing `blocked` is from the reader's point of view, and lumping it with
 * `working` would inflate the one number this tab exists to show.
 */
export type TimeBucket = 'running' | 'awaiting' | 'backlog';

const TIME_BUCKETS: Record<TaskStatus, TimeBucket | null> = {
  backlog: 'backlog',
  working: 'running',
  pairing: 'running',
  merging: 'running',
  blocked: 'awaiting',
  conflict: 'awaiting',
  submitted: 'awaiting',
  interrupted: 'awaiting',
  zombie: 'awaiting',
  // Terminal: the clock stops. Not a bucket, and not "awaiting forever".
  complete: null,
  abandoned: null,
};

export function timeBucketOf(status: string): TimeBucket | null {
  return TIME_BUCKETS[status as TaskStatus] ?? null;
}

/** A half-open [start, end) interval in unix ms. */
export interface Interval {
  start: number;
  end: number;
}

export interface TaskTimeStats {
  createdAt: number;
  /** Newest recorded event of any kind (status change, turn, commit), or null. */
  lastActivityAt: number | null;
  /** created_at → completion (terminal) or now. */
  elapsedMs: number;
  /** Wall clock in working / pairing / merging. */
  runningMs: number;
  /** Wall clock in blocked / conflict / submitted / interrupted / zombie. */
  awaitingMs: number;
  /** Wall clock in backlog, before the task ever started. */
  backlogMs: number;
  /**
   * The slice of `runningMs` during which at least one DIRECT child was itself
   * running — a cluster parent sits in `working` while its driver waits inside
   * `lazy_wait`, so this is a subset of running time, not a fourth bucket.
   *
   * null when no child histories were supplied (nothing to derive it from);
   * 0 is a real answer meaning "children ran, never while this task was".
   */
  subtaskRunningMs: number | null;
  /**
   * Elapsed the three buckets do not cover. Always 0 for one task — its
   * lifetime is fully partitioned — and a real number for a subtree, where a
   * stretch during which every task was finished and the next one not yet
   * created belongs to no bucket at all.
   */
  idleMs: number;
  /** True while the clock is still ticking (task not terminal). */
  live: boolean;
  /** Status changes the derivation saw. 0 = no history recorded. */
  transitions: number;
}

/**
 * Turn a status changelog into intervals per bucket, clipped to the task's
 * lifetime.
 *
 * The changelog records transitions, not spans: the status set at change `i`
 * holds until change `i+1`, or until the task finished, or until now. Time
 * before the first recorded change is attributed to `backlog` — every task is
 * created there, and a store whose history predates the changelog reads as an
 * honest "no transitions recorded" (transitions: 0) rather than a fabricated
 * split.
 */
export function statusIntervals(
  createdAt: number,
  changes: StatusChange[],
  endAt: number,
): Map<TimeBucket, number> {
  const spans = statusSpans(createdAt, changes, endAt);
  return new Map<TimeBucket, number>([
    ['running', intervalsLength(spans.get('running') ?? [])],
    ['awaiting', intervalsLength(spans.get('awaiting') ?? [])],
    ['backlog', intervalsLength(spans.get('backlog') ?? [])],
  ]);
}

/**
 * The same walk as {@link statusIntervals}, keeping the intervals rather than
 * their totals — what a subtree rollup needs, because overlapping wall clocks
 * may only be unioned, never added.
 *
 * Unlike {@link bucketIntervals} this includes the pre-history backlog span
 * (created → first recorded transition), which is not a recorded status and so
 * cannot be recovered from the changelog alone.
 */
export function statusSpans(
  createdAt: number,
  changes: StatusChange[],
  endAt: number,
): Map<TimeBucket, Interval[]> {
  const spans = new Map<TimeBucket, Interval[]>([
    ['running', []],
    ['awaiting', []],
    ['backlog', []],
  ]);
  const ordered = [...changes].sort((a, b) => a.timestamp - b.timestamp);

  // Pre-history: created, but no transition recorded yet.
  const firstAt = ordered.length ? Math.min(ordered[0].timestamp, endAt) : endAt;
  if (firstAt > createdAt) spans.get('backlog')!.push({ start: createdAt, end: firstAt });

  for (let i = 0; i < ordered.length; i++) {
    const start = Math.max(ordered[i].timestamp, createdAt);
    const next = i + 1 < ordered.length ? ordered[i + 1].timestamp : endAt;
    const stop = Math.min(next, endAt);
    if (stop <= start) continue;
    const bucket = timeBucketOf(ordered[i].status);
    if (!bucket) continue;
    spans.get(bucket)!.push({ start, end: stop });
  }
  return spans;
}

/** The intervals a status history spends in one bucket, clipped to `endAt`. */
export function bucketIntervals(
  changes: StatusChange[],
  bucket: TimeBucket,
  endAt: number,
): Interval[] {
  const ordered = [...changes].sort((a, b) => a.timestamp - b.timestamp);
  const out: Interval[] = [];
  for (let i = 0; i < ordered.length; i++) {
    if (timeBucketOf(ordered[i].status) !== bucket) continue;
    const start = ordered[i].timestamp;
    const next = i + 1 < ordered.length ? ordered[i + 1].timestamp : endAt;
    const end = Math.min(next, endAt);
    if (end > start) out.push({ start, end });
  }
  return out;
}

/** Total length of the overlap between one interval list and another. */
export function overlapMs(a: Interval[], b: Interval[]): number {
  if (!a.length || !b.length) return 0;
  const merged = mergeIntervals(b);
  let total = 0;
  for (const x of mergeIntervals(a)) {
    for (const y of merged) {
      if (y.end <= x.start) continue;
      if (y.start >= x.end) break;
      total += Math.min(x.end, y.end) - Math.max(x.start, y.start);
    }
  }
  return total;
}

/** Total length of a list of intervals, merging any overlap first. */
export function intervalsLength(intervals: Interval[]): number {
  let total = 0;
  for (const iv of mergeIntervals(intervals)) total += iv.end - iv.start;
  return total;
}

/**
 * `a` minus `b` — the parts of `a` no interval in `b` covers.
 *
 * The subtree time split is a PRIORITY over the union rather than a sum: a
 * moment at which any task was running is running time, whatever the others
 * were doing, so the awaiting and backlog unions have the higher-priority ones
 * cut out of them. Without this the three "buckets" would overlap and add up to
 * more than the elapsed window they claim to divide.
 */
export function subtractIntervals(a: Interval[], b: Interval[]): Interval[] {
  const cuts = mergeIntervals(b);
  const out: Interval[] = [];
  for (const iv of mergeIntervals(a)) {
    let start = iv.start;
    for (const cut of cuts) {
      if (cut.end <= start) continue;
      if (cut.start >= iv.end) break;
      if (cut.start > start) out.push({ start, end: cut.start });
      start = Math.max(start, cut.end);
      if (start >= iv.end) break;
    }
    if (start < iv.end) out.push({ start, end: iv.end });
  }
  return out;
}

export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((p, q) => p.start - q.start);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface TokenTotals extends TokenUsage {
  /** Sum of all four counters — what "total tokens" means everywhere here. */
  total: number;
}

export function emptyTokenTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    total: 0,
  };
}

export function totalOf(usage: TokenUsage): number {
  return (
    usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens
  );
}

/** One point of the per-turn series — one agent turn. */
export interface TurnTokenPoint {
  sequence: number;
  timestamp: number;
  /** null = this turn reported no usage. Never coerced to zero. */
  usage: TokenTotals | null;
  /** Running total of `total` across the whole series, including this point. */
  cumulative: number;
  model: string | null;
  effort: string | null;
  agent: string | null;
  /**
   * Wall clock from the previous turn of any role to this one. A SPAN, not
   * agent runtime — nothing records the latter. null for the first turn OF THAT
   * TASK: in a subtree view a span across two different tasks would be the gap
   * between unrelated conversations, which is not a span of anything.
   */
  spanMs: number | null;
  /**
   * Which task the turn belongs to, in a subtree view. null for a single-task
   * view, where every point is the same task and the column would be noise.
   */
  taskLabel: string | null;
}

export interface TaskTokenStats {
  /** Agent turns, whether or not they reported usage. */
  agentTurns: number;
  /** Agent turns that reported usage — the denominator for "recorded". */
  turnsWithUsage: number;
  totals: TokenTotals;
  /** Newest-last, one point per agent turn. Bounded by `turnLimit`. */
  series: TurnTokenPoint[];
  /** Turns omitted from the head of `series` because of the bound. */
  omittedTurns: number;
  /** Tokens in those omitted turns, so the chart's caption can account for them. */
  omittedTotal: number;
  /** The session's own running total, when recorded — an independent check. */
  sessionTotal: TokenTotals | null;
  /** Turns grouped by the model they were launched with. */
  byModel: Array<{ key: string; turns: number; totals: TokenTotals }>;
}

/** Label for a turn field that is deliberately not back-filled. */
export const UNKNOWN = 'unknown';

function addUsage(target: TokenTotals, usage: TokenUsage): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheCreationTokens += usage.cacheCreationTokens;
  target.cacheReadTokens += usage.cacheReadTokens;
  target.total = totalOf(target);
}

/**
 * Per-turn and total token usage.
 *
 * `turnLimit` bounds the CHART, not the totals: a task with hundreds of turns
 * still gets exact totals, and the series keeps the newest `turnLimit` points
 * with the remainder reported as one omitted count. Bounding by construction
 * rather than paginating is what keeps the tab cheap to open on a long task.
 */
export function buildTokenStats(
  turns: Turn[],
  session: Session | null,
  turnLimit: number,
): TaskTokenStats {
  return buildTokenStatsAcross([{ label: null, turns, session }], turnLimit);
}

/** One task's turns, for the multi-task form of {@link buildTokenStats}. */
export interface TurnGroup {
  /** The task these turns belong to. null = single-task view, no labelling. */
  label: string | null;
  turns: Turn[];
  session: Session | null;
}

/**
 * Per-turn and total token usage across one or more tasks.
 *
 * ONE GROUP is the single-task view and behaves exactly as it always has: turns
 * in `sequence` order, spans against the previous turn of any role.
 *
 * SEVERAL GROUPS is the subtree view, and the merge rule matters. Turn
 * SEQUENCES are per task — every task has a turn 1 — so ordering the merged
 * series by sequence would interleave unrelated conversations into nonsense.
 * The merged series is ordered by TIMESTAMP, which is the one axis the tasks
 * share, and the running `cumulative` is recomputed in that order so the growth
 * curve reads as the subtree's spend over time. Spans stay WITHIN a task, since
 * the gap from a child's last turn to a sibling's first is not a span of
 * anything.
 */
export function buildTokenStatsAcross(groups: TurnGroup[], turnLimit: number): TaskTokenStats {
  const points: TurnTokenPoint[] = [];
  let agentTurnCount = 0;

  for (const group of groups) {
    const agentTurns = group.turns
      .filter((t) => t.role === 'agent')
      .sort((a, b) => a.sequence - b.sequence);
    const byTimestamp = [...group.turns].sort((a, b) => a.timestamp - b.timestamp);
    agentTurnCount += agentTurns.length;

    let cursor = 0;
    let previous: Turn | undefined;
    for (const turn of agentTurns) {
      const usage: TokenTotals | null = turn.usage
        ? { ...turn.usage, total: totalOf(turn.usage) }
        : null;
      // Newest turn of any role strictly before this one. The pointer walks
      // forward once across the whole series rather than rescanning per turn.
      while (cursor < byTimestamp.length && byTimestamp[cursor].timestamp < turn.timestamp) {
        previous = byTimestamp[cursor];
        cursor++;
      }
      points.push({
        sequence: turn.sequence,
        timestamp: turn.timestamp,
        usage,
        // Filled in below, once the merged order is known.
        cumulative: 0,
        model: turn.model_id ?? turn.model ?? null,
        effort: turn.effort ?? null,
        agent: turn.agent ?? null,
        spanMs: previous ? turn.timestamp - previous.timestamp : null,
        taskLabel: group.label,
      });
    }
  }

  // A single group keeps its sequence order untouched — sorting it by timestamp
  // would silently reorder turns whose clock and sequence disagree.
  const all = groups.length > 1 ? points.sort((a, b) => a.timestamp - b.timestamp) : points;

  const totals = emptyTokenTotals();
  const byModel = new Map<string, { turns: number; totals: TokenTotals }>();
  let cumulative = 0;
  for (const point of all) {
    if (point.usage) {
      addUsage(totals, point.usage);
      cumulative += point.usage.total;
    }
    point.cumulative = cumulative;
    const key = point.model ?? UNKNOWN;
    const group = byModel.get(key) ?? { turns: 0, totals: emptyTokenTotals() };
    group.turns++;
    if (point.usage) addUsage(group.totals, point.usage);
    byModel.set(key, group);
  }

  const omitted = Math.max(0, all.length - turnLimit);
  const series = omitted > 0 ? all.slice(omitted) : all;
  const omittedTotal = omitted > 0 ? (all[omitted - 1]?.cumulative ?? 0) : 0;

  // The sessions' own running totals, summed — an independent check on the
  // per-turn arithmetic, and absent (rather than 0) when no session recorded one.
  const sessionTotal = emptyTokenTotals();
  let sawSessionTotal = false;
  for (const group of groups) {
    if (!group.session?.total_usage) continue;
    sawSessionTotal = true;
    addUsage(sessionTotal, group.session.total_usage);
  }

  return {
    agentTurns: agentTurnCount,
    turnsWithUsage: all.filter((p) => p.usage !== null).length,
    totals,
    series,
    omittedTurns: omitted,
    omittedTotal,
    sessionTotal: sawSessionTotal ? sessionTotal : null,
    byModel: [...byModel.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.totals.total - a.totals.total || b.turns - a.turns),
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolRow {
  name: string;
  /** DISTINCT `tool_use` blocks with this name across the audited requests. */
  invocations: number;
  /** Results for this tool that came back flagged as errors, when observed. */
  errors: number;
  /**
   * Tokens this tool's results added to the conversation, counted once per
   * call. Context size, not a share of the model bill — see
   * {@link buildToolStats}.
   */
  resultTokens: number;
  /** Distinct results for this tool that carried a token size. */
  resultsMeasured: number;
  /** Distinct results for this tool that did not — counted, never guessed at. */
  resultsUnmeasured: number;
}

export interface TaskToolStats {
  /**
   * Where these numbers came from, which is the difference between "this task's
   * whole life" and "a recent slice of it".
   *
   *  - `record` — the durable per-task record the proxy folds every forwarded
   *    request into (src/proxy/tool-stats.ts). Complete: nothing expires.
   *  - `window` — recomputed from the bounded, disposable audit log, which is
   *    what a time-sliced query (`lazy stats tools --since`) asks for. A
   *    renderer showing this MUST say it is a window.
   */
  source: 'record' | 'window';
  /** Proxied requests attributed to this task. */
  requests: number;
  /** Of those, how many carried usage we could read. */
  requestsWithUsage: number;
  /** Tokens the proxy observed for this task — independent of `Turn.usage`. */
  proxyTotals: TokenTotals;
  rows: ToolRow[];
  totalInvocations: number;
  /** Sum of the rows' `resultTokens` — attributed tool output in the window. */
  resultTokens: number;
  /** Distinct results in the window whose token size was not recorded. */
  resultsUnmeasured: number;
  /**
   * Tokens in results whose `tool_use` fell outside the retained window, so the
   * tool that produced them is unknown. Real tokens, deliberately not filed
   * under a guess — reported separately so the rows still add up honestly.
   */
  unattributedResultTokens: number;
  /** Oldest / newest audited record for this task, so the window is visible. */
  firstTs: number | null;
  lastTs: number | null;
}

/**
 * Tool usage for one task, recomputed from the proxy audit trail — a RECENT
 * WINDOW, and the answer only to a windowed question.
 *
 * The default reading is {@link toolStatsFromRecord}, over the durable record
 * the proxy keeps: it covers the task's whole life and nothing in it expires.
 * This one survives because a time-sliced query ("what did this task's tools
 * cost in the last two hours") is a different question, and the audit trail is
 * the only thing that can answer it. Any renderer showing this must say it is
 * a window; `TaskToolStats.source` is `'window'` here so it cannot forget.
 *
 * WHY THE AUDIT LOG.
 *
 * Per-tool data exists nowhere else: the stored turns keep the agent's text and
 * its usage totals, not its tool calls. The proxy records one
 * `ProxyAuditRecord` per forwarded request with the request body's `tool_use`
 * and `tool_result` blocks extracted, attributed by the `x-lazy-task-id` header.
 * The log is bounded by construction and disposable (see src/proxy/audit-log.ts):
 * a task older than the retained window has none, which is a recent-window view
 * and must be labelled as one. Nothing here moves the stream into Storage, which
 * CLAUDE.md forbids.
 *
 * EVERY REQUEST REPLAYS THE WHOLE CONVERSATION, SO EVERYTHING IS DEDUPED BY
 * `tool_use` ID. The audited body is the full messages array, so a tool called
 * on turn 3 appears again in every request after it. Measured on a real log:
 * one task's window held 3,966 `tool_use` blocks and 142 distinct ids — a 28×
 * inflation. Counting raw blocks answers "how many requests happened after this
 * call", which is not a tool statistic at all. A block with no id cannot be
 * deduped and is counted once per record it appears in; the API always sends
 * one, so this is the malformed case, not a path.
 *
 * WHAT THE TOKEN COLUMN IS, AND IS NOT. It is the size of each tool's RESULTS
 * — the output that tool pushed into the conversation — summed once per call,
 * from `ProxyToolResultAudit.contentTokens` which the proxy measures against
 * the `tool_use` id the result answers (src/proxy/tool-result-tokens.ts). It is
 * a CONTEXT-SIZE measurement, not a share of the model bill: nothing here
 * splits a request's usage across the tools it carried, because usage is per
 * request and a response routinely asks for several tools at once — that split
 * would be an invention, and it stays one. Results whose size was never
 * recorded are counted in `resultsUnmeasured` rather than assumed to be zero,
 * and results whose call fell outside the window land in
 * `unattributedResultTokens` rather than under a guessed tool name.
 */
export function buildToolStats(
  records: ProxyAuditRecord[],
  taskId: string,
): TaskToolStats {
  // The header carries whatever id the launch had; a stats page has the full
  // one. Either being a prefix of the other is the same match `lazy stats
  // tokens --task` makes, and an empty id never matches anything.
  const mine = records.filter((r) => {
    const id = r.taskId;
    return Boolean(id) && (taskId.startsWith(id as string) || (id as string).startsWith(taskId));
  });
  const proxyTotals = emptyTokenTotals();
  const counts = new Map<string, ToolRow>();
  let requestsWithUsage = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  // tool_use id → tool name, across every audited request. A tool_result
  // arrives on a LATER request than the tool_use it answers, so errors can
  // only be attributed after all the calls are known.
  const toolNameById = new Map<string, string>();
  for (const record of mine) {
    for (const use of record.toolUses) {
      if (use.id) toolNameById.set(use.id, use.name);
    }
  }

  // Ids already counted. The same call reappears in every later request's
  // replayed history; it is one invocation, and one result.
  const countedUses = new Set<string>();
  const countedResults = new Set<string>();
  let unattributedResultTokens = 0;
  let resultsUnmeasured = 0;

  const rowFor = (name: string): ToolRow => {
    let row = counts.get(name);
    if (!row) {
      row = { name, invocations: 0, errors: 0, resultTokens: 0, resultsMeasured: 0, resultsUnmeasured: 0 };
      counts.set(name, row);
    }
    return row;
  };

  for (const record of mine) {
    if (firstTs === null || record.ts < firstTs) firstTs = record.ts;
    if (lastTs === null || record.ts > lastTs) lastTs = record.ts;
    if (record.usage) {
      requestsWithUsage++;
      proxyTotals.inputTokens += record.usage.inputTokens ?? 0;
      proxyTotals.outputTokens += record.usage.outputTokens ?? 0;
      proxyTotals.cacheCreationTokens += record.usage.cacheCreationInputTokens ?? 0;
      proxyTotals.cacheReadTokens += record.usage.cacheReadInputTokens ?? 0;
    }
    for (const use of record.toolUses) {
      if (use.id !== null) {
        if (countedUses.has(use.id)) continue;
        countedUses.add(use.id);
      }
      rowFor(use.name).invocations++;
    }
  }

  // One pass over every observed result, attributed through the id map above,
  // and likewise deduped: a result is one piece of output however many requests
  // carried it. A result whose call is outside the retained window has no name,
  // so its tokens are reported separately rather than filed under a guess.
  for (const record of mine) {
    for (const result of record.toolResults) {
      if (!result.toolUseId || countedResults.has(result.toolUseId)) continue;
      countedResults.add(result.toolUseId);

      const name = toolNameById.get(result.toolUseId);
      const row = name ? counts.get(name) : undefined;
      const tokens = result.contentTokens ?? null;

      if (!row) {
        if (tokens !== null) unattributedResultTokens += tokens;
        continue;
      }
      if (result.isError) row.errors++;
      if (tokens === null) {
        row.resultsUnmeasured++;
        resultsUnmeasured++;
      } else {
        row.resultsMeasured++;
        row.resultTokens += tokens;
      }
    }
  }

  proxyTotals.total = totalOf(proxyTotals);
  const rows = rankToolRows([...counts.values()]);
  return {
    source: 'window',
    requests: mine.length,
    requestsWithUsage,
    proxyTotals,
    rows,
    totalInvocations: rows.reduce((sum, r) => sum + r.invocations, 0),
    resultTokens: rows.reduce((sum, r) => sum + r.resultTokens, 0),
    resultsUnmeasured,
    unattributedResultTokens,
    firstTs,
    lastTs,
  };
}

/**
 * Ordered by what the reader came for: the tool that put the most into the
 * context first, falling back to call count when nothing was measured.
 */
function rankToolRows(rows: ToolRow[]): ToolRow[] {
  return [...rows].sort(
    (a, b) =>
      b.resultTokens - a.resultTokens ||
      b.invocations - a.invocations ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Split audit records between the tasks they are attributed to.
 *
 * Same match `buildToolStats` makes (either id a prefix of the other, since the
 * header carries whatever id the launch had), memoized per distinct header
 * value so a subtree of fifty tasks costs one pass over the trail rather than
 * fifty. A record matching no task in the set is dropped: it belongs to some
 * other task's conversation.
 */
export function partitionAuditRecordsByTask(
  records: ProxyAuditRecord[],
  taskIds: string[],
): Map<string, ProxyAuditRecord[]> {
  const out = new Map<string, ProxyAuditRecord[]>(taskIds.map((id) => [id, []]));
  const resolved = new Map<string, string | null>();
  for (const record of records) {
    const header = record.taskId;
    if (!header) continue;
    let owner = resolved.get(header);
    if (owner === undefined) {
      owner = taskIds.find((id) => id.startsWith(header) || header.startsWith(id)) ?? null;
      resolved.set(header, owner);
    }
    if (owner) out.get(owner)!.push(record);
  }
  return out;
}

/**
 * Add per-task tool tables together, merging rows by tool name.
 *
 * Deliberately a merge over whatever produced each part rather than a second
 * derivation over the raw records — and the part that anticipated has since
 * happened: the per-task rows now come from a durable record
 * ({@link toolStatsFromRecord}), and this composes with that exactly as it did
 * with {@link buildToolStats}, because only the shape matters. The dedup that
 * makes a row honest is keyed on `tool_use` ids WITHIN one conversation, so ids
 * never collide between tasks and summing is exactly right.
 *
 * `source` is the WEAKER of the parts': a subtree in which even one task only
 * has a windowed reading is a windowed reading, and must not be labelled as
 * covering those tasks' whole lives.
 */
export function mergeToolStats(parts: TaskToolStats[]): TaskToolStats {
  const rowsByName = new Map<string, ToolRow>();
  const proxyTotals = emptyTokenTotals();
  let requests = 0;
  let requestsWithUsage = 0;
  let resultsUnmeasured = 0;
  let unattributedResultTokens = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const part of parts) {
    requests += part.requests;
    requestsWithUsage += part.requestsWithUsage;
    resultsUnmeasured += part.resultsUnmeasured;
    unattributedResultTokens += part.unattributedResultTokens;
    addUsage(proxyTotals, part.proxyTotals);
    if (part.firstTs !== null && (firstTs === null || part.firstTs < firstTs)) firstTs = part.firstTs;
    if (part.lastTs !== null && (lastTs === null || part.lastTs > lastTs)) lastTs = part.lastTs;
    for (const row of part.rows) {
      const merged = rowsByName.get(row.name);
      if (!merged) {
        rowsByName.set(row.name, { ...row });
        continue;
      }
      merged.invocations += row.invocations;
      merged.errors += row.errors;
      merged.resultTokens += row.resultTokens;
      merged.resultsMeasured += row.resultsMeasured;
      merged.resultsUnmeasured += row.resultsUnmeasured;
    }
  }

  const rows = rankToolRows([...rowsByName.values()]);
  return {
    source: parts.some((p) => p.source === 'window') ? 'window' : 'record',
    requests,
    requestsWithUsage,
    proxyTotals,
    rows,
    totalInvocations: rows.reduce((sum, r) => sum + r.invocations, 0),
    resultTokens: rows.reduce((sum, r) => sum + r.resultTokens, 0),
    resultsUnmeasured,
    unattributedResultTokens,
    firstTs,
    lastTs,
  };
}

/**
 * Tool usage for one task, from its DURABLE record — the default reading.
 *
 * The proxy folds every forwarded request into that record as it goes
 * (src/proxy/tool-stats.ts), so this covers the task's whole life and nothing
 * in it expires. That is the difference from {@link buildToolStats}, which
 * recomputes the same shape from the bounded audit log and is therefore a
 * recent window; both produce a `TaskToolStats` and the `source` field says
 * which, so the two renderers over this shape stay honest about what they show.
 *
 * Every honesty rule the window derivation encodes is preserved here, because
 * the fold applies the same ones as it writes: a call replayed in later
 * requests is one call, a result with no recorded size is counted as unmeasured
 * rather than as zero, a result whose call was never observed is unattributed
 * rather than filed under a guessed tool name, and no request's usage is ever
 * split across the tools it carried.
 */
export function toolStatsFromRecord(record: TaskToolStatsRecord): TaskToolStats {
  const proxyTotals: TokenTotals = {
    inputTokens: record.proxy_usage.inputTokens,
    outputTokens: record.proxy_usage.outputTokens,
    cacheCreationTokens: record.proxy_usage.cacheCreationTokens,
    cacheReadTokens: record.proxy_usage.cacheReadTokens,
    total: 0,
  };
  proxyTotals.total = totalOf(proxyTotals);

  const rows = rankToolRows(
    record.tools.map((tool) => ({
      name: tool.name,
      invocations: tool.invocations,
      errors: tool.errors,
      resultTokens: tool.resultTokens,
      resultsMeasured: tool.resultsMeasured,
      resultsUnmeasured: tool.resultsUnmeasured,
    })),
  );

  return {
    source: 'record',
    requests: record.requests,
    requestsWithUsage: record.requests_with_usage,
    proxyTotals,
    rows,
    totalInvocations: rows.reduce((sum, r) => sum + r.invocations, 0),
    resultTokens: rows.reduce((sum, r) => sum + r.resultTokens, 0),
    resultsUnmeasured: rows.reduce((sum, r) => sum + r.resultsUnmeasured, 0),
    unattributedResultTokens: record.unattributed_result_tokens,
    firstTs: record.first_ts,
    lastTs: record.last_ts,
  };
}

// ---------------------------------------------------------------------------
// The rollup
// ---------------------------------------------------------------------------

/** Default bound on the charted series. Totals are always exact. */
export const DEFAULT_TURN_CHART_LIMIT = 80;

/** Everything one task contributes to a readout. */
export interface TaskStatsPart {
  task: Task;
  session: Session | null;
  turns: Turn[];
  commits: Commit[];
  statusHistory: StatusChange[];
}

export interface TaskStatsInput extends TaskStatsPart {
  /**
   * Direct children's status histories. Absent = not loaded, which renders as
   * "not derived" rather than as zero.
   */
  childHistories?: Map<string, StatusChange[]>;
  /**
   * The task's durable tool-stats record. `null` = none exists (the task ran
   * before the proxy kept them, or its traffic never went through the proxy);
   * `undefined` = it was not read for this render. The two are different
   * answers and the renderer says which.
   */
  toolStatsRecord?: TaskToolStatsRecord | null;
  now?: number;
  turnChartLimit?: number;
}

/**
 * What a subtree view folded in, and what its time numbers mean.
 *
 * The wall clocks in {@link TaskTimeStats} are a UNION over the subtree: the
 * running figure is the time during which at least one task was running, and
 * the awaiting and backlog figures have the higher-priority unions cut out of
 * them, so the three still divide one elapsed window instead of overlapping.
 * That is the only way to add wall clocks that overlap by design — a cluster
 * parent sits in `working` for exactly as long as its children do.
 *
 * The SUMMED figures are here too, unnormalised, because they answer a
 * different and also real question: how much task-time the effort consumed, as
 * a timesheet would count it. `overlappedRunningMs` is the difference — the
 * parallelism the union hides.
 */
export interface SubtreeRollup {
  /** Tasks the numbers cover, the root included. */
  tasks: number;
  /** Tasks below the root, at every depth. */
  descendants: number;
  /** How many of them have any recorded status history. */
  tasksWithHistory: number;
  /** Per-task running wall clocks added up — parallel work counted once each. */
  summedRunningMs: number;
  summedAwaitingMs: number;
  summedBacklogMs: number;
  /** `summedRunningMs` − the union: wall clock two or more tasks shared. */
  overlappedRunningMs: number;
  /**
   * The ROOT task's own running wall clock, alone — not the union, not the sum.
   *
   * The denominator for `subtaskRunningMs`, and it exists because getting that
   * wrong is invisible. That figure is the root's own running time that
   * overlapped a descendant's, so the only whole it is a share OF is this one.
   * Dividing it by `summedRunningMs` — which folds in every descendant's clock
   * — answers a question nobody asked and always understates, worst on exactly
   * the deep trees where somebody is asking.
   *
   * Carried rather than re-derived: the root's running spans are already in
   * hand while the union is assembled, and a renderer that recomputed this
   * would need the per-task spans the payload deliberately does not ship.
   */
  rootRunningMs: number;
}

export interface TaskStats {
  /** Whether this covers one task or that task plus every descendant. */
  scope: StatsScope;
  time: TaskTimeStats;
  tokens: TaskTokenStats;
  /**
   * null means NO NUMBERS EXIST for this task — it has no durable record. It
   * never means "this task used no tools", and the renderer must not print it
   * as a zero.
   */
  tools: TaskToolStats | null;
  turns: { total: number; agent: number; human: number };
  commits: number;
  /** Direct children of the task the readout is about. */
  children: number;
  /** Tasks below it at every depth. 0 in `task` scope — nothing was folded in. */
  descendants: number;
  /** Present only in `subtree` scope: what was folded in, and how time was combined. */
  subtree: SubtreeRollup | null;
}

export function buildTaskStats(input: TaskStatsInput): TaskStats {
  const now = input.now ?? Date.now();
  const { task } = input;
  const terminal = isTerminalStatus(task.status);
  const endAt = partEndAt(input, now);

  const buckets = statusIntervals(task.created_at, input.statusHistory, Math.max(endAt, task.created_at));

  let subtaskRunningMs: number | null = null;
  if (input.childHistories && input.childHistories.size > 0) {
    const parentRunning = bucketIntervals(input.statusHistory, 'running', endAt);
    const childRunning: Interval[] = [];
    for (const history of input.childHistories.values()) {
      childRunning.push(...bucketIntervals(history, 'running', endAt));
    }
    subtaskRunningMs = overlapMs(parentRunning, childRunning);
  }

  const turnLimit = input.turnChartLimit ?? DEFAULT_TURN_CHART_LIMIT;
  return {
    scope: 'task',
    time: {
      createdAt: task.created_at,
      lastActivityAt: lastEventAt(input),
      elapsedMs: Math.max(0, endAt - task.created_at),
      runningMs: buckets.get('running') ?? 0,
      awaitingMs: buckets.get('awaiting') ?? 0,
      backlogMs: buckets.get('backlog') ?? 0,
      // One task's lifetime is fully partitioned by the three buckets.
      idleMs: 0,
      subtaskRunningMs,
      live: !terminal,
      transitions: input.statusHistory.length,
    },
    tokens: buildTokenStats(input.turns, input.session, turnLimit),
    tools: input.toolStatsRecord ? toolStatsFromRecord(input.toolStatsRecord) : null,
    turns: countTurns(input.turns),
    commits: input.commits.length,
    children: input.childHistories?.size ?? 0,
    descendants: 0,
    subtree: null,
  };
}

export interface SubtreeStatsInput {
  /** The task the readout is about. */
  root: TaskStatsPart;
  /** Every descendant, at every depth. Order is irrelevant. */
  descendants: TaskStatsPart[];
  /**
   * Each task's durable tool-stats record, by task id. A task absent from the
   * map, or mapped to null, simply has none and contributes nothing — that is
   * not an error, and it is not a zero either. `null`/`undefined` for the whole
   * map means no records were read for this call.
   */
  toolStatsRecords?: Map<string, TaskToolStatsRecord | null> | null;
  now?: number;
  turnChartLimit?: number;
}

/**
 * The same stats over a task AND every descendant.
 *
 * Counts, tokens, commits and the per-tool table are sums, because they measure
 * things that happened once each. TIME IS A UNION, because it does not: see
 * {@link SubtreeRollup}. `subtaskRunningMs` keeps its meaning — the root's own
 * running time that overlapped a descendant's — widened from direct children to
 * the whole subtree, which for a release hub is the difference between "waited
 * on one child" and "waited on the work".
 */
export function buildSubtreeStats(input: SubtreeStatsInput): TaskStats {
  const now = input.now ?? Date.now();
  const parts = [input.root, ...input.descendants];
  const turnLimit = input.turnChartLimit ?? DEFAULT_TURN_CHART_LIMIT;

  const spansOf = new Map<string, Map<TimeBucket, Interval[]>>();
  const running: Interval[] = [];
  const awaiting: Interval[] = [];
  const backlog: Interval[] = [];
  let summedRunningMs = 0;
  let summedAwaitingMs = 0;
  let summedBacklogMs = 0;
  let transitions = 0;
  let tasksWithHistory = 0;
  let createdAt = input.root.task.created_at;
  let endAt = createdAt;
  let live = false;

  for (const part of parts) {
    const partEnd = Math.max(partEndAt(part, now), part.task.created_at);
    const spans = statusSpans(part.task.created_at, part.statusHistory, partEnd);
    spansOf.set(part.task.id, spans);
    running.push(...(spans.get('running') ?? []));
    awaiting.push(...(spans.get('awaiting') ?? []));
    backlog.push(...(spans.get('backlog') ?? []));
    summedRunningMs += intervalsLength(spans.get('running') ?? []);
    summedAwaitingMs += intervalsLength(spans.get('awaiting') ?? []);
    summedBacklogMs += intervalsLength(spans.get('backlog') ?? []);
    transitions += part.statusHistory.length;
    if (part.statusHistory.length > 0) tasksWithHistory++;
    if (part.task.created_at < createdAt) createdAt = part.task.created_at;
    if (partEnd > endAt) endAt = partEnd;
    if (!isTerminalStatus(part.task.status)) live = true;
  }

  // Priority over the union: running beats awaiting beats backlog, so the three
  // divide the elapsed window instead of triple-counting the same minute.
  const runningU = mergeIntervals(running);
  const awaitingU = subtractIntervals(awaiting, runningU);
  const backlogU = subtractIntervals(backlog, [...runningU, ...awaitingU]);
  const runningMs = intervalsLength(runningU);
  const awaitingMs = intervalsLength(awaitingU);
  const backlogMs = intervalsLength(backlogU);
  const elapsedMs = Math.max(0, endAt - createdAt);

  const descendantRunning: Interval[] = [];
  for (const part of input.descendants) {
    descendantRunning.push(...(spansOf.get(part.task.id)?.get('running') ?? []));
  }
  const rootRunning = spansOf.get(input.root.task.id)?.get('running') ?? [];
  const rootRunningMs = intervalsLength(rootRunning);
  const subtaskRunningMs = input.descendants.length
    ? overlapMs(rootRunning, descendantRunning)
    : null;

  const rootId = input.root.task.id;
  const children = input.descendants.filter((p) => parentTaskIdOf(p.task) === rootId).length;

  // Only the tasks that HAVE a record are folded in. A subtree where none of
  // them does has no numbers at all, which the renderer states as such — summing
  // nothing into a zeroed table would claim the whole subtree called no tools.
  let tools: TaskToolStats | null = null;
  if (input.toolStatsRecords) {
    const records = parts
      .map((p) => input.toolStatsRecords!.get(p.task.id) ?? null)
      .filter((r): r is TaskToolStatsRecord => r !== null);
    if (records.length > 0) tools = mergeToolStats(records.map(toolStatsFromRecord));
  }

  const allTurns = parts.flatMap((p) => p.turns);
  return {
    scope: 'subtree',
    time: {
      createdAt,
      lastActivityAt: lastEventAt({
        turns: allTurns,
        commits: parts.flatMap((p) => p.commits),
        statusHistory: parts.flatMap((p) => p.statusHistory),
      }),
      elapsedMs,
      runningMs,
      awaitingMs,
      backlogMs,
      idleMs: Math.max(0, elapsedMs - runningMs - awaitingMs - backlogMs),
      subtaskRunningMs,
      live,
      transitions,
    },
    tokens: buildTokenStatsAcross(
      parts.map((p) => ({ label: displayId(p.task), turns: p.turns, session: p.session })),
      turnLimit,
    ),
    tools,
    turns: countTurns(allTurns),
    commits: parts.reduce((sum, p) => sum + p.commits.length, 0),
    children,
    descendants: input.descendants.length,
    subtree: {
      tasks: parts.length,
      descendants: input.descendants.length,
      tasksWithHistory,
      summedRunningMs,
      summedAwaitingMs,
      summedBacklogMs,
      overlappedRunningMs: Math.max(0, summedRunningMs - runningMs),
      rootRunningMs,
    },
  };
}

function countTurns(turns: Turn[]): { total: number; agent: number; human: number } {
  return {
    total: turns.length,
    agent: turns.filter((t) => t.role === 'agent').length,
    human: turns.filter((t) => t.role === 'human').length,
  };
}

/** Where a task's clock stops: completion for a terminal task, now otherwise. */
function partEndAt(part: TaskStatsPart, now: number): number {
  if (!isTerminalStatus(part.task.status)) return now;
  return part.task.completed_at ?? lastEventAt(part) ?? now;
}

/**
 * Newest recorded event of any kind, or null.
 *
 * A fold rather than `Math.max(...stamps)`: a subtree rollup passes every turn
 * of every descendant through here, and spreading a six-figure array into a
 * call blows the argument limit on a task tree large enough to want this view.
 */
function lastEventAt(input: Pick<TaskStatsInput, 'turns' | 'commits' | 'statusHistory'>): number | null {
  let newest: number | null = null;
  const consider = (ts: number): void => {
    if (newest === null || ts > newest) newest = ts;
  };
  for (const turn of input.turns) consider(turn.timestamp);
  for (const commit of input.commits) consider(commit.timestamp);
  for (const change of input.statusHistory) consider(change.timestamp);
  return newest;
}
