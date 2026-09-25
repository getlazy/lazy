/**
 * Daemon event feed — the push half of the daemon's read surface.
 *
 * `GET /rpc/events` streams Server-Sent Events over the daemon's existing TCP
 * listener. Its subscriber is the lazy-teams Rails listener process, which
 * turns each event into a cache invalidation and re-reads the affected object
 * through the normal RPC read path.
 *
 * DESIGN INVARIANT: the feed is NOT durable, and must never become durable.
 * The store is the truth; an event is a hint that some part of the truth moved.
 * v0.11 shipped a durable events table plus an SSE endpoint with zero wired
 * subscribers, and the whole thing was deleted as dead weight — see
 * docs/spikes/event-data-plane.md. Events live in a bounded in-memory ring for
 * exactly as long as it takes a briefly-disconnected client to reconnect. A
 * client that falls further behind than the ring is told to resnapshot; it is
 * never told a lie, and nothing is written to disk to make that unnecessary.
 *
 * Consequences that follow from "not durable", and that callers rely on:
 *   - `seq` restarts at 1 when the daemon restarts. A `Last-Event-ID` from a
 *     previous daemon generation is therefore ahead of the ring and answered
 *     with a gap, not with silence.
 *   - A subscriber that cannot keep up is disconnected rather than buffered
 *     without bound. It reconnects with `Last-Event-ID` and gets either its
 *     missed events or a gap.
 */

import { randomBytes } from 'crypto';
import { logger } from '../utils/logger';

/**
 * Ring capacity. ~1000 events is the design figure (docs/design/lazy-teams.md
 * §2.3): enough to cover a listener restart or a brief network blip on a busy
 * project, small enough that the memory cost is irrelevant.
 */
export const EVENT_RING_CAPACITY = 1000;

/**
 * SSE comment heartbeat interval.
 *
 * Bun.serve reaps a connection that has been silent for `idleTimeout` seconds
 * (DAEMON_IDLE_TIMEOUT_S = 120), and an event feed on a quiet project is silent
 * by definition. Writing bytes resets the idle timer, so a periodic comment
 * frame keeps the connection alive. 15s leaves an 8x margin — the same posture
 * as the heartbeat envelope's 5s against the same 120s timeout.
 */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Interval for the periodic `daemon.health` event. Also doubles as a liveness
 * signal a client can use to distinguish "daemon quiet" from "daemon gone"
 * without parsing comment frames.
 */
export const DAEMON_HEALTH_INTERVAL_MS = 30_000;

/**
 * Cap on concurrent subscribers. The intended subscriber count is one (the
 * Rails listener); the cap exists so a misbehaving client reconnect-looping
 * cannot exhaust daemon file descriptors. Over the cap, the route answers 503.
 */
export const MAX_EVENT_SUBSCRIBERS = 32;

/**
 * Per-subscriber outbound queue cap. A subscriber whose socket has stopped
 * draining accumulates frames in the stream's internal queue; past this many
 * pending frames we close it rather than grow without bound. It reconnects with
 * `Last-Event-ID` and is answered from the ring (or told to resnapshot).
 */
export const MAX_QUEUED_FRAMES = 256;

export const DAEMON_EVENT_TYPES = [
  'task.status_changed',
  'turn.added',
  'comment.added',
  'comment.updated',
  'artifact.added',
  'artifact.removed',
  'session.started',
  'session.ended',
  'ports.changed',
  'daemon.health',
] as const;

export type DaemonEventType = (typeof DAEMON_EVENT_TYPES)[number];

export interface DaemonEvent {
  /** Monotonic within one daemon process, starting at 1. Resets on restart. */
  seq: number;
  /** ISO-8601 emission time. */
  ts: string;
  type: DaemonEventType;
  /** Present for every task-scoped event; absent for daemon-scoped ones. */
  taskId?: string;
  data: Record<string, unknown>;
}

export interface ReplayResult {
  events: DaemonEvent[];
  /**
   * True when the requested `Last-Event-ID` cannot be served from the ring —
   * either it was evicted, or it belongs to a previous daemon generation. The
   * client must resnapshot through normal reads.
   */
  gap: boolean;
}

/**
 * Identifies this daemon process's feed. Included in the open frame so a client
 * can tell "the daemon restarted" from "I fell behind" without inferring it
 * from sequence numbers. Purely informational — the server computes `gap`
 * itself and clients need not act on this.
 */
const FEED_ID = randomBytes(8).toString('hex');

let ring: DaemonEvent[] = [];
let nextSeq = 1;

type Subscriber = {
  id: number;
  deliver: (event: DaemonEvent) => void;
  close: () => void;
};

let nextSubscriberId = 1;
const subscribers = new Map<number, Subscriber>();

/** Latest sequence number in this daemon generation (0 if nothing emitted). */
export function latestEventSeq(): number {
  return nextSeq - 1;
}

/** Oldest sequence number still in the ring, or null when the ring is empty. */
export function oldestEventSeq(): number | null {
  return ring.length > 0 ? ring[0].seq : null;
}

export function eventFeedId(): string {
  return FEED_ID;
}

export function subscriberCount(): number {
  return subscribers.size;
}

let heartbeatIntervalOverride: number | null = null;

/**
 * Override the heartbeat interval. TEST-ONLY: the idle-timeout behaviour this
 * protects against only reproduces on a multi-second timescale, and a test that
 * had to wait out the production 120s idleTimeout would not be run.
 */
export function setSseHeartbeatIntervalForTests(ms: number | null): void {
  heartbeatIntervalOverride = ms;
}

function heartbeatIntervalMs(): number {
  return heartbeatIntervalOverride ?? SSE_HEARTBEAT_INTERVAL_MS;
}

/**
 * Reset all feed state. TEST-ONLY: a real daemon owns its process and gets a
 * fresh module scope; in-process test daemons share one.
 */
export function resetEventFeedForTests(): void {
  for (const sub of [...subscribers.values()]) {
    try {
      sub.close();
    } catch {
      // Already-closed streams throw on close; nothing to recover.
    }
  }
  subscribers.clear();
  ring = [];
  nextSeq = 1;
}

function broadcast(event: DaemonEvent): void {
  for (const sub of [...subscribers.values()]) {
    try {
      sub.deliver(event);
    } catch (err) {
      // A failed deliver means the subscriber's stream is gone or wedged.
      // Drop it — it will reconnect with Last-Event-ID. Never let one bad
      // subscriber break emission for the others, or for the write that
      // triggered it.
      logger.debug(`event feed: dropping subscriber ${sub.id}: ${err instanceof Error ? err.message : err}`);
      subscribers.delete(sub.id);
      try {
        sub.close();
      } catch {
        // Best-effort — the stream is already broken, which is why we're here.
      }
    }
  }
}

/**
 * Emit an event: assign it a sequence number, add it to the ring, and push it
 * to every live subscriber.
 *
 * Never throws — emission is a side effect of storage writes and must not be
 * able to fail one.
 */
export function publishDaemonEvent(
  type: DaemonEventType,
  options: { taskId?: string; data?: Record<string, unknown> } = {},
): DaemonEvent | null {
  try {
    const event: DaemonEvent = {
      seq: nextSeq++,
      ts: new Date().toISOString(),
      type,
      ...(options.taskId ? { taskId: options.taskId } : {}),
      data: options.data ?? {},
    };
    ring.push(event);
    if (ring.length > EVENT_RING_CAPACITY) {
      ring.splice(0, ring.length - EVENT_RING_CAPACITY);
    }
    broadcast(event);
    return event;
  } catch (err) {
    logger.debug(`event feed: publish failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Emit an event that is delivered to live subscribers but NOT added to the
 * ring, and carries no `id:` line — so it never becomes a client's
 * `Last-Event-ID`. Used for `daemon.health`, which is a liveness tick rather
 * than a state change: replaying stale heartbeats after a reconnect would be
 * noise, and letting one advance a client's cursor would make it skip real
 * events.
 */
export function publishEphemeralEvent(
  type: DaemonEventType,
  data: Record<string, unknown> = {},
): void {
  try {
    broadcast({
      // The ring's current head, so an idle client can see whether it is
      // behind without waiting for the next real event.
      seq: latestEventSeq(),
      ts: new Date().toISOString(),
      type,
      data,
    });
  } catch (err) {
    logger.debug(`event feed: ephemeral publish failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Events with `seq > lastEventId`, plus whether the answer is complete.
 *
 * `lastEventId === 0` means "no cursor" — a fresh subscriber, which gets no
 * replay and no gap.
 */
export function replaySince(lastEventId: number): ReplayResult {
  if (lastEventId <= 0) return { events: [], gap: false };

  const latest = latestEventSeq();

  // Ahead of us: the cursor is from a previous daemon generation (seq resets on
  // restart). Not a silent no-op — the client has missed everything since.
  if (lastEventId > latest) return { events: [], gap: true };

  const oldest = oldestEventSeq();
  // Ring empty but events were emitted: everything was evicted (only reachable
  // with a capacity of 0, but the arithmetic should not depend on that).
  if (oldest === null) return { events: [], gap: true };

  // The client's next expected event is lastEventId + 1. If the ring starts
  // after that, the events between were evicted.
  const gap = oldest > lastEventId + 1;
  return { events: ring.filter((e) => e.seq > lastEventId), gap };
}

/** Parse and validate a `Last-Event-ID`. Returns null when malformed. */
export function parseLastEventId(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return 0;
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

const encoder = new TextEncoder();

function frameEvent(event: DaemonEvent, withId: boolean): Uint8Array {
  // JSON.stringify never emits a raw newline, so a single `data:` line is safe.
  const lines =
    (withId ? `id: ${event.seq}\n` : '') +
    `event: ${event.type}\n` +
    `data: ${JSON.stringify(event)}\n\n`;
  return encoder.encode(lines);
}

function frameComment(text: string): Uint8Array {
  return encoder.encode(`: ${text}\n\n`);
}

/**
 * Control frame sent immediately on connect, before any replay. Tells the
 * client where the stream starts, whether it missed anything, and how much
 * replay depth it can count on.
 */
function frameOpen(replayed: number, gap: boolean): Uint8Array {
  const payload = {
    feedId: FEED_ID,
    latestSeq: latestEventSeq(),
    oldestSeq: oldestEventSeq(),
    replayed,
    gap,
    capacity: EVENT_RING_CAPACITY,
    heartbeatIntervalMs: heartbeatIntervalMs(),
  };
  return encoder.encode(`event: feed.open\ndata: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Build the SSE response for one subscriber.
 *
 * The stream stays open until the client disconnects (`signal`), the daemon
 * shuts down (`closeAllEventStreams`), or the subscriber falls too far behind.
 */
export function eventStreamResponse(options: {
  lastEventId: number;
  signal?: AbortSignal;
}): Response {
  const { lastEventId, signal } = options;
  const id = nextSubscriberId++;

  let closed = false;
  let onAbort: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const shutdown = () => {
        if (closed) return;
        closed = true;
        subscribers.delete(id);
        if (heartbeat) clearInterval(heartbeat);
        if (onAbort && signal) signal.removeEventListener('abort', onAbort);
        try {
          controller.close();
        } catch {
          // Closing an already-errored/closed controller throws; the stream is
          // going away either way and there is nothing left to report.
        }
      };

      const enqueue = (chunk: Uint8Array) => {
        if (closed) return;
        // desiredSize goes negative once the consumer stops draining. Treat a
        // deep backlog as a dead subscriber rather than buffering forever.
        const desired = controller.desiredSize;
        if (desired !== null && desired < -MAX_QUEUED_FRAMES) {
          logger.debug(`event feed: subscriber ${id} fell behind — closing`);
          shutdown();
          return;
        }
        controller.enqueue(chunk);
      };

      const { events, gap } = replaySince(lastEventId);
      enqueue(frameOpen(events.length, gap));
      for (const event of events) enqueue(frameEvent(event, true));

      subscribers.set(id, {
        id,
        deliver: (event) => enqueue(frameEvent(event, event.type !== 'daemon.health')),
        close: shutdown,
      });

      heartbeat = setInterval(() => enqueue(frameComment('hb')), heartbeatIntervalMs());
      // Never hold the process open for a heartbeat timer.
      (heartbeat as any).unref?.();

      if (signal) {
        if (signal.aborted) {
          shutdown();
          return;
        }
        onAbort = shutdown;
        signal.addEventListener('abort', onAbort);
      }
    },
    // The consumer went away (client disconnect, or Bun tearing the connection
    // down). Deregister without touching the controller — it is already gone.
    cancel() {
      closed = true;
      subscribers.delete(id);
      if (heartbeat) clearInterval(heartbeat);
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      // Proxies that buffer would defeat the point of a push feed.
      'X-Accel-Buffering': 'no',
    },
  });
}

/** Close every open stream. Called from daemon shutdown. */
export function closeAllEventStreams(): void {
  for (const sub of [...subscribers.values()]) {
    try {
      sub.close();
    } catch (err) {
      logger.debug(`event feed: close failed for subscriber ${sub.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  subscribers.clear();
}

/**
 * Start the periodic `daemon.health` tick. Returns a stop function.
 */
export function startDaemonHealthEvents(startedAt: number = Date.now()): () => void {
  const timer = setInterval(() => {
    if (subscribers.size === 0) return;
    publishEphemeralEvent('daemon.health', {
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      subscribers: subscribers.size,
      latestSeq: latestEventSeq(),
    });
  }, DAEMON_HEALTH_INTERVAL_MS);
  (timer as any).unref?.();
  return () => clearInterval(timer);
}
