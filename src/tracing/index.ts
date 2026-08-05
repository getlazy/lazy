/**
 * lazy tracing — OpenTelemetry API surface, persisted through lazy's own
 * Storage as JSONL (no collector, no network, always on, bounded retention).
 *
 * See docs/spikes/timings.md for the architecture.
 */
export { withSpan, withRootSpan } from './span';
export { initTracing, shutdownTracing, isTracingEnabled, TRACER_NAME } from './provider';
export { currentTraceparent, contextFromTraceparent, TRACEPARENT_KEY } from './propagation';
export type { SpanRecord, SpanSink } from './types';
