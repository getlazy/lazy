import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'bun';
import { createWatchUpgrader, createRpcWatchUpgrader, watchServerMessage } from '../../src/server/watch-ws';
import { composeUpgraders, type WebSocketUpgrader, type UpgradeOutcome } from '../../src/server/ws';
import { guardDashboardRequest, DASHBOARD_COOKIE_NAME } from '../../src/daemon/dashboard-auth';
import {
  clearDashboardSessionCache,
  mintDashboardLoginTicket,
  redeemDashboardLoginTicket,
} from '../../src/daemon/dashboard-sessions';
import type { Storage } from '../../src/storage';

/**
 * The watch WebSocket upgrader's authorization routing — the same shape, and the
 * same INVARIANT, as test/unit/shell-upgrader.test.ts.
 *
 * INVARIANT: the upgrader runs AHEAD of the HTTP handler's dashboard gate
 * (src/daemon/dashboard-auth.ts), so it must apply the same gate itself, FIRST,
 * on every upgrade. A watch stream carries the agent's prompts, thinking and the
 * file contents it read — no less sensitive than the pages the gate protects, so
 * "it's read-only" is not a reason to leave it open.
 */
describe('watch upgrader authorization', () => {
  const notFoundStorage = {
    getTask: async () => null,
    getSessionByTaskId: async () => null,
  } as unknown as Storage;

  const dummyServer = {} as unknown as Server<unknown>;

  const allow = async () => null;
  const denyWith = (status: number) => async () => new Response('denied', { status });

  function upgrader(guard: (req: Request) => Promise<Response | null>) {
    return createWatchUpgrader({
      getStorage: async () => notFoundStorage,
      root: '/tmp/does-not-matter',
      guard,
    });
  }

  test('ignores requests that are not the watch route', async () => {
    const u = upgrader(allow);
    expect(await u.tryUpgrade(new Request('http://localhost/tasks/abc'), dummyServer)).toBeNull();
    // The shell's route belongs to the shell upgrader, not this one.
    expect(
      await u.tryUpgrade(new Request('http://localhost/tasks/abc/shell/ws'), dummyServer),
    ).toBeNull();
  });

  // INVARIANT: the guard's denial is returned VERBATIM, before the method or the
  // task id is even looked at — an unauthenticated caller learns nothing about
  // the route beyond "sign in", and cannot probe which task ids exist.
  test('returns the guard denial before anything else', async () => {
    let sawTaskLookup = false;
    const u = createWatchUpgrader({
      getStorage: async () => {
        sawTaskLookup = true;
        return notFoundStorage;
      },
      root: '/tmp/does-not-matter',
      guard: denyWith(401),
    });
    const outcome = await u.tryUpgrade(
      new Request('http://localhost/tasks/abc/watch/ws', { method: 'POST' }),
      dummyServer,
    );
    expect(outcome).toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(401);
    expect(sawTaskLookup).toBe(false);
  });

  test('a managed-mode style 404 from the guard passes through untouched', async () => {
    const u = upgrader(denyWith(404));
    const outcome = await u.tryUpgrade(
      new Request('http://localhost/tasks/abc/watch/ws'),
      dummyServer,
    );
    expect((outcome as Response).status).toBe(404);
  });

  test('rejects a non-GET method with 405 once the guard passes', async () => {
    const u = upgrader(allow);
    const outcome = await u.tryUpgrade(
      new Request('http://localhost/tasks/abc/watch/ws', { method: 'POST' }),
      dummyServer,
    );
    expect((outcome as Response).status).toBe(405);
  });

  test('passes the guard then 404s an unknown task', async () => {
    const u = upgrader(allow);
    const outcome = await u.tryUpgrade(
      new Request('http://localhost/tasks/unknown/watch/ws'),
      dummyServer,
    );
    expect((outcome as Response).status).toBe(404);
  });
});

/**
 * Control frames are the panel's only non-byte channel, so their shape is part
 * of the wire protocol (src/server/watch-ui.ts switches on `type`).
 */
describe('watch control messages', () => {
  test('are JSON text frames carrying a type', () => {
    expect(JSON.parse(watchServerMessage({ type: 'ready', task: 'abc' }))).toEqual({
      type: 'ready',
      task: 'abc',
    });
    expect(JSON.parse(watchServerMessage({ type: 'idle', status: 'blocked' }))).toEqual({
      type: 'idle',
      status: 'blocked',
    });
  });
});

/**
 * `Bun.serve` takes exactly one websocket handler per bind, so the shell and the
 * watch upgraders are folded together by composeUpgraders.
 */
describe('composeUpgraders', () => {
  const dummyServer = {
    upgrade: (_req: Request, _opts?: { data?: unknown }) => true,
  } as unknown as Server<unknown>;

  function stub(match: string, outcome: UpgradeOutcome, opened: string[]): WebSocketUpgrader {
    return {
      handler: {
        open(ws: { data?: unknown }) {
          opened.push(match + ':' + String((ws.data as { tag?: string })?.tag));
        },
      } as unknown as import('bun').WebSocketHandler<unknown>,
      async tryUpgrade(req, server) {
        if (!new URL(req.url).pathname.endsWith(match)) return null;
        if (outcome === 'upgraded') {
          server.upgrade(req, { data: { tag: match } });
          return 'upgraded';
        }
        return outcome;
      },
    };
  }

  test('declines when no sub-upgrader recognizes the request', async () => {
    const composed = composeUpgraders([stub('/a', 'upgraded', []), stub('/b', 'upgraded', [])]);
    expect(await composed.tryUpgrade(new Request('http://localhost/c'), dummyServer)).toBeNull();
  });

  // INVARIANT: the first non-null outcome wins, refusals included. A route that
  // RECOGNIZES a request but rejects it (bad method, unknown task) must not be
  // silently retried by the next upgrader, which would answer for a feature the
  // caller never addressed.
  test('a refusal from the first matching upgrader is final', async () => {
    const refusal = new Response('nope', { status: 405 });
    const composed = composeUpgraders([stub('/a', refusal, []), stub('/a', 'upgraded', [])]);
    const outcome = await composed.tryUpgrade(new Request('http://localhost/a'), dummyServer);
    expect(outcome).toBe(refusal);
  });

  // INVARIANT: a socket is routed back to the upgrader that OPENED it, not by
  // re-matching its path — so two features whose paths overlap can never deliver
  // each other's frames.
  test('routes handler callbacks to the upgrader that opened the socket', async () => {
    const opened: string[] = [];
    const composed = composeUpgraders([stub('/a', 'upgraded', opened), stub('/b', 'upgraded', opened)]);

    let captured: unknown = null;
    const capturingServer = {
      upgrade: (_req: Request, opts?: { data?: unknown }) => {
        captured = opts?.data;
        return true;
      },
    } as unknown as Server<unknown>;

    expect(await composed.tryUpgrade(new Request('http://localhost/b'), capturingServer)).toBe('upgraded');
    (composed.handler as unknown as { open: (ws: unknown) => void }).open({ data: captured });
    expect(opened).toEqual(['/b:/b']);
  });

  /**
   * INVARIANT: the server handed to a sub-upgrader behaves like the real one.
   *
   * It is a Proxy — that is how `upgrade()` stamps ownership on the socket — and
   * `Bun.serve`'s handle is a NATIVE object whose methods read internal slots
   * off `this`. A pass-through `get` trap hands back an unbound method, `this`
   * becomes the Proxy, and the call throws "Expected this to be instanceof
   * Server". The serve proxy calls `requestIP()` to fill in `X-Forwarded-For`,
   * so that throw took out every WebSocket upgrade to a task subdomain — HMR,
   * ActionCable, the lot — with a bare handshake failure and no message.
   *
   * Needs a real `Bun.serve`: a plain-object stand-in has no internal slots to
   * be wrong about, so it cannot reproduce this.
   */
  test('a sub-upgrader can call the real server’s native methods', async () => {
    const observed: string[] = [];
    const probe: WebSocketUpgrader = {
      handler: {} as unknown as import('bun').WebSocketHandler<unknown>,
      async tryUpgrade(req, server) {
        // Both shapes the native handle has: a method, and a property getter.
        observed.push(`${server.requestIP(req)?.address ?? 'none'}:${typeof server.port}`);
        return new Response('probed', { status: 200 });
      },
    };
    const composed = composeUpgraders([probe]);

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req, srv) => {
        const outcome = await composed.tryUpgrade(req, srv);
        return outcome instanceof Response ? outcome : new Response('unreached');
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/probe`);
      expect(res.status).toBe(200);
      expect(observed).toEqual(['127.0.0.1:number']);
    } finally {
      server.stop(true);
    }
  });
});

/**
 * The same upgrader against the REAL dashboard gate — a genuine session store, a
 * genuine cookie, the genuine host check.
 */
describe('watch upgrader with the real dashboard session gate', () => {
  const notFoundStorage = {
    getTask: async () => null,
    getSessionByTaskId: async () => null,
  } as unknown as Storage;
  const dummyServer = {} as unknown as Server<unknown>;

  const DASHBOARD_HOST = 'lazy.localhost';
  const projectRoot = '/tmp/lazy-watch-upgrader-project';
  let baseDir: string;
  let previousBaseDir: string | undefined;
  let sessionId: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'lazy-watch-upgrader-'));
    // The session registry lives in daemon runtime state, addressed through the
    // documented LAZY_DAEMON_BASE_DIR seam (never HOME).
    previousBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = baseDir;
    clearDashboardSessionCache();
    const ticket = await mintDashboardLoginTicket(projectRoot);
    const redeemed = await redeemDashboardLoginTicket(projectRoot, ticket);
    if (!redeemed) throw new Error('test setup: ticket did not redeem');
    sessionId = redeemed;
  });

  afterEach(async () => {
    if (previousBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = previousBaseDir;
    clearDashboardSessionCache();
    await rm(baseDir, { recursive: true, force: true });
  });

  function realUpgrader() {
    return createWatchUpgrader({
      getStorage: async () => notFoundStorage,
      root: projectRoot,
      guard: (req) => guardDashboardRequest(projectRoot, req, DASHBOARD_HOST),
    });
  }

  function wsRequest(headers: Record<string, string>) {
    return new Request(`http://${DASHBOARD_HOST}/tasks/unknown/watch/ws`, { headers });
  }

  // INVARIANT: no session cookie, no watch — on every bind.
  test('refuses an upgrade without a session cookie', async () => {
    const outcome = await realUpgrader().tryUpgrade(wsRequest({ host: DASHBOARD_HOST }), dummyServer);
    expect(outcome).toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(401);
  });

  test('refuses a made-up session cookie', async () => {
    const outcome = await realUpgrader().tryUpgrade(
      wsRequest({ host: DASHBOARD_HOST, cookie: `${DASHBOARD_COOKIE_NAME}=not-a-session` }),
      dummyServer,
    );
    expect((outcome as Response).status).toBe(401);
  });

  // INVARIANT: a valid cookie presented on the WRONG host is refused — cookies
  // are scoped by host and task apps publish on 127.0.0.1.
  test('refuses a valid session cookie on the wrong host', async () => {
    const outcome = await realUpgrader().tryUpgrade(
      wsRequest({ host: '127.0.0.1', cookie: `${DASHBOARD_COOKIE_NAME}=${sessionId}` }),
      dummyServer,
    );
    expect(outcome).toBeInstanceOf(Response);
    expect((outcome as Response).status).not.toBe(404); // never reached task lookup
    expect([401, 421]).toContain((outcome as Response).status);
  });

  test('a valid session cookie on the dashboard host proceeds past the gate', async () => {
    const outcome = await realUpgrader().tryUpgrade(
      wsRequest({ host: DASHBOARD_HOST, cookie: `${DASHBOARD_COOKIE_NAME}=${sessionId}` }),
      dummyServer,
    );
    // Past the gate: the unknown task is now the reason, not the session.
    expect((outcome as Response).status).toBe(404);
  });
});

/**
 * INVARIANT: the /rpc watch route (what a Teams relay opens, since managed mode
 * 404s the dashboard's) authenticates exactly as `/rpc/*` does — an actor
 * token and the project header, checked BEFORE the task is looked up.
 */
describe('rpc watch upgrader authorization', () => {
  const ROOT = '/projects/demo';
  let looked = false;
  const storage = {
    getTask: async () => { looked = true; return null; },
    getSessionByTaskId: async () => null,
  } as unknown as Storage;
  const server = { upgrade: () => true } as unknown as Server<unknown>;

  function up(ok: boolean) {
    return createRpcWatchUpgrader({
      getStorage: async () => storage,
      root: ROOT,
      authenticate: async () => (ok
        ? { ok: true, actor: { kind: 'user', email: 'a@example.com' } as never, legacyShared: false }
        : { ok: false, failure: { reason: 'missing' } } as never),
    });
  }

  beforeEach(() => { looked = false; });

  test('only answers /rpc/tasks/:id/watch/ws', async () => {
    expect(await up(true).tryUpgrade(new Request('http://d/tasks/abc/watch/ws'), server)).toBeNull();
  });

  test('a missing token is a 401 before any task lookup', async () => {
    const out = await up(false).tryUpgrade(new Request('http://d/rpc/tasks/abc/watch/ws'), server);
    expect((out as Response).status).toBe(401);
    expect(looked).toBe(false);
  });

  test('another project is refused before any task lookup', async () => {
    const out = await up(true).tryUpgrade(new Request('http://d/rpc/tasks/abc/watch/ws', {
      headers: { 'X-Lazy-Project': '/projects/other' },
    }), server);
    expect((out as Response).status).toBe(400);
    expect(looked).toBe(false);
  });

  test('an authenticated request for this project reaches the task lookup', async () => {
    const out = await up(true).tryUpgrade(new Request('http://d/rpc/tasks/abc/watch/ws', {
      headers: { 'X-Lazy-Project': ROOT },
    }), server);
    expect((out as Response).status).toBe(404);
    expect(looked).toBe(true);
  });
});
