/**
 * Trace-context propagation across process hops.
 *
 * A single user request spans multiple processes: CLI → daemon RPC → (future)
 * supervisor → agent container. To stitch them into ONE trace tree we carry a
 * W3C `traceparent` string across each boundary:
 *   - CLI → daemon: as an RPC param / HTTP header
 *   - daemon → container: as a `TRACEPARENT` env var (design; not yet wired)
 *
 * The receiving side calls `contextFromTraceparent()` to rebuild the parent
 * context, then starts its root span under it.
 */
import {
  context, propagation, ROOT_CONTEXT, trace,
  defaultTextMapGetter, defaultTextMapSetter,
} from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

const propagator = new W3CTraceContextPropagator();

/** The header/field name we use to carry trace context. */
export const TRACEPARENT_KEY = 'traceparent';

/**
 * Serialize the currently-active span context to a `traceparent` string, or
 * null if there is no active/recording span (tracing disabled). Inject this at
 * an outgoing process boundary.
 */
export function currentTraceparent(): string | null {
  const span = trace.getSpan(context.active());
  if (!span || !span.spanContext().traceId) return null;
  const carrier: Record<string, string> = {};
  propagator.inject(context.active(), carrier, defaultTextMapSetter);
  return carrier[TRACEPARENT_KEY] ?? null;
}

/**
 * Rebuild a parent Context from an incoming `traceparent` string. Returns the
 * ROOT_CONTEXT when absent/invalid so the receiver simply starts a new trace.
 */
export function contextFromTraceparent(traceparent: string | null | undefined): Context {
  if (!traceparent) return ROOT_CONTEXT;
  const carrier = { [TRACEPARENT_KEY]: traceparent };
  return propagator.extract(ROOT_CONTEXT, carrier, defaultTextMapGetter);
}

// Register globally so any code path using the standard propagation API works.
propagation.setGlobalPropagator(propagator);
