/**
 * Tracing provider lifecycle.
 *
 * Tracing is ALWAYS ON. There is no env var and no config knob: a span costs
 * microseconds and the writes are batched and asynchronous, which is invisible
 * against the multi-second git/docker/network operations we instrument (see the
 * measured overhead in docs/spikes/timings.md). An off-switch would only create
 * two code paths to reason about and — as the original `LAZY_TRACE` gate proved
 * — a `lazy timings` that silently reports nothing because a knob nobody knew
 * about was unset.
 *
 * `initTracing()` registers:
 *   - an AsyncLocalStorageContextManager, so nested async spans stitch into a
 *     tree in-process (verified to work under Bun — see docs/spikes/timings);
 *   - a BasicTracerProvider with a BatchSpanProcessor feeding our JSONL
 *     exporter, so span persistence never blocks the traced operation.
 *
 * A process that never calls `initTracing()` still works: no provider is
 * registered, so `trace.getTracer()` returns the OTel no-op tracer and
 * `withSpan()` degrades to a plain awaited function call.
 *
 * This module deliberately uses `@opentelemetry/sdk-trace-base` (the SDK's
 * tracer) rather than a hand-rolled tracer: the SDK gives correct id
 * generation, hrtime, sampling and W3C propagation for free.
 */
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { JsonlSpanExporter } from './jsonl-exporter';
import type { SpanSink } from './types';

export const TRACER_NAME = 'lazy';

let provider: BasicTracerProvider | null = null;

/** True once tracing has been initialized in this process. */
export function isTracingEnabled(): boolean {
  return provider !== null;
}

/**
 * Initialize tracing for the current process. Idempotent. `service` labels
 * which process the spans came from; `sink` persists finished spans (wired to
 * Storage by the caller).
 */
export function initTracing(service: string, sink: SpanSink): void {
  if (provider) return;

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const exporter = new JsonlSpanExporter(sink, service);
  provider = new BasicTracerProvider({
    // Batch so a burst of spans flushes together and Storage writes stay off
    // the hot path. Short delay keeps `lazy timings` fresh after a command.
    spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 500 })],
  });
  trace.setGlobalTracerProvider(provider);
}

/**
 * Flush and tear down. CLI processes are short-lived, so callers must flush
 * before exit or batched spans are lost. Safe to call when never initialized.
 */
export async function shutdownTracing(): Promise<void> {
  if (!provider) return;
  try {
    await provider.forceFlush();
    await provider.shutdown();
  } finally {
    provider = null;
  }
}
