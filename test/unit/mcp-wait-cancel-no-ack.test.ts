/**
 * INVARIANT: a `lazy_wait` the MCP client cancelled is never DELIVERED.
 *
 * A wait's delivered answer marks the waiting task's comments delivered
 * (lazy_wait's afterDelivery ack). A harness whose own tool timeout fired sends
 * `notifications/cancelled` and never shows the late answer to its model, so if
 * the proxy kept reading, the daemon would see the answer delivered and a
 * human's comment would be marked delivered unread — hidden from the next
 * unblock and from accept's undelivered-feedback gate. The proxy therefore
 * drops the connection on cancel for lazy_wait; the daemon still finishes the
 * call but withholds the receipt. Every other tool keeps reading as before
 * (a cancellation never aborts work — src/mcp/server.ts).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { createDaemonProxyHandler, type DaemonMcpConfig } from '../../src/daemon/mcp-proxy';
import { heartbeatEnvelopeResponse } from '../../src/daemon/heartbeat';

describe('lazy_wait cancellation withholds delivery', () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  afterEach(() => {
    for (const s of servers) s.stop(true);
    servers.length = 0;
  });

  /** A daemon stand-in whose answer takes `ms` and records whether it was delivered. */
  function slowDaemon(ms: number): { config: DaemonMcpConfig; delivered: () => boolean } {
    let delivered = false;
    const s = Bun.serve({
      port: 0,
      fetch: (req) => heartbeatEnvelopeResponse(
        async () => { await Bun.sleep(ms); return { status: 200, body: { result: { ok: true } } }; },
        { signal: req.signal, intervalMs: 20, onDelivered: () => { delivered = true; } },
      ),
    });
    servers.push(s);
    return {
      config: { token: 't', projectRoot: '/proj', taskId: 'task-a', target: `http://localhost:${s.port}` },
      delivered: () => delivered,
    };
  }

  test('a cancelled lazy_wait drops the connection, so the daemon never marks it delivered', async () => {
    const daemon = slowDaemon(400);
    const handler = createDaemonProxyHandler(daemon.config, 'lazy_wait', { refresh: null });
    const cancel = new AbortController();
    const call = handler({}, { reportProgress: () => {}, cancelled: cancel.signal });
    await Bun.sleep(100);
    cancel.abort();
    await expect(call).rejects.toThrow(/cancelled/);
    await Bun.sleep(600);
    expect(daemon.delivered()).toBe(false);
  });

  test('other tools still read their answer after a cancel', async () => {
    const daemon = slowDaemon(300);
    const handler = createDaemonProxyHandler(daemon.config, 'lazy_accept', { refresh: null });
    const cancel = new AbortController();
    const call = handler({}, { reportProgress: () => {}, cancelled: cancel.signal });
    await Bun.sleep(100);
    cancel.abort();
    expect(await call).toBeDefined();
    expect(daemon.delivered()).toBe(true);
  });
});

describe('McpServer hands a cancellation to the handler', () => {
  // INVARIANT: notifications/cancelled aborts the call's `cancelled` signal (and
  // nothing else); without it the proxy above never learns the client gave up.
  test('notifications/cancelled aborts ctx.cancelled for that request', async () => {
    const { McpServer } = await import('../../src/mcp/server');
    const server = new McpServer({ name: 'test', version: '0' });
    let sawAbort = false;
    server.registerTool({ name: 'slow', description: 'slow', inputSchema: { type: 'object', properties: {} } }, async (_a, ctx) => {
      await new Promise<void>(resolve => ctx?.cancelled?.addEventListener('abort', () => { sawAbort = true; resolve(); }));
      return { ok: true };
    });
    const enc = new TextEncoder();
    let c!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({ start(ctrl) { c = ctrl; } });
    const lines: string[] = [];
    const running = server.run({ input, output: l => { lines.push(l); } });
    c.enqueue(enc.encode(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'slow', arguments: {} } }) + '\n'));
    await Bun.sleep(50);
    c.enqueue(enc.encode(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5 } }) + '\n'));
    c.close();
    await running;
    expect(sawAbort).toBe(true);
    // The reply is still written: the work was not abandoned.
    expect(lines.length).toBe(1);
  });
});
