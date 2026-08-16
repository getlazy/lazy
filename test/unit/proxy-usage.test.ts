/**
 * Token-usage extraction and the streaming tee (src/proxy/usage.ts).
 *
 * Two things are under test and they matter for different reasons:
 *   - extraction correctness across Anthropic's two usage shapes (JSON body,
 *     SSE message_start + cumulative message_delta);
 *   - the tee's PASSTHROUGH FIDELITY. The proxy's core promise is that response
 *     bytes reach the client unchanged and undelayed; a usage scanner that
 *     corrupts, reorders, or withholds a byte would be worse than no usage at
 *     all. Several tests here exist only to pin that.
 */
import { describe, test, expect } from 'bun:test';
import { extractUsage, teeUsageStream } from '../../src/proxy/usage';
import type { ProxyTokenUsage } from '../../src/storage/types';

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** A realistic streamed turn: message_start seeds input/cache, message_delta carries final output. */
function streamedTurn(): string {
  return sse([
    {
      type: 'message_start',
      message: {
        type: 'message',
        role: 'assistant',
        content: [],
        usage: {
          input_tokens: 12,
          output_tokens: 1,
          cache_creation_input_tokens: 400,
          cache_read_input_tokens: 9000,
        },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 137 } },
    { type: 'message_stop' },
  ]);
}

/** Collect a ReadableStream into bytes, so we can compare against the source exactly. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** A stream that emits exactly the given byte slices, in order. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i++]);
    },
  });
}

/** Split text into `size`-byte chunks — used to force split-mid-line/mid-codepoint cases. */
function chunkText(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

async function teeAndCollect(
  text: string,
  isStream: boolean,
  chunkSize = 16,
): Promise<{ body: string; usage: ProxyTokenUsage | null; calls: number }> {
  let usage: ProxyTokenUsage | null = null;
  let calls = 0;
  const teed = teeUsageStream(streamOf(chunkText(text, chunkSize)), isStream, (u) => {
    usage = u;
    calls++;
  });
  const bytes = await drain(teed);
  return { body: new TextDecoder().decode(bytes), usage, calls };
}

describe('extractUsage', () => {
  test('reads usage from a non-streaming JSON response', () => {
    const body = JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [],
      usage: {
        input_tokens: 55,
        output_tokens: 210,
        cache_creation_input_tokens: 1024,
        cache_read_input_tokens: 20480,
      },
    });
    expect(extractUsage(false, body)).toEqual({
      inputTokens: 55,
      outputTokens: 210,
      cacheCreationInputTokens: 1024,
      cacheReadInputTokens: 20480,
    });
  });

  // INVARIANT: on a streamed turn, message_delta's usage is CUMULATIVE and must
  // override message_start's placeholder output_tokens (which is ~1), while the
  // input/cache counts message_delta omits are kept from message_start. Getting
  // this backwards would under-report output by orders of magnitude.
  test('merges SSE message_start with the cumulative message_delta', () => {
    expect(extractUsage(true, streamedTurn())).toEqual({
      inputTokens: 12,
      outputTokens: 137,
      cacheCreationInputTokens: 400,
      cacheReadInputTokens: 9000,
    });
  });

  test('returns null when the body carries no usage at all', () => {
    expect(extractUsage(false, JSON.stringify({ type: 'message', content: [] }))).toBeNull();
    expect(extractUsage(true, sse([{ type: 'message_stop' }]))).toBeNull();
    expect(extractUsage(false, '')).toBeNull();
  });

  test('returns null rather than throwing on an unparseable body', () => {
    expect(extractUsage(false, '<html>502 Bad Gateway</html>')).toBeNull();
    expect(extractUsage(true, 'data: {not json\n\n')).toBeNull();
  });

  test('one malformed SSE line does not cost the usage on other lines', () => {
    const body = 'data: {broken\n\n' + streamedTurn();
    expect(extractUsage(true, body)?.outputTokens).toBe(137);
  });

  test('ignores the [DONE] sentinel', () => {
    expect(extractUsage(true, streamedTurn() + 'data: [DONE]\n\n')?.outputTokens).toBe(137);
  });
});

describe('teeUsageStream', () => {
  // INVARIANT: the tee must be byte-for-byte transparent. The proxy streams
  // agent traffic; a scanner that alters the body would corrupt conversations.
  test('forwards the body unchanged', async () => {
    const text = streamedTurn();
    const { body } = await teeAndCollect(text, true, 7);
    expect(body).toBe(text);
  });

  test('captures usage from a streamed SSE body split across chunks', async () => {
    // 7-byte chunks split every SSE line (and multi-byte-safe decoding) —
    // the scanner must reassemble lines across chunk boundaries.
    const { usage, calls } = await teeAndCollect(streamedTurn(), true, 7);
    expect(usage).toEqual({
      inputTokens: 12,
      outputTokens: 137,
      cacheCreationInputTokens: 400,
      cacheReadInputTokens: 9000,
    });
    expect(calls).toBe(1);
  });

  test('captures usage from a non-streaming JSON body split across chunks', async () => {
    const text = JSON.stringify({ type: 'message', usage: { input_tokens: 9, output_tokens: 3 } });
    const { body, usage } = await teeAndCollect(text, false, 5);
    expect(body).toBe(text);
    expect(usage).toEqual({
      inputTokens: 9,
      outputTokens: 3,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
  });

  test('handles a multi-byte character split across a chunk boundary', async () => {
    const text =
      'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":5}}\n\n' +
      'data: {"type":"note","text":"日本語テキスト"}\n\n';
    const bytes = new TextEncoder().encode(text);
    // Split mid-codepoint: the first chunk ends inside a 3-byte character.
    const cut = bytes.length - 10;
    // Held in an object: a `let` assigned only inside the callback is narrowed
    // to `null` by control-flow analysis, which makes the toEqual below a type
    // error even though it is exactly the assertion we want.
    const captured: { usage: ProxyTokenUsage | null } = { usage: null };
    const teed = teeUsageStream(streamOf([bytes.slice(0, cut), bytes.slice(cut)]), true, (u) => {
      captured.usage = u;
    });
    expect(new TextDecoder().decode(await drain(teed))).toBe(text);
    expect(captured.usage).toEqual({
      inputTokens: null,
      outputTokens: 5,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
  });

  test('parses a final event that never got a trailing newline', async () => {
    const text = 'data: {"type":"message_delta","usage":{"output_tokens":42}}';
    const { usage } = await teeAndCollect(text, true, 8);
    expect(usage?.outputTokens).toBe(42);
  });

  // INVARIANT: onDone fires exactly once on EVERY termination path, including a
  // client that walks away mid-stream. The proxy enqueues its audit record from
  // that callback — if it can be skipped, requests vanish from the audit trail.
  test('fires onDone once when the consumer cancels mid-stream', async () => {
    let calls = 0;
    const teed = teeUsageStream(streamOf(chunkText(streamedTurn(), 4)), true, () => {
      calls++;
    });
    const reader = teed.getReader();
    await reader.read();
    await reader.cancel('client went away');
    expect(calls).toBe(1);
  });

  test('propagates an upstream read error to the client and still reports', async () => {
    let calls = 0;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('upstream exploded'));
      },
    });
    const teed = teeUsageStream(failing, true, () => {
      calls++;
    });
    await expect(drain(teed)).rejects.toThrow('upstream exploded');
    expect(calls).toBe(1);
  });

  test('an over-long SSE line does not prevent later usage from being read', async () => {
    // A single 2 MiB line exceeds the scanner's line cap; it must resync at the
    // next newline rather than give up (or grow without bound).
    const huge = 'data: {"type":"noise","blob":"' + 'x'.repeat(2 * 1024 * 1024) + '"}\n\n';
    const text = huge + streamedTurn();
    const { body, usage } = await teeAndCollect(text, true, 64 * 1024);
    expect(body).toBe(text);
    expect(usage?.outputTokens).toBe(137);
  });
});
