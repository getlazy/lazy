/**
 * forwardableBody: what a forwarded request body looks like on the wire.
 *
 * INVARIANT: a body forwarded through forwardableBody is framed exactly once —
 * one framing header, the exact bytes, and nothing after them. Both lazy
 * proxies (the cursor route and the served-app proxy) forward the client's own
 * Content-Length, so the declared-length case must not gain chunked framing as
 * well (Content-Length + Transfer-Encoding is a 400 at strict servers), and the
 * chunked case must end with ONE terminating chunk (Bun 1.3.11 wrote two when
 * handed `req.body` directly, poisoning the next request on the connection).
 * Checked against a raw TCP upstream because an HTTP server hides both faults.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import net from 'node:net';
import { forwardableBody } from '../../src/utils/forward-body';

describe('forwardableBody on the wire', () => {
  let upstream: net.Server;
  let forwarder: ReturnType<typeof Bun.serve>;
  let received: Buffer | null = null;

  beforeAll(async () => {
    upstream = net.createServer((socket) => {
      let bytes = Buffer.alloc(0);
      socket.on('data', (d: Buffer) => { bytes = Buffer.concat([bytes, d]); });
      setTimeout(() => {
        received = bytes;
        socket.end('HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      }, 600);
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;

    // Forwards the way serve-proxy does: the client's headers minus hop-by-hop
    // ones (Content-Length kept), the body streamed with duplex 'half'.
    forwarder = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const headers = new Headers(req.headers);
        for (const h of ['host', 'connection', 'transfer-encoding']) headers.delete(h);
        const resp = await fetch(`http://127.0.0.1:${upstreamPort}/x`, {
          method: 'POST',
          headers,
          body: forwardableBody(req.body),
          duplex: 'half',
        } as RequestInit);
        return new Response(null, { status: resp.status });
      },
    });
  });

  afterAll(() => {
    forwarder.stop(true);
    upstream.close();
  });

  /** Send `head`, then `body` a moment later (as a streaming client does); return the upstream's bytes. */
  async function forward(head: string, body: Buffer): Promise<{ head: string; body: Buffer }> {
    received = null;
    await new Promise<void>((resolve, reject) => {
      const client = net.connect(forwarder.port!, '127.0.0.1', () => {
        client.write(head);
        setTimeout(() => client.write(body), 100);
      });
      client.on('data', () => { client.destroy(); resolve(); });
      client.on('error', reject);
    });
    const wire = received as Buffer | null;
    expect(wire).not.toBeNull();
    const at = wire!.indexOf('\r\n\r\n') + 4;
    return { head: wire!.subarray(0, at).toString('latin1').toLowerCase(), body: wire!.subarray(at) };
  }

  const PAYLOAD = Buffer.from([0x28, 0x01, 0x38, 0x01]);

  test('a declared-length body keeps Content-Length and gains no chunked framing', async () => {
    const out = await forward(`POST / HTTP/1.1\r\nhost: x\r\ncontent-length: ${PAYLOAD.length}\r\n\r\n`, PAYLOAD);
    expect(out.head).toContain(`content-length: ${PAYLOAD.length}`);
    expect(out.head).not.toContain('transfer-encoding');
    expect(out.body).toEqual(PAYLOAD);
  });

  test('a chunked body is terminated exactly once', async () => {
    const chunked = Buffer.concat([Buffer.from('4\r\n'), PAYLOAD, Buffer.from('\r\n0\r\n\r\n')]);
    const out = await forward('POST / HTTP/1.1\r\nhost: x\r\ntransfer-encoding: chunked\r\n\r\n', chunked);
    expect(out.head).toContain('transfer-encoding: chunked');
    expect(out.head).not.toContain('content-length');
    expect(out.body).toEqual(chunked);
  });
});
