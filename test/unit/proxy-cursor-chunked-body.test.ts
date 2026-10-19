/**
 * A chunked request body forwarded on the cursor route is framed ONCE.
 *
 * INVARIANT: the bytes the proxy writes upstream for a chunked request end with
 * exactly one terminating chunk, and nothing follows it. Bun 1.3.11's fetch,
 * handed a server request's own `req.body`, wrote `0\r\n\r\n` twice; the extra
 * one stayed on the pooled keep-alive connection and became the start of the
 * next request, which Cursor's edge answered `400 Bad Request`. Every Cursor
 * turn crashed after six attempts (2026-10-11, 2026-10-14). A raw TCP upstream
 * is the only place that can see this — any HTTP server parses the stray bytes
 * as a separate (failed) request and the forwarded call itself still succeeds.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import net from 'node:net';
import { createProxyServer, type ProxyCredentialDeps } from '../../src/proxy/server';
import { TargetCredentials } from '../../src/proxy/target-credentials';
import type { CredentialGrant } from '../../src/proxy/credential-broker';

const PLACEHOLDER = 'key_lazy_chunkedgrant';

const GRANT: CredentialGrant = {
  token: PLACEHOLDER,
  role: 'agent',
  taskId: 'ab12',
  label: 'lazy-task-ab12',
  envKey: 'CURSOR_API_KEY',
  createdAt: new Date(0).toISOString(),
};

describe('cursor route: chunked request body framing', () => {
  let upstream: net.Server;
  let proxy: ReturnType<typeof createProxyServer>;
  const received: Buffer[] = [];

  beforeAll(async () => {
    // Raw TCP, not Bun.serve: we need the exact bytes on the wire. Answers
    // once the request has had time to arrive in full.
    upstream = net.createServer((socket) => {
      let bytes = Buffer.alloc(0);
      socket.on('data', (d: Buffer) => { bytes = Buffer.concat([bytes, d]); });
      setTimeout(() => {
        received.push(bytes);
        socket.end('HTTP/1.1 200 OK\r\ncontent-type: application/proto\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      }, 600);
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const cursorUpstream = `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`;

    const targets = new TargetCredentials();
    targets.set(cursorUpstream, async () => ({
      kind: 'credential',
      placement: { kind: 'in-place', value: 'key_real' },
      label: 'CURSOR_API_KEY',
    }));
    const credentials: ProxyCredentialDeps = {
      lookup: async (token) => (token === PLACEHOLDER ? GRANT : null),
      targets,
    };
    proxy = createProxyServer(
      { port: 0, bind: '127.0.0.1', upstream: 'http://127.0.0.1:1', cursorUpstream },
      { append: async () => {} },
      credentials,
    );
  });

  afterAll(() => {
    proxy.stop(true);
    upstream.close();
  });

  test('a streamed body is terminated exactly once', async () => {
    // What cursor-agent's HTTP/1.1 transport sends: headers first, then a
    // chunked protobuf body a moment later.
    const status = await new Promise<string>((resolve, reject) => {
      const client = net.connect(proxy.port!, '127.0.0.1', () => {
        client.write(
          `POST /_lazy/cursor/${PLACEHOLDER}/aiserver.v1.BidiService/BidiAppend HTTP/1.1\r\n` +
          'host: proxy\r\ncontent-type: application/proto\r\ntransfer-encoding: chunked\r\n\r\n',
        );
        setTimeout(() => {
          client.write(Buffer.concat([
            Buffer.from('4\r\n'), Buffer.from([0x28, 0x01, 0x38, 0x01]), Buffer.from('\r\n0\r\n\r\n'),
          ]));
        }, 100);
      });
      client.on('data', (d) => { resolve(d.toString('latin1').split('\r\n')[0]); client.destroy(); });
      client.on('error', reject);
    });
    expect(status).toBe('HTTP/1.1 200 OK');

    expect(received).toHaveLength(1);
    const wire = received[0];
    const bodyStart = wire.indexOf('\r\n\r\n') + 4;
    const head = wire.subarray(0, bodyStart).toString('latin1').toLowerCase();
    expect(head).toContain('transfer-encoding: chunked');
    // The whole body, byte for byte: one data chunk, ONE terminator, nothing after.
    expect(wire.subarray(bodyStart)).toEqual(Buffer.concat([
      Buffer.from('4\r\n'), Buffer.from([0x28, 0x01, 0x38, 0x01]), Buffer.from('\r\n0\r\n\r\n'),
    ]));
  });
});
