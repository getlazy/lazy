/**
 * Unit tests for TRANSPORT-triggered credential refresh — the half of
 * "MCP survives a daemon restart" that 401 handling could never cover.
 *
 * The field failure: a daemon restart moves the port (the 26024+ window is
 * shared across projects), the daemon rewrites every mounted MCP config with the
 * new address, and the running container keeps calling the OLD one. If nothing
 * took that port there is no 401 to heal on — `fetch` fails with ECONNREFUSED —
 * so the corrected address sat unread while every lazy tool reported "the daemon
 * appears to be down" for the rest of the turn. Agents reached end of turn with
 * no way to record a journal entry or follow-ups.
 *
 * The contract these tests pin:
 *   - a connection that was never established re-reads the trusted local file
 *     and retries EXACTLY ONCE
 *   - a connection lost MID-FLIGHT is never replayed (lazy tools are not
 *     idempotent — a retried lazy_commit would commit twice)
 *   - a torn read of the credential file (the daemon truncates it in place) is
 *     retried rather than mistaken for "nothing changed"
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createDaemonProxyHandler,
  createDaemonConfigRefresher,
  readDaemonMcpConfigWithRetry,
  type DaemonMcpConfig,
} from '../../src/daemon/mcp-proxy';

describe('daemon MCP transport-failure credential refresh', () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  let dir: string;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-transport-refresh-'));
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    for (const s of servers) {
      try { s.stop(true); } catch { /* the server may already be stopped */ }
    }
    servers.length = 0;
    await rm(dir, { recursive: true, force: true });
  });

  function serveDaemon(token: string) {
    const seen: string[] = [];
    const s = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/daemon/status') {
          return Response.json({ status: 'running', projectRoot: '/proj' });
        }
        seen.push(url.pathname);
        if (req.headers.get('authorization') !== `Bearer ${token}`) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }
        return Response.json({ result: { ok: true } });
      },
    });
    servers.push(s);
    return { port: s.port!, seen };
  }

  /** A port nothing is listening on — a connect here fails with ECONNREFUSED. */
  async function deadPort(): Promise<number> {
    const s = Bun.serve({ port: 0, fetch: () => new Response('') });
    const port = s.port!;
    s.stop(true);
    return port;
  }

  async function writeConfigFile(body: Record<string, unknown>): Promise<string> {
    const path = join(dir, 'daemon-mcp-task.json');
    await writeFile(path, JSON.stringify(body, null, 2));
    return path;
  }

  // INVARIANT: a moved daemon heals WITHOUT a 401. This is the whole point —
  // the previous implementation only re-read credentials on 401, so a restart
  // onto a free port (nothing answering the old address) never healed at all.
  test('a connection refused at the old address re-reads the config and retries once', async () => {
    const live = serveDaemon('tok-1');
    const stale = await deadPort();

    const sourcePath = await writeConfigFile({
      token: 'tok-1',
      projectRoot: '/proj',
      taskId: 'task-1',
      target: `http://127.0.0.1:${live.port}`,
    });

    // The in-memory config still points at the address the container launched
    // with; the FILE already carries the corrected one.
    const config: DaemonMcpConfig = {
      token: 'tok-1',
      projectRoot: '/proj',
      taskId: 'task-1',
      target: `http://127.0.0.1:${stale}`,
      sourcePath,
    };

    const handler = createDaemonProxyHandler(config, 'lazy_journal', { log: () => {} });
    const result = await handler({ message: 'hi' });

    expect(result).toEqual({ ok: true });
    expect(config.target).toBe(`http://127.0.0.1:${live.port}`);
    // Exactly one tool request reached the daemon — the retry, not a loop.
    expect(live.seen).toEqual(['/mcp/task-1/lazy_journal']);
  });

  // INVARIANT: no unbounded retry. A daemon that is down stays down as far as
  // this call is concerned: retrying is bounded by the reconnect window and then
  // the failure is reported. (The bound used to be "exactly one re-read"; it is
  // now a time window, so that a daemon merely being REBUILT is waited out
  // rather than ending the session — see daemon-mcp-reconnect.test.ts. The
  // window is passed explicitly here so the bound itself is what's asserted.)
  test('an unchanged config surfaces the failure once the window is spent', async () => {
    const stale = await deadPort();
    const sourcePath = await writeConfigFile({
      token: 'tok-1',
      projectRoot: '/proj',
      taskId: 'task-1',
      target: `http://127.0.0.1:${stale}`,
    });
    const config: DaemonMcpConfig = {
      token: 'tok-1',
      projectRoot: '/proj',
      taskId: 'task-1',
      target: `http://127.0.0.1:${stale}`,
      sourcePath,
    };

    const handler = createDaemonProxyHandler(config, 'lazy_journal', {
      log: () => {},
      reconnectWindowMs: 300,
    });
    await expect(handler({ message: 'hi' })).rejects.toThrow(/daemon/i);
  });

  // INVARIANT: a call lost MID-flight may already have executed on the daemon,
  // and lazy tools are not idempotent — replaying one could commit twice. Only
  // a connection that was never established is safe to retry.
  test('a mid-flight loss is reported, never replayed', async () => {
    const sourcePath = await writeConfigFile({
      token: 'tok-2',
      projectRoot: '/proj',
      taskId: 'task-1',
      target: 'http://127.0.0.1:1',
    });
    const config: DaemonMcpConfig = {
      token: 'tok-1',
      projectRoot: '/proj',
      taskId: 'task-1',
      target: 'http://127.0.0.1:1',
      sourcePath,
    };

    let attempts = 0;
    let refreshes = 0;
    globalThis.fetch = (async () => {
      attempts++;
      throw new Error('The socket connection was closed unexpectedly');
    }) as unknown as typeof fetch;

    const handler = createDaemonProxyHandler(config, 'lazy_commit', {
      log: () => {},
      refresh: async () => { refreshes++; return true; },
    });

    await expect(handler({ message: 'x' })).rejects.toThrow(/closed unexpectedly/);
    expect(attempts).toBe(1);
    expect(refreshes).toBe(0);
  });

  // INVARIANT: the daemon rewrites these files with an in-place truncate (a
  // rename would break the container's bind mount), so a reader can legitimately
  // land mid-write. One bad parse must not be mistaken for "nothing changed" —
  // that would abandon the very refresh the caller needs.
  test('a torn credential file is re-read rather than treated as unchanged', async () => {
    const sourcePath = join(dir, 'daemon-mcp-task.json');
    await writeFile(sourcePath, '{"token": "tok-1", "targ');  // truncated mid-write

    const config: DaemonMcpConfig = {
      token: 'tok-1',
      projectRoot: '/proj',
      taskId: 'task-1',
      target: 'http://127.0.0.1:1',
      sourcePath,
    };
    const refresh = createDaemonConfigRefresher(config, () => {})!;

    // The writer completes while the refresher is between attempts.
    setTimeout(() => {
      void writeFile(sourcePath, JSON.stringify({
        token: 'tok-1',
        projectRoot: '/proj',
        taskId: 'task-1',
        target: 'http://127.0.0.1:2',
      }));
    }, 20);

    expect(await refresh()).toBe(true);
    expect(config.target).toBe('http://127.0.0.1:2');
  });

  // INVARIANT: a torn read at MCP server startup must not kill the process.
  // Claude Code does not respawn a server that died starting up, so the agent
  // would lose every lazy tool for the whole turn with no recovery.
  test('the startup config read retries a torn file', async () => {
    const sourcePath = join(dir, 'daemon-mcp-task.json');
    await writeFile(sourcePath, '');  // mid-truncate: zero bytes

    setTimeout(() => {
      void writeFile(sourcePath, JSON.stringify({
        token: 'tok-9',
        projectRoot: '/proj',
        taskId: 'task-1',
        target: 'http://127.0.0.1:3',
      }));
    }, 20);

    const config = await readDaemonMcpConfigWithRetry(sourcePath);
    expect(config.token).toBe('tok-9');
    expect(config.sourcePath).toBe(sourcePath);
  });

  test('a permanently unreadable config fails with an actionable message', async () => {
    await expect(readDaemonMcpConfigWithRetry(join(dir, 'nope.json')))
      .rejects.toThrow(/Could not read daemon MCP config/);
  });
});
