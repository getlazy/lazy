import { describe, test, expect, afterEach } from 'bun:test';
import {
  eventStreamResponse,
  publishDaemonEvent,
  resetEventFeedForTests,
  setSseHeartbeatIntervalForTests,
  SSE_HEARTBEAT_INTERVAL_MS,
} from '../../src/daemon/event-feed';
import { DAEMON_IDLE_TIMEOUT_S } from '../../src/daemon/heartbeat';
import { openSse } from '../helpers/sse';

/**
 * Bun.serve reaps a connection that has written no bytes for `idleTimeout`
 * seconds. An event feed on a quiet project writes nothing by definition, so
 * without comment heartbeats every subscriber would be silently disconnected
 * after DAEMON_IDLE_TIMEOUT_S — and, because the client reconnects, the failure
 * would look like an intermittent event loss rather than a timeout.
 *
 * This suite serves the real `eventStreamResponse` from a real Bun.serve with a
 * deliberately short idleTimeout, so the reaping actually happens on a
 * test-length timescale. It does not need a daemon: the subject is the response
 * body's keep-alive behaviour, not routing or auth.
 *
 * The idleTimeout is 5, not 2: values 2–4 degenerate into a ~4s hard deadline
 * that writes do NOT reset (see the `bun-serve-idle-timeout-footguns` note), so
 * a lower value would fail regardless of heartbeats and prove nothing.
 */
describe('SSE keep-alive against Bun.serve idleTimeout', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
    setSseHeartbeatIntervalForTests(null);
    resetEventFeedForTests();
  });

  function serveFeed(): string {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 5,
      fetch: (req) => eventStreamResponse({ lastEventId: 0, signal: req.signal }),
    });
    cleanups.push(() => server.stop(true));
    return `http://127.0.0.1:${server.port}`;
  }

  // The margin is what makes this safe in production: a 15s heartbeat against a
  // 120s reap is 8 writes per window, so several consecutive misses are needed
  // before a connection is at risk. If someone raises the interval, this fails.
  test('the production heartbeat interval leaves a wide margin on the real idleTimeout', () => {
    expect(SSE_HEARTBEAT_INTERVAL_MS).toBeLessThan((DAEMON_IDLE_TIMEOUT_S * 1000) / 4);
  });

  test(
    'a silent stream survives past the idleTimeout on heartbeats alone',
    async () => {
      setSseHeartbeatIntervalForTests(1_000);
      const base = serveFeed();

      const conn = await openSse(`${base}/rpc/events`);
      cleanups.push(() => conn.close());
      await conn.waitFor((f) => f.event === 'feed.open', 5_000, 'feed.open');

      // Nothing is published for well over two idle windows.
      await new Promise((r) => setTimeout(r, 12_000));

      // Heartbeat comment frames kept the connection alive...
      expect(conn.frames.filter((f) => f.comment !== undefined).length).toBeGreaterThanOrEqual(8);

      // ...and it is still a live stream, not a corpse: a new event arrives.
      publishDaemonEvent('task.status_changed', { taskId: 't1', data: { status: 'working' } });
      const frame = await conn.waitFor(
        (f) => f.event === 'task.status_changed',
        5_000,
        'post-idle event',
      );
      expect(frame.id).toBe('1');
    },
    30_000,
  );

  // The control: with heartbeats disabled the same stream IS reaped. Without
  // this, a green test above could mean "Bun stopped reaping" rather than "our
  // heartbeats work", and the protection could be deleted with tests still passing.
  test(
    'without heartbeats the same stream is reaped by the idleTimeout',
    async () => {
      // Longer than the whole test: effectively no heartbeats.
      setSseHeartbeatIntervalForTests(600_000);
      const base = serveFeed();

      const conn = await openSse(`${base}/rpc/events`);
      cleanups.push(() => conn.close());
      await conn.waitFor((f) => f.event === 'feed.open', 5_000, 'feed.open');

      await new Promise((r) => setTimeout(r, 9_000));

      publishDaemonEvent('task.status_changed', { taskId: 't1', data: { status: 'working' } });
      await expect(
        conn.waitFor((f) => f.event === 'task.status_changed', 3_000, 'post-idle event'),
      ).rejects.toThrow(/timed out/);
    },
    30_000,
  );
});
