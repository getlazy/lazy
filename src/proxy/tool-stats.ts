/**
 * Durable per-task tool statistics, folded on the proxy's own path.
 *
 * WHY THIS EXISTS. Per-tool numbers used to be recomputed on read from the
 * proxy audit trail, which is bounded and disposable by design
 * (src/proxy/audit-log.ts): once a task's requests rotated out, the Stats tab
 * and `lazy stats tools` had nothing left to show and said so. The numbers
 * themselves are tiny and monotonic, so they are kept instead — a small
 * per-task record (`TaskToolStatsRecord`) the proxy folds each forwarded
 * request into as it goes. The audit log is untouched and stays exactly the
 * carve-out CLAUDE.md describes; nothing here moves that stream into Storage.
 *
 * THE HARD PART IS NOT DOUBLE COUNTING. Every request re-sends the entire
 * conversation, so one `tool_use` block appears in every later request — on a
 * real log, 142 distinct calls appeared as 3,966 blocks, a 28× inflation. The
 * read-time derivation could dedupe by id because it held the whole window at
 * once. A running aggregate cannot: it sees one request at a time and may not
 * keep an unbounded set of every id the task ever produced.
 *
 * Three bounded rules do it instead, and they compose:
 *
 *  1. THE TAIL. A block is only a candidate if the extractor marked it as the
 *     conversation tail — a `tool_use` in the request's LAST assistant message,
 *     a `tool_result` after it. Replayed history is never in the tail, so the
 *     28× inflation is gone with no per-id state at all.
 *  2. THE RECENT RING. The tail can still repeat: a retried request replays it
 *     verbatim, and appending a plain user message leaves the previous
 *     response as the last assistant message. So the last
 *     TOOL_STATS_RECENT_CAP ids counted are remembered and skipped. Small,
 *     because a repeat can only be a few requests old — a block older than the
 *     ring is by construction not in the tail any more.
 *  3. AWAITING. A counted call whose result has not arrived sits in `awaiting`
 *     (id → tool name), which is what attributes the result when it does. It
 *     is normally one or two entries deep: the results of a turn's calls come
 *     back on the very next request.
 *
 * A result whose id is in neither `awaiting` nor the ring is REAL OUTPUT WITH
 * NO KNOWN TOOL — the proxy started mid-conversation, say. Its tokens are
 * counted as unattributed and never guessed at a tool name, exactly as the
 * read-time derivation did.
 *
 * All three structures are capped, so the record's size is bounded whatever the
 * task does, which is the condition for storing it at all.
 *
 * WRITES NEVER TOUCH THE REQUEST. `observe()` is synchronous and returns
 * immediately; the load-fold-save runs on a per-task promise chain behind it.
 * A storage failure is logged and dropped — a task's statistics are never worth
 * failing or delaying the request they describe.
 */

import type { ProxyAuditRecord, TaskToolStatsRecord, ToolStatEntry } from '../storage/types';
import { logger } from '../utils/logger';

/**
 * Calls remembered while waiting for their result.
 *
 * Deep enough that a result arriving many turns late still lands on its tool
 * (parallel calls, a client that batches); small enough that a pathological
 * session cannot grow the record. Oldest entries are evicted first, and an
 * evicted call keeps its invocation — only the attribution of its result is
 * lost, and that lands in `unattributed` rather than under a guess.
 */
export const TOOL_STATS_AWAITING_CAP = 512;

/** Depth of the recently-counted id rings. See rule 2 above. */
export const TOOL_STATS_RECENT_CAP = 256;

/**
 * Tasks whose record the recorder keeps in memory, oldest evicted first.
 *
 * The cache exists only to make the steady state one write rather than a read
 * and a write; evicting a record costs a re-read, never a number. A daemon that
 * has served hundreds of tasks must not hold all of their records forever.
 */
export const TOOL_STATS_CACHED_TASKS = 64;

export function emptyToolStatsRecord(taskId: string): TaskToolStatsRecord {
  return {
    version: 1,
    task_id: taskId,
    updated_at: 0,
    first_ts: null,
    last_ts: null,
    requests: 0,
    requests_with_usage: 0,
    proxy_usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    tools: [],
    unattributed_results: 0,
    unattributed_result_tokens: 0,
    awaiting: [],
    recent_use_ids: [],
    recent_result_ids: [],
  };
}

/** Push onto a capped ring, oldest first. */
function ring(ids: string[], id: string, cap: number): void {
  ids.push(id);
  if (ids.length > cap) ids.splice(0, ids.length - cap);
}

function entryFor(record: TaskToolStatsRecord, name: string, ts: number): ToolStatEntry {
  let entry = record.tools.find((t) => t.name === name);
  if (!entry) {
    entry = {
      name,
      invocations: 0,
      errors: 0,
      resultTokens: 0,
      resultsMeasured: 0,
      resultsUnmeasured: 0,
      firstSeen: ts,
      lastSeen: ts,
    };
    record.tools.push(entry);
  }
  if (ts < entry.firstSeen) entry.firstSeen = ts;
  if (ts > entry.lastSeen) entry.lastSeen = ts;
  return entry;
}

/**
 * Fold one audited request into a task's running tool statistics, in place.
 *
 * Pure and synchronous: the caller owns loading and saving. Idempotency is NOT
 * claimed for an arbitrary replay of the same record — it is claimed for the
 * replay that actually happens on the wire, which is the same conversation
 * being re-sent, and that is what rules 1-3 above cover.
 */
export function foldAuditRecord(record: TaskToolStatsRecord, audit: ProxyAuditRecord): void {
  const ts = audit.ts;
  record.requests++;
  record.updated_at = Math.max(record.updated_at, ts);
  if (record.first_ts === null || ts < record.first_ts) record.first_ts = ts;
  if (record.last_ts === null || ts > record.last_ts) record.last_ts = ts;

  if (audit.usage) {
    record.requests_with_usage++;
    record.proxy_usage.inputTokens += audit.usage.inputTokens ?? 0;
    record.proxy_usage.outputTokens += audit.usage.outputTokens ?? 0;
    record.proxy_usage.cacheCreationTokens += audit.usage.cacheCreationInputTokens ?? 0;
    record.proxy_usage.cacheReadTokens += audit.usage.cacheReadInputTokens ?? 0;
  }

  const awaiting = new Map(record.awaiting.map((a) => [a.id, a.name] as const));
  const countedUses = new Set(record.recent_use_ids);
  const filedResults = new Set(record.recent_result_ids);

  // --- New calls: the tail, minus anything already counted ---
  for (const use of audit.toolUses) {
    // A block with no id cannot be deduped at all. The API always sends one, so
    // this is the malformed case: skip it rather than count a call that every
    // later request would count again.
    if (!use.tail || use.id === null) continue;
    if (countedUses.has(use.id) || awaiting.has(use.id)) continue;

    entryFor(record, use.name, ts).invocations++;
    countedUses.add(use.id);
    ring(record.recent_use_ids, use.id, TOOL_STATS_RECENT_CAP);
    awaiting.set(use.id, use.name);
  }

  // --- New results: the tail, attributed through `awaiting` ---
  for (const result of audit.toolResults) {
    const id = result.toolUseId;
    if (!result.tail || id === null) continue;
    if (filedResults.has(id)) continue;

    const name = awaiting.get(id);
    const tokens = result.contentTokens ?? null;
    filedResults.add(id);
    ring(record.recent_result_ids, id, TOOL_STATS_RECENT_CAP);

    if (name === undefined) {
      // Real output whose call this record never saw. Counted honestly rather
      // than filed under a guessed tool name.
      record.unattributed_results++;
      if (tokens !== null) record.unattributed_result_tokens += tokens;
      continue;
    }
    awaiting.delete(id);

    const entry = entryFor(record, name, ts);
    if (result.isError) entry.errors++;
    if (tokens === null) entry.resultsUnmeasured++;
    else {
      entry.resultsMeasured++;
      entry.resultTokens += tokens;
    }
  }

  // Oldest-first eviction keeps the cap exact; insertion order is the age order.
  const pending = [...awaiting.entries()].map(([id, name]) => ({ id, name }));
  record.awaiting =
    pending.length > TOOL_STATS_AWAITING_CAP
      ? pending.slice(pending.length - TOOL_STATS_AWAITING_CAP)
      : pending;
}

/** The two Storage methods this recorder needs. Keeps it testable with a stub. */
export interface ToolStatsStore {
  getToolStats(taskId: string): Promise<TaskToolStatsRecord | null>;
  saveToolStats(record: TaskToolStatsRecord): Promise<void>;
}

/**
 * Folds audited requests into each task's durable record, off the request path.
 *
 * One promise chain per task serialises that task's read-modify-write, so two
 * in-flight requests for the same task cannot lose each other's fold. Chains
 * for different tasks run independently — there is no global queue to back up.
 */
export class ProxyToolStatsRecorder {
  private readonly store: ToolStatsStore;
  private readonly chains = new Map<string, Promise<void>>();
  /** Loaded records, kept so the steady state is one write, not a read+write. */
  private readonly cache = new Map<string, TaskToolStatsRecord>();
  private lastFailure: string | null = null;

  constructor(store: ToolStatsStore) {
    this.store = store;
  }

  /**
   * Fold one record. Returns immediately — nothing here is ever awaited by the
   * request being audited.
   */
  observe(audit: ProxyAuditRecord): void {
    const taskId = audit.taskId;
    // No task, no record to file it against. Builder traffic and unattributed
    // requests are deliberately not aggregated anywhere.
    if (!taskId) return;
    // Nothing to learn from a request that carried neither tools nor usage —
    // a refusal, a count_tokens call, a failed forward. Skipping them keeps
    // `requests` meaning "requests this task's conversation actually made".
    if (!audit.toolUses.length && !audit.toolResults.length && !audit.usage) return;

    const previous = this.chains.get(taskId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const record = await this.load(taskId);
        foldAuditRecord(record, audit);
        await this.store.saveToolStats(record);
        this.lastFailure = null;
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        // Statistics are never worth a repeated warning per request. Report
        // each distinct failure once; a sustained one is reported when it
        // changes or when it stops.
        if (message !== this.lastFailure) {
          this.lastFailure = message;
          logger.warn(
            `[proxy] tool stats for task ${taskId.slice(0, 8)} not recorded: ${message}. ` +
              `Requests are unaffected; the Stats tab will be short by these calls.`,
          );
        }
        // Drop the cached record: it holds a fold that never reached storage,
        // so continuing from it would make the file and memory disagree.
        this.cache.delete(taskId);
      })
      .finally(() => {
        // Let a finished task's chain go. Only if it is still the newest — a
        // request that arrived while this one ran owns the entry now.
        if (this.chains.get(taskId) === next) this.chains.delete(taskId);
      });
    this.chains.set(taskId, next);
  }

  private async load(taskId: string): Promise<TaskToolStatsRecord> {
    const cached = this.cache.get(taskId);
    if (cached) {
      // Refresh its position: Map keeps insertion order, which is the age order
      // the eviction below walks.
      this.cache.delete(taskId);
      this.cache.set(taskId, cached);
      return cached;
    }
    const stored = await this.store.getToolStats(taskId);
    const record = stored ?? emptyToolStatsRecord(taskId);
    this.cache.set(taskId, record);
    while (this.cache.size > TOOL_STATS_CACHED_TASKS) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    return record;
  }

  /** Wait for every in-flight fold to settle. Tests and shutdown. */
  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }
}
