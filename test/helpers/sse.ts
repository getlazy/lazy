/**
 * Minimal SSE frame reader for tests.
 *
 * Deliberately a TEST helper and not a `src/` client. The event feed's real
 * subscriber is the lazy-teams Rails listener (Ruby); shipping an unused
 * TypeScript client alongside it would repeat the v0.11 mistake in miniature —
 * see docs/spikes/event-data-plane.md. Tests still need to speak the wire
 * format, so it lives here.
 */

export interface SseFrame {
  /** `id:` line, when the frame carried one. */
  id?: string;
  /** `event:` line. */
  event?: string;
  /** `data:` lines, joined with newlines. */
  data?: string;
  /** A `:`-prefixed comment frame (heartbeat). */
  comment?: string;
}

function parseFrame(raw: string): SseFrame | null {
  const frame: SseFrame = {};
  const dataLines: string[] = [];
  let sawField = false;

  for (const line of raw.split('\n')) {
    if (line === '') continue;
    if (line.startsWith(':')) {
      frame.comment = line.slice(1).trim();
      sawField = true;
      continue;
    }
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
    sawField = true;
    if (field === 'id') frame.id = value;
    else if (field === 'event') frame.event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (!sawField) return null;
  if (dataLines.length > 0) frame.data = dataLines.join('\n');
  return frame;
}

export interface SseConnection {
  /** HTTP status of the SSE response. */
  status: number;
  /** Every frame received so far, in order. */
  frames: SseFrame[];
  /** Wait until a frame matching `predicate` arrives; resolves with it. */
  waitFor(predicate: (f: SseFrame) => boolean, timeoutMs?: number, label?: string): Promise<SseFrame>;
  /** Close the connection (aborts the underlying fetch). */
  close(): void;
}

/**
 * Open an SSE connection and start collecting frames in the background.
 *
 * Throws if the response is not a 2xx `text/event-stream` — a caller testing a
 * rejection should use plain `fetch` and assert on the status instead.
 */
export async function openSse(
  url: string,
  init: { headers?: Record<string, string> } = {},
): Promise<SseConnection> {
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream', ...(init.headers ?? {}) },
    signal: controller.signal,
  });

  if (!res.ok || !res.body) {
    controller.abort();
    throw new Error(`SSE connect failed: ${res.status} ${await res.text().catch(() => '')}`);
  }

  const frames: SseFrame[] = [];
  const waiters: Array<{ predicate: (f: SseFrame) => boolean; resolve: (f: SseFrame) => void }> = [];

  const pump = (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const frame = parseFrame(raw);
          if (!frame) continue;
          frames.push(frame);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].predicate(frame)) waiters.splice(i, 1)[0].resolve(frame);
          }
        }
      }
    } catch (err) {
      // An abort is how close() works, and a daemon shutdown ends the stream
      // abruptly by design; either way the collected frames are what the test
      // asserts on.
      if (!controller.signal.aborted) {
        // Surface anything else, since a silent pump failure would look like
        // "the event never arrived".
        // eslint-disable-next-line no-console
        console.error(`SSE pump error: ${err instanceof Error ? err.message : err}`);
      }
    }
  })();
  void pump;

  return {
    status: res.status,
    frames,
    waitFor(predicate, timeoutMs = 10_000, label = 'frame') {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<SseFrame>((resolve, reject) => {
        const entry = { predicate, resolve: (f: SseFrame) => { clearTimeout(timer); resolve(f); } };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(
            new Error(
              `timed out after ${timeoutMs}ms waiting for ${label}; received: ` +
                JSON.stringify(frames.map((f) => f.event ?? `:${f.comment}`)),
            ),
          );
        }, timeoutMs);
        waiters.push(entry);
      });
    },
    close() {
      controller.abort();
    },
  };
}

/** Parse an SSE frame's `data` as JSON. */
export function frameData<T = any>(frame: SseFrame): T {
  if (frame.data === undefined) throw new Error(`SSE frame has no data: ${JSON.stringify(frame)}`);
  return JSON.parse(frame.data) as T;
}
