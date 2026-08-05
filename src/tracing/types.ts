/**
 * Persisted span schema — one JSONL row per finished span.
 *
 * This is the on-disk contract that `lazy timings` reads back. It is a flat,
 * self-describing projection of an OpenTelemetry span: enough to reconstruct
 * the trace tree and answer "what was slow" without any OTel dependency at
 * read time.
 */
export interface SpanRecord {
  /** W3C trace id (32 hex). All spans of one request share this. */
  trace_id: string;
  /** Span id (16 hex). */
  span_id: string;
  /** Parent span id, or null for a trace root. */
  parent_span_id: string | null;
  /** Operation name, e.g. `lazy.start` or `git.worktree.create`. */
  name: string;
  /** Wall-clock start (epoch ms). */
  start_ms: number;
  /** Wall-clock end (epoch ms). */
  end_ms: number;
  /** Convenience: end_ms - start_ms. */
  duration_ms: number;
  /** Coarse outcome. */
  status: 'ok' | 'error' | 'unset';
  /** Which process emitted the span (cli, daemon, supervisor). */
  service: string;
  /** Flat attribute bag (git ref, container name, task id, …). */
  attributes: Record<string, string | number | boolean>;
}

/** A sink that durably persists finished spans (wired to Storage). */
export type SpanSink = (records: SpanRecord[]) => Promise<void>;
