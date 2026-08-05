/**
 * Heartbeat envelope — keeps long daemon requests alive on Bun.serve.
 *
 * WHY THIS EXISTS (measured, not assumed — Bun 1.3.14):
 *
 * `Bun.serve`'s `idleTimeout` is an *idle* timer on the connection, and a
 * request handler that has not yet returned a `Response` writes no bytes. So a
 * handler that legitimately takes longer than the idle timeout has its
 * connection reaped out from under it, mid-operation: the client sees a socket
 * close or a timeout, and the work either completes invisibly or is abandoned.
 *
 * Every long daemon operation hit this:
 *   - `wait` long-polls for up to 600s; both listeners used idleTimeout=120, so
 *     any wait past ~2 minutes was GUARANTEED to die.
 *   - a large `accept` (merge + fast-forward + push) holds the request for the
 *     whole merge and died at the same 120s boundary.
 *
 * None of the obvious escapes work:
 *   - `Bun.serve` refuses `idleTimeout > 255`, so no value covers a 600s wait.
 *   - `server.timeout(req, n)` extends the deadline on a TCP listener but is
 *     ignored on a unix-socket listener (verified), and re-arming it on a timer
 *     does not reliably reset the deadline.
 *
 * What DOES work on both transports: writing bytes. A streamed response body
 * resets the idle timer (verified: a 26s response survived a 5s idleTimeout with
 * 2s between writes), so this module frames the reply as newline-delimited JSON
 * and emits a heartbeat line every few seconds until the real result is ready:
 *
 *   {"lazyEnvelope":1}                      <- immediately, on request receipt
 *   {"progress":{...}}                      <- whenever the handler changes phase
 *   {"heartbeat":5000,"phase":"Merge"}      <- every HEARTBEAT_INTERVAL_MS
 *   {"status":200,"body":{...}}             <- once, when the handler settles
 *
 * The HTTP status of an enveloped response is always 200 (headers must be sent
 * before the handler's outcome is known); the real status travels in the final
 * line and the client reconstructs it. Because a truncated stream is
 * distinguishable from a complete one, a dropped connection now produces a
 * precise error instead of masquerading as "the daemon is down".
 *
 * Opt-in per request via the `X-Lazy-Heartbeat` header, so a client that
 * predates this framing (an already-running container) keeps the old plain-JSON
 * behaviour instead of choking on NDJSON.
 */

import type { ProgressEmitter, ProgressEvent } from './progress';

/**
 * `idleTimeout` used by every daemon listener (unix socket and TCP web server).
 *
 * Bun rejects any value above 255. It is deliberately NOT the mechanism that
 * keeps long operations alive — the heartbeat envelope is. This is the ceiling
 * for a connection that produces no bytes at all (a client that opened a socket
 * and vanished), and it must stay comfortably above HEARTBEAT_INTERVAL_MS.
 *
 * Do NOT set this below ~5 seconds, here or in a test harness: measured on Bun
 * 1.3.14, values of 2-4 degenerate into a hard ~4s request deadline that writes
 * do NOT reset (timer granularity), so heartbeats stop working entirely.
 */
export const DAEMON_IDLE_TIMEOUT_S = 120;

/** Request header a client sends to ask for heartbeat framing. */
export const HEARTBEAT_HEADER = 'x-lazy-heartbeat';

/** Value of {@link HEARTBEAT_HEADER} — a version, so framing can evolve. */
export const HEARTBEAT_HEADER_VALUE = '1';

/** Content type of an enveloped response body. */
export const HEARTBEAT_CONTENT_TYPE = 'application/x-ndjson';

/**
 * How often a heartbeat line is written while the handler runs.
 *
 * INVARIANT: this MUST stay well below the smallest `idleTimeout` any daemon
 * listener uses (see DAEMON_IDLE_TIMEOUT_S in server.ts) — the whole mechanism
 * is "write something before the connection goes idle". 5s against a 120s idle
 * timeout leaves a 24x margin, which also survives a briefly-starved event loop.
 */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Deadline applied to every web-dashboard request (see `createWebRequestHandler`).
 *
 * The heartbeat envelope is not available to those routes: their client is a
 * browser, which cannot opt in via {@link HEARTBEAT_HEADER} and cannot read
 * NDJSON. So the dashboard gets the other half of the guarantee — a deadline
 * strictly inside the idle timeout, so a request that would otherwise be reaped
 * mid-flight instead ends as a real, visible, actionable HTTP response.
 *
 * Derived from DAEMON_IDLE_TIMEOUT_S rather than written as a literal: the whole
 * point is that it lands BEFORE the connection is reaped, and a literal would
 * silently stop doing that the moment the idle timeout is retuned. The 15s
 * margin covers a briefly-starved event loop (the timer fires late) plus the
 * time to render and write the error page.
 *
 * This is a backstop for pathological cases, not a performance budget: a
 * dashboard page that takes 105s is already broken, and this only decides
 * whether the user learns that or sees an empty browser error.
 */
export const WEB_REQUEST_DEADLINE_MS = (DAEMON_IDLE_TIMEOUT_S - 15) * 1_000;

/** First line of an enveloped body: marks the framing and resets the idle timer. */
interface EnvelopePreamble { lazyEnvelope: number }

/** A phase-progress line written by the handler mid-flight. */
interface EnvelopeProgressLine { progress: ProgressEvent }

/** Final line of an enveloped body: the real HTTP status and JSON body. */
export interface EnvelopeResult {
  status: number;
  body: unknown;
}

/**
 * What a wrapped daemon route produces: the status and body it would have sent.
 *
 * The producer is handed a {@link ProgressEmitter}. Calling it writes a
 * `{"progress": …}` line into the same stream, immediately — so a long handler
 * can narrate its phases to the caller instead of being a silent five-minute
 * gap. Handlers that have nothing to narrate simply ignore the argument.
 */
export type EnvelopeProducer = (emit: ProgressEmitter) => Promise<EnvelopeResult>;

/**
 * Thrown when an enveloped response ended without its final line — the daemon
 * died, was restarted, or the connection was severed while the operation ran.
 *
 * Distinct from "could not reach the daemon" on purpose: the request DID reach a
 * healthy daemon and the operation may well have completed on the host, so the
 * advice differs (re-check state, don't relaunch anything).
 */
export class DaemonConnectionLostError extends Error {
  constructor(operation: string, detail?: string) {
    super(
      `The daemon dropped the connection while '${operation}' was still running` +
      (detail ? ` (${detail})` : '') + '. ' +
      'The daemon was reachable when the request started, so this is a lost connection, ' +
      'not a daemon that is down — the operation may have completed on the host. ' +
      'Re-check state (e.g. `lazy show <task>`) before retrying, and see `lazy daemon status`.',
    );
    this.name = 'DaemonConnectionLostError';
  }
}

/** True when `req` asked for heartbeat framing. */
export function clientAcceptsHeartbeat(req: Request): boolean {
  return req.headers.get(HEARTBEAT_HEADER) !== null;
}

/** Headers a client must send to receive heartbeat framing. */
export function heartbeatRequestHeaders(): Record<string, string> {
  return { 'X-Lazy-Heartbeat': HEARTBEAT_HEADER_VALUE };
}

/**
 * Wrap a route's work in a heartbeat-framed streaming response.
 *
 * `produce` must not throw — it is the route's own try/catch boundary and
 * returns the status/body it wants to send. A throw is still handled (reported
 * as a 500 inside the envelope) so a bug cannot leave the client hanging on a
 * stream that never terminates.
 */
export function heartbeatEnvelopeResponse(
  produce: EnvelopeProducer,
  options?: { intervalMs?: number },
): Response {
  const intervalMs = options?.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const encoder = new TextEncoder();
  const line = (value: unknown) => encoder.encode(JSON.stringify(value) + '\n');

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Sent before any work begins: the connection is never idle from birth,
      // and the client knows the framing before the first heartbeat is due.
      controller.enqueue(line({ lazyEnvelope: 1 } satisfies EnvelopePreamble));

      const started = Date.now();
      let settled = false;
      // Label of the phase the handler last entered, mirrored onto every
      // heartbeat so a liveness tick says WHAT is alive, not merely that
      // something is. Cleared when the phase closes.
      let currentPhase: string | undefined;

      const emit: ProgressEmitter = (event) => {
        if (settled) return;
        if (event.kind === 'phase') {
          currentPhase = event.state === 'start' ? event.label : undefined;
        }
        try {
          controller.enqueue(line({ progress: event } satisfies EnvelopeProgressLine));
        } catch {
          // Client hung up. Same reasoning as the heartbeat timer below: the
          // work continues, there is simply nobody left to narrate to.
        }
      };

      const timer = setInterval(() => {
        if (settled) return;
        try {
          controller.enqueue(line({ heartbeat: Date.now() - started, phase: currentPhase }));
        } catch {
          // The client hung up. Nothing to keep alive; stop writing. The work
          // itself is already in flight and is deliberately NOT cancelled — a
          // half-applied merge is far worse than an unread result.
          clearInterval(timer);
        }
      }, intervalMs);

      let result: EnvelopeResult;
      try {
        result = await produce(emit);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = { status: 500, body: { error: message } };
      } finally {
        settled = true;
        clearInterval(timer);
      }

      try {
        controller.enqueue(line(result));
        controller.close();
      } catch {
        // Client already gone — the response is undeliverable, and there is no
        // one left to report that to. The work completed regardless.
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': HEARTBEAT_CONTENT_TYPE },
  });
}

/** True when `response` carries heartbeat framing (vs a plain JSON reply). */
export function isHeartbeatEnvelope(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes(HEARTBEAT_CONTENT_TYPE);
}

/**
 * Read an enveloped response down to its final line and return the real status
 * and body.
 *
 * Throws {@link DaemonConnectionLostError} when the stream ends without a final
 * result line — that is the "connection died mid-operation" case, and it must
 * NOT be reported as an unreachable daemon.
 *
 * `operation` names the call for the error message (an RPC command or tool name).
 *
 * `onHeartbeat` is invoked for each liveness line the daemon wrote, with the
 * daemon-reported elapsed time and the label of the phase in flight (when the
 * handler is narrating one). This is the ONLY honest liveness signal a
 * caller has while the operation runs — it means the daemon's handler is still
 * in flight, not merely that a socket is open — and it is what the MCP proxy
 * relays to its own client as `notifications/progress`. It must never be
 * simulated locally: if the daemon stops writing, the silence is the message.
 *
 * `onProgress` is invoked for each phase-progress line — the daemon telling the
 * caller what it just started or finished (see ./progress.ts).
 */
export async function readHeartbeatEnvelope(
  response: Response,
  operation: string,
  onHeartbeat?: (elapsedMs: number, phase?: string) => void,
  onProgress?: ProgressEmitter,
): Promise<EnvelopeResult> {
  const reader = response.body?.getReader();
  if (!reader) throw new DaemonConnectionLostError(operation, 'response had no body');

  const decoder = new TextDecoder();
  let buffered = '';
  let last: EnvelopeResult | null = null;

  const consume = (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const raw = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `daemon sent an unparseable envelope line for '${operation}': ${message} (line: ${raw.slice(0, 200)})`,
        );
      }
      // Preamble and heartbeats are liveness only; the result line is the payload.
      if (parsed && typeof parsed === 'object' && 'status' in (parsed as Record<string, unknown>)) {
        last = parsed as EnvelopeResult;
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const record = parsed as Record<string, unknown>;
      // A progress line is BOTH narration and liveness: the daemon wrote it
      // because its handler is running right now. Feed the heartbeat callback
      // too, so a client whose deadline is reset by liveness is reset by a
      // phase change as well.
      if (record.progress && typeof record.progress === 'object') {
        onProgress?.(record.progress as ProgressEvent);
        onHeartbeat?.(0, undefined);
        continue;
      }
      if (!onHeartbeat) continue;
      // The preamble counts: it is the daemon's first written byte, and a
      // client's idle clock starts at the request, not at the first heartbeat.
      if ('lazyEnvelope' in record) onHeartbeat(0);
      else if (typeof record.heartbeat === 'number') {
        onHeartbeat(record.heartbeat, typeof record.phase === 'string' ? record.phase : undefined);
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) consume(decoder.decode(value, { stream: true }));
      if (done) break;
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new DaemonConnectionLostError(operation, detail);
  }
  consume(decoder.decode());

  if (!last) throw new DaemonConnectionLostError(operation, 'stream ended before the result line');
  return last;
}
