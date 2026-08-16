/**
 * Request-lifetime span for every daemon HTTP request.
 *
 * WHY THIS EXISTS
 *
 * A span is written to the trace log when `withSpan`'s callback *settles* (see
 * `run()` in src/tracing/span.ts — `span.end()` lives in a `finally`). So until
 * this module existed, a request that never settled left NO record at all: the
 * connection reaped under `Bun.serve`'s idle timer, the handler abandoned
 * mid-flight, and `lazy stats timings` showing absence — which reads exactly like a
 * request that was never made. `fix-daemon-blips` was a stall of precisely that
 * shape, and it had to be reproduced against a real `Bun.serve` because timings
 * could not see it.
 *
 * The fix is a span whose end is NOT tied to the handler settling. It ends at
 * the first of:
 *   - the handler returning a Response (or, for a heartbeat-framed reply, that
 *     reply's body reaching its final line),
 *   - the handler throwing,
 *   - `req.signal` aborting — which is what Bun fires when it reaps the
 *     connection (verified on Bun 1.3.14: a silent handler under
 *     `idleTimeout: 5` sees `abort` at ~8s and keeps running afterwards).
 *
 * A reaped request therefore lands in `lazy stats timings` as an ERROR row carrying
 * `lazy.request.reaped=true`, not as silence. "No span" now really does mean
 * "the request never reached this daemon" — the one residual blind spot is hard
 * process death (SIGKILL), where nothing gets a chance to write anything.
 */
import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { contextFromTraceparent, isTracingEnabled, TRACER_NAME } from '../tracing';
import { isHeartbeatEnvelope } from './heartbeat';

/** Which listener took the request — the two have different reap behaviour. */
export type DaemonTransport = 'unix' | 'tcp';

/**
 * Path segments are interpolated into the span NAME, so anything unbounded
 * (a task id) must never reach it: `lazy stats timings` groups by name, and one
 * name per task id makes the readout useless. RPC commands and MCP tool names
 * ARE bounded — there is a finite list of each — so they stay in the name,
 * which is what makes `daemon.request /rpc/wait` directly rankable.
 *
 * A bogus client can still put anything in those positions, so they are
 * validated rather than trusted.
 */
const SAFE_SEGMENT = /^[a-z][a-z0-9_-]{0,31}$/i;

function segment(raw: string | undefined): string {
  return raw && SAFE_SEGMENT.test(raw) ? raw : 'other';
}

/**
 * Collapse a request path to a low-cardinality route template.
 *
 * Mirrors the ROUTE TABLE in src/daemon/server.ts. Dashboard routes are not
 * enumerated there (they live in src/server/index.ts and are open-ended), so
 * they collapse to their first segment.
 */
export function daemonRouteTemplate(pathname: string): string {
  if (pathname === '/daemon/status' || pathname === '/daemon/shutdown') return pathname;

  const parts = pathname.split('/').filter(Boolean);

  // /mcp/:taskId/:toolName — the task id is unbounded, the tool name is not.
  if (parts[0] === 'mcp') return `/mcp/:taskId/${segment(parts[2])}`;

  // /rpc/{command}
  if (parts[0] === 'rpc') return `/rpc/${segment(parts[1])}`;

  return parts.length > 0 ? `/${segment(parts[0])}/*` : '/';
}

/** Ends `span` at most once, whichever of the racing outcomes gets there first. */
function endOnce(span: Span): (finish: (span: Span) => void) => void {
  let ended = false;
  return (finish) => {
    if (ended) return;
    ended = true;
    finish(span);
    span.end();
  };
}

/**
 * Wrap a daemon listener's outermost handler in a request-lifetime span.
 *
 * Placed at the *listener* boundary rather than around `handleDaemonRequest` on
 * purpose: auth rejections, 404s, and dashboard routes are requests too, and a
 * reap during any of them is exactly as invisible as a reap during an RPC.
 *
 * When tracing is disabled this is a direct pass-through — no span, no body
 * wrapping, no listener registration.
 */
export function withRequestSpan(
  req: Request,
  transport: DaemonTransport,
  handle: () => Promise<Response>,
): Promise<Response> {
  if (!isTracingEnabled()) return handle();

  const route = daemonRouteTemplate(new URL(req.url).pathname);

  // Stitch onto the caller's trace when the client propagated a `traceparent`
  // header (src/daemon/client.ts sends one whenever the CLI is tracing), so the
  // daemon-side request sits in the same trace as the command that made it.
  // Without one this starts a fresh trace, which is the correct server default.
  const parentCtx = contextFromTraceparent(req.headers.get('traceparent') ?? undefined);

  const span = trace.getTracer(TRACER_NAME).startSpan(
    `daemon.request ${route}`,
    {
      attributes: {
        'http.request.method': req.method,
        'http.route': route,
        'lazy.daemon.transport': transport,
      },
    },
    parentCtx,
  );

  const finish = endOnce(span);

  const onAbort = () => finish((s) => {
    s.setAttribute('lazy.request.reaped', true);
    s.setStatus({
      code: SpanStatusCode.ERROR,
      // Named for the symptom a human will be searching for.
      message: 'connection closed before the response was delivered (reaped or client hung up)',
    });
  });
  req.signal.addEventListener('abort', onAbort, { once: true });

  const settled = (response: Response) => finish((s) => {
    s.setAttribute('http.response.status_code', response.status);
    s.setStatus({ code: response.status >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
  });

  return context.with(trace.setSpan(parentCtx, span), handle).then(
    (response) => {
      // A heartbeat-framed reply returns its Response almost immediately and
      // does the real work while streaming (src/daemon/heartbeat.ts). Ending
      // here would report a 600s `wait` as a 2ms request AND leave the span's
      // own children outliving it, so for those the span ends when the body
      // reaches its final line instead. Only enveloped bodies are wrapped —
      // they are a handful of tiny NDJSON lines, whereas wrapping every
      // dashboard asset would add a pass-through copy for no diagnostic gain.
      if (isHeartbeatEnvelope(response) && response.body) {
        span.setAttribute('lazy.response.framed', true);
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              controller.enqueue(chunk);
            },
            flush() {
              settled(response);
            },
          }),
        );
        // The abort listener deliberately stays armed here: a stream that errors
        // instead of flushing means the client is gone, and that is the reap
        // this whole module exists to record.
        return new Response(body, { status: response.status, headers: response.headers });
      }

      req.signal.removeEventListener('abort', onAbort);
      settled(response);
      return response;
    },
    (err) => {
      req.signal.removeEventListener('abort', onAbort);
      finish((s) => {
        s.recordException(err as Error);
        s.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
      });
      throw err;
    },
  );
}
