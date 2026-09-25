/**
 * INVARIANT: a proxy started with extra bind hosts answers on every one of
 * them, on the SAME port, and one `stop` takes them all down; started with
 * none, it listens on its configured bind alone. This is the mechanism under
 * `resolveProxyBindHosts` (test/unit/daemon-bind-hosts.test.ts decides WHEN
 * the bridge gateway is added; this decides that adding it works) — the
 * daemon's RPC port has the same dual-bind test there. A task container on
 * native Linux Docker dials the proxy at host.docker.internal:<port>, the
 * bridge gateway, which a loopback-only proxy refuses: every model call fails
 * and no fleet turn completes.
 *
 * `127.0.0.2` stands in for the bridge gateway: a second local address, in
 * the loopback range, bindable on Linux without privileges. macOS configures
 * only 127.0.0.1 on lo0, so the suite gates on the address being bindable and
 * says so when it skips (test/helpers/second-loopback.ts).
 */

import { describe, test, expect } from 'bun:test';
import { createProxyServer } from '../../src/proxy/server';
import type { AuditSink } from '../../src/proxy/audit';
import { SECOND_LOOPBACK_HOST, secondLoopbackSuiteSkipped } from '../helpers/second-loopback';

const sink: AuditSink = { append: async () => {} };

async function connects(host: string, port: number): Promise<boolean> {
  try {
    // Any path: the answer's status does not matter, only that a listener
    // on this address answered at all.
    await fetch(`http://${host}:${port}/v1/messages`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(secondLoopbackSuiteSkipped('proxy bridge bind'))('the credential proxy on more than one address', () => {
  test('answers on its bind AND every extra host, on one port; one stop takes all down', async () => {
    const proxy = createProxyServer(
      { port: 0, bind: '127.0.0.1', upstream: 'http://127.0.0.1:9', extraBindHosts: [SECOND_LOOPBACK_HOST, '127.0.0.1'] },
      sink,
      null,
    );
    try {
      expect(proxy.binds).toEqual(['127.0.0.1', SECOND_LOOPBACK_HOST]);
      expect(await connects('127.0.0.1', proxy.port!)).toBe(true);
      expect(await connects(SECOND_LOOPBACK_HOST, proxy.port!)).toBe(true);
    } finally {
      proxy.stop(true);
    }
    expect(await connects('127.0.0.1', proxy.port!)).toBe(false);
    expect(await connects(SECOND_LOOPBACK_HOST, proxy.port!)).toBe(false);
  });

  test('with no extra hosts it listens on its bind alone — the loopback-only behaviour every Mac and host-process daemon keeps', async () => {
    const proxy = createProxyServer({ port: 0, bind: '127.0.0.1', upstream: 'http://127.0.0.1:9' }, sink, null);
    try {
      expect(proxy.binds).toEqual(['127.0.0.1']);
      expect(await connects('127.0.0.1', proxy.port!)).toBe(true);
      expect(await connects(SECOND_LOOPBACK_HOST, proxy.port!)).toBe(false);
    } finally {
      proxy.stop(true);
    }
  });

  test('an extra host that cannot be bound is skipped, and the proxy still serves its bind', async () => {
    const proxy = createProxyServer(
      { port: 0, bind: '127.0.0.1', upstream: 'http://127.0.0.1:9', extraBindHosts: ['203.0.113.7'] },
      sink,
      null,
    );
    try {
      expect(proxy.binds).toEqual(['127.0.0.1']);
      expect(await connects('127.0.0.1', proxy.port!)).toBe(true);
    } finally {
      proxy.stop(true);
    }
  });
});
