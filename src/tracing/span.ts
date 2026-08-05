/**
 * Ergonomic span helpers over the OTel API.
 *
 * `withSpan` wraps an async operation in a span: it becomes the active span for
 * the duration (so nested `withSpan` calls attach as children), records ok/error
 * status, and always ends. When tracing is disabled the global no-op tracer
 * makes this a thin pass-through — safe to sprinkle on hot paths.
 */
import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import type { Span, Context, Attributes } from '@opentelemetry/api';
import { TRACER_NAME } from './provider';

function tracer() {
  return trace.getTracer(TRACER_NAME);
}

async function run<T>(span: Span, fn: (span: Span) => Promise<T>): Promise<T> {
  try {
    const result = await fn(span);
    if (span.isRecording()) span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    span.end();
  }
}

/**
 * Run `fn` inside a span named `name`, attached to the current active span (if
 * any) as a child.
 */
export function withSpan<T>(
  name: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes: attrs }, (span) => run(span, fn));
}

/**
 * Run `fn` inside a span rooted under an explicit parent `Context` (e.g. one
 * rebuilt from an incoming `traceparent`). Use this at a process boundary to
 * stitch the local trace onto the caller's.
 */
export function withRootSpan<T>(
  name: string,
  parent: Context,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer().startSpan(name, { attributes: attrs }, parent);
  const ctx = trace.setSpan(parent, span);
  return context.with(ctx, () => run(span, fn));
}
