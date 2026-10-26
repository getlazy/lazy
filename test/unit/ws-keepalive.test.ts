import { describe, test, expect } from 'bun:test';
import { composeUpgraders, WS_IDLE_TIMEOUT_S } from '../../src/server/ws';

describe('daemon WebSocket keepalive', () => {
  // INVARIANT: the daemon's terminal and watch sockets ping an idle peer and
  // count its pong as traffic, so a terminal left idle for hours is never
  // closed for idleness while its peer is there. Without `sendPings`, Bun
  // closes a socket silent for `idleTimeout` seconds — an idle shell.
  test('every daemon WebSocket pings idle peers rather than reaping them', () => {
    const handler = composeUpgraders([]).handler as { sendPings?: boolean; idleTimeout?: number };
    expect(handler.sendPings).toBe(true);
    expect(handler.idleTimeout).toBe(WS_IDLE_TIMEOUT_S);
  });

  test('an idle socket outlives idleTimeout when its peer answers pings', async () => {
    const server = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('no', { status: 426 })),
      websocket: { idleTimeout: 2, sendPings: true, message() {} },
    });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      let closed = false;
      ws.onclose = () => { closed = true; };
      await new Promise((r) => { ws.onopen = r; });
      await Bun.sleep(6000);
      expect(closed).toBe(false);
      ws.close();
    } finally {
      server.stop(true);
    }
  }, 15_000);
});
