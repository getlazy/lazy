/**
 * Token-usage capture for the passthrough proxy.
 *
 * Anthropic reports usage in two shapes:
 *
 *   - Non-streaming `/v1/messages`: a top-level `usage` object on the response
 *     body.
 *   - Streaming (SSE): `message_start` carries the initial usage (input,
 *     cache-creation, cache-read; output is a placeholder), and the final
 *     `message_delta` carries the CUMULATIVE `usage` for the turn — chiefly the
 *     real `output_tokens`. Later API versions also repeat the input counts
 *     there. We therefore merge `message_start` then overlay `message_delta`,
 *     which is correct for both.
 *
 * Two entry points, one for each proxy path:
 *
 *   - `extractUsage()` — for a body we already hold in memory (the enforcement
 *     path buffers the response to rewrite it).
 *   - `teeUsageStream()` — for the streaming passthrough. Wraps the upstream
 *     `ReadableStream` and forwards every chunk to the client BEFORE inspecting
 *     it, so the client sees bytes at exactly the same moment it would have
 *     without the tee. Nothing is buffered beyond a bounded partial-line
 *     remainder (SSE) or a capped body accumulator (non-SSE JSON). `onDone` is
 *     invoked exactly once — on end-of-stream, on client cancel, or on a read
 *     error — so the caller can always enqueue its audit record.
 */

import type { ProxyTokenUsage } from '../storage/types';

/**
 * Cap on the SSE partial-line remainder. A single `data:` line is a few KB at
 * most in practice; anything past this means we are not looking at an SSE
 * stream we understand, so we resync at the next newline rather than growing
 * without bound.
 */
const MAX_SSE_LINE_BYTES = 1024 * 1024;

/**
 * Cap on the accumulated non-streaming JSON body. Beyond this we stop
 * accumulating and report no usage rather than hold an unbounded string for a
 * response we only want four integers out of.
 */
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** True when every field is null — i.e. we saw no usage worth recording. */
function isEmpty(u: ProxyTokenUsage): boolean {
  return (
    u.inputTokens === null &&
    u.outputTokens === null &&
    u.cacheCreationInputTokens === null &&
    u.cacheReadInputTokens === null
  );
}

/**
 * Accumulates usage across the (possibly several) places Anthropic reports it.
 * Later non-null values win — `message_delta`'s cumulative counts override
 * `message_start`'s placeholders — while a field that a later event omits keeps
 * the value an earlier event provided.
 */
class UsageAccumulator {
  private usage: ProxyTokenUsage = {
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  };

  /** Merge one raw Anthropic `usage` object. Unknown/absent fields are ignored. */
  merge(raw: unknown): void {
    if (raw === null || typeof raw !== 'object') return;
    const u = raw as Record<string, unknown>;
    const input = numberOrNull(u.input_tokens);
    const output = numberOrNull(u.output_tokens);
    const cacheCreation = numberOrNull(u.cache_creation_input_tokens);
    const cacheRead = numberOrNull(u.cache_read_input_tokens);
    if (input !== null) this.usage.inputTokens = input;
    if (output !== null) this.usage.outputTokens = output;
    if (cacheCreation !== null) this.usage.cacheCreationInputTokens = cacheCreation;
    if (cacheRead !== null) this.usage.cacheReadInputTokens = cacheRead;
  }

  /** The merged usage, or null when nothing usable was ever seen. */
  result(): ProxyTokenUsage | null {
    return isEmpty(this.usage) ? null : { ...this.usage };
  }
}

/**
 * Feed one parsed SSE `data:` payload into the accumulator. Only the two event
 * types that carry usage are considered; everything else is ignored.
 */
function mergeSSEEvent(acc: UsageAccumulator, data: Record<string, unknown>): void {
  if (data.type === 'message_start') {
    const msg = data.message as Record<string, unknown> | undefined;
    if (msg) acc.merge(msg.usage);
    return;
  }
  if (data.type === 'message_delta') {
    acc.merge(data.usage);
  }
}

/** Merge every usage-bearing `data:` line of a buffered SSE body. */
function mergeSSEBody(acc: UsageAccumulator, bodyText: string): void {
  for (const line of bodyText.split('\n')) {
    mergeSSELine(acc, line);
  }
}

/** Merge one raw SSE line (with or without a trailing `\r`). */
function mergeSSELine(acc: UsageAccumulator, line: string): void {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith('data:')) return;
  const payload = trimmed.slice('data:'.length).trim();
  if (!payload || payload === '[DONE]') return;
  try {
    mergeSSEEvent(acc, JSON.parse(payload) as Record<string, unknown>);
  } catch {
    // A malformed data line means this event is unreadable — skip it and keep
    // scanning. Usage lives on its own event, so one bad line elsewhere in the
    // stream must not cost us the whole record.
  }
}

/**
 * Extract token usage from a fully-buffered response body.
 *
 * @param isStream whether the body is an SSE stream (vs. a single JSON object)
 * @param bodyText the complete response body
 * @returns merged usage, or null when the body carries none
 */
export function extractUsage(isStream: boolean, bodyText: string): ProxyTokenUsage | null {
  if (!bodyText) return null;
  const acc = new UsageAccumulator();
  if (isStream) {
    mergeSSEBody(acc, bodyText);
  } else {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      acc.merge(parsed?.usage);
    } catch {
      // Not JSON we can read (e.g. an HTML error page from a proxy in front of
      // the upstream) — no usage to report.
      return null;
    }
  }
  return acc.result();
}

/**
 * Incremental scanner fed chunk-by-chunk from the streaming tee. Holds only a
 * partial-line remainder (SSE) or a capped body accumulator (JSON).
 */
class UsageScanner {
  private readonly acc = new UsageAccumulator();
  private readonly decoder = new TextDecoder('utf-8');
  private readonly isStream: boolean;
  private buffer = '';
  /** Set after an over-long SSE line: skip bytes until the next newline resyncs us. */
  private resyncing = false;
  /** Set once the JSON accumulator hits its cap: stop accumulating entirely. */
  private overflowed = false;

  constructor(isStream: boolean) {
    this.isStream = isStream;
  }

  push(chunk: Uint8Array): void {
    if (this.overflowed) return;
    const text = this.decoder.decode(chunk, { stream: true });
    if (!text) return;

    if (!this.isStream) {
      if (this.buffer.length + text.length > MAX_JSON_BODY_BYTES) {
        // Too large to be worth holding for four integers — give up cleanly.
        this.overflowed = true;
        this.buffer = '';
        return;
      }
      this.buffer += text;
      return;
    }

    this.buffer += text;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (this.resyncing) {
        // Tail of the over-long line we abandoned — drop it, we are back in sync.
        this.resyncing = false;
        continue;
      }
      mergeSSELine(this.acc, line);
    }
    if (this.buffer.length > MAX_SSE_LINE_BYTES) {
      this.buffer = '';
      this.resyncing = true;
    }
  }

  /** Flush the decoder + any remaining unterminated line, then report. */
  result(): ProxyTokenUsage | null {
    const tail = this.decoder.decode();
    if (tail) this.buffer += tail;
    if (this.overflowed) return this.acc.result();
    if (this.isStream) {
      if (!this.resyncing && this.buffer) mergeSSELine(this.acc, this.buffer);
    } else if (this.buffer) {
      try {
        const parsed = JSON.parse(this.buffer) as Record<string, unknown>;
        this.acc.merge(parsed?.usage);
      } catch {
        // Truncated or non-JSON body — nothing to report.
      }
    }
    this.buffer = '';
    return this.acc.result();
  }
}

/**
 * Wrap an upstream response body so usage can be observed without buffering it
 * or delaying it.
 *
 * Every chunk is enqueued to the client FIRST and only then handed to the
 * scanner, so the tee cannot add latency to the byte stream. Backpressure is
 * preserved: we read one chunk per `pull`, exactly as the consumer asks for it.
 *
 * `onDone` fires exactly once with whatever usage was observed — including the
 * cancel and error paths, where usage is typically null. Callers rely on this
 * to enqueue their audit record no matter how the stream ends.
 */
export function teeUsageStream(
  body: ReadableStream<Uint8Array>,
  isStream: boolean,
  onDone: (usage: ProxyTokenUsage | null) => void,
): ReadableStream<Uint8Array> {
  const scanner = new UsageScanner(isStream);
  const reader = body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone(scanner.result());
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          finish();
          return;
        }
        // Forward before inspecting — the client never waits on the scanner.
        controller.enqueue(value);
        scanner.push(value);
      } catch (err) {
        // The upstream stream broke mid-flight. Propagate to the client (it must
        // see the failure, not a silently truncated body) and still close out the
        // audit record with whatever usage we managed to observe.
        controller.error(err);
        finish();
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
}
