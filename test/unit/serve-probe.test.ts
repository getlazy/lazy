/**
 * The `[serve]` liveness probe (src/serve/probe.ts).
 *
 * INVARIANT: the probe is side-effect-free by contract — it connects, closes on
 * connect, and never writes a byte. Every surface that shows liveness (CLI
 * `lazy url`, the `servePorts` RPC, the web Services card) shares this one
 * implementation, so this suite is where that contract is enforced.
 */

import { describe, test, expect } from 'bun:test';
import { probeTcpListening, probeServices, DEFAULT_PROBE_TIMEOUT_MS } from '../../src/serve/probe';
import type { ResolvedService } from '../../src/serve/ports';

describe('probeTcpListening', () => {
  test('a listening port answers true — and receives zero bytes', async () => {
    let bytesSeen = 0;
    let opened = 0;
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open() { opened++; },
        data(_socket, data) { bytesSeen += data.length; },
      },
    });
    try {
      expect(await probeTcpListening('127.0.0.1', server.port)).toBe(true);
      // Give any (contract-violating) written byte time to arrive before
      // asserting none did.
      await new Promise((r) => setTimeout(r, 50));
      expect(opened).toBe(1);
      expect(bytesSeen).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test('a closed port answers false', async () => {
    // Bind then release: the OS assigned this port and nothing listens on it
    // now, so a connect there is refused rather than swallowed.
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const port = server.port;
    server.stop(true);
    expect(await probeTcpListening('127.0.0.1', port)).toBe(false);
  });

  test('an unreachable host resolves false within the timeout bound', async () => {
    // 192.0.2.1 is TEST-NET-1 (RFC 5737): never assigned, so the SYN is either
    // dropped (timeout path) or rejected as unroutable (error path). Both must
    // resolve false, and neither may hold the caller past the cap — the whole
    // point of the bound is that a page render can afford to wait it out.
    const started = Date.now();
    const result = await probeTcpListening('192.0.2.1', 81, 200);
    expect(result).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('the default timeout stays "slightest of pings" small', () => {
    // A render-time probe must never make a page feel slow.
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(500);
  });
});

describe('probeServices', () => {
  const service = (name: string, port: number, hostPort: number | null): ResolvedService => ({
    name,
    port,
    binding: hostPort === null
      ? null
      : { containerPort: port, hostAddress: '127.0.0.1', hostPort },
    url: hostPort === null ? null : `http://127.0.0.1:${hostPort}`,
  });

  test('probes bound services in parallel and skips unbound ones with null', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const dead = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const deadPort = dead.port;
    dead.stop(true);
    try {
      const probed = await probeServices([
        service('web', 3000, server.port),
        service('api', 8080, deadPort),
        service('stale', 5173, null),
      ]);
      expect(probed.map((s) => s.listening)).toEqual([true, false, null]);
      // Everything else on the service rides through untouched.
      expect(probed[0].url).toBe(`http://127.0.0.1:${server.port}`);
      expect(probed[2].binding).toBeNull();
    } finally {
      server.stop(true);
    }
  });
});
