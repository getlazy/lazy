/**
 * The body of an incoming `Bun.serve` request, safe to hand to `fetch` as an
 * outgoing streamed body.
 *
 * WHY: Bun 1.3.11 has a fast path for
 * `fetch(url, { body: req.body })` when `req.body` is a server request's own
 * stream, and on a chunked request that path writes the terminating chunk
 * TWICE (`…0\r\n\r\n0\r\n\r\n`). The forwarded request itself completes, but the
 * stray terminator stays on the pooled keep-alive connection and is read as the
 * start of the NEXT request on it, which an HTTP/1.1 server rejects. For Cursor
 * (Envoy at its edge) that was `400 Bad Request`, text/plain, on calls like
 * BidiAppend and AvailableModels — every Cursor turn failed after six
 * attempts. Re-piping through a TransformStream gives fetch an ordinary stream,
 * which it frames once. Still streaming: nothing is buffered, so a bidi call
 * cannot deadlock. Bun 1.4.3 no longer has the bug.
 */
export function forwardableBody(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
  return body ? body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>()) : null;
}
