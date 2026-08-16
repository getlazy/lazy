/**
 * Custom OpenTelemetry SpanExporter that persists finished spans through
 * lazy's own Storage as JSONL — NOT to a collector or network backend.
 *
 * This is the crux of the "OTel API surface without the OTel pipeline"
 * approach: we reuse the battle-tested tracer/context/propagation machinery
 * but own the tail end (persistence + query) so timings are answerable by
 * lazy itself (`lazy stats timings`).
 */
import { hrTimeToMilliseconds } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';
import { logger } from '../utils/logger';
import type { SpanRecord, SpanSink } from './types';

function toRecord(span: ReadableSpan, service: string): SpanRecord {
  const ctx = span.spanContext();
  // OTel v2 exposes the parent via parentSpanContext; older shapes used
  // parentSpanId. Support both so a version bump doesn't silently drop nesting.
  const parent =
    (span as { parentSpanContext?: { spanId?: string } }).parentSpanContext?.spanId ??
    (span as { parentSpanId?: string }).parentSpanId ??
    null;
  const start = hrTimeToMilliseconds(span.startTime);
  const end = hrTimeToMilliseconds(span.endTime);
  const status =
    span.status.code === SpanStatusCode.OK ? 'ok'
    : span.status.code === SpanStatusCode.ERROR ? 'error'
    : 'unset';
  // Attributes may hold arrays/undefined; flatten to primitives for JSONL.
  const attributes: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(span.attributes)) {
    if (v == null) continue;
    attributes[k] = Array.isArray(v) ? v.join(',') : (v as string | number | boolean);
  }
  return {
    trace_id: ctx.traceId,
    span_id: ctx.spanId,
    parent_span_id: parent,
    name: span.name,
    start_ms: start,
    end_ms: end,
    duration_ms: end - start,
    status,
    service,
    attributes,
  };
}

export class JsonlSpanExporter implements SpanExporter {
  constructor(
    private readonly sink: SpanSink,
    private readonly service: string,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const records = spans.map((s) => toRecord(s, this.service));
    // The sink is async (Storage write); report the OTel result once it lands.
    // A persistence failure must be visible, not swallowed — but it must never
    // crash the traced operation, so we log and report FAILED rather than throw.
    this.sink(records)
      .then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
      .catch((err: unknown) => {
        logger.warn(`Trace span persistence failed: ${err instanceof Error ? err.message : String(err)}`);
        resultCallback({ code: ExportResultCode.FAILED, error: err instanceof Error ? err : new Error(String(err)) });
      });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
