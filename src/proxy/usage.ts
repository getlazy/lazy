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
 * Which wire format the response being scanned speaks.
 *
 * `anthropic` — the historical default: `usage` on the body / `message_start`
 * + `message_delta` SSE events.
 *
 * `openai` — OpenAI-compatible upstreams (api.openai.com, openrouter.ai), both
 * the Chat Completions and the Responses API. Non-streaming bodies carry a
 * top-level `usage`; streaming chat completions carry it on the final chunk
 * (only when the client asked via `stream_options.include_usage`), and
 * streaming Responses carry it under `response.usage` on the
 * `response.completed` event. One merge handles all four cases because the
 * field names are disjoint per API and both are folded below.
 *
 * FIELD MAPPING, deliberate: OpenAI's `prompt_tokens` / `input_tokens` INCLUDE
 * cached tokens, while Anthropic's `input_tokens` EXCLUDES cache reads — and
 * lazy's aggregator (src/proxy/aggregate.ts) sums all four counters for a
 * total. So cached tokens are SUBTRACTED out of input and recorded as
 * `cacheReadInputTokens`: totals stay correct and the record means the same
 * thing as the Anthropic records sharing the audit log.
 */
export type UsageWire = 'anthropic' | 'openai';

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

  /**
   * Merge one raw OpenAI-wire `usage` object — Chat Completions
   * (`prompt_tokens`/`completion_tokens`/`prompt_tokens_details.cached_tokens`)
   * or Responses (`input_tokens`/`output_tokens`/`input_tokens_details.cached_tokens`).
   * See {@link UsageWire} for the cached-token subtraction.
   */
  mergeOpenAI(raw: unknown): void {
    if (raw === null || typeof raw !== 'object') return;
    const u = raw as Record<string, unknown>;
    const prompt = numberOrNull(u.prompt_tokens) ?? numberOrNull(u.input_tokens);
    const output = numberOrNull(u.completion_tokens) ?? numberOrNull(u.output_tokens);
    const details = (u.prompt_tokens_details ?? u.input_tokens_details) as
      | Record<string, unknown>
      | null
      | undefined;
    const cached = details && typeof details === 'object' ? numberOrNull(details.cached_tokens) : null;

    if (output !== null) this.usage.outputTokens = output;
    if (prompt !== null) {
      if (cached !== null && cached > 0) {
        this.usage.inputTokens = Math.max(0, prompt - cached);
        this.usage.cacheReadInputTokens = cached;
      } else {
        this.usage.inputTokens = prompt;
      }
    }
  }

  /** The merged usage, or null when nothing usable was ever seen. */
  result(): ProxyTokenUsage | null {
    return isEmpty(this.usage) ? null : { ...this.usage };
  }
}

/**
 * Feed one parsed SSE `data:` payload into the accumulator. Only the event
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

/**
 * OpenAI-wire SSE payloads that carry usage:
 *  - Chat Completions chunks: top-level `usage` (null on every chunk except the
 *    final one, and present at all only when the client sent
 *    `stream_options: {"include_usage": true}`).
 *  - Responses events: `response.usage` on the terminal `response.completed`
 *    (matched by the nested field rather than the event name, so partial usage
 *    on earlier lifecycle events also folds in — later values win).
 */
function mergeOpenAISSEEvent(acc: UsageAccumulator, data: Record<string, unknown>): void {
  if (data.usage !== null && data.usage !== undefined) acc.mergeOpenAI(data.usage);
  const response = data.response as Record<string, unknown> | undefined;
  if (response && typeof response === 'object') acc.mergeOpenAI(response.usage);
}

/**
 * Does this parsed SSE payload carry generated CONTENT — the event whose
 * arrival defines time-to-first-token? Anthropic: `content_block_delta`.
 * OpenAI chat: a chunk whose `delta` has non-empty text, reasoning or tool
 * arguments (the opening role-only chunk does not count). Responses: a
 * `response.*.delta` event with a non-empty payload.
 */
function isContentEvent(data: Record<string, unknown>, wire: UsageWire): boolean {
  if (wire === 'anthropic') return data.type === 'content_block_delta';
  const type = data.type;
  if (typeof type === 'string') {
    if (!type.startsWith('response.') || !type.endsWith('.delta')) return false;
    const delta = data.delta;
    return typeof delta === 'string' ? delta.length > 0 : delta !== null && delta !== undefined;
  }
  const choices = data.choices;
  if (!Array.isArray(choices)) return false;
  return choices.some((choice) => {
    const delta = (choice as Record<string, unknown> | null)?.delta as Record<string, unknown> | undefined;
    if (!delta || typeof delta !== 'object') return false;
    for (const key of ['content', 'reasoning_content', 'reasoning', 'refusal']) {
      const v = delta[key];
      if (typeof v === 'string' && v.length > 0) return true;
    }
    const calls = delta.tool_calls;
    return (Array.isArray(calls) && calls.length > 0) || delta.function_call != null;
  });
}

/** Merge every usage-bearing `data:` line of a buffered SSE body. */
function mergeSSEBody(acc: UsageAccumulator, bodyText: string, wire: UsageWire): void {
  for (const line of bodyText.split('\n')) {
    mergeSSELine(acc, line, wire);
  }
}

/**
 * Merge one raw SSE line (with or without a trailing `\r`). Returns whether the
 * line was a content event (see {@link isContentEvent}).
 */
function mergeSSELine(acc: UsageAccumulator, line: string, wire: UsageWire): boolean {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith('data:')) return false;
  const payload = trimmed.slice('data:'.length).trim();
  if (!payload || payload === '[DONE]') return false;
  try {
    const data = JSON.parse(payload) as Record<string, unknown>;
    if (wire === 'openai') mergeOpenAISSEEvent(acc, data);
    else mergeSSEEvent(acc, data);
    return isContentEvent(data, wire);
  } catch {
    // A malformed data line means this event is unreadable — skip it and keep
    // scanning. Usage lives on its own event, so one bad line elsewhere in the
    // stream must not cost us the whole record.
    return false;
  }
}

/** Merge a fully-parsed non-streaming JSON body's `usage`, per wire. */
function mergeJsonBody(acc: UsageAccumulator, parsed: Record<string, unknown>, wire: UsageWire): void {
  if (wire === 'openai') acc.mergeOpenAI(parsed?.usage);
  else acc.merge(parsed?.usage);
}

/**
 * Extract token usage from a fully-buffered response body.
 *
 * @param isStream whether the body is an SSE stream (vs. a single JSON object)
 * @param bodyText the complete response body
 * @returns merged usage, or null when the body carries none
 */
export function extractUsage(
  isStream: boolean,
  bodyText: string,
  wire: UsageWire = 'anthropic',
): ProxyTokenUsage | null {
  if (!bodyText) return null;
  const acc = new UsageAccumulator();
  if (isStream) {
    mergeSSEBody(acc, bodyText, wire);
  } else {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      mergeJsonBody(acc, parsed, wire);
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
  private readonly wire: UsageWire;
  private buffer = '';
  /** Set after an over-long SSE line: skip bytes until the next newline resyncs us. */
  private resyncing = false;
  /** Set once the JSON accumulator hits its cap: stop accumulating entirely. */
  private overflowed = false;
  /** Wall-clock (ms) of the chunk that first carried a content event. */
  firstContentAt: number | null = null;

  constructor(isStream: boolean, wire: UsageWire) {
    this.isStream = isStream;
    this.wire = wire;
  }

  push(chunk: Uint8Array, now: number): void {
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
      if (mergeSSELine(this.acc, line, this.wire) && this.firstContentAt === null) this.firstContentAt = now;
    }
    if (this.buffer.length > MAX_SSE_LINE_BYTES) {
      this.buffer = '';
      this.resyncing = true;
    }
  }

  /** Flush the decoder + any remaining unterminated line, then report. */
  result(now: number): ProxyTokenUsage | null {
    const tail = this.decoder.decode();
    if (tail) this.buffer += tail;
    if (this.overflowed) return this.acc.result();
    if (this.isStream) {
      if (!this.resyncing && this.buffer && mergeSSELine(this.acc, this.buffer, this.wire) && this.firstContentAt === null) {
        this.firstContentAt = now;
      }
    } else if (this.buffer) {
      try {
        const parsed = JSON.parse(this.buffer) as Record<string, unknown>;
        mergeJsonBody(this.acc, parsed, this.wire);
      } catch {
        // Truncated or non-JSON body — nothing to report.
      }
    }
    this.buffer = '';
    return this.acc.result();
  }
}

/**
 * When the stream's interesting moments happened (wall-clock ms, the same
 * clock as the audit record's `ts`). `firstContentAt` is null for a response
 * with no content event (non-streamed, or a stream that ended without one).
 */
export interface StreamTiming {
  firstContentAt: number | null;
  endedAt: number;
  /** True only when the upstream stream ran to its end; false on client cancel or a read error. */
  completed: boolean;
  /** The upstream read error that broke the stream, when it broke (never set on a client cancel). */
  error?: unknown;
}

/**
 * Read a whole response body — for a caller that must buffer it (the tool-use
 * policy rewrites the complete body) — timing it exactly as the tee times a
 * forwarded stream: chunk by chunk, so the first content event is stamped when
 * its bytes ARRIVE rather than when the last byte does. `text` is what
 * `Response.text()` would have produced (UTF-8, invalid bytes replaced).
 */
export async function readBodyTimed(
  body: ReadableStream<Uint8Array>,
  isStream: boolean,
  wire: UsageWire = 'anthropic',
  now: () => number = Date.now,
): Promise<{ text: string; firstContentAt: number | null; endedAt: number }> {
  const scanner = new UsageScanner(isStream, wire);
  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    scanner.push(value, now());
  }
  text += decoder.decode();
  const endedAt = now();
  scanner.result(endedAt);
  return { text, firstContentAt: scanner.firstContentAt, endedAt };
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
  onDone: (usage: ProxyTokenUsage | null, timing: StreamTiming) => void,
  wire: UsageWire = 'anthropic',
  now: () => number = Date.now,
): ReadableStream<Uint8Array> {
  const scanner = new UsageScanner(isStream, wire);
  const reader = body.getReader();
  let finished = false;
  const finish = (completed = false, error?: unknown) => {
    if (finished) return;
    finished = true;
    const endedAt = now();
    onDone(scanner.result(endedAt), {
      firstContentAt: scanner.firstContentAt, endedAt, completed, ...(error !== undefined ? { error } : {}),
    });
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          finish(true);
          return;
        }
        // Forward before inspecting — the client never waits on the scanner.
        controller.enqueue(value);
        scanner.push(value, now());
      } catch (err) {
        // The upstream stream broke mid-flight. Propagate to the client (it must
        // see the failure, not a silently truncated body) and still close out the
        // audit record with whatever usage we managed to observe.
        controller.error(err);
        finish(false, err);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
}
