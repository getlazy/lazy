import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'bun';
import { createShellUpgrader } from '../../src/server/shell-ws';
import { guardDashboardRequest, DASHBOARD_COOKIE_NAME } from '../../src/daemon/dashboard-auth';
import {
  clearDashboardSessionCache,
  mintDashboardLoginTicket,
  redeemDashboardLoginTicket,
} from '../../src/daemon/dashboard-sessions';
import type { Storage } from '../../src/storage';

/**
 * The web-shell WebSocket upgrader's authorization routing. These cases all sit
 * BEFORE container resolution — the dashboard guard, then method, then task
 * existence — so they need no Docker and no runner.
 *
 * INVARIANT: the upgrader runs AHEAD of the HTTP handler's dashboard gate
 * (src/daemon/dashboard-auth.ts), so it must apply the same gate itself, FIRST,
 * on every upgrade — otherwise the shell would be the one unauthenticated route
 * on the daemon's port, and it is the single most valuable thing there. There
 * is deliberately no MCP surface for the shell (see
 * public-docs/surface-asymmetries.md).
 */
describe('web-shell upgrader authorization', () => {
  const notFoundStorage = {
    getTask: async () => null,
    getSessionByTaskId: async () => null,
  } as unknown as Storage;

  const dummyServer = {} as unknown as Server<unknown>;

  const allow = async () => null;
  const denyWith = (status: number) => async () =>
    new Response('denied', { status });

  function upgrader(guard: (req: Request) => Promise<Response | null>) {
    return createShellUpgrader({
      getStorage: async () => notFoundStorage,
      root: '/tmp/does-not-matter',
      guard,
    });
  }

  test('ignores requests that are not the shell route', async () => {
    const u = upgrader(allow);
    const outcome = await u.tryUpgrade(new Request('http://localhost/tasks/abc'), dummyServer);
    expect(outcome).toBeNull();
  });

  // INVARIANT: the guard's denial is returned VERBATIM, before the method or
  // task id is even looked at — an unauthenticated caller learns nothing about
  // the route beyond "sign in", exactly like every dashboard page.
  test('returns the guard denial before anything else', async () => {
    let sawTaskLookup = false;
    const u = createShellUpgrader({
      getStorage: async () => {
        sawTaskLookup = true;
        return notFoundStorage;
      },
      root: '/tmp/does-not-matter',
      guard: denyWith(401),
    });
    const outcome = await u.tryUpgrade(
      new Request('http://localhost/tasks/abc/shell/ws', { method: 'POST' }),
      dummyServer,
    );
    expect(outcome).toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(401);
    expect(sawTaskLookup).toBe(false);
  });

  test('a managed-mode style 404 from the guard passes through untouched', async () => {
    const u = upgrader(denyWith(404));
    const outcome = await u.tryUpgrade(
      new Request('http://localhost/tasks/abc/shell/ws'),
      dummyServer,
    );
    expect((outcome as Response).status).toBe(404);
  });

  test('rejects a non-GET method with 405 once the guard passes', async () => {
    const u = upgrader(allow);
    const outcome = await u.tryUpgrade(
      new Request('http://localhost/tasks/abc/shell/ws', { method: 'POST' }),
      dummyServer,
    );
    expect(outcome).toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(405);
  });

  test('passes the guard then 404s an unknown task', async () => {
    const u = upgrader(allow);
    const outcome = await u.tryUpgrade(
      new Request('http://localhost/tasks/unknown/shell/ws'),
      dummyServer,
    );
    expect((outcome as Response).status).toBe(404);
  });
});

/**
 * The same upgrader against the REAL dashboard gate — a genuine session store,
 * a genuine cookie, the genuine host check. Pins the contract in
 * src/daemon/dashboard-auth.ts: the web shell's upgrade requires a valid
 * dashboard session cookie presented on the dashboard host, on every bind.
 */
describe('web-shell upgrader with the real dashboard session gate', () => {
  const notFoundStorage = {
    getTask: async () => null,
    getSessionByTaskId: async () => null,
  } as unknown as Storage;
  const dummyServer = {} as unknown as Server<unknown>;

  const DASHBOARD_HOST = 'lazy.localhost';
  const projectRoot = '/tmp/lazy-shell-upgrader-project';
  let baseDir: string;
  let previousBaseDir: string | undefined;
  let sessionId: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'lazy-shell-upgrader-'));
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
    return createShellUpgrader({
      getStorage: async () => notFoundStorage,
      root: projectRoot,
      guard: (req) => guardDashboardRequest(projectRoot, req, DASHBOARD_HOST),
    });
  }

  function wsRequest(headers: Record<string, string>) {
    return new Request(`http://${DASHBOARD_HOST}/tasks/unknown/shell/ws`, { headers });
  }

  // INVARIANT: no session cookie, no shell — on every bind. The refusal is the
  // dashboard's own sign-in 401; the daemon bearer token is not a browser
  // credential and buys nothing here.
  test('refuses an upgrade without a session cookie', async () => {
    const outcome = await realUpgrader().tryUpgrade(
      wsRequest({ host: DASHBOARD_HOST }),
      dummyServer,
    );
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
  // are scoped by host and task apps publish on 127.0.0.1, so the session must
  // never be accepted there.
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
