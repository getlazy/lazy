/**
 * A proxy failure must never take the daemon down.
 *
 * The audit proxy runs IN-PROCESS with the daemon (`startDaemonServer` holds
 * `proxyServer` beside `webServer`), so the two are only as isolated as the
 * error handling between them makes them. This suite pins both layers of that
 * isolation:
 *
 *   1. A throw inside the proxy's request handler is answered as a normal
 *      upstream-shaped error for THAT request, and the proxy keeps serving.
 *   2. An unhandled rejection or uncaught exception anywhere in the daemon
 *      process is logged, not fatal — because under Bun the default is to
 *      terminate, which drops every in-flight RPC as
 *      "the daemon dropped the connection".
 *
 * Both are regression tests for the 2026-09-08 outage, where a proxy failure
 * took the daemon's RPC listener with it mid-`lazy_wait`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createProxyServer, type ProxyCredentialDeps } from '../../src/proxy/server';
import { TargetCredentials, anthropicPlacement } from '../../src/proxy/target-credentials';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';
import { installDaemonProcessGuards } from '../../src/daemon/process-guards';

const PLACEHOLDER = 'sk-ant-api03-lazy-abcdef';
const REAL = 'sk-ant-oat01-THE-REAL-USER-TOKEN';

const GRANT: CredentialGrant = {
  token: PLACEHOLDER,
  role: 'agent',
  taskId: 'task-42',
  label: 'lazy-task-42',
  envKey: 'ANTHROPIC_API_KEY',
  createdAt: new Date().toISOString(),
};

function freePort(): number {
  return 41000 + Math.floor(Math.random() * 8000);
}

describe('a proxy request failure is isolated to that request', () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let records: ProxyAuditRecord[];
  /** Flipped per test: makes the credential broker misbehave mid-request. */
  let lookupShouldThrow = false;

  beforeAll(async () => {
    records = [];
    const upstreamPort = freePort();
    upstream = Bun.serve({
      port: upstreamPort,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ type: 'message', model: 'm' }),
    });

    // The misbehaving dependency is the credential broker, not the upstream:
    // an upstream that merely fails is ALREADY handled inline (502 + audit
    // record), so it could never reach the handler-failure path this suite is
    // about. `lookup` is awaited on the hot path with no try/catch around it,
    // which is exactly how a storage or registry fault becomes a handler throw.
    const targets = new TargetCredentials();
    targets.set(`http://127.0.0.1:${upstreamPort}`, async () => ({
      kind: 'credential',
      placement: anthropicPlacement('ANTHROPIC_API_KEY', REAL),
      label: 'ANTHROPIC_API_KEY',
    }));

    const credentials: ProxyCredentialDeps = {
      lookup: async (token: string) => {
        if (lookupShouldThrow) throw new Error('credential registry is corrupt');
        return token === PLACEHOLDER ? GRANT : null;
      },
      targets,
    };

    const sink: AuditSink = { append: async (r) => { records.push(r); } };
    proxyPort = freePort();
    proxy = createProxyServer(
      {
        port: proxyPort,
        bind: '127.0.0.1',
        upstream: `http://127.0.0.1:${upstreamPort}`,
      },
      sink,
      credentials,
    );
    await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(() => {
    upstream.stop(true);
    proxy.stop(true);
  });

  async function send() {
    return fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': PLACEHOLDER },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    });
  }

  // INVARIANT: a handler bug is answered in the SAME JSON error envelope every
  // other proxy refusal uses. Without the `error` callback on Bun.serve, Bun
  // replies with its own 500 and prints the stack — unparseable by an SDK, and
  // it ships lazy's internals to the agent. A client that can read an upstream
  // error must be able to read this one.
  test('a throwing request handler yields an upstream-shaped JSON error, not a Bun 500 page', async () => {
    lookupShouldThrow = true;
    const res = await send();

    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('proxy_error');
    // The cause survives to the caller — this is a report, not a swallow.
    expect(body.error.message).toContain('credential registry is corrupt');
  });

  // INVARIANT: the failure is scoped to the one request. A proxy that dies (or
  // stops accepting) on a handler bug is the outage this task exists to fix.
  test('the proxy keeps serving the next request after a handler throw', async () => {
    lookupShouldThrow = true;
    expect((await send()).status).toBe(502);

    lookupShouldThrow = false;
    const ok = await send();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ type: 'message' });
  });
});

describe('daemon process guards', () => {
  // INVARIANT: an unhandled rejection must not terminate the daemon.
  //
  // This is the property the whole fix turns on. Verified on Bun 1.4.2: with no
  // listener installed, `Promise.reject` in a timer exits the process with code
  // 1 — so in production one stray rejection from any proxy path ended every
  // task's turn at once. Asserted in a SUBPROCESS because the assertion is
  // "the process is still alive", which cannot be observed from inside the
  // process that would have died.
  test('an unhandled rejection does not kill the process once guards are installed', async () => {
    const script = `
      import { installDaemonProcessGuards } from '${import.meta.dir}/../../src/daemon/process-guards';
      installDaemonProcessGuards();
      setTimeout(() => { Promise.reject(new Error('proxy-path-rejection')); }, 10);
      setTimeout(() => { throw new Error('proxy-path-throw'); }, 30);
      setTimeout(() => { console.log('STILL-ALIVE'); process.exit(0); }, 200);
    `;
    const proc = Bun.spawn(['bun', 'run', '-'], {
      stdin: new TextEncoder().encode(script),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    expect(out).toContain('STILL-ALIVE');
    expect(exitCode).toBe(0);
  }, 20_000);

  // The control for the test above: without the guards the very same script
  // dies. Without this case, the one above could pass for the wrong reason
  // (e.g. a future Bun that stops exiting on unhandled rejections), and the
  // guard would look load-bearing while being dead code.
  test('the same rejection DOES kill an unguarded process (the guard is load-bearing)', async () => {
    const script = `
      setTimeout(() => { Promise.reject(new Error('proxy-path-rejection')); }, 10);
      setTimeout(() => { console.log('STILL-ALIVE'); process.exit(0); }, 200);
    `;
    const proc = Bun.spawn(['bun', 'run', '-'], {
      stdin: new TextEncoder().encode(script),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    expect(out).not.toContain('STILL-ALIVE');
    expect(exitCode).not.toBe(0);
  }, 20_000);

  // INVARIANT: the guards are removable, and the daemon's stop() removes them.
  //
  // Load-bearing for the test suite itself, not just for tidiness: an
  // in-process test daemon that left these installed would leave a listener on
  // the `bun test` process, and the mere PRESENCE of a listener is what stops
  // Bun exiting on a rejection — silently masking genuine failures in every
  // file that ran afterwards.
  test('uninstall removes both listeners, leaving the count exactly as found', () => {
    const before = {
      exception: process.listenerCount('uncaughtException'),
      rejection: process.listenerCount('unhandledRejection'),
    };

    const uninstall = installDaemonProcessGuards();
    expect(process.listenerCount('uncaughtException')).toBe(before.exception + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(before.rejection + 1);

    uninstall();
    expect(process.listenerCount('uncaughtException')).toBe(before.exception);
    expect(process.listenerCount('unhandledRejection')).toBe(before.rejection);
  });
});
