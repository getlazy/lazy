/**
 * SSE keep-alive framing for proxied response bodies.
 *
 * WHY: `Bun.serve` reaps a connection whose RESPONSE BODY has written no bytes
 * for `idleTimeout` seconds — verified on Bun 1.4.2: a server with
 * `idleTimeout: 6` streaming a body that stays silent for 20s tears the client
 * down at ~8s with "The socket connection was closed unexpectedly", and the
 * client never sees the real response. Bun caps `idleTimeout` at 255s, so
 * raising the number is not a fix (the same footgun the daemon answered with
 * NDJSON heartbeat framing — src/daemon/heartbeat.ts).
 *
 * A local model that is queued behind other sessions on one GPU can legitimately
 * go minutes between tokens, so lazy must keep the pipe warm itself. On an SSE
 * response the conventional shape is a COMMENT frame: a line starting with `:`
 * is ignored by every spec-compliant SSE parser, on both wires the proxy fronts
 * (Anthropic `/v1/messages` and OpenAI `/v1/chat/completions` + `/v1/responses`
 * both stream `text/event-stream`), and it carries no event, no data and no
 * usage — so nothing downstream can mistake it for model output.
 *
 * Applied OUTSIDE the usage tee (src/proxy/usage.ts) on purpose: the scanner
 * that fills the audit record must see the upstream's bytes and only those.
 *
 * Never applied to a non-SSE body: injecting bytes into a JSON response would
 * corrupt it.
 */

const KEEPALIVE_FRAME = new TextEncoder().encode(': lazy-proxy keepalive\n\n');

/** Default silence, in ms, after which a keep-alive comment is emitted. */
export const DEFAULT_SSE_KEEPALIVE_MS = 30_000;

/** True when a response's content type is an SSE stream. */
export function isSseContentType(contentType: string | null | undefined): boolean {
  return (contentType ?? '').toLowerCase().includes('text/event-stream');
}

/**
 * Wrap `body` so that a silence longer than `intervalMs` emits an SSE comment
 * frame to the client instead of nothing.
 *
 * Backpressure is preserved: the wrapper is pull-driven like the stream it
 * wraps, and an outstanding upstream read is never dropped — the keep-alive
 * timer races the read, and a read that loses the race stays pending for the
 * next pull. A fast upstream therefore never emits a single keep-alive byte.
 */
export function withSseKeepAlive(
  body: ReadableStream<Uint8Array>,
  intervalMs: number = DEFAULT_SSE_KEEPALIVE_MS,
): ReadableStream<Uint8Array> {
  if (!(intervalMs > 0)) return body;

  const reader = body.getReader();
  let pending: Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> | null = null;
  const TICK = Symbol('keepalive');

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!pending) pending = reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<typeof TICK>((resolve) => {
        timer = setTimeout(() => resolve(TICK), intervalMs);
      });

      try {
        const winner = await Promise.race([pending, tick]);
        if (winner === TICK) {
          // Upstream is still thinking. Keep the socket warm; `pending` stays
          // outstanding and is awaited again on the next pull.
          controller.enqueue(KEEPALIVE_FRAME);
          return;
        }
        pending = null;
        const { done, value } = winner as Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
        if (done) {
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (err) {
        // The upstream stream broke mid-flight. Propagate it — the client must
        // see the failure, never a silently truncated body.
        pending = null;
        controller.error(err);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    cancel(reason) {
      pending = null;
      return reader.cancel(reason);
    },
  });
}
