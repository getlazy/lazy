/**
 * Per-turn latency rollups kept in the store (src/task/turn-latency.ts).
 *
 * The audit trail rotates away after a week; these are what lets providers and
 * models be compared over any period. What is pinned here is what makes them
 * worth keeping: histograms merge EXACTLY, percentiles stay within the agreed
 * error, the guards keep absurd values out, and a request is counted once —
 * a refused tier attempt, a count_tokens call or a cancelled stream never
 * inflates the numbers.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage/file-storage';
import {
  classifyAudit,
  emptyHistogram,
  emptyRollup,
  foldAudit,
  latencyHistory,
  mergeHistogram,
  mergeRollup,
  observe,
  percentile,
  stddev,
  summarizeTurn,
  TIME_SCALE,
  TPS_SCALE,
  totalEntry,
  turnWallMs,
  rollupShapeProblem,
  latencyRowLabel,
} from '../../src/task/turn-latency';
import { ProxyTurnLatencyRecorder, setActiveTurnLatencyRecorder } from '../../src/proxy/turn-latency-recorder';
import { createAgentTurn } from '../../src/daemon/turn-owner';
import { formatTurnLaunchLabels } from '../../src/utils/turn-labels';
import { loadTaskStats } from '../../src/task/stats-data';
import { statsTabHtml } from '../../src/server/stats-tab';
import type { ProxyAuditRecord } from '../../src/storage/types';

const T0 = new Date('2026-10-11T00:00:00Z').getTime();
let seq = 0;
function audit(over: Partial<ProxyAuditRecord> = {}): ProxyAuditRecord {
  seq++;
  return {
    id: `a-${seq}`,
    seq,
    ts: T0 + seq * 1000,
    role: 'agent',
    taskId: 'task-1111',
    backend: 'anthropic',
    upstream: 'https://api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    endpoint: 'messages',
    model: 'claude-opus-5-5',
    tier: 'opus',
    stream: true,
    requestShape: null,
    toolUses: [],
    toolResults: [],
    status: 200,
    usage: { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 1000, cacheCreationInputTokens: 10 },
    stopReason: 'end_turn',
    error: null,
    durationMs: 300,
    ttftMs: 800,
    ttltMs: 4000,
    reroute: null,
    ...over,
  } as unknown as ProxyAuditRecord;
}

/** Deterministic pseudo-random values across the time scale. */
function samples(n: number, seed: number): number[] {
  let x = seed;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(20 * Math.exp((x / 2147483648) * 9)); // 20 ms … ~160 s, log-uniform
  }
  return out;
}

function exactQuantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

describe('histograms', () => {
  // INVARIANT: merging histograms is exact — the merge of two halves equals the
  // histogram of the whole, bucket for bucket. That is what lets per-turn
  // rollups combine into any period, task set or endpoint group.
  test('merge of two halves equals the histogram of the whole', () => {
    const values = samples(500, 7);
    const whole = emptyHistogram();
    const a = emptyHistogram();
    const b = emptyHistogram();
    values.forEach((v, i) => {
      observe(whole, TIME_SCALE, v);
      observe(i % 2 ? a : b, TIME_SCALE, v);
    });
    const merged = emptyHistogram();
    mergeHistogram(merged, a);
    mergeHistogram(merged, b);
    expect(merged.buckets).toEqual(whole.buckets);
    expect(merged.count).toBe(whole.count);
    expect(merged.min).toBe(whole.min);
    expect(merged.max).toBe(whole.max);
    expect(merged.sum).toBeCloseTo(whole.sum, 6);
    expect(merged.sumsq).toBeCloseTo(whole.sumsq, 0);
    expect(stddev(merged)).toBeCloseTo(stddev(whole)!, 6);
  });

  // INVARIANT: p5/p50/p95 from the buckets are within ±16% of the exact
  // quantile (half a bucket's ratio, √1.354). The engineer accepted ~±15%.
  test('percentiles stay within the agreed error', () => {
    for (const seed of [1, 2, 3, 4]) {
      const values = samples(2000, seed);
      const h = emptyHistogram();
      values.forEach((v) => observe(h, TIME_SCALE, v));
      for (const q of [0.05, 0.5, 0.95]) {
        const est = percentile(h, TIME_SCALE, q)!;
        const exact = exactQuantile(values, q);
        expect(Math.abs(est - exact) / exact).toBeLessThan(0.17);
      }
    }
  });

  test('the bucket layout is about 40 buckets of ~1.35× from 10 ms to 30 min', () => {
    const h = emptyHistogram();
    observe(h, TIME_SCALE, 5); // under
    observe(h, TIME_SCALE, 10);
    observe(h, TIME_SCALE, 29 * 60 * 1000);
    observe(h, TIME_SCALE, 31 * 60 * 1000); // over
    expect(h.first).toBe(-1);
    expect(h.buckets.length).toBe(42);
    expect(h.buckets.map((n, i) => (n ? h.first! + i : null)).filter((i) => i !== null)).toEqual([-1, 0, 39, 40]);
  });
});

describe('folding requests', () => {
  test('a streamed request fills every histogram and the token totals', () => {
    const r = emptyRollup();
    foldAudit(r, audit());
    const e = r.entries[0];
    expect(e.endpoint).toBe('https://api.anthropic.com');
    expect(e.requests).toBe(1);
    expect(e.tokens).toEqual({ input: 100, output: 200, cache_read: 1000, cache_write: 10 });
    expect([e.ttfb.count, e.ttft.count, e.ttlt.count, e.tps.count]).toEqual([1, 1, 1, 1]);
    // Throughput is over the whole request: 200 tokens ÷ 4 s.
    expect(e.tps.sum).toBeCloseTo(50, 6);
  });

  // INVARIANT: a non-streamed response lands all at once, so its TTFT is its
  // TTLT — and its throughput still divides by TTLT, never TTLT − TTFT (zero).
  test('a non-streamed response: TTFT == TTLT and throughput is measured', () => {
    const r = emptyRollup();
    foldAudit(r, audit({ stream: false, ttftMs: null, ttltMs: 2000 }));
    const e = r.entries[0];
    expect(e.ttft.sum).toBe(2000);
    expect(e.ttlt.sum).toBe(2000);
    expect(e.tps.sum).toBeCloseTo(100, 6);
    expect(e.tps_unmeasurable).toBe(0);
  });

  // INVARIANT: a zero or sub-millisecond duration, or no output, never reaches
  // the throughput histogram — it is counted as unmeasurable instead.
  test('zero-duration and zero-token guards', () => {
    const r = emptyRollup();
    foldAudit(r, audit({ ttltMs: 0, ttftMs: 0 }));
    foldAudit(r, audit({ ttltMs: 0.5, ttftMs: 0.5 }));
    foldAudit(r, audit({ usage: { inputTokens: 5, outputTokens: 0 } as never }));
    foldAudit(r, audit({ usage: null }));
    const e = r.entries[0];
    expect(e.tps.count).toBe(0);
    expect(e.tps_unmeasurable).toBe(4);
    // The wait share divides by the turn's wall clock; a zero clock is null, not Infinity.
    expect(summarizeTurn(r, 0).model_wait_share).toBeNull();
    expect(summarizeTurn(emptyRollup(), 1000).model_wait_share).toBeNull();
  });

  test('errors are split by class, and add no timings', () => {
    const r = emptyRollup();
    foldAudit(r, audit({ status: 429, ttltMs: undefined }));
    foldAudit(r, audit({ status: 400 }));
    foldAudit(r, audit({ status: 529 }));
    foldAudit(r, audit({ status: null, error: 'connect ETIMEDOUT' }));
    foldAudit(r, audit({ ttltMs: null })); // cancelled stream
    const e = r.entries[0];
    expect(e.requests).toBe(5);
    expect(e.errors).toEqual({ rate_limited: 1, client_error: 1, server_error: 1, network: 1, cancelled: 1 });
    expect(e.ttlt.count).toBe(0);
  });

  // INVARIANT: a tier attempt the proxy refused and re-sent is a RETRY, never a
  // second request or an error — the re-sent request is counted once, on the
  // tier that served it. count_tokens, the cursor passthrough, builder
  // traffic and lazy's own auth refusals are not requests at all.
  test('no double counting on tier retry, and non-inference calls are ignored', () => {
    const r = emptyRollup();
    foldAudit(r, audit({ servedByEndpoint: 'anthropic-sub', tierIndex: 0, status: 429, error: 'tier refused: tier 1 (anthropic-sub, opus) is full' }));
    foldAudit(r, audit({ servedByEndpoint: 'lunaroute', tierIndex: 1 }));
    foldAudit(r, audit({ endpoint: 'count_tokens' }));
    foldAudit(r, audit({ endpoint: 'cursor' }));
    foldAudit(r, audit({ taskId: null }));
    foldAudit(r, audit({ authDenial: 'unknown_session_token', status: null }));
    expect(classifyAudit(audit({ endpoint: 'count_tokens' }))).toBe('ignore');
    const t = totalEntry(r);
    expect(t.requests).toBe(1);
    expect(t.retries).toBe(1);
    expect(t.errors.rate_limited).toBe(0);
    const served = r.entries.find((e) => e.endpoint === 'lunaroute')!;
    expect(served.tier).toBe(1);
    expect(served.requests).toBe(1);
  });

  // INVARIANT: builder traffic never folds into a task's rollup — including the
  // builder one-shots that run FOR a task and carry its id (accept-time
  // summaries, link descriptions). They are not the task's turns, and nothing
  // would ever close them.
  test('builder one-shots carrying a task id are not counted', () => {
    const r = emptyRollup();
    foldAudit(r, audit({ role: 'builder', taskId: 'task-1111' }));
    expect(classifyAudit(audit({ role: 'builder', taskId: 'task-1111' }))).toBe('ignore');
    expect(r.entries).toEqual([]);
  });

  // INVARIANT: a tier is keyed by its tiered profile AND position, as the audit
  // summary keys it — tier 1 of two profiles is two different things.
  test('tier entries are keyed by profile and tier index', () => {
    const r = emptyRollup();
    foldAudit(r, audit({ servedByEndpoint: 'e', tierIndex: 0, tierProfile: 'fast' } as never));
    foldAudit(r, audit({ servedByEndpoint: 'e', tierIndex: 0, tierProfile: 'cheap' } as never));
    foldAudit(r, audit({ servedByEndpoint: 'e', tierIndex: 0, tierProfile: 'fast' } as never));
    expect(r.entries.map((e) => [e.profile, e.requests])).toEqual([['fast', 2], ['cheap', 1]]);
    const rows = latencyHistory([r]).rows;
    expect(rows.map((x) => latencyRowLabel(x)).sort()).toEqual(['e · claude-opus-5-5 · cheap tier 1', 'e · claude-opus-5-5 · fast tier 1']);
    // An entry stored before profiles were recorded still merges and labels.
    const legacy = emptyRollup();
    foldAudit(legacy, audit({ servedByEndpoint: 'e', tierIndex: 1 }));
    delete (legacy.entries[0] as { profile?: unknown }).profile;
    const merged = emptyRollup();
    mergeRollup(merged, legacy);
    mergeRollup(merged, legacy);
    expect(merged.entries).toHaveLength(1);
    expect(latencyRowLabel(latencyHistory([merged]).rows[0])).toBe('e · claude-opus-5-5 · tier 2');
  });

  test('a failover inside one request adds its extra attempts as retries', () => {
    const r = emptyRollup();
    foldAudit(r, audit({ reroute: { attempts: 3 } as never }));
    expect(r.entries[0].retries).toBe(2);
    expect(r.entries[0].requests).toBe(1);
  });

  test('tier switches are counted, including across merged deltas', () => {
    const a = emptyRollup();
    foldAudit(a, audit({ servedByEndpoint: 'one', tierIndex: 0 }));
    const b = emptyRollup();
    foldAudit(b, audit({ servedByEndpoint: 'two', tierIndex: 1 }));
    foldAudit(b, audit({ servedByEndpoint: 'one', tierIndex: 0 }));
    mergeRollup(a, b);
    expect(a.tier_switches).toBe(2);
  });
});

describe('the turn wall clock', () => {
  // INVARIANT: the wait share divides by launch row → closing row. A mid-turn
  // row (a self-sync) must not shorten it, and a request left over from before
  // a human's idle time must not stretch it.
  test('runs from the launching row, else the elapsed time', () => {
    expect(turnWallMs(T0, 100, T0 + 10_000)).toBe(10_000);
    expect(turnWallMs(null, 60_000, T0 + 10_000)).toBe(60_000);
    expect(turnWallMs(null, null, T0)).toBeNull();
    expect(turnWallMs(T0 + 5, 0, T0)).toBeNull();
  });
});

describe('history across turns', () => {
  test('groups by endpoint × model × tier, filters by period, and reports the wait share', () => {
    const t1 = { ...emptyRollup(), wall_ms: 10_000 };
    foldAudit(t1, audit({ ts: T0, ttltMs: 4000 }));
    const t2 = { ...emptyRollup(), wall_ms: 10_000 };
    foldAudit(t2, audit({ ts: T0 + 86_400_000, ttltMs: 1000 }));
    const all = latencyHistory([t1, t2]);
    expect(all.turns).toBe(2);
    expect(all.rows).toHaveLength(1);
    expect(all.rows[0].requests).toBe(2);
    expect(all.model_wait_share).toBeCloseTo(0.25, 6);
    const recent = latencyHistory([t1, t2], { sinceMs: T0 + 1000 });
    expect(recent.turns).toBe(1);
  });
});

describe('in the store', () => {
  let root: string;
  let base: string;
  let storage: FileStorage;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lazy-turn-latency-'));
    base = join(root, 'store');
    mkdirSync(base, { recursive: true });
    writeFileSync(join(root, 'lazy.toml'), `[storage]\nbackend = "external"\nexternal_path = "${base}"\n`);
    storage = new FileStorage(root, { basePath: base });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  // INVARIANT: the agent WORK row closes the running turn's rollup and carries
  // its summary; a row written mid-turn (a self-sync) neither takes it nor
  // loses it, and the next turn starts empty.
  test('the work row closes the open rollup and carries its summary', async () => {
    const task = await storage.createTask('goal');
    const sess = await storage.createSession(task.id, 'claude-code', 'lazy/x', 'abc123');
    await storage.createTurn({ sessionId: sess.id, sequence: 1, role: 'human', content: 'go' });

    const recorder = new ProxyTurnLatencyRecorder(storage, { intervalMs: 0 });
    recorder.observe(audit({ taskId: task.id }));
    recorder.observe(audit({ taskId: task.id, status: 529 }));
    await recorder.flush();
    await storage.createTurn({ sessionId: sess.id, sequence: 2, role: 'agent', content: 'merged', turnType: 'sync' });
    recorder.observe(audit({ taskId: task.id }));
    await recorder.flush();

    const agent = await storage.createTurn({ sessionId: sess.id, sequence: 3, role: 'agent', content: 'done' });
    expect(agent.latency?.requests).toBe(3);
    expect(agent.latency?.errors).toBe(1);
    expect(formatTurnLaunchLabels({ ...agent, agent: 'claude-code' })).toContain('3 model calls · 1 error');

    const stored = await storage.getTurnLatency(task.id);
    expect(stored?.open).toBeNull();
    expect(stored?.turns.map((t) => t.turn_sequence)).toEqual([3]);

    // The Stats tab payload (daemon dashboard and the taskStats RPC Teams reads).
    const { stats } = await loadTaskStats(storage, (await storage.getTask(task.id))!, { scope: 'task' });
    expect(stats.latency?.rows[0]).toMatchObject({ endpoint: 'https://api.anthropic.com', requests: 3 });
    const html = statsTabHtml(stats);
    expect(html).toContain('Model latency');
    expect(html).toContain('https://api.anthropic.com · claude-opus-5-5');

    await storage.createTurn({ sessionId: sess.id, sequence: 4, role: 'human', content: 'again' });
    const next = await storage.createTurn({ sessionId: sess.id, sequence: 5, role: 'agent', content: 'ok' });
    expect(next.latency).toBeUndefined();
  });

  // INVARIANT: what was flushed survives a daemon restart — a fresh storage
  // instance (and a fresh recorder) continue the same running turn.
  test('durable across a restart', async () => {
    const task = await storage.createTask('goal');
    const sess = await storage.createSession(task.id, 'claude-code', 'lazy/x', 'abc123');
    await storage.createTurn({ sessionId: sess.id, sequence: 1, role: 'human', content: 'go' });
    const before = new ProxyTurnLatencyRecorder(storage, { intervalMs: 0 });
    before.observe(audit({ taskId: task.id }));
    await before.flush();
    await storage.close();

    storage = new FileStorage(root, { basePath: base });
    await storage.initialize();
    const after = new ProxyTurnLatencyRecorder(storage, { intervalMs: 0 });
    after.observe(audit({ taskId: task.id }));
    await after.flush();
    const agent = await storage.createTurn({ sessionId: sess.id, sequence: 2, role: 'agent', content: 'done' });
    expect(agent.latency?.requests).toBe(2);
  });

  // INVARIANT: the agent row closes its turn with every request, even though
  // proxied records carry the grant's task CODE rather than the task UUID and
  // nothing was flushed by hand — the turn writer flushes before the row.
  test('the turn writer flushes before the row, whatever reference the records carry', async () => {
    const task = await storage.createTask('goal', undefined, undefined, 'latency-code');
    const sess = await storage.createSession(task.id, 'claude-code', 'lazy/x', 'abc123');
    await storage.createTurn({ sessionId: sess.id, sequence: 1, role: 'human', content: 'go' });
    const recorder = new ProxyTurnLatencyRecorder(storage, { intervalMs: 0 });
    setActiveTurnLatencyRecorder(recorder);
    try {
      recorder.observe(audit({ taskId: 'latency-code' }));
      recorder.observe(audit({ taskId: 'latency-code' }));
      const row = await createAgentTurn(storage, { sessionId: sess.id, sequence: 2, role: 'agent', content: 'done' });
      expect(row.latency?.requests).toBe(2);
    } finally {
      setActiveTurnLatencyRecorder(null);
    }
  });

  // INVARIANT: an ask's requests close on the ask's own row, never inflating
  // the next work turn.
  test('an ask between two work turns keeps its own requests', async () => {
    const task = await storage.createTask('goal');
    const sess = await storage.createSession(task.id, 'claude-code', 'lazy/x', 'abc123');
    const recorder = new ProxyTurnLatencyRecorder(storage, { intervalMs: 0 });
    await storage.createTurn({ sessionId: sess.id, sequence: 1, role: 'human', content: 'go' });
    recorder.observe(audit({ taskId: task.id }));
    await recorder.flush();
    await storage.createTurn({ sessionId: sess.id, sequence: 2, role: 'agent', content: 'done' });
    await storage.createTurn({ sessionId: sess.id, sequence: 3, role: 'human', content: 'q?', turnType: 'ask' });
    recorder.observe(audit({ taskId: task.id }));
    recorder.observe(audit({ taskId: task.id }));
    await recorder.flush();
    const ask = await storage.createTurn({ sessionId: sess.id, sequence: 4, role: 'agent', content: 'a', turnType: 'ask' });
    expect(ask.latency?.requests).toBe(2);
    await storage.createTurn({ sessionId: sess.id, sequence: 5, role: 'human', content: 'again' });
    recorder.observe(audit({ taskId: task.id }));
    await recorder.flush();
    const work = await storage.createTurn({ sessionId: sess.id, sequence: 6, role: 'agent', content: 'ok' });
    expect(work.latency?.requests).toBe(1);
  });

  // INVARIANT: statistics never cost the turn row, and history that cannot be
  // read is never overwritten.
  test('a broken history file neither blocks the row nor is overwritten', async () => {
    const task = await storage.createTask('goal');
    const sess = await storage.createSession(task.id, 'claude-code', 'lazy/x', 'abc123');
    await storage.createTurn({ sessionId: sess.id, sequence: 1, role: 'human', content: 'go' });
    const recorder = new ProxyTurnLatencyRecorder(storage, { intervalMs: 0 });
    recorder.observe(audit({ taskId: task.id }));
    await recorder.flush();
    const historyPath = join(base, 'tasks', task.id, 'turn-latency.json');
    writeFileSync(historyPath, '{ not json');
    const row = await storage.createTurn({ sessionId: sess.id, sequence: 2, role: 'agent', content: 'done' });
    expect(row.sequence).toBe(2);
    expect(row.latency).toBeUndefined();
    expect(readFileSync(historyPath, 'utf-8')).toBe('{ not json');
  });

  // INVARIANT: a delta that names no task is dropped — never retried forever,
  // and never given a task directory of its own.
  test('a delta for no task is dropped and creates nothing', async () => {
    const recorder = new ProxyTurnLatencyRecorder(storage, { intervalMs: 0 });
    const ghost = '00000000-0000-4000-8000-000000000000';
    recorder.observe(audit({ taskId: ghost }));
    recorder.observe(audit({ taskId: 'no-such-code' }));
    await recorder.flush();
    expect(recorder.pendingTaskIds()).toEqual([]);
    expect(existsSync(join(base, 'tasks', ghost))).toBe(false);
  });

  test('a malformed delta is described, a real one passes', () => {
    const r = emptyRollup();
    foldAudit(r, audit());
    expect(rollupShapeProblem(r)).toBeNull();
    r.entries[0].ttlt.first = 1e9;
    expect(rollupShapeProblem(r)).toContain('histograms');
    expect(rollupShapeProblem({ version: 2, entries: [] })).toContain('version');
  });

  // INVARIANT: every counter in a delta is checked at the RPC boundary, not
  // only the histograms — a string or negative count would be summed into the
  // stored rollup and poison every report that reads it.
  test('every counter in a delta is validated', () => {
    const fresh = () => { const r = emptyRollup(); foldAudit(r, audit()); return r; };
    const cases: Array<[(r: ReturnType<typeof emptyRollup>) => void, string]> = [
      [(r) => { (r.entries[0] as { requests: unknown }).requests = '5'; }, 'requests'],
      [(r) => { r.entries[0].retries = -1; }, 'retries'],
      [(r) => { r.entries[0].tps_unmeasurable = 1.5; }, 'tps_unmeasurable'],
      [(r) => { (r.entries[0].errors as { network: unknown }).network = null; }, 'errors.network'],
      [(r) => { r.entries[0].tokens.output = Number.POSITIVE_INFINITY; }, 'tokens.output'],
      [(r) => { delete (r.entries[0].tokens as { cache_write?: number }).cache_write; }, 'tokens.cache_write'],
      [(r) => { r.tier_switches = -2; }, 'tier_switches'],
      [(r) => { (r.entries[0] as { profile: unknown }).profile = 7; }, 'profile'],
    ];
    for (const [spoil, field] of cases) {
      const r = fresh();
      spoil(r);
      expect(rollupShapeProblem(r)).toContain(field);
    }
  });

  // INVARIANT: a delta is filed under the task its grant REFERENCE names, found
  // through the index — a hex-looking code never lands on another task whose id
  // it happens to prefix, and an unknown ref is dropped without reading every
  // task in the store.
  test('a grant reference resolves to the task it names, never an id-prefix lookalike', async () => {
    const victim = await storage.createTask('victim');
    const lookalike = victim.id.slice(0, 6);
    const owner = await storage.createTask('owner', undefined, undefined, lookalike);
    await storage.updateTaskMetadata(owner.id, 'task_ref', lookalike);
    const pinned = await storage.createTask('pinned', undefined, undefined, 'reused');
    await storage.updateTaskMetadata(pinned.id, 'task_ref', 'reused-26-10-11');

    await storage.mergeOpenTurnLatency(lookalike, (() => { const r = emptyRollup(); foldAudit(r, audit()); return r; })());
    await storage.mergeOpenTurnLatency('reused-26-10-11', (() => { const r = emptyRollup(); foldAudit(r, audit()); return r; })());
    expect((await storage.getTurnLatency(owner.id))?.open?.entries[0].requests).toBe(1);
    expect(await storage.getTurnLatency(victim.id)).toBeNull();
    expect((await storage.getTurnLatency(pinned.id))?.open?.entries[0].requests).toBe(1);

    // A ref nobody carries is refused without a full-store read.
    const listTasks = storage.listTasks.bind(storage);
    let listed = 0;
    (storage as { listTasks: typeof storage.listTasks }).listTasks = async (...a) => { listed++; return listTasks(...a); };
    const priv = storage as unknown as { readTasksWithCode: (...a: unknown[]) => Promise<unknown[]> };
    const scan = priv.readTasksWithCode.bind(storage);
    let scanned = 0;
    priv.readTasksWithCode = async (...a: unknown[]) => { scanned++; return scan(...a); };
    await expect(storage.mergeOpenTurnLatency('reused-26-01-01', emptyRollup())).rejects.toThrow(/no task matches/);
    await expect(storage.mergeOpenTurnLatency('no-such-code', emptyRollup())).rejects.toThrow(/no task matches/);
    expect(listed).toBe(0);
    expect(scanned).toBe(0);
    // A code with no pinned ref still resolves, from the code index.
    const plain = await storage.createTask('plain', undefined, undefined, 'plain-code');
    await storage.mergeOpenTurnLatency('plain-code', (() => { const r = emptyRollup(); foldAudit(r, audit()); return r; })());
    expect((await storage.getTurnLatency(plain.id))?.open?.entries[0].requests).toBe(1);
  });

  test('a failed flush keeps its delta and lands it on the next one', async () => {
    let fail = true;
    const merged: number[] = [];
    const recorder = new ProxyTurnLatencyRecorder(
      {
        mergeOpenTurnLatency: async (_id, delta) => {
          if (fail) throw new Error('disk full');
          merged.push(totalEntry(delta).requests);
        },
      },
      { intervalMs: 0 },
    );
    recorder.observe(audit());
    await recorder.flush();
    recorder.observe(audit());
    fail = false;
    await recorder.flush();
    expect(merged).toEqual([2]);
    expect(recorder.pendingTaskIds()).toEqual([]);
  });

  test('record size on a realistic turn stays well under 1 KB per endpoint × model', () => {
    const r = emptyRollup();
    for (const v of samples(60, 11)) {
      foldAudit(r, audit({ durationMs: v / 4, ttftMs: v / 2, ttltMs: v, usage: { inputTokens: 5, outputTokens: Math.round(v / 20) } as never }));
    }
    const bytes = JSON.stringify(r.entries[0]).length;
    expect(bytes).toBeLessThan(1024);
  });
});

describe('one tokens/s definition and per-column sample counts', () => {
  // INVARIANT: tokens/s is output over TTLT from request start everywhere (rollups,
  // --recent, stats audit, Teams); a non-streamed response (TTFT==TTLT) is still measured.
  test('outputTokensPerSecond guards missing and zero inputs', async () => {
    const { outputTokensPerSecond } = await import('../../src/task/turn-latency');
    expect(outputTokensPerSecond(100, 2000)).toBe(50);
    expect(outputTokensPerSecond(0, 2000)).toBeNull();
    expect(outputTokensPerSecond(100, 0)).toBeNull();
    expect(outputTokensPerSecond(100, null)).toBeNull();
    expect(outputTokensPerSecond(undefined, 2000)).toBeNull();
  });

  // INVARIANT: readers see which sample set each timing column covers; n differs per column.
  test('history percentiles carry n and formatPercentiles prints it', async () => {
    const { formatPercentiles } = await import('../../src/task/turn-latency');
    const r = emptyRollup();
    foldAudit(r, audit());
    foldAudit(r, audit({ ttftMs: null } as never));
    const row = latencyHistory([r]).rows[0];
    expect(row.ttfb!.n).toBe(2);
    expect(row.ttft!.n).toBe(1);
    expect(formatPercentiles(row.ttfb, 'ms')).toContain('(n=2)');
    expect(formatPercentiles(row.ttft, 'ms')).toContain('(n=1)');
  });
});
