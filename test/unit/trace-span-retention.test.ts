/**
 * Unit tests: trace span persistence + retention.
 *
 * Tracing is always-on (no env var, no config knob), so the span store MUST be
 * bounded — unbounded growth on an always-on writer is not shippable. These
 * tests encode the retention invariants. See docs/spikes/timings.md.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendSpansJsonl,
  readSpansJsonl,
  PRUNE_TRIGGER_BYTES,
  PRUNE_TARGET_BYTES,
  type RetentionBounds,
} from '../../src/storage/trace-spans';
import type { SpanRecord } from '../../src/tracing/types';

/**
 * Test-sized retention bounds. Production prunes at 128 MB down to 64 MB;
 * writing that much in a unit test would be absurdly slow, so we inject small
 * bounds that preserve the shape of the production config — same 2× trigger:
 * target ratio, so the amortization behaviour under test is the real one.
 */
const TEST_BOUNDS: RetentionBounds = {
  triggerBytes: 512 * 1024,
  targetBytes: 256 * 1024,
};

/** Build one request's worth of spans (a root + children), all one trace. */
function makeTrace(traceId: string, startMs: number, spanCount = 7): SpanRecord[] {
  const spans: SpanRecord[] = [];
  const rootId = `${traceId.slice(0, 15)}0`;
  spans.push({
    trace_id: traceId,
    span_id: rootId,
    parent_span_id: null,
    name: 'lazy.start',
    start_ms: startMs,
    end_ms: startMs + 1000,
    duration_ms: 1000,
    status: 'ok',
    service: 'daemon',
    attributes: { 'lazy.command': 'start', 'lazy.task_id': 'abc12345' },
  });
  for (let i = 1; i < spanCount; i++) {
    spans.push({
      trace_id: traceId,
      span_id: `${traceId.slice(0, 15)}${i}`,
      parent_span_id: rootId,
      name: `child.op.${i}`,
      start_ms: startMs + i,
      end_ms: startMs + i + 10,
      duration_ms: 10,
      status: 'ok',
      service: 'daemon',
      attributes: { 'git.branch': 'lazy/abc12345' },
    });
  }
  return spans;
}

const traceIdFor = (n: number) => n.toString(16).padStart(32, '0');

/**
 * Write `totalBytes` worth of traces into the store, in batches. Note the loop
 * counts bytes WRITTEN, not current file size: pruning keeps the file small, so
 * a size-based loop would never terminate.
 */
async function fillStore(storagePath: string, totalBytes: number): Promise<number> {
  let n = 0;
  let written = 0;
  while (written < totalBytes) {
    const batch: SpanRecord[] = [];
    for (let i = 0; i < 50; i++) batch.push(...makeTrace(traceIdFor(++n), 1000 + n));
    written += batch.reduce((acc, s) => acc + JSON.stringify(s).length + 1, 0);
    await appendSpansJsonl(storagePath, batch, TEST_BOUNDS);
  }
  return n;
}

describe('trace span storage', () => {
  let storagePath: string;

  beforeEach(async () => {
    storagePath = await mkdtemp(join(tmpdir(), 'lazy-spans-'));
  });

  afterEach(async () => {
    await rm(storagePath, { recursive: true, force: true });
  });

  test('round-trips appended spans', async () => {
    await appendSpansJsonl(storagePath, makeTrace(traceIdFor(1), 1000));
    const read = await readSpansJsonl(storagePath);
    expect(read).toHaveLength(7);
    expect(read[0].trace_id).toBe(traceIdFor(1));
  });

  test('reading a store that does not exist yet is empty, not an error', async () => {
    expect(await readSpansJsonl(storagePath)).toEqual([]);
  });

  test('sinceMs filters out older spans', async () => {
    await appendSpansJsonl(storagePath, makeTrace(traceIdFor(1), 1000));
    await appendSpansJsonl(storagePath, makeTrace(traceIdFor(2), 50_000));
    const read = await readSpansJsonl(storagePath, 40_000);
    expect(read.every((s) => s.trace_id === traceIdFor(2))).toBe(true);
  });

  // INVARIANT: tracing is always-on, so the store must stay bounded. Without
  // this, a long-lived daemon grows spans.jsonl without limit.
  test('prunes the store back under the bound once it exceeds the trigger', async () => {
    // Write well past the (test-sized) trigger. Each trace is ~7 spans (~2 KB).
    await fillStore(storagePath, TEST_BOUNDS.triggerBytes * 1.5);

    const finalSize = (await stat(join(storagePath, 'traces', 'spans.jsonl'))).size;
    expect(finalSize).toBeLessThanOrEqual(TEST_BOUNDS.triggerBytes);
    // Pruning must retain history, not wipe it.
    expect(finalSize).toBeGreaterThan(TEST_BOUNDS.targetBytes / 2);
  });

  // The production bounds are what actually ship; the tests above exercise the
  // same logic at a size a unit test can afford to write.
  test('production bounds are 128MB trigger / 64MB target, keeping the 2x ratio', () => {
    expect(PRUNE_TRIGGER_BYTES).toBe(128 * 1024 * 1024);
    expect(PRUNE_TARGET_BYTES).toBe(64 * 1024 * 1024);
    // 2x amortization: prune runs once per ~target bytes written, not per append.
    expect(PRUNE_TRIGGER_BYTES).toBe(PRUNE_TARGET_BYTES * 2);
  });

  // INVARIANT: prune by WHOLE traces. Dropping part of a trace would leave
  // orphaned spans and render a broken tree in `lazy timings`.
  test('pruning never splits a trace across the retention boundary', async () => {
    await fillStore(storagePath, TEST_BOUNDS.triggerBytes * 1.5);

    const read = await readSpansJsonl(storagePath);
    const byTrace = new Map<string, SpanRecord[]>();
    for (const s of read) {
      if (!byTrace.has(s.trace_id)) byTrace.set(s.trace_id, []);
      byTrace.get(s.trace_id)!.push(s);
    }
    // Every surviving trace kept all 7 of its spans, and each has its root.
    for (const [, spans] of byTrace) {
      expect(spans).toHaveLength(7);
      expect(spans.filter((s) => s.parent_span_id === null)).toHaveLength(1);
    }
  });

  test('pruning keeps the NEWEST traces and drops the oldest', async () => {
    const n = await fillStore(storagePath, TEST_BOUNDS.triggerBytes * 1.5);

    const read = await readSpansJsonl(storagePath);
    const survivingEnds = read.map((s) => s.end_ms);
    // The most recently written trace must have survived...
    expect(Math.max(...survivingEnds)).toBe(1000 + n + 1000);
    // ...and the very first one must have been dropped.
    expect(read.some((s) => s.trace_id === traceIdFor(1))).toBe(false);
  });

  test('a torn line does not break the readout', async () => {
    await appendSpansJsonl(storagePath, makeTrace(traceIdFor(1), 1000));
    const file = join(storagePath, 'traces', 'spans.jsonl');
    const raw = await readFile(file, 'utf-8');
    await Bun.write(file, raw + '{"trace_id":"incomplete');
    const read = await readSpansJsonl(storagePath);
    expect(read).toHaveLength(7);
  });
});
