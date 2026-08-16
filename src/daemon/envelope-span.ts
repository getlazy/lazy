/**
 * Tracing for the heartbeat envelope writer (src/daemon/heartbeat.ts).
 *
 * Lives in its own module so `heartbeat.ts` — the framing contract, imported by
 * clients as well as the daemon — does not take a direct dependency on the OTel
 * API, and so `request-span.ts` can keep importing `heartbeat.ts` without a
 * cycle.
 *
 * The writer's span is the one that carries the real duration of a framed
 * route: `wait` long-polls up to 600s while the HTTP Response is handed back
 * within milliseconds. Its three outcomes are deliberately distinct, because
 * they call for completely different follow-up:
 *
 *   delivered     — the result line reached the client. Nothing to see.
 *   undeliverable — the work finished but the client had already gone. The
 *                   operation DID happen on the host; a user reporting "it
 *                   failed" here is reporting a lost reply, not lost work.
 *   reaped        — the connection went away while the work was still running.
 *                   This is the `fix-daemon-blips` shape.
 *
 * `lazy.heartbeat.count` is the liveness evidence in all three: a healthy long
 * request writes one every HEARTBEAT_INTERVAL_MS, so a low count on a
 * long-duration span means the writer stopped being able to write.
 */
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { isTracingEnabled, TRACER_NAME } from '../tracing';

/** Handle returned by {@link startEnvelopeSpan}. Ends the span at most once. */
export interface EnvelopeSpan {
  /** Result line written and the stream closed. */
  delivered(status: number, heartbeats: number): void;
  /** Work finished, but the client was already gone. */
  undeliverable(status: number, heartbeats: number): void;
  /** The request aborted while the work was still in flight. */
  reaped(heartbeats: number): void;
}

const NOOP: EnvelopeSpan = {
  delivered() {},
  undeliverable() {},
  reaped() {},
};

/**
 * Start a span covering the envelope writer, as a child of whatever span is
 * active (the request span, in the daemon). A no-op when tracing is off.
 */
export function startEnvelopeSpan(): EnvelopeSpan {
  if (!isTracingEnabled()) return NOOP;

  const span = trace.getTracer(TRACER_NAME).startSpan('daemon.envelope');

  let ended = false;
  const end = (finish: (span: Span) => void): void => {
    if (ended) return;
    ended = true;
    finish(span);
    span.end();
  };

  return {
    delivered(status, heartbeats) {
      end((s) => {
        s.setAttribute('lazy.envelope.outcome', 'delivered');
        s.setAttribute('lazy.envelope.status', status);
        s.setAttribute('lazy.heartbeat.count', heartbeats);
        s.setStatus({ code: status >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      });
    },
    undeliverable(status, heartbeats) {
      end((s) => {
        s.setAttribute('lazy.envelope.outcome', 'undeliverable');
        s.setAttribute('lazy.envelope.status', status);
        s.setAttribute('lazy.heartbeat.count', heartbeats);
        s.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'the work completed but the client was gone before the result line could be written',
        });
      });
    },
    reaped(heartbeats) {
      end((s) => {
        s.setAttribute('lazy.envelope.outcome', 'reaped');
        s.setAttribute('lazy.heartbeat.count', heartbeats);
        s.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'the connection was lost while the operation was still running',
        });
      });
    },
  };
}
