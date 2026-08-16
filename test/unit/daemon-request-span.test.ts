/**
 * A daemon request must leave a trace even when it never finishes.
 *
 * INVARIANT: a span is written when its callback settles, so before
 * `withRequestSpan` a request reaped mid-flight (Bun's idle timer closing the
 * connection out from under a handler that hasn't returned yet) produced NO
 * record at all — `lazy timings` showed absence, which is indistinguishable
 * from a request that was never made. `fix-daemon-blips` was exactly that
 * shape and had to be debugged without timings.
 *
 * These tests encode the two halves of the fix: a reaped request ends as a
 * visible ERROR span, and a heartbeat-framed reply is measured over its whole
 * streamed lifetime rather than the milliseconds it takes to hand back a
 * Response object.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { withRequestSpan, daemonRouteTemplate } from '../../src/daemon/request-span';
import { heartbeatEnvelopeResponse } from '../../src/daemon/heartbeat';
import { initTracing, shutdownTracing } from '../../src/tracing';
import type { SpanRecord } from '../../src/tracing';

/** Collects finished spans; `initTracing` batches, so flush before reading. */
function captureSpans(): SpanRecord[] {
  const records: SpanRecord[] = [];
  initTracing('test', async (batch) => {
    records.push(...batch);
  });
  return records;
}

/** Flush the batch processor and reset global tracing state between tests. */
async function flush(): Promise<void> {
  await shutdownTracing();
}

afterEach(async () => {
  await flush();
});

const request = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, init);

const requestSpan = (records: SpanRecord[]) =>
  records.find((r) => r.name.startsWith('daemon.request'));

describe('daemonRouteTemplate', () => {
  // INVARIANT: `lazy timings` groups by span name, so an unbounded segment in
  // the name (a task id) makes the readout useless. Task ids are placeholdered;
  // RPC commands and tool names are a finite set and stay, which is what makes
  // `daemon.request /rpc/wait` directly rankable.
  test('placeholders the unbounded task id but keeps the bounded command', () => {
    expect(daemonRouteTemplate('/rpc/wait')).toBe('/rpc/wait');
    expect(daemonRouteTemplate('/mcp/a1b2c3d4e5f6/lazy_accept')).toBe('/mcp/:taskId/lazy_accept');
    expect(daemonRouteTemplate('/daemon/status')).toBe('/daemon/status');
    expect(daemonRouteTemplate('/daemon/shutdown')).toBe('/daemon/shutdown');
  });

  test('rejects segments a bogus client could use to explode cardinality', () => {
    expect(daemonRouteTemplate('/rpc/' + 'x'.repeat(200))).toBe('/rpc/other');
    expect(daemonRouteTemplate('/rpc/../../etc/passwd')).toBe('/rpc/other');
    // Tool names are identifiers; a hex blob in that slot is not one.
    expect(daemonRouteTemplate('/mcp/task/9f8e7d6c')).toBe('/mcp/:taskId/other');
  });

  test('collapses open-ended dashboard paths to their first segment', () => {
    expect(daemonRouteTemplate('/api/tasks/abc123/diff')).toBe('/api/*');
    expect(daemonRouteTemplate('/')).toBe('/');
  });
});

describe('withRequestSpan', () => {
  test('records a completed request with its status', async () => {
    const records = captureSpans();

    const response = await withRequestSpan(request('/daemon/status'), 'tcp', async () =>
      Response.json({ ok: true }));
    expect(response.status).toBe(200);

    await flush();
    const span = requestSpan(records);
    expect(span?.name).toBe('daemon.request /daemon/status');
    expect(span?.status).toBe('ok');
    expect(span?.attributes['http.response.status_code']).toBe(200);
    expect(span?.attributes['lazy.daemon.transport']).toBe('tcp');
  });

  // INVARIANT: this is the whole point of the module. A handler that never
  // settles used to leave nothing behind; it must now leave an ERROR row.
  test('a request reaped mid-flight still produces an error span', async () => {
    const records = captureSpans();
    const controller = new AbortController();

    // Deliberately never resolves — this is a handler killed mid-operation, so
    // the returned promise is not awaited.
    void withRequestSpan(request('/rpc/wait', { signal: controller.signal }), 'unix',
      () => new Promise<Response>(() => {}));

    controller.abort();

    await flush();
    const span = requestSpan(records);
    expect(span?.name).toBe('daemon.request /rpc/wait');
    expect(span?.status).toBe('error');
    expect(span?.attributes['lazy.request.reaped']).toBe(true);
    // The handler never produced one, and claiming a status here would be a lie.
    expect(span?.attributes['http.response.status_code']).toBeUndefined();
  });

  test('an aborted request is not re-ended when its handler settles later', async () => {
    const records = captureSpans();
    const controller = new AbortController();
    let settle: (r: Response) => void = () => {};

    const inFlight = withRequestSpan(request('/rpc/accept', { signal: controller.signal }), 'unix',
      () => new Promise<Response>((resolve) => { settle = resolve; }));

    controller.abort();
    settle(Response.json({ ok: true }));
    await inFlight;

    await flush();
    const spans = records.filter((r) => r.name.startsWith('daemon.request'));
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status).toBe('error');
  });

  // INVARIANT: a heartbeat-framed route hands back its Response almost
  // immediately and does the work while streaming, so ending the span on
  // return would report a multi-second `wait` as a sub-millisecond request.
  test('a heartbeat-framed reply is measured until its final line', async () => {
    const records = captureSpans();
    const workMs = 60;

    const response = await withRequestSpan(request('/rpc/wait'), 'unix', async () =>
      heartbeatEnvelopeResponse(async () => {
        await Bun.sleep(workMs);
        return { status: 200, body: { done: true } };
      }, { intervalMs: 10 }));

    // The span is still open here: the body has not been read yet.
    await response.text();

    await flush();
    const span = requestSpan(records);
    expect(span?.attributes['lazy.response.framed']).toBe(true);
    expect(span?.duration_ms).toBeGreaterThanOrEqual(workMs);
    expect(span?.status).toBe('ok');

    // The writer's own span carries the liveness evidence.
    const envelope = records.find((r) => r.name === 'daemon.envelope');
    expect(envelope?.attributes['lazy.envelope.outcome']).toBe('delivered');
    expect(envelope?.attributes['lazy.heartbeat.count'] as number).toBeGreaterThan(0);
    expect(envelope?.parent_span_id).toBe(span!.span_id);
  });

  test('a framed reply whose client vanishes mid-work is recorded as reaped', async () => {
    const records = captureSpans();
    const controller = new AbortController();

    const req = request('/rpc/wait', { signal: controller.signal });
    // The signal is what src/daemon/server.ts hands the envelope; without it the
    // writer cannot tell a lost client from a slow one.
    const response = await withRequestSpan(req, 'unix',
      async () => heartbeatEnvelopeResponse(async () => {
        await Bun.sleep(200);
        return { status: 200, body: { done: true } };
      }, { intervalMs: 10, signal: req.signal }));
    void response.body?.cancel();

    controller.abort();
    await Bun.sleep(20);

    await flush();
    const envelope = records.find((r) => r.name === 'daemon.envelope');
    expect(envelope?.attributes['lazy.envelope.outcome']).toBe('reaped');
    expect(envelope?.status).toBe('error');
    expect(requestSpan(records)?.attributes['lazy.request.reaped']).toBe(true);
  });
});
