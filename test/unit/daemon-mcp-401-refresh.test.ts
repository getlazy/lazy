/**
 * Unit tests for 401-triggered credential refresh — the container-side half of
 * "builder MCP survives daemon restarts".
 *
 * Observed in the field: after a daemon restart, EVERY lazy tool in a running
 * builder returned "Unauthorized" — read-only ones included — for the rest of
 * the session. The daemon reuses its bearer token across restarts, but the
 * container's copy of the token AND the target port are frozen at launch, and
 * the shared 26024+ port window means a restart can land elsewhere while a
 * foreign project's daemon answers on the old port.
 *
 * The recovery contract these tests pin:
 *   - a 401 re-reads the SAME trusted local file the config was minted from
 *   - and retries EXACTLY ONCE (never a loop, never a weakened auth check)
 *   - a still-failing 401 names the real cause (foreign daemon on our port)
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createDaemonProxyHandler,
  createAllDaemonProxyHandlers,
  createDaemonConfigRefresher,
  readDaemonMcpConfig,
  type DaemonMcpConfig,
} from '../../src/daemon/mcp-proxy';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';

describe('daemon MCP 401 credential refresh', () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-401-refresh-'));
  });

  afterEach(async () => {
    for (const s of servers) {
      try { s.stop(true); } catch { /* ignore */ }
    }
    servers.length = 0;
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * A daemon that only accepts `validToken`. Counts requests so tests can prove
   * the retry happened exactly once.
   */
  function serveDaemon(validToken: () => string, opts?: { projectRoot?: string }) {
    const seen: string[] = [];
    const s = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/daemon/status') {
          return Response.json({ status: 'running', projectRoot: opts?.projectRoot ?? '/proj' });
        }
        const auth = req.headers.get('authorization');
        seen.push(auth ?? '');
        if (auth !== `Bearer ${validToken()}`) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }
        return Response.json({ result: { ok: true } });
      },
    });
    servers.push(s);
    return { port: s.port!, seen };
  }

  async function writeConfigFile(body: Record<string, unknown>): Promise<string> {
    const path = join(dir, 'daemon-mcp-builder.json');
    await writeFile(path, JSON.stringify(body, null, 2));
    return path;
  }

  // INVARIANT: the mounted config file is a LIVE credential source. When the
  // daemon rewrites it (refreshDaemonMcpConfigs), the very next 401 must pick
  // up the new token and succeed — no relaunch, no lost session.
  test('a 401 re-reads the mounted config and the retry succeeds', async () => {
    const { port, seen } = serveDaemon(() => 'current-token');
    const path = await writeConfigFile({
      token: 'stale-token', projectRoot: '/proj', taskId: '',
      target: `http://localhost:${port}`,
    });
    const config = readDaemonMcpConfig(path);
    const handler = createDaemonProxyHandler(config, 'lazy_list', { log: () => {} });

    // The daemon restarted and rewrote the mounted file in place.
    await writeFile(path, JSON.stringify({
      token: 'current-token', projectRoot: '/proj', taskId: '',
      target: `http://localhost:${port}`,
    }));

    expect(await handler({})).toEqual({ ok: true });
    expect(seen).toEqual(['Bearer stale-token', 'Bearer current-token']);
    // The refreshed credentials stick — later calls don't pay the 401 again.
    expect(config.token).toBe('current-token');
  });

  // A restart that MOVED the port is the failure mode that persisted-token
  // reuse cannot fix on its own: the token is right, the daemon is wrong.
  test('a 401 also picks up a moved target port from the refreshed config', async () => {
    const moved = serveDaemon(() => 'shared-token');
    // Something else — another project's daemon — answers on the old port.
    const foreign = serveDaemon(() => 'foreign-token');

    const path = await writeConfigFile({
      token: 'shared-token', projectRoot: '/proj', taskId: '',
      target: `http://localhost:${foreign.port}`,
    });
    const config = readDaemonMcpConfig(path);
    const handler = createDaemonProxyHandler(config, 'lazy_list', { log: () => {} });

    await writeFile(path, JSON.stringify({
      token: 'shared-token', projectRoot: '/proj', taskId: '',
      target: `http://localhost:${moved.port}`,
    }));

    expect(await handler({})).toEqual({ ok: true });
    expect(config.target).toBe(`http://localhost:${moved.port}`);
  });

  // INVARIANT: refresh-and-retry is bounded to ONE attempt. An unbounded retry
  // against a daemon that will never accept us would hammer it forever.
  test('retries at most once and then fails with an actionable message', async () => {
    const { port, seen } = serveDaemon(() => 'never-matches');
    const path = await writeConfigFile({
      token: 'a', projectRoot: '/proj', taskId: '', target: `http://localhost:${port}`,
    });
    const config = readDaemonMcpConfig(path);
    const handler = createDaemonProxyHandler(config, 'lazy_show', { log: () => {} });

    // File changes, so a retry IS attempted — and still fails.
    await writeFile(path, JSON.stringify({
      token: 'b', projectRoot: '/proj', taskId: '', target: `http://localhost:${port}`,
    }));

    await expect(handler({})).rejects.toThrow(/401 Unauthorized/);
    expect(seen).toEqual(['Bearer a', 'Bearer b']);
  });

  // When the file has not changed, retrying is pointless — don't spend a second
  // round trip proving the same token still fails.
  test('does not retry when the credential source is unchanged', async () => {
    const { port, seen } = serveDaemon(() => 'other');
    const path = await writeConfigFile({
      token: 'a', projectRoot: '/proj', taskId: '', target: `http://localhost:${port}`,
    });
    const handler = createDaemonProxyHandler(readDaemonMcpConfig(path), 'lazy_list', { log: () => {} });

    await expect(handler({})).rejects.toThrow(/401/);
    expect(seen).toEqual(['Bearer a']);
  });

  // The diagnosis that turns a mystery into a one-line explanation: the port is
  // owned by a different project's daemon, which is why our token is rejected.
  test('a persistent 401 from a foreign daemon names the other project', async () => {
    const { port } = serveDaemon(() => 'theirs', { projectRoot: '/Users/me/other-project' });
    const config: DaemonMcpConfig = {
      token: 'ours', projectRoot: '/Users/me/my-project', taskId: '',
      target: `http://localhost:${port}`,
    };
    const handler = createDaemonProxyHandler(config, 'lazy_list', { refresh: null, log: () => {} });

    let msg = '';
    try { await handler({}); } catch (err) { msg = (err as Error).message; }

    expect(msg).toContain('DIFFERENT project');
    expect(msg).toContain('/Users/me/other-project');
    expect(msg).toContain('/Users/me/my-project');
    expect(msg).toContain('lazy builder --resume');
  });

  // INVARIANT: all tools share one config object and one refresher, so healing
  // any tool heals them all — the failure was always "EVERY lazy tool is dead",
  // and the recovery has to be just as total.
  test('one tool refreshing the credentials heals the other tools too', async () => {
    const { port, seen } = serveDaemon(() => 'v2');
    const path = await writeConfigFile({
      token: 'v1', projectRoot: '/proj', taskId: '', target: `http://localhost:${port}`,
    });
    const config = readDaemonMcpConfig(path);
    const handlers = createAllDaemonProxyHandlers(config, ['lazy_list', 'lazy_show'], { log: () => {} });

    await writeFile(path, JSON.stringify({
      token: 'v2', projectRoot: '/proj', taskId: '', target: `http://localhost:${port}`,
    }));

    expect(await handlers.get('lazy_list')!({})).toEqual({ ok: true });
    expect(await handlers.get('lazy_show')!({})).toEqual({ ok: true });
    // lazy_show never paid a 401: it inherited the healed token from the shared
    // config and authenticated on its FIRST attempt.
    expect(seen).toEqual(['Bearer v1', 'Bearer v2', 'Bearer v2']);
  });

  // A config built in memory (no file) has nothing trustworthy to re-read.
  test('a config with no file source has no refresher', () => {
    const config: DaemonMcpConfig = { token: 't', projectRoot: '/p', taskId: '', target: 'http://x' };
    expect(createDaemonConfigRefresher(config)).toBeNull();
  });

  // Security: a refresh must never invent credentials. An unreadable or
  // malformed source reports "no change" so the 401 stands.
  test('an unreadable or malformed credential source never changes the token', async () => {
    const config: DaemonMcpConfig = {
      token: 'keep', projectRoot: '/p', taskId: '', target: 'http://x',
      sourcePath: join(dir, 'missing.json'),
    };
    const refresh = createDaemonConfigRefresher(config, () => {})!;
    expect(await refresh()).toBe(false);
    expect(config.token).toBe('keep');

    const junkPath = join(dir, 'junk.json');
    await writeFile(junkPath, '{{{');
    const junkConfig: DaemonMcpConfig = { ...config, sourcePath: junkPath };
    const junkRefresh = createDaemonConfigRefresher(junkConfig, () => {})!;
    expect(await junkRefresh()).toBe(false);
    expect(junkConfig.token).toBe('keep');
  });

  // INVARIANT: the long-lived DaemonClient (builder conversation capture holds
  // one for the whole session) must recover the same way — otherwise a daemon
  // restart silently 401s away every conversation write until the builder exits.
  test('DaemonClient re-reads credentials on 401 and retries once', async () => {
    const { port, seen } = serveDaemon(() => 'rotated');
    let current = { target: `http://localhost:${port}`, token: 'stale' };
    const client = DaemonClient.fromTarget(current.target, current.token, async () => current);

    current = { target: `http://localhost:${port}`, token: 'rotated' };
    expect(await client.rpc('storage', '/proj', {})).toEqual({ result: { ok: true } } as any);
    expect(seen).toEqual(['Bearer stale', 'Bearer rotated']);

    // A later call reuses the healed token — no repeated 401 round trip.
    seen.length = 0;
    await client.rpc('storage', '/proj', {});
    expect(seen).toEqual(['Bearer rotated']);
  });

  // Bounded: a client whose source never yields working credentials must not
  // retry forever — it surfaces the daemon's 401 as an application error.
  test('DaemonClient surfaces a persistent 401 instead of retrying forever', async () => {
    const { port, seen } = serveDaemon(() => 'never');
    const client = DaemonClient.fromTarget(
      `http://localhost:${port}`, 'a',
      async () => ({ target: `http://localhost:${port}`, token: 'b' }),
    );

    await expect(client.rpc('storage', '/proj', {})).rejects.toBeInstanceOf(RpcApplicationError);
    expect(seen).toEqual(['Bearer a', 'Bearer b']);
  });

  // Without a credential source the client behaves exactly as before — no
  // silent extra round trip for callers that never had a refreshable source.
  test('DaemonClient without a credential source does not retry', async () => {
    const { port, seen } = serveDaemon(() => 'never');
    const client = DaemonClient.fromTarget(`http://localhost:${port}`, 'a');

    await expect(client.rpc('storage', '/proj', {})).rejects.toBeInstanceOf(RpcApplicationError);
    expect(seen).toEqual(['Bearer a']);
  });
});
