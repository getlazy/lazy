/**
 * Unit tests for surviving a daemon that is GONE FOR A WHILE — a rebuild and
 * restart, not just a move.
 *
 * The field failure (v0.20 release, 2026-08-03): the engineer rebuilt the daemon
 * from the release branch and restarted it while a builder session was live. The
 * next lazy tool call found nothing listening, re-read an unchanged config file,
 * and failed with "the daemon appears to be down … exit and relaunch this
 * builder" — costing the whole conversation for a routine restart. Task agents
 * hit the same wall mid-turn as "MCP error -32000: Connection closed".
 *
 * The contract these tests pin:
 *   - a connection that was NEVER established keeps retrying, with backoff,
 *     until the daemon comes back — on the same address or a new one
 *   - that wait is BOUNDED, and ends in the same actionable error as before
 *   - a call lost MID-flight is still never replayed, window or no window
 *   - a 401 the mounted file cannot immediately fix waits, briefly, for the
 *     session's owner to re-issue a credential — then gives up
 *   - credentials are only ever taken from the trusted local file; nothing the
 *     daemon says over the wire can change them
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDaemonProxyHandler, type DaemonMcpConfig } from '../../src/daemon/mcp-proxy';

describe('daemon MCP reconnect across a daemon restart', () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-mcp-reconnect-'));
  });

  afterEach(async () => {
    for (const s of servers) {
      try { s.stop(true); } catch { /* already stopped */ }
    }
    servers.length = 0;
    await rm(dir, { recursive: true, force: true });
  });

  /** A daemon that accepts exactly one token. `port: 0` picks a free one. */
  function serveDaemon(token: string, port = 0) {
    const seen: { path: string; token: string | null }[] = [];
    const s = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/daemon/status') {
          return Response.json({ status: 'running', projectRoot: '/proj' });
        }
        const auth = req.headers.get('authorization');
        seen.push({ path: url.pathname, token: auth?.replace('Bearer ', '') ?? null });
        if (auth !== `Bearer ${token}`) {
          // A hostile-ish daemon: the body offers a token. Nothing may adopt it.
          return Response.json({ error: 'Unauthorized', token: 'attacker-token' }, { status: 401 });
        }
        return Response.json({ result: { ok: true } });
      },
    });
    servers.push(s);
    return { port: s.port!, seen, stop: () => { try { s.stop(true); } catch { /* ok */ } } };
  }

  /** A port nothing is listening on — connecting fails with ECONNREFUSED. */
  async function deadPort(): Promise<number> {
    const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const port = s.port!;
    s.stop(true);
    return port;
  }

  async function writeConfigFile(body: Record<string, unknown>): Promise<string> {
    const path = join(dir, 'daemon-mcp-builder.json');
    await writeFile(path, JSON.stringify(body, null, 2));
    return path;
  }

  function progressSpy() {
    const messages: string[] = [];
    return { messages, ctx: { reportProgress: (m?: string) => { messages.push(m ?? ''); } } };
  }

  // INVARIANT: a daemon that is merely RESTARTING must not end the session. The
  // call waits for it and then succeeds — the whole point of this task.
  test('a call spanning a restart waits and succeeds when the daemon returns', async () => {
    const port = await deadPort();
    const sourcePath = await writeConfigFile({
      token: 'tok-1', projectRoot: '/proj', taskId: '', target: `http://127.0.0.1:${port}`,
    });
    const config: DaemonMcpConfig = {
      token: 'tok-1', projectRoot: '/proj', taskId: '', target: `http://127.0.0.1:${port}`, sourcePath,
    };

    // The daemon comes back on the same port a moment later.
    let live: ReturnType<typeof serveDaemon> | undefined;
    const timer = setTimeout(() => { live = serveDaemon('tok-1', port); }, 400);

    const handler = createDaemonProxyHandler(config, 'lazy_journal', { log: () => {} });
    const spy = progressSpy();
    try {
      expect(await handler({ message: 'hi' }, spy.ctx)).toEqual({ ok: true });
    } finally {
      clearTimeout(timer);
    }
    expect(live?.seen.length).toBe(1);
    // The human is told what the pause is, rather than watching a silent hang.
    expect(spy.messages.join('\n')).toMatch(/not answering|waiting for it to come back/i);
  }, 20_000);

  // INVARIANT: the address is re-read from the mounted file on EVERY round, not
  // just the first. A daemon that cannot re-bind its old port moves up the
  // shared 26024+ window, and the container only learns that from the file.
  test('a daemon that returns on a different port is picked up mid-wait', async () => {
    const stale = await deadPort();
    const sourcePath = await writeConfigFile({
      token: 'tok-1', projectRoot: '/proj', taskId: '', target: `http://127.0.0.1:${stale}`,
    });
    const config: DaemonMcpConfig = {
      token: 'tok-1', projectRoot: '/proj', taskId: '', target: `http://127.0.0.1:${stale}`, sourcePath,
    };

    let live: ReturnType<typeof serveDaemon> | undefined;
    const timer = setTimeout(() => {
      live = serveDaemon('tok-1');
      // The restarted daemon rewrites the mounted config in place.
      void writeFile(sourcePath, JSON.stringify({
        token: 'tok-1', projectRoot: '/proj', taskId: '', target: `http://127.0.0.1:${live.port}`,
      }));
    }, 400);

    const handler = createDaemonProxyHandler(config, 'lazy_journal', { log: () => {} });
    try {
      expect(await handler({ message: 'hi' })).toEqual({ ok: true });
    } finally {
      clearTimeout(timer);
    }
    expect(config.target).toBe(`http://127.0.0.1:${live!.port}`);
  }, 20_000);

  // INVARIANT: bounded, always. Waiting forever would replace one bad failure
  // mode (giving up instantly) with a worse one (a tool call that never
  // returns), and the error must stay the actionable one.
  test('the wait is bounded and ends in the actionable unreachable error', async () => {
    const port = await deadPort();
    const sourcePath = await writeConfigFile({
      token: 'tok-1', projectRoot: '/proj', taskId: '', target: `http://127.0.0.1:${port}`,
    });
    const config: DaemonMcpConfig = {
      token: 'tok-1', projectRoot: '/proj', taskId: '', target: `http://127.0.0.1:${port}`, sourcePath,
    };

    const handler = createDaemonProxyHandler(config, 'lazy_journal', {
      log: () => {},
      reconnectWindowMs: 400,
    });
    const started = Date.now();
    await expect(handler({ message: 'hi' })).rejects.toThrow(/could not reach the daemon/i);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  // INVARIANT: a call lost MID-flight may already have executed on the daemon,
  // and lazy tools are not idempotent — a retried lazy_commit commits twice.
  // The reconnect window must never turn that into a replay.
  test('a mid-flight loss is never replayed, window open or not', async () => {
    const sourcePath = await writeConfigFile({
      token: 'tok-1', projectRoot: '/proj', taskId: '', target: 'http://127.0.0.1:1',
    });
    const config: DaemonMcpConfig = {
      token: 'tok-1', projectRoot: '/proj', taskId: '', target: 'http://127.0.0.1:1', sourcePath,
    };

    let attempts = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      attempts++;
      throw new Error('The socket connection was closed unexpectedly');
    }) as unknown as typeof fetch;

    try {
      const handler = createDaemonProxyHandler(config, 'lazy_commit', { log: () => {} });
      await expect(handler({ message: 'x' })).rejects.toThrow(/closed unexpectedly/);
      expect(attempts).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // INVARIANT: a daemon that came back WITHOUT our token record (registry moved
  // by an upgrade, cleared by a repair, label evicted) rejects the session's
  // token. Its owner re-issues one bound to the SAME identity into the same
  // mounted file; the call picks that up rather than declaring the session dead.
  test('a credential re-issued into the mounted file mid-call is picked up', async () => {
    const live = serveDaemon('tok-2');   // the daemon now only knows tok-2
    const sourcePath = await writeConfigFile({
      token: 'tok-1', projectRoot: '/proj', taskId: '', target: `http://127.0.0.1:${live.port}`,
    });
    const config: DaemonMcpConfig = {
      token: 'tok-1', projectRoot: '/proj', taskId: '', target: `http://127.0.0.1:${live.port}`, sourcePath,
    };

    const timer = setTimeout(() => {
      void writeFile(sourcePath, JSON.stringify({
        token: 'tok-2', projectRoot: '/proj', taskId: '', target: `http://127.0.0.1:${live.port}`,
      }));
    }, 300);

    const handler = createDaemonProxyHandler(config, 'lazy_list', { log: () => {} });
    try {
      expect(await handler({})).toEqual({ ok: true });
    } finally {
      clearTimeout(timer);
    }
    expect(live.seen.map(s => s.token)).toEqual(['tok-1', 'tok-2']);
  }, 20_000);

  // INVARIANT: the re-auth wait is bounded too — a genuinely revoked token must
  // still fail, with the message that names relaunch as the remedy.
  test('a token that is never re-issued still fails with the 401 guidance', async () => {
    const live = serveDaemon('tok-2');
    const sourcePath = await writeConfigFile({
      token: 'tok-1', projectRoot: '/proj', taskId: '', target: `http://127.0.0.1:${live.port}`,
    });
    const config: DaemonMcpConfig = {
      token: 'tok-1', projectRoot: '/proj', taskId: '', target: `http://127.0.0.1:${live.port}`, sourcePath,
    };

    const handler = createDaemonProxyHandler(config, 'lazy_list', {
      log: () => {},
      reauthWindowMs: 300,
    });
    await expect(handler({})).rejects.toThrow(/401 Unauthorized/);
  }, 20_000);

  // SECURITY INVARIANT: credentials come from the trusted local file and
  // nowhere else. A daemon answering at our address — including a stranger that
  // took the port — cannot hand us a token, however it words its response.
  test('a token offered in the daemon response body is never adopted', async () => {
    const live = serveDaemon('tok-2');
    const sourcePath = await writeConfigFile({
      token: 'tok-1', projectRoot: '/proj', taskId: '', target: `http://127.0.0.1:${live.port}`,
    });
    const config: DaemonMcpConfig = {
      token: 'tok-1', projectRoot: '/proj', taskId: '', target: `http://127.0.0.1:${live.port}`, sourcePath,
    };

    const handler = createDaemonProxyHandler(config, 'lazy_list', {
      log: () => {},
      reauthWindowMs: 200,
    });
    await expect(handler({})).rejects.toThrow(/401 Unauthorized/);
    expect(config.token).toBe('tok-1');
    expect(live.seen.every(s => s.token === 'tok-1')).toBe(true);
  }, 20_000);
});
