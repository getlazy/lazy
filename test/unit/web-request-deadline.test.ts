/**
 * The dashboard must never let a request die of idleness either.
 *
 * The daemon's RPC and MCP routes are kept alive past `idleTimeout` by the
 * heartbeat envelope (see daemon-heartbeat.test.ts). The web dashboard cannot
 * use that mechanism — its client is a browser, which does not send
 * `X-Lazy-Heartbeat` and cannot read NDJSON — so it gets the other half of the
 * guarantee: a deadline strictly inside the idle timeout, so a request that
 * would have been reaped mid-flight instead ends as a visible HTTP response.
 *
 * These tests run against a real Bun.serve with a compressed deadline, so the
 * failure the field would hit at ~105s reproduces in a fraction of a second.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { DAEMON_IDLE_TIMEOUT_S, WEB_REQUEST_DEADLINE_MS } from '../../src/daemon/heartbeat';
import { createWebRequestHandler } from '../../src/server/index';
import type { Storage } from '../../src/storage';

/** Compressed stand-in for WEB_REQUEST_DEADLINE_MS so tests finish quickly. */
const TEST_DEADLINE_MS = 200;

const servers: { stop(closeActiveConnections?: boolean): void; port?: number }[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) {
    try { s.stop(true); } catch { /* already stopped by the test */ }
  }
});

/**
 * Storage where every read hangs forever — the real failure being modelled is a
 * backend that is slow or unreachable, not a route doing a lot of work.
 *
 * A Proxy rather than a fixed set of stubs on purpose: which method a given
 * route reaches first is an implementation detail, and pinning it would make
 * this test quietly stop covering a route the day someone reorders a query.
 */
function hangingStorage(): Storage {
  return new Proxy({}, {
    get: () => () => new Promise(() => { /* never settles */ }),
  }) as unknown as Storage;
}

/** Storage where every read resolves immediately with nothing. */
function emptyStorage(): Storage {
  return new Proxy({}, {
    get: () => async () => [],
  }) as unknown as Storage;
}

function startDashboard(storage: Storage) {
  const server = Bun.serve({
    port: 0,
    fetch: createWebRequestHandler(storage, { deadlineMs: TEST_DEADLINE_MS }),
  });
  servers.push(server);
  return server;
}

// INVARIANT: the deadline must land BEFORE the connection is reaped, or it buys
// nothing — the socket dies first and the user still sees nothing. It is derived
// from DAEMON_IDLE_TIMEOUT_S for exactly this reason; this fails if someone
// replaces the derivation with a literal that later drifts past the timeout.
test('the web request deadline lands inside the listener idle timeout', () => {
  expect(WEB_REQUEST_DEADLINE_MS).toBeLessThan(DAEMON_IDLE_TIMEOUT_S * 1000);
  // With enough headroom to render and write the error page on a briefly
  // starved event loop, rather than racing the reaper by a hair.
  expect(DAEMON_IDLE_TIMEOUT_S * 1000 - WEB_REQUEST_DEADLINE_MS).toBeGreaterThanOrEqual(10_000);
  // And not so tight that an ordinary large-project render trips it — that
  // would turn a slow page into a broken one.
  expect(WEB_REQUEST_DEADLINE_MS).toBeGreaterThan(30_000);
});

describe('a dashboard route that overruns its deadline', () => {
  // INVARIANT: an overrunning route must fail as an HTTP response the user can
  // read. Bun.serve's idle timer would otherwise close the connection with no
  // status and no body — the same silent reaping that killed long RPCs before
  // the heartbeat envelope existed, but with no envelope available here.
  test('an HTML route returns a 503 page, not a dead connection', async () => {
    const server = startDashboard(hangingStorage());

    const response = await fetch(`http://localhost:${server.port}/`);
    expect(response.status).toBe(503);

    const body = await response.text();
    expect(body).toContain('Request Timed Out');
    // Actionable, per CLAUDE.md: says what happened and what to do next.
    expect(body).toContain('lazy doctor');
  });

  // INVARIANT: the API surface must fail as JSON. An HTML error page delivered
  // to a JSON client is a parse error at the caller, which reads as a bug in the
  // caller rather than a timeout in the daemon.
  test('an API route returns a 503 JSON error', async () => {
    const server = startDashboard(hangingStorage());

    const response = await fetch(`http://localhost:${server.port}/api/activity`);
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');

    const body = await response.json() as { error: string };
    expect(body.error).toContain('lazy doctor');
  });

  test('a route that finishes in time is unaffected by the deadline', async () => {
    const server = startDashboard(emptyStorage());

    const response = await fetch(`http://localhost:${server.port}/api/tasks`);
    expect(response.status).toBe(200);
  });
});
