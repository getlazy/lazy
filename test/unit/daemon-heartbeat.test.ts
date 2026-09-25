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

/**
 * Poll until `predicate` holds, or throw with `what` on timeout.
 *
 * Used instead of "sleep long enough and hope": a fixed sleep that is too short
 * fails a correct daemon, and one that is long enough to be safe pads every run.
 * Throwing (rather than returning false) keeps a never-satisfied condition from
 * looking like a pass.
 */
async function waitUntil(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`${what} (within ${timeoutMs}ms)`);
}

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
    // "Mid-flight" is established by an explicit gate, never by wall-clock: the
    // handler's work cannot finish until the test releases it, so the
    // pre-abort `completed === false` assertion is a fact rather than a race.
    // A `Bun.sleep(2s)` in the handler made it a race — on a starved event loop
    // (the whole suite runs ~45s of real sockets) the sleep could elapse before
    // the client had even read the preamble, and the test failed asserting that
    // work which correctly ran had not yet run. That flake said nothing about
    // the invariant, which is only ever about what happens AFTER the abort.
    let releaseWork!: () => void;
    const workGate = new Promise<void>(resolve => { releaseWork = resolve; });
    let completed = false;

    // What "nothing threw out of the handler" actually means: the enqueues that
    // run AFTER the socket is gone (heartbeat timer, progress, the final result
    // line) are wrapped in try/catch by design, so an escaping throw would land
    // here as an uncaught error and take the daemon with it. Observed directly —
    // the previous spelling watched the CLIENT's `reader.cancel()` promise, which
    // measures the client's own fetch implementation and not the daemon at all
    // (on Bun 1.4 cancelling an already-aborted body rejects with AbortError,
    // which is correct client behaviour and said nothing about this invariant).
    const escaped: unknown[] = [];
    const onUncaught = (err: unknown) => { escaped.push(err); };
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);

    let cancelRejection: unknown;

    const server = Bun.serve({
      port: 0,
      idleTimeout: TEST_IDLE_TIMEOUT_S,
      fetch: () => heartbeatEnvelopeResponse(
        async () => {
          await workGate;
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
    // Releasing the client's grip on a body the abort already errored is a
    // client-side no-op whose promise may resolve or reject depending on the
    // fetch implementation; neither outcome is what is under test, so the
    // rejection is only held (checked loosely at the end), never asserted on.
    await reader.cancel().catch((err: unknown) => { cancelRejection = err; });

    try {
      // The work was mid-flight at abort time — guaranteed, the gate is shut —
      // and must still finish once released, with nobody left to deliver to.
      expect(completed).toBe(false);
      // Hold the gate shut across several heartbeat intervals so the timer
      // really does attempt enqueues into a stream whose socket is gone — that
      // is the write the handler must swallow, and with no wait here the test
      // could go green without a single post-abort enqueue being tried. Unlike
      // the wall-clock this test used to depend on, a longer wait here is only
      // ever safer: it adds attempts, it cannot invalidate an assertion.
      await Bun.sleep(1_000);
      releaseWork();
      await waitUntil(() => completed, 10_000, 'daemon-side work never completed after client abort');
      // ...and every post-abort write must still have been swallowed by the
      // handler, because there is no one left to report them to. Give the
      // wrapper's post-`produce()` enqueue/close a beat to run and any escaping
      // rejection a beat to surface before concluding nothing escaped.
      await Bun.sleep(500);
      expect(escaped).toEqual([]);
      // The hang-up must be OUR hang-up and nothing else. Aborting errors the
      // response stream with the signal's reason, so cancelling the reader
      // afterwards rejects with that `AbortError` (streams spec; observed on Bun
      // 1.4.2 — Bun 1.3.14 resolved instead, so both outcomes are accepted). Any
      // other rejection means the connection died of something this test did not
      // cause, which would make the assertions above prove less than they claim.
      // Daemon-side enqueue failures never reach here at all: they are swallowed
      // inside `heartbeatEnvelopeResponse`, where there is nobody left to report
      // them to — that swallowing is what lets the work above run to completion.
      const cancelOutcome = cancelRejection === undefined
        ? 'resolved'
        : (cancelRejection as Error)?.name ?? String(cancelRejection);
      expect(['resolved', 'AbortError']).toContain(cancelOutcome);
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUncaught);
    }
  }, 20_000);

  // INVARIANT: the request's own AbortSignal is for TRACING ONLY — wiring it
  // into cancellation is the regression this guards.
  //
  // The case above hangs up without handing the wrapper a signal, so it can only
  // observe that Bun.serve does not tear the stream's `start()` down. But every
  // production call site passes `{ signal: req.signal }` (src/daemon/server.ts),
  // and that signal is the single input a cancellation regression would arrive
  // through — racing `produce()` against it, or forwarding it into the work, is
  // a two-line change that the signal-less case cannot see. So this case wires
  // the signal in exactly as production does and aborts it mid-flight.
  test('an aborted request signal is traced, not honoured as cancellation', async () => {
    // Gated, not timed — same reasoning as the case above: "the work is still
    // in flight when the signal fires" must be arranged, not hoped for.
    let releaseWork!: () => void;
    const workGate = new Promise<void>(resolve => { releaseWork = resolve; });
    let completed = false;

    const controller = new AbortController();
    const server = Bun.serve({
      port: 0,
      idleTimeout: TEST_IDLE_TIMEOUT_S,
      fetch: () => heartbeatEnvelopeResponse(
        async () => {
          await workGate;
          completed = true;
          return { status: 200, body: { merged: true } };
        },
        // Same shape as every production route.
        { intervalMs: 200, signal: controller.signal },
      ),
    });
    servers.push(server);

    const response = await fetch(`http://localhost:${server.port}/slow`, {
      headers: heartbeatRequestHeaders(),
    });
    const reader = response.body!.getReader();
    await reader.read();

    // Fire the signal the wrapper was handed, mid-work, then let the work run.
    // Releasing AFTER the abort is what makes this a cancellation test: if the
    // wrapper raced `produce()` against the signal, the envelope would have
    // already terminated with an abort-shaped result by the time the work
    // finishes, and the last-line assertion below would catch it.
    expect(completed).toBe(false);
    controller.abort();
    releaseWork();

    // This case aborts only the SIGNAL, not the fetch, so the socket is still
    // open and the envelope is still readable. That is deliberate: it lets the
    // assertion be about what the wrapper DELIVERS, which is the only thing that
    // actually distinguishes "traced" from "honoured". Asserting merely that the
    // work ran to completion would not — `produce()` keeps running and sets its
    // own flag even when the wrapper has already abandoned it to a race.
    const decoder = new TextDecoder();
    let buffered = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
    }
    const lines = buffered.trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);

    // The work finished, and its real result — not an abort-shaped error — is
    // what the envelope terminated with.
    expect(completed).toBe(true);
    expect(lines.at(-1)).toEqual({ status: 200, body: { merged: true } });
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
