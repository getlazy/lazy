/**
 * Daemon must never let a live request die of idleness.
 *
 * These tests encode the invariant that a long daemon operation (a `wait`
 * long-poll, a big accept/merge) survives the listener's idle timer, and that
 * the daemon keeps answering other requests while it runs.
 *
 * They deliberately run against a REAL Bun.serve with a tiny `idleTimeout`
 * rather than the daemon's production 120s, so the same failure the field hit at
 * two minutes reproduces in a few seconds. The `noHeartbeat` control case is
 * what production did before this module existed — it must still fail, or these
 * tests would pass for the wrong reason.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  clientAcceptsHeartbeat,
  heartbeatEnvelopeResponse,
  heartbeatRequestHeaders,
  isHeartbeatEnvelope,
  readHeartbeatEnvelope,
  DaemonConnectionLostError,
  DAEMON_IDLE_TIMEOUT_S,
  HEARTBEAT_INTERVAL_MS,
  type EnvelopeResult,
} from '../../src/daemon/heartbeat';
import { isMidFlightTransportFailure } from '../../src/daemon/mcp-proxy';

/**
 * Server idle timeout used by the harness — small so tests finish in seconds,
 * but NOT below 5: measured on Bun 1.3.14, an `idleTimeout` of 2-4 degenerates
 * into a hard ~4s request deadline that outgoing writes do not reset, so the
 * heartbeat would appear broken when it is the timer that is degenerate. At 5 it
 * behaves as a true idle timer (a 26s streamed response survives with 2s gaps).
 */
const TEST_IDLE_TIMEOUT_S = 5;
/** How long the "slow operation" holds the request: comfortably past the idle timer. */
const SLOW_OP_MS = 16_000;
/** Heartbeat cadence for the harness, scaled to TEST_IDLE_TIMEOUT_S the way production is to 120s. */
const TEST_HEARTBEAT_MS = 1_000;

const servers: { stop(closeActiveConnections?: boolean): void }[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) {
    try { s.stop(true); } catch { /* already stopped by the test */ }
  }
});

/**
 * A stand-in for the daemon's request handler: `/slow` models a long operation
 * (merge, long-poll), `/fast` models the short RPCs (`active`, `show`, `diff`)
 * that were observed to succeed between failures.
 */
function startHarness(options?: { noHeartbeat?: boolean }) {
  const server = Bun.serve({
    port: 0,
    idleTimeout: TEST_IDLE_TIMEOUT_S,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/fast') {
        return Response.json({ ok: true, at: Date.now() });
      }

      const produce = async (): Promise<EnvelopeResult> => {
        await new Promise(resolve => setTimeout(resolve, SLOW_OP_MS));
        return { status: 200, body: { merged: true } };
      };

      if (url.pathname === '/boom') {
        const fail = async (): Promise<EnvelopeResult> => ({
          status: 409,
          body: { error: 'Task already accepted' },
        });
        return heartbeatEnvelopeResponse(fail, { intervalMs: TEST_HEARTBEAT_MS });
      }

      // A large result line — models an ask answer or a big diff, where the
      // payload spans many TCP segments and several reader.read() chunks.
      if (url.pathname === '/big') {
        const size = Number(url.searchParams.get('size') ?? '500000');
        const big = async (): Promise<EnvelopeResult> => ({
          status: 200,
          body: { answer: 'A'.repeat(size) + 'FINAL_TOKEN' },
        });
        return heartbeatEnvelopeResponse(big, { intervalMs: TEST_HEARTBEAT_MS });
      }

      // Same, but with multi-byte characters, so sequences straddle chunk edges.
      if (url.pathname === '/unicode') {
        const size = Number(url.searchParams.get('size') ?? '200000');
        const unicode = async (): Promise<EnvelopeResult> => ({
          status: 200,
          body: { answer: 'héllo → wörld '.repeat(Math.ceil(size / 14)) + 'FINAL_TOKEN' },
        });
        return heartbeatEnvelopeResponse(unicode, { intervalMs: TEST_HEARTBEAT_MS });
      }

      if (url.pathname === '/throws') {
        const thrower = async (): Promise<EnvelopeResult> => { throw new Error('handler exploded'); };
        return heartbeatEnvelopeResponse(thrower, { intervalMs: TEST_HEARTBEAT_MS });
      }

      // The control case: what the daemon did before heartbeat framing.
      if (options?.noHeartbeat || !clientAcceptsHeartbeat(req)) {
        const outcome = await produce();
        return Response.json(outcome.body, { status: outcome.status });
      }

      return heartbeatEnvelopeResponse(produce, { intervalMs: TEST_HEARTBEAT_MS });
    },
  });
  servers.push(server);
  return server;
}

// `port` is optional on Bun's Server type (unix-socket listeners have none), but
// the harness always binds TCP, so it is always present here.
const call = (server: { port?: number }, path: string, heartbeat = true) =>
  fetch(`http://localhost:${server.port}${path}`, {
    headers: heartbeat ? heartbeatRequestHeaders() : {},
  });

describe('daemon heartbeat envelope', () => {
  // INVARIANT: a daemon operation that outlives the listener's idleTimeout must
  // still deliver its result. This is the bug that made lazy_wait (600s
  // long-poll) and large lazy_accept merges die at the 120s idle boundary while
  // the daemon itself was healthy.
  test('an operation longer than the listener idleTimeout still returns its result', async () => {
    const server = startHarness();
    const started = Date.now();

    const response = await call(server, '/slow');
    expect(isHeartbeatEnvelope(response)).toBe(true);

    const { status, body } = await readHeartbeatEnvelope(response, 'slow');
    const elapsed = Date.now() - started;

    expect(status).toBe(200);
    expect(body).toEqual({ merged: true });
    // Proof the request really outlived the idle timer rather than finishing early.
    expect(elapsed).toBeGreaterThan(TEST_IDLE_TIMEOUT_S * 1000);
  }, 30_000);

  // REGRESSION: a large result line spans many reader.read() chunks, and a
  // decoder or line-splitter that drops its trailing buffer would truncate the
  // tail — silently, because the answer still *looks* like an answer. Asserting
  // the final token and the exact length is the point: a substring check aimed
  // at the head of the payload passes even when the end is missing.
  test('a large result line survives chunked reads intact', async () => {
    const server = startHarness();
    const size = 500_000;

    const { status, body } = await readHeartbeatEnvelope(await call(server, `/big?size=${size}`), 'ask');

    expect(status).toBe(200);
    const answer = (body as { answer: string }).answer;
    expect(answer.endsWith('FINAL_TOKEN')).toBe(true);
    expect(answer.length).toBe(size + 'FINAL_TOKEN'.length);
  }, 30_000);

  // A multi-byte character split across two chunk boundaries is the classic way
  // a stream decoder corrupts the tail. `readHeartbeatEnvelope` decodes with
  // {stream: true} and flushes at end precisely to survive this.
  test('a result line with multi-byte characters is not corrupted at chunk boundaries', async () => {
    const server = startHarness();
    // 'é' and '→' are 2- and 3-byte sequences; repeated to guarantee that some
    // instance straddles a read boundary.
    const size = 200_000;

    const { body } = await readHeartbeatEnvelope(await call(server, `/unicode?size=${size}`), 'ask');
    const answer = (body as { answer: string }).answer;
    expect(answer.endsWith('FINAL_TOKEN')).toBe(true);
    expect(answer).not.toContain('�'); // replacement char = a split sequence was mis-decoded
  }, 30_000);

  // CONTROL: without heartbeat framing the same operation is killed mid-flight.
  // If this ever starts passing, Bun changed its idle-timer semantics and the
  // test above no longer proves anything — investigate before deleting either.
  test('without heartbeats the same operation is killed by the idle timer', async () => {
    const server = startHarness({ noHeartbeat: true });

    let failed = false;
    try {
      const response = await call(server, '/slow', false);
      await response.text();
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);
  }, 30_000);

  // INVARIANT: a long operation must not block other requests. Short RPCs kept
  // succeeding in the field, which is what pointed at per-request reaping rather
  // than a wedged event loop — this keeps that property from regressing (e.g. if
  // someone reintroduces a sync spawn on a request path).
  test('short requests are answered promptly while a long operation is in flight', async () => {
    const server = startHarness();

    const slow = call(server, '/slow').then(r => readHeartbeatEnvelope(r, 'slow'));

    // Sample short requests across the whole window, including past the point
    // where an unprotected connection would already have been reaped.
    const latencies: number[] = [];
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setTimeout(resolve, 1_200));
      const t0 = Date.now();
      const res = await call(server, '/fast');
      expect(res.status).toBe(200);
      latencies.push(Date.now() - t0);
    }

    const slowResult = await slow;
    expect(slowResult.status).toBe(200);

    // A local daemon answering a trivial request has no excuse for taking a
    // second. Generous vs. the sub-millisecond reality, tight enough to catch a
    // blocked event loop.
    expect(Math.max(...latencies)).toBeLessThan(1_000);
  }, 30_000);

  test('non-2xx outcomes survive the envelope with their status intact', async () => {
    const server = startHarness();
    const response = await call(server, '/boom');

    // The HTTP status of an enveloped reply is always 200 — the real one is inside.
    expect(response.status).toBe(200);
    const { status, body } = await readHeartbeatEnvelope(response, 'accept');
    expect(status).toBe(409);
    expect(body).toEqual({ error: 'Task already accepted' });
  });

  test('a throwing producer terminates the stream as a 500 instead of hanging', async () => {
    const server = startHarness();
    const { status, body } = await readHeartbeatEnvelope(await call(server, '/throws'), 'boom');
    expect(status).toBe(500);
    expect((body as { error: string }).error).toContain('handler exploded');
  });

  // INVARIANT: a dropped connection must be reported as a dropped connection.
  // Reporting it as "the daemon appears to be down" is what sent an engineer to
  // relaunch a builder against a daemon that was answering fine.
  test('a truncated envelope raises DaemonConnectionLostError, not "unreachable"', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(
        // Preamble + a heartbeat, then the connection ends with no result line.
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"lazyEnvelope":1}\n{"heartbeat":5}\n'));
            c.close();
          },
        }),
        { headers: { 'content-type': 'application/x-ndjson' } },
      ),
    });
    servers.push(server);

    const response = await fetch(`http://localhost:${server.port}/`);
    let caught: unknown;
    try {
      await readHeartbeatEnvelope(response, 'lazy_wait');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DaemonConnectionLostError);
    const message = (caught as Error).message;
    expect(message).toContain('lazy_wait');
    expect(message).toContain('not a daemon that is down');
  });

  // INVARIANT: heartbeats must be frequent enough to reset the idle timer with
  // room to spare, even on a briefly-starved event loop. If someone raises the
  // interval past the idle timeout, every long request dies again.
  test('heartbeat interval stays far below the listener idle timeout', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan((DAEMON_IDLE_TIMEOUT_S * 1000) / 4);
    // Bun refuses idleTimeout above 255s — which is why no timeout value alone
    // can cover wait's 600s long-poll, and why the envelope exists.
    expect(DAEMON_IDLE_TIMEOUT_S).toBeLessThanOrEqual(255);
  });

  // INVARIANT: a client that hangs up mid-operation does NOT cancel the
  // operation. The daemon owns the work — an accept is a merge, a push, a
  // fast-forward — and abandoning it half-way is far worse than producing a
  // result nobody reads. So the deliberate semantics are: the daemon always
  // finishes, the client's abort only decides whether the answer is delivered.
  //
  // This is measured, not assumed: `heartbeatEnvelopeResponse` runs `produce()`
  // inside a ReadableStream `start()`, and the question "does Bun.serve tear
  // that down when the socket closes?" has to be answered by a real socket.
  test('a client abort mid-operation does not cancel the daemon-side work', async () => {
    const WORK_MS = 2_000;
    let completed = false;
    let sawEnqueueFailure = false;

    const server = Bun.serve({
      port: 0,
      idleTimeout: TEST_IDLE_TIMEOUT_S,
      fetch: () => heartbeatEnvelopeResponse(
        async () => {
          await Bun.sleep(WORK_MS);
          completed = true;
          return { status: 200, body: { merged: true } };
        },
        { intervalMs: 200 },
      ),
    });
    servers.push(server);

    const controller = new AbortController();
    const response = await fetch(`http://localhost:${server.port}/slow`, {
      headers: heartbeatRequestHeaders(),
      signal: controller.signal,
    });

    // Read the preamble so the connection is genuinely established and streaming,
    // then hang up the way an aborting MCP client does.
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => { sawEnqueueFailure = true; });

    // The work was mid-flight at abort time and must still finish.
    expect(completed).toBe(false);
    await Bun.sleep(WORK_MS + 1_000);
    expect(completed).toBe(true);
    // Nothing above should have thrown out of the handler; enqueue failures are
    // swallowed by design (there is no one left to report them to).
    expect(sawEnqueueFailure).toBe(false);
  }, 20_000);

  test('framing is opt-in: a request without the header gets plain JSON', async () => {
    const server = startHarness();
    const response = await call(server, '/fast', false);
    expect(isHeartbeatEnvelope(response)).toBe(false);
    expect((await response.json() as { ok: boolean }).ok).toBe(true);
  });
});

describe('transport failure classification', () => {
  // INVARIANT: "never connected" and "lost mid-request" get different advice.
  test('connect-time failures are not mid-flight failures', () => {
    for (const detail of [
      'connect ECONNREFUSED 127.0.0.1:26025',
      'Unable to connect. Is the computer able to access the url?',
      'failed to connect to host.docker.internal',
      'getaddrinfo ENOTFOUND host.docker.internal',
    ]) {
      expect(isMidFlightTransportFailure(detail)).toBe(false);
    }
  });

  test('post-connect failures are recognised as mid-flight', () => {
    for (const detail of [
      'The operation timed out.',
      'The socket connection was closed unexpectedly.',
      'read ECONNRESET',
      'write EPIPE',
    ]) {
      expect(isMidFlightTransportFailure(detail)).toBe(true);
    }
  });
});
